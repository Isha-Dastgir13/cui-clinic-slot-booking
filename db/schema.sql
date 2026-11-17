-- Data model: User (1) -> (N) clinic_slots (staff publish) ; User (1) -> (N) appointments (student books)
-- clinic_slot (1) -> (N) appointments over time, but only ONE active appointment per slot.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','staff','admin')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clinic_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  doctor TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES clinic_slots(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Race-condition guard: the database itself refuses a second active booking on the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_appointment_per_slot
  ON appointments (slot_id) WHERE status <> 'cancelled';
