# CUI Clinic Slot Booking (Variant 3)

Clinic Slot (A) / Appointment (B) / 409 "Slot already taken" / live event `slot:taken`.
Built to match the handwritten design: Client -> Reverse proxy / load balancer -> 2 app instances
(REST + Socket.IO) -> Redis (cache + pub/sub) + PostgreSQL.

## Run in VS Code
1. Install and start **Docker Desktop** (https://www.docker.com/products/docker-desktop). Wait until it says "running".
2. Unzip, then File > Open Folder in VS Code.
3. Open the terminal (Ctrl + `) and run:

       docker compose up --build

   First run downloads images and takes a few minutes. Wait for `[app-1] listening on :3000` and `[app-2] listening on :3000`.
4. Open http://localhost:3000
5. Stop with Ctrl + C. Reset the database with `docker compose down -v`.

Demo accounts: student@cui.edu.pk / Student@123, staff@cui.edu.pk / Staff@123, admin@cui.edu.pk / Admin@123

## How the code matches your design
| Your design | Where |
|---|---|
| Reverse proxy / load balancer, TLS-ready | `nginx.conf` (round-robin to app1 and app2) |
| App instance 1 / 2, API + WebSocket | `server.js` run twice (`INSTANCE=app-1/app-2`); header shows which one you are on |
| Redis cache (browse slots, lazy load, invalidation) | `cachedSlots()` / `invalidate()` in `server.js`, 60s TTL, `X-Cache: HIT/MISS` header |
| Redis pub/sub for live events | `@socket.io/redis-adapter`: an event on one instance reaches clients on the other |
| Managed PostgreSQL | `postgres` service, tables in `db/schema.sql` |
| Data model User(1)-(N) slots, User(1)-(N) appointments, Slot(1)-(N) appointments | `users`, `clinic_slots.created_by`, `appointments` |
| Auth: stateless JWT | `auth` middleware |
| RBAC matrix | `allow(...)` guards on every route (403 on deny) |
| Preventing race conditions | partial unique index `one_active_appointment_per_slot` -> second booking gets 409 |

## API (all under /api/v1, JWT in Authorization: Bearer ...)
- POST /auth/register, POST /auth/login, GET /auth/me
- GET /clinic-slots (cached), GET /clinic-slots/:id, POST, PATCH, DELETE (staff/admin)
- POST /clinic-slots/:id/appointments (student; 409 if taken)
- GET /clinic-slots/:id/appointments (staff, nested URI), GET /appointments, GET /appointments/:id
- PATCH /appointments/:id/status (pending > confirmed > completed or cancelled; forward only)
- GET /users, PATCH /users/:id/role (admin)

## Live events (Socket.IO, JWT-checked)
`slot:taken`, `slot:released`, `slot:changed` go to everyone. `appointment:updated` goes only to the owning student
(room `user:<id>`) and to staff/admin (room `staff`).

## Try the load balancer and live updates
Open two browser windows (student and staff). Book a slot as the student: the staff window updates instantly,
even if the two windows are connected to different instances (look at "Live · app-1/app-2" top right).
