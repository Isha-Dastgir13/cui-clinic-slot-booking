// CUI Clinic Slot Booking
// Client -> Nginx (load balancer / reverse proxy) -> 2x Node app instances (REST + Socket.IO)
//        -> Redis (cache + pub/sub for live events) + PostgreSQL (system of record)
const express = require('express'), http = require('http'), path = require('path'), fs = require('fs');
const jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs'), { Pool } = require('pg'), Redis = require('ioredis');
const { Server } = require('socket.io'), { createAdapter } = require('@socket.io/redis-adapter');

const PORT = process.env.PORT || 3000, INSTANCE = process.env.INSTANCE || 'app-1';
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://clinic:clinic@localhost:5432/clinic';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const pool = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on('error', e => console.error('[redis]', e.message));

const app = express(), server = http.createServer(app);
const io = new Server(server);
io.adapter(createAdapter(redis, redis.duplicate()));   // events emitted on one instance reach clients on the other
app.use(express.json());
app.use((req, res, next) => { res.set('X-Served-By', INSTANCE); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, instance: INSTANCE }));

/* ---------- Database bootstrap (safe with two instances starting together) ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addMin = (t, n) => { const m = +t.slice(0, 2) * 60 + +t.slice(3) + n; return String((m / 60) | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
async function initDb() {
  for (let i = 0; ; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) { if (i > 30) throw e; console.log('Waiting for PostgreSQL...'); await sleep(2000); }
  }
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)');          // one instance initialises at a time
    await c.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
    if ((await c.query('SELECT 1 FROM users LIMIT 1')).rowCount === 0) {
      const ids = {};
      for (const [name, email, pw, role] of [['Admin User', 'admin@cui.edu.pk', 'Admin@123', 'admin'],
        ['Clinic Staff', 'staff@cui.edu.pk', 'Staff@123', 'staff'], ['Sample Student', 'student@cui.edu.pk', 'Student@123', 'student']]) {
        ids[role] = (await c.query('INSERT INTO users(name,email,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
          [name, email, role, bcrypt.hashSync(pw, 10)])).rows[0].id;
      }
      const docs = ['Dr. Ayesha Khan', 'Dr. Bilal Ahmed'];
      for (let d = 0; d < 3; d++) {
        const date = new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
        for (const [i, t] of ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'].entries())
          await c.query('INSERT INTO clinic_slots(slot_date,start_time,end_time,doctor,created_by) VALUES($1,$2,$3,$4,$5)',
            [date, t, addMin(t, 30), docs[i % 2], ids.staff]);
      }
      console.log('Seeded demo users and slots');
    }
  } finally { await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {}); c.release(); }
}

/* ---------- SQL views ---------- */
const SLOT_SQL = `SELECT s.id, s.slot_date AS date, s.start_time AS "startTime", s.end_time AS "endTime", s.doctor, s.created_by AS "createdBy",
  CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status <> 'cancelled') THEN 'taken' ELSE 'available' END AS status
  FROM clinic_slots s`;
const APPT_SQL = `SELECT a.id, a.slot_id AS "slotId", a.student_id AS "studentId", a.status, a.created_at AS "createdAt",
  json_build_object('id', s.id, 'date', s.slot_date, 'startTime', s.start_time, 'endTime', s.end_time, 'doctor', s.doctor) AS slot,
  json_build_object('id', u.id, 'name', u.name) AS student
  FROM appointments a JOIN clinic_slots s ON s.id = a.slot_id JOIN users u ON u.id = a.student_id`;
const APPT_ORDER = ' ORDER BY s.slot_date, s.start_time';
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const slotById = id => one(SLOT_SQL + ' WHERE s.id = $1', [id]);
const apptById = id => one(APPT_SQL + ' WHERE a.id = $1', [id]);

/* ---------- Redis cache-aside for browsing slots (A) ----------
   Lazy load: fill on first read, TTL 60s. Invalidation = bump a version number, so every cached
   list from before the change is instantly orphaned (no half-deleted keys, no stale-write race). */
async function cachedSlots(date) {
  let key;
  try {
    key = `slots:v${(await redis.get('slots:ver')) || 0}:${date || 'all'}`;
    const hit = await redis.get(key);
    if (hit) return { data: JSON.parse(hit), hit: true };
  } catch { key = null; }                                   // Redis down -> fall back to PostgreSQL
  const { rows } = await pool.query(SLOT_SQL + (date ? ' WHERE s.slot_date = $1' : '') + ' ORDER BY s.slot_date, s.start_time', date ? [date] : []);
  if (key) redis.set(key, JSON.stringify(rows), 'EX', 60).catch(() => {});
  return { data: rows, hit: false };
}
const invalidate = () => redis.incr('slots:ver').catch(() => {});

/* ---------- Helpers + middleware ---------- */
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pubUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const sign = u => jwt.sign({ sub: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '8h' });
const slotErr = b => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return 'date must be YYYY-MM-DD';
  if (!/^\d{2}:\d{2}$/.test(b.startTime || '') || !/^\d{2}:\d{2}$/.test(b.endTime || '')) return 'startTime and endTime must be HH:MM';
  if (b.endTime <= b.startTime) return 'endTime must be after startTime';
  if (!(b.doctor || '').trim()) return 'doctor is required';
};
const auth = (req, res, next) => {                           // stateless JWT: no session store needed
  try { const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); req.user = { id: p.sub, role: p.role, name: p.name }; next(); }
  catch { fail(res, 401, 'Please sign in again'); }
};
const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : fail(res, 403, 'Your role cannot do this');
const staffUp = allow('staff', 'admin');
const router = express.Router();
router.param('id', (req, res, next, id) => UUID.test(id) ? next() : fail(res, 404, 'Not found'));

/* ---------- Auth ---------- */
router.post('/auth/register', ah(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) return fail(res, 400, 'Name, email and a password of 6+ characters are required');
  try {
    const u = await one('INSERT INTO users(name,email,role,password_hash) VALUES($1,$2,$3,$4) RETURNING *',
      [name.trim(), email.toLowerCase(), 'student', bcrypt.hashSync(password, 10)]);
    res.status(201).json({ token: sign(u), user: pubUser(u) });
  } catch (e) { e.code === '23505' ? fail(res, 409, 'Email already registered') : Promise.reject(e); }
}));
router.post('/auth/login', ah(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE email = $1', [(req.body?.email || '').toLowerCase()]);
  if (!u || !bcrypt.compareSync(req.body?.password || '', u.password_hash)) return fail(res, 401, 'Wrong email or password');
  res.json({ token: sign(u), user: pubUser(u) });
}));
router.get('/auth/me', auth, ah(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  u ? res.json(pubUser(u)) : fail(res, 401, 'Please sign in again');
}));

/* ---------- Clinic slots (A): staff CRUD, everyone reads (cached) ---------- */
router.get('/clinic-slots', auth, ah(async (req, res) => {
  const date = req.query.date;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'date must be YYYY-MM-DD');
  const { data, hit } = await cachedSlots(date);
  res.set('X-Cache', hit ? 'HIT' : 'MISS').json(data);
}));
router.get('/clinic-slots/:id', auth, ah(async (req, res) => {
  const s = await slotById(req.params.id); s ? res.json(s) : fail(res, 404, 'Slot not found');
}));
router.post('/clinic-slots', auth, staffUp, ah(async (req, res) => {
  const e = slotErr(req.body); if (e) return fail(res, 400, e);
  const { date, startTime, endTime, doctor } = req.body;
  const r = await one('INSERT INTO clinic_slots(slot_date,start_time,end_time,doctor,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [date, startTime, endTime, doctor.trim(), req.user.id]);
  await invalidate(); io.emit('slot:changed', { slotId: r.id });
  res.status(201).json(await slotById(r.id));
}));
router.patch('/clinic-slots/:id', auth, staffUp, ah(async (req, res) => {
  const cur = await slotById(req.params.id); if (!cur) return fail(res, 404, 'Slot not found');
  const n = { ...cur, ...req.body }, e = slotErr(n); if (e) return fail(res, 400, e);
  await pool.query('UPDATE clinic_slots SET slot_date=$1,start_time=$2,end_time=$3,doctor=$4 WHERE id=$5',
    [n.date, n.startTime, n.endTime, n.doctor.trim(), cur.id]);
  await invalidate(); io.emit('slot:changed', { slotId: cur.id });
  res.json(await slotById(cur.id));
}));
router.delete('/clinic-slots/:id', auth, staffUp, ah(async (req, res) => {
  const s = await slotById(req.params.id); if (!s) return fail(res, 404, 'Slot not found');
  if (s.status === 'taken') return fail(res, 409, 'This slot has an active appointment. Cancel it first.');
  await pool.query('DELETE FROM clinic_slots WHERE id = $1', [s.id]);
  await invalidate(); io.emit('slot:changed', {}); res.status(204).end();
}));

/* ---------- Appointments (B) ---------- */
// The partial unique index makes the INSERT itself the conflict check, so two students clicking at the
// same moment (even on different app instances) cannot both win: the loser gets 409.
router.post('/clinic-slots/:id/appointments', auth, allow('student'), ah(async (req, res) => {
  let r;
  try { r = await one('INSERT INTO appointments(slot_id, student_id) VALUES($1,$2) RETURNING id', [req.params.id, req.user.id]); }
  catch (e) {
    if (e.code === '23505') return fail(res, 409, 'Slot already taken');
    if (e.code === '23503') return fail(res, 404, 'Slot not found');
    throw e;
  }
  await invalidate();
  io.emit('slot:taken', { slotId: req.params.id });                          // everyone sees availability change
  io.to('staff').emit('appointment:updated', { id: r.id, status: 'pending' });
  res.status(201).json(await apptById(r.id));
}));
router.get('/clinic-slots/:id/appointments', auth, staffUp, ah(async (req, res) =>
  res.json((await pool.query(APPT_SQL + ' WHERE a.slot_id = $1' + APPT_ORDER, [req.params.id])).rows)));
router.get('/appointments', auth, ah(async (req, res) => {
  const mine = req.user.role === 'student';
  res.json((await pool.query(APPT_SQL + (mine ? ' WHERE a.student_id = $1' : '') + APPT_ORDER, mine ? [req.user.id] : [])).rows);
}));
router.get('/appointments/:id', auth, ah(async (req, res) => {
  const a = await apptById(req.params.id);
  if (!a) return fail(res, 404, 'Appointment not found');
  if (req.user.role === 'student' && a.studentId !== req.user.id) return fail(res, 403, 'You can only view your own appointments');
  res.json(a);
}));
const NEXT = { pending: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [] };
router.patch('/appointments/:id/status', auth, ah(async (req, res) => {
  const a = await apptById(req.params.id), to = req.body?.status;
  if (!a) return fail(res, 404, 'Appointment not found');
  const student = req.user.role === 'student';
  if (student && a.studentId !== req.user.id) return fail(res, 403, 'You can only change your own appointments');
  if (student && to !== 'cancelled') return fail(res, 403, 'Students can only cancel');
  if (!NEXT[a.status]?.includes(to)) return fail(res, 422, `Cannot move from ${a.status} to ${to}. Status only moves forward.`);
  const u = await pool.query('UPDATE appointments SET status=$1 WHERE id=$2 AND status=$3', [to, a.id, a.status]);   // guards a double-click race
  if (!u.rowCount) return fail(res, 409, 'Appointment was just changed by someone else. Refresh and try again.');
  await invalidate();
  if (to === 'cancelled') io.emit('slot:released', { slotId: a.slotId });
  io.to('user:' + a.studentId).emit('appointment:updated', { id: a.id, status: to });
  io.to('staff').emit('appointment:updated', { id: a.id, status: to });
  res.json(await apptById(a.id));
}));

/* ---------- Admin: users and roles ---------- */
router.get('/users', auth, allow('admin'), ah(async (req, res) =>
  res.json((await pool.query('SELECT id,name,email,role FROM users ORDER BY created_at')).rows)));
router.patch('/users/:id/role', auth, allow('admin'), ah(async (req, res) => {
  if (!['student', 'staff', 'admin'].includes(req.body?.role)) return fail(res, 400, 'Role must be student, staff or admin');
  const u = await one('UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role', [req.body.role, req.params.id]);
  u ? res.json(u) : fail(res, 404, 'User not found');
}));
app.use('/api/v1', router);
app.use('/api', (req, res) => fail(res, 404, 'Route not found'));
app.use((err, req, res, next) => { console.error(err); fail(res, 500, 'Something went wrong on the server'); });

/* ---------- Real-time gateway (Socket.IO over WebSocket, JWT-checked, Redis pub/sub across instances) ---------- */
io.use((socket, next) => {
  try { const p = jwt.verify(socket.handshake.auth.token, SECRET); socket.data = { id: p.sub, role: p.role }; next(); }
  catch { next(new Error('unauthorized')); }
});
io.on('connection', s => {
  s.join('user:' + s.data.id);                               // a student only receives their own booking updates
  if (s.data.role !== 'student') s.join('staff');            // staff/admin see every booking change
  s.emit('hello', { instance: INSTANCE });
});

initDb().then(() => server.listen(PORT, () => console.log(`[${INSTANCE}] listening on :${PORT}`)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
