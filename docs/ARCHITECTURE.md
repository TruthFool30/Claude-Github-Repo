# Hearth — Family Organizer (architecture & conventions)

Hearth is a self-hosted, private family hub comparable to FamilyWall: a shared
wall/feed, calendar, lists & tasks, messaging, photo albums, meal planner,
budget, locator, contacts and a document vault — for one or more family
"circles". This document is the contract every module is built against.
**Read it fully before writing code.**

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22 (ESM, `"type": "module"`) |
| Server | Express 5, `node:sqlite` (`DatabaseSync`, no native deps), `multer` for uploads, `cookie-parser` |
| Realtime | Server-Sent Events at `GET /api/stream` |
| Auth | email + password, `crypto.scrypt` hashing, opaque session token in an httpOnly cookie `hearth_session`, stored in `sessions` table |
| Client | Vite + React 19 + TypeScript (strict) + Tailwind CSS v4 (`@tailwindcss/vite`) + React Router 7 + TanStack Query 5 + `lucide-react` icons + `date-fns` + `@fontsource-variable/inter` |
| Maps | `leaflet` + `react-leaflet` (OpenStreetMap tiles) |
| Charts | `recharts` |
| Tests | `node --test` for server API tests (`server/test/*.test.js`), Playwright (preinstalled Chromium at `/opt/pw-browsers/chromium`) for UI smoke tests / screenshots |

Repository layout (npm workspaces: `server`, `client`):

```
package.json            # root: workspaces + scripts (dev, build, start, test, seed)
server/
  package.json
  src/
    index.js            # boot: create app, listen on PORT (default 8080)
    app.js              # createApp({ dbPath }) -> express app (used by tests)
    db.js               # openDb(path), runs core + module migrations
    auth.js             # hashing, sessions, requireAuth / requireFamily middleware
    realtime.js         # SSE hub: broadcast(familyId, type, payload)
    activity.js         # logActivity(...) -> activity table + broadcast 'activity'
    uploads.js          # multer config, /uploads static serving (auth-checked)
    core/               # core routers: auth, families, members, activity, notifications
    modules/
      index.js          # imports and registers every module (DO NOT EDIT from a feature module)
      wall.js calendar.js lists.js messages.js photos.js meals.js budget.js locator.js vault.js
    seed.js             # demo family seed (`npm run seed`)
  test/
client/
  package.json
  vite.config.ts        # proxy /api and /uploads -> http://localhost:${API_PORT||8080}
  index.html
  src/
    main.tsx App.tsx
    lib/api.ts          # fetch wrapper
    lib/live.ts         # SSE client + useLive hook
    lib/auth.tsx        # AuthProvider / useAuth
    lib/format.ts       # date/currency helpers
    ui/                 # shared design-system components (see below)
    layout/             # AppShell, Sidebar, BottomNav, TopBar
    pages/              # Login, Register, JoinFamily, Onboarding, Settings, Profile, Family
    modules/
      registry.tsx      # list of module descriptors (DO NOT EDIT from a feature module)
      wall/ calendar/ lists/ messages/ photos/ meals/ budget/ locator/ vault/
docs/
```

## Running

- `npm install` at repo root.
- `npm run dev` — server on :8080 (nodemon) + Vite on :5173 (proxying API).
- `npm run build` — builds client to `client/dist`; `npm start` serves API + `client/dist` on :8080.
- `npm run seed` — creates demo family (see Seed data) in the DB.
- `npm test` — server tests.
- Env vars: `PORT` (8080), `DB_PATH` (`./data/hearth.db`), `UPLOAD_DIR` (`./data/uploads`),
  `CLIENT_DIST` (`client/dist`). Tests/critics use temp `DB_PATH`/`UPLOAD_DIR` and unique ports so
  several instances can run at once.

## Server conventions

### Core schema (owned by foundation, in `db.js`)

```sql
users(id INTEGER PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
      color TEXT NOT NULL, avatar_url TEXT, birthday TEXT /*YYYY-MM-DD*/, phone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
families(id INTEGER PK, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL, cover_url TEXT,
         currency TEXT NOT NULL DEFAULT 'USD', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))
memberships(family_id INTEGER, user_id INTEGER, role TEXT CHECK(role IN ('admin','member','child')),
            nickname TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(family_id,user_id))
sessions(token TEXT PK, user_id INTEGER NOT NULL, active_family_id INTEGER, created_at TEXT, expires_at TEXT)
activity(id INTEGER PK, family_id INTEGER NOT NULL, user_id INTEGER, module TEXT NOT NULL, verb TEXT NOT NULL,
         entity_id INTEGER, summary TEXT NOT NULL, link TEXT, created_at TEXT DEFAULT (datetime('now')))
notifications(id INTEGER PK, user_id INTEGER NOT NULL, family_id INTEGER NOT NULL, module TEXT, title TEXT NOT NULL,
              body TEXT, link TEXT, read_at TEXT, created_at TEXT DEFAULT (datetime('now')))
```

All timestamps are ISO-8601 strings in UTC (`new Date().toISOString()` or sqlite `datetime('now')`
converted). Dates without time are `YYYY-MM-DD`. Foreign keys ON, WAL mode.

### Module contract (`server/src/modules/<name>.js`)

```js
import { Router } from 'express';
export const name = 'lists';                 // mounted at /api/lists
export const migrations = [                   // idempotent SQL strings, run at boot in order
  `CREATE TABLE IF NOT EXISTS lists (...)`,
];
export function router(ctx) {                 // ctx described below
  const r = Router();
  r.get('/', (req, res) => { /* req.user, req.family, req.role available */ });
  return r;
}
```

- Every module router is mounted behind `requireAuth` + `requireFamily`, so `req.user`
  (`{id,name,email,color,avatar_url}`), `req.family` (`{id,name,currency,...}`) and `req.role` are set.
  **Always scope every query by `req.family.id`** and verify ownership of IDs in params (return 404
  if the row belongs to another family).
- Table names are prefixed by module when ambiguous (e.g. `meal_recipes`, `budget_transactions`).
- `ctx` = `{ db, broadcast, logActivity, notify, upload, publicUser }`:
  - `db` — `DatabaseSync`. Use prepared statements. Use `db.exec('BEGIN')/COMMIT` for multi-writes.
  - `broadcast(familyId, type, payload)` — SSE to all family members. `type` is `'<module>.<event>'`
    e.g. `'lists.item.updated'`. Clients invalidate queries whose key starts with `[<module>]`.
  - `logActivity({ familyId, userId, module, verb, entityId, summary, link })` — feed entry shown on the
    Wall (e.g. summary `"added 3 items to Groceries"`, link `"/lists/12"`). Log meaningful actions
    only (create, complete, upload), not every keystroke.
  - `notify({ familyId, userIds, module, title, body, link })` — per-user notification
    (bell icon), also broadcast as `'notification'` to those users.
  - `upload` — multer instance storing to `UPLOAD_DIR/<familyId>/` with random names, 25 MB limit.
    After `upload.single('file')`, the public URL is `req.file.url` (e.g. `/uploads/3/ab12cd.jpg`).
    `/uploads/<familyId>/...` is only served to members of that family.
  - `publicUser(row)` — strips secrets from a users row.
- Errors: respond `res.status(4xx).json({ error: 'Human readable message' })`. Validate input.
  Unhandled errors are caught by the app-level handler (500 JSON).
- JSON field naming: **snake_case** in API payloads, matching columns.

### Core API (foundation)

```
POST /api/auth/register {name,email,password, family_name?}     -> {user, families}
POST /api/auth/login {email,password}                             -> {user, families}
POST /api/auth/logout
GET  /api/auth/me                    -> {user, families:[{id,name,role,...}], active_family_id}  (signed out: 200 {user:null, families:[], active_family_id:null})
PATCH /api/auth/me {name,color,birthday,phone,email?,password?,current_password?}  (email or password change requires current_password)
POST /api/auth/me/avatar (multipart file) -> {user}
POST /api/auth/login/2fa {ticket, code}   -> {user, families}  (second step, see "Two-factor login" below)
POST /api/auth/2fa/setup {password}       -> {secret, otpauth_uri, qr_svg}  (pending until enabled, max 15 min)
DELETE /api/auth/2fa/setup                -> {ok}  (cancel: forget the pending secret)
POST /api/auth/2fa/enable {code}          -> {...me, recovery_codes}  (signs out the user's other sessions)
POST /api/auth/2fa/recovery-codes {code}  -> {...me, recovery_codes}  (replaces all old codes)
POST /api/auth/2fa/disable {password, code} -> me
POST /api/families {name}            -> family (creator becomes admin, becomes active)
POST /api/families/join {invite_code} -> family
POST /api/families/:id/activate      -> sets the session's DEFAULT family (used by tabs/requests without X-Family-Id)
GET  /api/families/invite/:code      -> {name, member_count, already_member, family_id}  (no auth needed, rate-limited; for /join/<code> links)
GET  /api/family                     -> active family + members [{id,name,color,avatar_url,role,birthday,...}]
PATCH /api/family {name,currency}    (admin)
DELETE /api/family {confirm_name}    (admin; deletes the family and ALL its data; confirm_name must equal the family name)
POST /api/family/cover (multipart)   (admin)
POST /api/family/invite-code/rotate  (admin)
PATCH /api/family/members/:userId {role,nickname} (admin)
DELETE /api/family/members/:userId   (admin, or self = leave; the sole admin must promote someone first;
                                      when the last member who can sign in leaves, the family is deleted -> {ok, family_deleted:true})
POST /api/family/members {name,email?,role:'child',password?}  (admin: add a child/managed member)
GET  /api/activity?before=<id>&limit=30  -> [{..., user}]
GET  /api/notifications              -> {items, unread}
POST /api/notifications/read {ids?}  (all if omitted)
GET  /api/stream?family_id=<id>      -> SSE (event: message, data: {type,payload,at}); bound to that family (default: session family)
GET  /api/search?q=                  -> aggregated results (modules may register a `search(ctx, familyId, q)` export returning [{module,title,subtitle,link}])
```

**Which family a request is for.** Every request may carry an `X-Family-Id: <id>` header (the web
client sends it on every call, holding the family per browser tab). `requireFamily` verifies
membership and sets `req.family`; a family you don't belong to → `403 {code:'NOT_MEMBER'}`. Without
the header the session's default family is used. So two tabs can safely work in two families.
`invite_code` is only returned to admins (`null` for everyone else). Login/register/join/invite
lookups are rate-limited (429 `{error}` + `Retry-After`; login counts only FAILED attempts, per IP
and per email+IP, so nobody can lock another user out); set `HEARTH_RATE_LIMITS=off` on scripted
test instances if needed. Client IPs come from `req.ip`, governed by `TRUST_PROXY` (default `loopback`).

**Two-factor login (TOTP).** RFC 6238 codes (SHA1, 6 digits, 30 s, ±1 step) from any
authenticator app, implemented with `node:crypto` in `server/src/totp.js`; the QR code is rendered
server-side as SVG (`qrcode`). Columns on `users`: `totp_secret` / `totp_pending` (sealed with
`ctx.box`), `totp_last_step` (codes at or before it are refused, so a code can't be replayed) and
`totp_recovery` (JSON array of sha256 hashes of the 10 one-time recovery codes, `abcd-efgh-jkmn`).
When an account has 2FA on, a correct password makes `POST /api/auth/login` answer
`200 {two_factor_required: true, ticket}` instead of creating a session; the ticket lives 5 minutes in
memory (single process), is single-use and dies after 5 wrong codes (then `401 {code:'TWO_FACTOR_EXPIRED'}`).
`code` may be a TOTP or a recovery code everywhere except `enable` (recovery codes are consumed). Wrong codes
on every code endpoint (`login/2fa`, `enable`, `disable`, `recovery-codes`) and wrong passwords on the 2FA
endpoints count against the same `login-ip` / `login-email` failure budget as wrong passwords (a correct
password alone doesn't reset it), plus a per-account `code-user` budget (20 per 15 min, any IP) → 429.
A wrong password there answers `400 {error, field:'password'}`. A pending setup secret is sealed together
with its issue time and refused after 15 minutes. `/api/auth/me` (and every response built like it:
login, register, PATCH /me) carries `two_factor_enabled` and `recovery_codes_left` for the signed-in user only;
`publicUser()` never includes them. Admin escape hatch: `npm run reset-2fa -- someone@example.com`.

Optional module exports: `search(ctx, familyId, q)` (see above) and `dashboard(ctx, req)` returning a
small object the Wall can show (e.g. calendar returns today's events). The foundation exposes
`GET /api/dashboard` which merges `{ [moduleName]: await dashboard(ctx, req) }`.

## Client conventions

### Module descriptor (`client/src/modules/<name>/index.tsx`)

```tsx
import { ListChecks } from 'lucide-react';
import { lazy } from 'react';
import type { ModuleDef } from '../types';
const mod: ModuleDef = {
  id: 'lists', label: 'Lists', icon: ListChecks, path: '/lists',
  element: lazy(() => import('./ListsPage')),   // may use nested <Routes> inside for /lists/:id
  nav: 'primary',   // 'primary' shows in mobile bottom bar (max 4 + More), 'secondary' shows in "More"
  order: 30,
  accent: '#10b981',// module accent color used for icons/headers
};
export default mod;
```

`registry.tsx` imports all 9 descriptors; the router mounts `path + '/*'`. Feature modules only
edit files inside their own `client/src/modules/<name>/` folder (and their own
`server/src/modules/<name>.js` + `server/test/<name>.test.js`). Never edit shared files; if a
shared component is missing, build a local one inside the module folder.

### Shared client APIs

- `api.get<T>(path)`, `api.post<T>(path, body)`, `api.patch`, `api.put`, `api.del`,
  `api.upload<T>(path, formData)` — paths are relative to `/api` (e.g. `api.get('/lists')`); throw
  `ApiError{status,message}`; 401 redirects to /login.
- TanStack Query: query keys start with the module id: `['lists']`, `['lists', id]`.
- `useLive(prefix, handler?)` — subscribes to SSE; **by default any event whose type starts with
  `<prefix>.` invalidates queries with key `[prefix]`** so data stays live across devices.
- `useAuth()` → `{ user, family, familyId, members, families, role, isAdmin, loading, refresh, switchFamily, logout, expectFamilyExit }` (family is per browser tab).
  `members` are `{id,name,color,avatar_url,role,birthday}`.
- `lib/format.ts` → `fmtDate`, `fmtTime`, `fmtRelative`, `fmtMoney(amount, currency)`, `initials`.
- `ui/` exports (from `ui/index.ts`): `Button` (variants primary/secondary/ghost/danger, sizes sm/md/lg,
  `loading`, `icon`), `IconButton`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Field`
  (label + hint + error wrapper), `Modal` (centered on desktop, bottom sheet on mobile; props
  `open,onClose,title,footer`), `ConfirmDialog` / `useConfirm()`, `Card`, `Avatar`
  (`user`, size xs/sm/md/lg/xl — shows photo or initials on member color), `AvatarStack`,
  `MemberPicker` (multi/single select of family members), `ColorPicker`, `EmptyState`
  (icon, title, description, action), `Spinner`, `Skeleton`, `Tabs`/`SegmentedControl`, `Badge`,
  `Menu` (dropdown actions), `PageHeader` (title, subtitle, actions, accent), `Fab` (mobile floating
  add button), `toast` (`toast.success/error/info`), `ImageUploader` (select + preview + client-side
  resize to max 2000px JPEG before upload), `Lightbox`.
- Styling: Tailwind utility classes with design tokens defined as CSS variables in `src/index.css`
  (`--color-primary` etc., mapped via Tailwind v4 `@theme`). Dark mode via `.dark` class on `<html>`
  (user toggle in settings: system/light/dark). **Always support dark mode** (`dark:` variants or
  token classes like `bg-surface`, `text-muted`).

### Design language

- Warm, friendly and polished — think a premium family app. Primary: indigo `#5B5BD6`; background
  soft warm gray (`#F7F7FB` light / `#0F1117` dark); cards white / `#171A23` with 1px subtle borders,
  `rounded-2xl`, soft shadows; generous spacing; Inter variable font.
- Each family member has a color (palette: `#5B5BD6 #E5484D #F76B15 #FFB224 #30A46C #12A594 #0090FF #8E4EC6 #D6409F #978365`)
  used consistently for avatars, calendar events, assignees, locator pins.
- Mobile-first: everything must be usable at 375px width (bottom nav, sheets, FAB); desktop ≥1024px
  shows a left sidebar and roomier multi-column layouts.
- Micro-interactions: hover/focus states, subtle transitions, optimistic updates for checkboxes,
  skeletons while loading, friendly empty states with an illustration-like icon and a CTA.
- Accessibility: semantic buttons/labels, visible focus rings, `aria-label` on icon buttons,
  color contrast AA.

## Seed data

`npm run seed` creates the "Rivera Family" with 4 members — Alex (admin, alex@hearth.test),
Sam (member, sam@hearth.test), Mia (child, mia@hearth.test), Leo (child, leo@hearth.test) — all with
password `hearth123`. Each module exports an optional `seed(ctx, { familyId, users })` that adds
realistic demo content (events this week, a grocery list, a family chat, recipes, a meal plan,
budget transactions for the last 2 months, places, contacts…). Seeding is idempotent-ish: it
recreates the demo family from scratch. The Riveras live in Austin: the seed stores `America/Chicago`
(`DEMO_TZ`; override with `HEARTH_DEMO_TZ`) as the demo users' zone unless a browser already reported
one, so seeds use `ctx.time.familyTz` / `todayForFamily` for the family's "today", never the server's.

---

## Module author guide (foundation — as built)

Everything below describes the foundation exactly as implemented. You own only
`server/src/modules/<name>.js`, `server/test/<name>.test.js` and `client/src/modules/<name>/`.
Each of those already exists as a working stub — replace the stub contents. No `npm install` is
needed (every package in the stack table is installed; `playwright@1.56.1` is a root devDependency).

### Server

```js
// server/src/modules/lists.js
import { Router } from 'express';
import { ISO_NOW } from '../db.js';                          // "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
import { cleanStr, httpError, toId, isDate, isColor } from '../util.js';

export const name = 'lists';
export const migrations = [
  `CREATE TABLE IF NOT EXISTS lists (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE TABLE IF NOT EXISTS list_items (
     id INTEGER PRIMARY KEY,
     list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
     text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`,
];

export function router(ctx) {
  const r = Router();
  r.get('/', (req, res) => {
    res.json(ctx.db.prepare('SELECT * FROM lists WHERE family_id = ? ORDER BY id').all(req.family.id));
  });
  r.post('/', (req, res) => {
    const title = cleanStr(req.body?.name, { field: 'Name', required: true, max: 120 }); // throws 400
    const { lastInsertRowid } = ctx.db.prepare('INSERT INTO lists (family_id, name, created_by) VALUES (?, ?, ?)')
      .run(req.family.id, title, req.user.id);
    const row = ctx.db.prepare('SELECT * FROM lists WHERE id = ?').get(lastInsertRowid);
    ctx.broadcast(req.family.id, 'lists.created', row);
    ctx.logActivity({ familyId: req.family.id, userId: req.user.id, module: 'lists', verb: 'created',
                      entityId: row.id, summary: `created the list ${title}`, link: `/lists/${row.id}` });
    res.status(201).json(row);
  });
  r.get('/:id', (req, res) => {
    const row = ctx.db.prepare('SELECT * FROM lists WHERE id = ? AND family_id = ?').get(toId(req.params.id), req.family.id);
    if (!row) throw httpError(404, 'List not found');   // Express 5: sync or async throws become JSON errors
    res.json(row);
  });
  return r;
}
```

- **Request context** (set by `requireAuth` + `requireFamily` before your router):
  `req.user = { id, name, email, color, avatar_url, birthday, phone, created_at }` (email is `null`
  for managed members), `req.family` = the full `families` row (`id, name, invite_code, cover_url,
  currency, created_by, created_at`), `req.role` = `'admin' | 'member' | 'child'`.
- **`ctx`** — `{ db, broadcast, sendToUsers, logActivity, notify, upload, publicUser, storeFile,
  removeFile, tx, httpError, uploadDir, hub, auth, rateLimit, failureLimit }`:
  - `broadcast(familyId, type, payload)` — SSE to every member currently viewing that family.
  - `sendToUsers(userIds, type, payload, familyId?)` — SSE to specific users only.
  - `logActivity({ familyId, userId, module, verb, entityId?, summary, link?, createdAt? })` — returns the
    row (with `user`) and broadcasts `'activity'`. `createdAt` (ISO) lets seeds backdate entries.
    The summary is rendered after the actor's name ("Alex **added 3 items to Groceries**").
    Optional `audience: number[]` (user ids) makes the entry private to those members: it is stored
    in `activity.audience` (JSON; `NULL` = whole family), filtered out of `GET /api/activity` and the
    Wall feed for everyone else, and the live `'activity'` event goes only to them (`sendToUsers`).
    Use it for anything that names a private thing (e.g. a group chat's name → its participants).
    Modules that read the `activity` table directly must filter with `activityVisibleSql(alias)`
    from `../activity.js` (binds the viewer's user id), and send follow-up `activity.updated` /
    `activity.removed` events with `emitActivityEvent(ctx.hub, row, type, payload)`.
  - `notify({ familyId, userIds, module, title, body?, link?, excludeUserId? })` — skips non-members
    and `excludeUserId` (pass `req.user.id` so people aren't notified about their own actions). Live
    delivery only reaches the recipients' streams that are viewing that family.
  - `upload` — multer: `r.post('/', ctx.upload.single('file'), handler)` → `req.file.url`
    (`/uploads/<familyId>/<random>.<ext>`), plus `req.file.size/mimetype/originalname`. 25 MB limit,
    any file type (validate `mimetype` yourself; oversize → 413 JSON). `upload.array('files', 20)` works too.
    **Automatic cleanup:** if the response ends with status ≥ 400 (you `res.status(400)`, throw
    `httpError`, or crash), the files multer stored for that request are deleted — no manual cleanup.
  - `storeFile(familyId, buffer, ext)` → URL (for seeds/server-generated files, e.g. SVG placeholder photos).
  - `removeFile(url)` — delete an uploaded file when its row is deleted.
  - `tx(db, () => { ... })` — synchronous transaction wrapper; **re-entrant** (nested calls, or a
    call inside a manual `BEGIN`, use SAVEPOINTs, so an inner failure only rolls back the inner part).
    `publicUser(row)` — strip secrets. (`purge()` from `../purge.js` runs its own transaction and
    throws if called inside `tx()`.)
  - `rateLimit(rule, req => key)` — middleware using a rule from `DEFAULT_LIMITS` in `app.js`.
  - `box` — encryption at rest (AES-256-GCM, one instance key; `secretbox.js`). `box.seal(str)` →
    `'enc:v1:…'` (null stays null, never double-seals), `box.open(v)` (plaintext passes through, so
    legacy rows keep working); `box.sealBuffer(buf)` / `box.openBuffer(buf)` for files;
    `box.isSealed(v)` / `box.isSealedBuffer(buf)`. Seal sensitive columns/files on write and open them
    on read; sealed values can't be searched or sorted in SQL, so keep what listings need plaintext.
    Refuse user input that already looks sealed (it would be *opened* on read). Startup checks the
    key against a canary in `app_meta` and refuses to run with the wrong one. Used by the vault
    (see `modules/vault.js`).
- **Errors**: `throw httpError(status, 'Message')` (or `ctx.httpError`) anywhere in a handler, or
  `res.status(4xx).json({ error })`. Unknown errors → 500 `{ error: 'Something went wrong on our side' }`.
- **Timestamps**: core tables store ISO-8601 UTC (`2026-09-29T07:41:00.123Z`). Use `ISO_NOW` as the
  column default, or `new Date().toISOString()`.
- **Table rules**: every table must either have a `family_id` column **or** a foreign key with
  `ON DELETE CASCADE` to a table that has one. The seed/purge logic relies on this to wipe a family
  cleanly (it deletes by `family_id`, then removes rows whose FK parent vanished).
- **Hooks** (all optional, errors are caught and logged, never break the page):
  - `seed(ctx, { familyId, users, userList })` — `users` = `{ alex, sam, mia, leo }` full users rows
    (use `.id`, `.name`, `.color`); `userList` = the same four in that order. May be async.
  - `search(ctx, familyId, q, req)` → `[{ title, subtitle?, link }]` (≤ 8 used; `module` is added for you;
    `q` is ≥ 2 chars). Match with the `search_match(column, ?)` SQL function (case-insensitive
    contains that also ignores punctuation/spaces, so "wifi" finds "Wi-Fi"; JS twin `searchMatch`
    in `../db.js`) and scope by `familyId`.
  - `dashboard(ctx, req)` → small JSON object; `GET /api/dashboard` returns `{ [module]: value }`.
- **Core SSE event types** (besides your `'<module>.*'` events): `hello` (on connect), `activity`,
  `notification`, `notification.read`, `family.updated`, `family.member.joined`,
  `family.member.left`, `family.removed` (`{family_id, reason: 'removed'|'left'|'deleted'}`),
  `session.ended` (session revoked: logout elsewhere, password change, expiry — the stream closes).
- **Validation helpers** (`../util.js`): `cleanStr` rejects non-strings (400), `isDate` requires a real
  calendar date (`2020-02-31` is invalid), `isColor`, `isEmail`, `toId`.
- **Core API response notes**: `GET /api/search` → `{ q, results: [{ module, title, subtitle, link, avatar? }] }`;
  `GET /api/family` → family fields + `role` + `members[]` (`{ id, name, email, color, avatar_url,
  birthday, phone, role, nickname, joined_at, managed }`); also `GET /api/family/members`.
  `GET /api/activity?before=&limit=&module=` supports a `module` filter.

#### Server tests

```js
// server/test/lists.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });        // temp DB + uploads, random port
after(() => srv.close());

test('lists are family-scoped', async () => {
  const a = await familyFixture(srv, 'A');                  // { admin, member, family } — admin/member have .agent and .user
  const b = await familyFixture(srv, 'B');
  const created = await a.admin.agent.post('/api/lists', { name: 'Groceries' });
  assert.equal(created.status, 201);
  assert.equal((await b.admin.agent.get(`/api/lists/${created.body.id}`)).status, 404);
});
```

Agent methods: `get/post/patch/put(url, body?)`, `del(url, { body }?)` → `{ status, body, headers }`;
`agent.familyId = id` pins the agent like a browser tab (sends `X-Family-Id`), `agent.tab()` returns a
second agent on the same session; rate limits are relaxed in `startServer()` unless you pass `limits`;
`upload(url, { file: PNG_1X1, filename, type, field = 'file', fields })`. `collectEvents(agent, { count | until, timeoutMs })`
resolves once the SSE stream is connected and returns `{ events: Promise<event[]> }`.
`srv.ctx` / `srv.db` give direct access (e.g. to call your `seed`). Run one file:
`node --disable-warning=ExperimentalWarning --test server/test/lists.test.js`.

### Client

Import paths from inside `client/src/modules/<name>/`:

```ts
import { api, qs, errorMessage, ApiError } from '../../lib/api';   // api.del(path, body?) supports a JSON body
import { useAuth, useMember } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { fmtDate, fmtTime, fmtDateTime, fmtDay, fmtRelative, fmtMoney, initials, firstName, plural, toDate, toDateKey, age, fmtBytes } from '../../lib/format';
import type { User, Member, Family, Activity, Notification, LiveEvent } from '../../lib/types';
import { useDebounce, useIsDesktop, useMediaQuery, useDocumentTitle } from '../../lib/hooks';
import { cn } from '../../lib/cn';
import { Button, Card, Modal, toast, useConfirm /* … */ } from '../../ui';
import type { ModuleDef } from '../types';
```

- **Routing**: your page is mounted at `${path}/*`, so nested routes are relative:
  `<Routes><Route index element={<Overview />} /><Route path=":id" element={<Detail />} /></Routes>`
  (import from `react-router`). Link with absolute paths (`/lists/12`).
- **Data**: `useQuery({ queryKey: ['lists'], queryFn: () => api.get<List[]>('/lists') })`; after mutations
  `queryClient.invalidateQueries({ queryKey: ['lists'] })`. `useLive('lists')` keeps every `['lists', …]`
  query fresh when anyone changes data (optional handler: `useLive('lists', (e) => …)`; pass
  `{ invalidate: false }` to handle events yourself). All non-auth queries are reset whenever the tab's
  family changes (switch, removal, deletion), and the SSE stream is re-opened for the new family —
  you never need family ids in query keys. `useAuth().familyId` is this tab's family id; the client
  sends it as `X-Family-Id` automatically. Notification toasts are shown once by the shell.
  A request that fails with `403 NOT_MEMBER` (a family the tab just lost) rejects with
  `ApiError { status: 403, code: 'NOT_MEMBER' }`, but before it lands the AuthProvider has already
  cancelled in-flight queries and moved the tab to another family, so pages don't flash an error.
  `isFamilyLost(err)` (from `lib/api`) detects it; `errorMessage(err)` returns `''` for it and
  `toast.error('')` shows nothing, so the usual `toast.error(errorMessage(e))` pattern stays quiet.
  After leaving/deleting a family yourself call `useAuth().forgetFamily(id)`.
- **Text on member colors**: `import { readableOn } from '../../lib/color'` → `{ bg, fg }` with ≥4.5:1
  contrast (white text on a slightly darkened color, or dark text on light colors like yellow/orange).
  `Avatar`, `ColorPicker` and `MemberPicker` already use it; use it for any filled chip with text.
- **Dates**: API dates `YYYY-MM-DD` are local calendar days — parse with `toDate()`, format a `Date` back with `toDateKey()`.
- **Layout**: pages render inside a padded, max-width `<main>` (`max-w-6xl`). Start each page with
  `<PageHeader title subtitle icon={mod.icon} accent={mod.accent} actions={…} />` (it also sets the tab title).
  For full-height layouts (chat, map) use `className="h-[calc(100dvh-var(--shell-chrome))]"`.
  On mobile, the bottom nav is 64px + safe area; `<Fab>` already sits above it (hidden ≥1024px unless `desktop`).
- **Styling**: token classes work in both themes — `bg-bg`, `bg-surface`, `bg-surface-2/-3`, `text-fg`,
  `text-muted`, `text-subtle`, `border-border`, `border-border-strong`, `text-primary` (text/icons),
  `bg-primary-solid` / `bg-danger-solid` (filled backgrounds under white text — AA in both themes;
  prefer these over `bg-primary`/`bg-danger` for anything with white text),
  `bg-primary-soft text-primary-soft-fg`, `bg-danger|success|warning|info` and their `-soft` / `-soft-fg`
  pairs, `shadow-card|lift|pop`, `ring-ring`, animations `animate-fade-in|scale-in|pop-in`. Tint with a
  module/member color via inline style, e.g.
  `style={{ backgroundColor: \`color-mix(in oklab, ${accent} 14%, transparent)\`, color: accent }}`.
- **Living style guide**: sign in and open **`/ui-kit`** to see every shared component in both themes.

#### `ui/` components (props summary)

| Component | Key props |
|---|---|
| `Button` | `variant` primary\|secondary\|soft\|outline\|ghost\|danger, `size` sm\|md\|lg, `loading`, `icon`/`iconRight` (lucide component or element), `block`; `buttonClass(variant,size)` to style a `<Link>` |
| `IconButton` | `icon`, `label` (required aria-label), `variant` ghost\|secondary\|primary\|danger\|soft, `size`, `badge` (true or number), `loading` |
| `Input` | native props + `icon`, `trailing`, `invalid`, `size` |
| `Textarea` | native props + `autoGrow` |
| `Select` | native props + `options=[{value,label}]`, `placeholder` (or `<option>` children) |
| `Field` | `label`, `hint`, `error`, `required`, `aside` — wraps one control and wires id/aria automatically |
| `Checkbox` | `checked`, `onChange(bool)`, `label`, `description`, `color`, `shape` square\|circle, `size` |
| `Switch` | `checked`, `onChange(bool)`, `label`, `description` |
| `Modal` | `open`, `onClose`, `title`, `description`, `footer`, `size` sm\|md\|lg\|xl, `icon`, `dismissible`, `hideClose`. Bottom sheet < 640px (swipe down to close). For forms: `<form id="x">` in body + `<Button type="submit" form="x">` in footer |
| `useConfirm()` | `const confirm = useConfirm(); if (await confirm({ title, message, confirmLabel, danger })) …` (`ConfirmDialog` for controlled use) |
| `toast` | `toast.success/error/info/warning(msg, { description, action: {label,onClick}, duration })` |
| `Card` / `CardHeader` | `padding` none\|sm\|md\|lg, `interactive` · `title, subtitle, icon, accent, action` |
| `Avatar` / `AvatarStack` | `user` ({name,color,avatar_url}), `size` xs\|sm\|md\|lg\|xl\|2xl, `ring`, `status` · `users`, `max`, `size` |
| `MemberPicker` | `multiple` + `value:number[]` / single `value:number\|null`, `onChange`, `members?`, `filter?`, `showAll`, `allowEmpty`, `size` |
| `ColorPicker` / `PALETTE` | `value`, `onChange`, `colors`, `size` |
| `EmptyState` | `icon`, `title`, `description`, `action`, `accent`, `compact` |
| `Spinner`, `PageSpinner` | `size` |
| `Skeleton`, `SkeletonText`, `SkeletonList`, `SkeletonCard` | size via `className`; `lines` / `rows` |
| `Tabs` | `tabs=[{id,label,icon?,count?}]`, `value`, `onChange`, `accent` |
| `SegmentedControl` | `options=[{value,label,icon?}]`, `value`, `onChange`, `size`, `block` |
| `Badge` | `tone` neutral\|primary\|success\|warning\|danger\|info or `color` (hex), `dot`, `size` |
| `Menu` | `items=[{label, icon, onSelect \| href, danger, disabled, hint} \| 'divider' \| false]`, `trigger?={({open}) => node}`, `label`, `align` |
| `Popover` | `open`, `onClose`, `anchorRef`, `align`, `className` |
| `PageHeader` | `title`, `subtitle`, `icon`, `accent`, `actions`, `back` (path or true), `children` (tabs row) |
| `Fab` | `label`, `onClick`, `icon`, `accent`, `extended`, `desktop` |
| `ImageUploader` | `onSelect(file)` (already resized ≤2000px JPEG; return a promise for a spinner), `value`, `onRemove`, `multiple`, `shape` rect\|circle, `aspect`, `label`, `hint`, `maxSize`, `quality`, or `children` as a custom trigger. Helpers: `resizeImage(file, opts)`, `fileForm(file, fields)` → FormData for `api.upload` |
| `Lightbox` | `images` (strings or `{src, alt, caption}`), `index` (number\|null), `onClose`, `onIndexChange`, `actions?(img, i)`, `download` |

### Running an isolated instance (for Playwright / manual checks)

```bash
npm run build                                           # once, after client changes
PORT=4011 DB_PATH=/tmp/h4011/hearth.db UPLOAD_DIR=/tmp/h4011/up npm run seed
PORT=4011 DB_PATH=/tmp/h4011/hearth.db UPLOAD_DIR=/tmp/h4011/up npm start   # http://localhost:4011
```

Use a unique port + temp paths per agent. Seeding a running instance is fine (WAL mode). Stop the
server with its PID when done (avoid `pkill -f` patterns that also match your own shell).

```js
// /tmp/.../shot.mjs — run with `node shot.mjs` from anywhere
import { chromium } from '/home/user/Claude-Github-Repo/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => localStorage.setItem('hearth-theme', 'dark'));   // 'light' | 'dark' | 'system'
const page = await ctx.newPage();
// Fast login: the API sets the session cookie on the browser context.
await page.request.post('http://localhost:4011/api/auth/login', { data: { email: 'alex@hearth.test', password: 'hearth123' } });
// (or via the UI: fill input[name=email] / input[name=password], click button[type=submit], waitForURL('**/home'))
await page.goto('http://localhost:4011/lists');
await page.screenshot({ path: '/tmp/lists.png' });
await browser.close();
```

Foundation browser regressions: `BASE=http://localhost:4011 npm run e2e` (runs
`scripts/e2e-foundation.mjs` — modal typing, menu focus, per-tab families, join links, rate-limit UI…).

Dev mode alternative: `API_PORT=4011 VITE_PORT=5180 npm run dev -w client` points a Vite dev server
at an already running API.

### Nav badges and cross-module contracts (added before module fan-out)

- `ModuleDef.useBadge?: () => number | undefined` — optional hook; the count is rendered as a red
  badge on the module's sidebar item, bottom-bar icon and More-sheet tile (`layout/NavBadge.tsx`).
  It is called once per rendered nav item, so back it with a shared TanStack query (e.g.
  `useQuery({ queryKey: ['messages', 'unread'], ... }).data?.total`) kept fresh by `useLive`.
  Messages uses it for unread counts; Lists may use it for overdue tasks assigned to me.
  The hook must be side-effect free (no toasts, no writes): the sidebar, bottom bar, More sheet
  and the mobile "More" dot may all call it at once. The badge is `aria-hidden` with visually
  hidden ", N new" text so the link reads "Messages, 3 new".
- Modules are built in parallel and must not import each other's code. Cross-module features go
  through the HTTP API only and must degrade gracefully (hide the feature / friendly message) when
  the other module's endpoint is missing or returns an error:
  - Meals → Lists: `GET /api/lists?type=shopping` returns `[{ id, name, type, ... }]`;
    `POST /api/lists/:id/items/bulk { items: [{ text, quantity?, category? }] }` → `201 { items }`.
  - Wall → others: `GET /api/dashboard` returns `{ calendar?, lists?, meals?, ... }` — each key is
    optional. Keys: `calendar: { today: Event[], upcoming: Event[] }` (Event has `id, title, start,
    end, all_day, color, location`), `lists: { due: Item[], overdue: Item[], lists: [{id,name,type,open_count}] }`
    (Item has `id, list_id, list_name, text, due_date, assignee_id`), `meals: { today: [{ slot, title, recipe_id? }] }`.
  - Wall reads `GET /api/activity` (core) for other modules' entries; each module's `logActivity`
    `link` must point to a route inside that module.

### Time zones — the family's "today" (added during module review)

Servers usually run in UTC, so never compute "today", "overdue" or "due today" with the server's
local date. The client sends its IANA zone as `X-Timezone` on every API call (`lib/api.ts`); the
server validates it and remembers it per user (`users.timezone`). Use `ctx.time`:

- `ctx.time.today(req)` → `'YYYY-MM-DD'` for the requesting user (also `req.today`, `req.tz`).
- `ctx.time.tz(req)` → the requesting user's zone.
- Background jobs (reminders, recurring bills, due notifications): `ctx.time.todayForFamily(familyId)`
  / `ctx.time.familyTz(familyId)` (most common zone among members) or `ctx.time.todayForUser(id)`.
- `ctx.time.dateIn(tz, date?)`, `ctx.time.offsetMinutes(tz, date?)`, `ctx.time.isValidTz(tz)`.
- The core `/api/dashboard` runs module `dashboard(ctx, req)` hooks with the same `req`, so
  `ctx.time.today(req)` is correct there too.

### Hiding the mobile bottom bar

`import { useHideBottomNav } from '../../lib/shell'` — call `useHideBottomNav(active)` in a page
that should be full-screen on phones (e.g. an open chat): the bottom tab bar disappears and
`--shell-chrome` / bottom padding shrink accordingly while `active` is true; restored on unmount.
Only affects < 1024px (the bar is mobile-only). Pass `active` based on a media query if the page
also renders on desktop.

### Upload safety (added during module review)

- `/uploads/...` serves only `.jpg .jpeg .png .gif .webp .avif .pdf .svg` inline (with `nosniff` and a
  sandbox CSP). Every other extension is sent as `application/octet-stream` +
  `Content-Disposition: attachment`, so a disguised HTML/SVG file can never render.
- For image uploads, call `const info = ctx.verifyImage(req.file)` right after multer: it checks the
  real bytes (JPEG/PNG/GIF/WebP/AVIF, 1–30000 px per side, ≤ 80 MP total), renames the file to the detected
  extension (updating `req.file.url`), and throws 400 otherwise (the upload is auto-deleted).
  Use `info.width/info.height` — never trust client-sent dimensions or MIME types.
- `ctx.sniffImage(buffer)` does the same check on an in-memory buffer.

### Suppressing a toast for what's already on screen

`useSuppressNotificationToast((n) => n.link === currentLink)` from `lib/notifyFilter.ts` skips the
live pop-up toast for matching notifications while the component is mounted (the bell still
receives them). Use it for e.g. comments on the photo/post/chat the user is viewing; the page may
also mark such notifications read via `POST /api/notifications/read {ids}`.

### Membership lifecycle hooks

Modules may export `onMemberJoined(ctx, { familyId, userId, reason })` (reason `'joined'` via invite
code or `'added'` by an admin) and `onMemberLeft(ctx, { familyId, userId, reason })` (`'left'` or
`'removed'`). They run synchronously right after the membership row changes (errors are logged, not
thrown). Use them e.g. to record when someone left a conversation, or to delete a departed member's
location data. Not called when a whole family is deleted (its rows cascade).

### Toast placement

`useToastPlacement('top', active?)` from `lib/shell` moves toasts to the top-centre while mounted
(e.g. cook mode, where the main buttons are at the bottom). The toaster container carries
`data-toaster="default|top"`; never restyle it via its utility classes.

### Compression and private activity (added during integration)

- Responses (API JSON, the built client, other text assets ≥ 1 KB) are compressed with br/gzip by
  the `compression` middleware in `app.js`. `/api/stream` (`text/event-stream`) is explicitly
  excluded so SSE stays unbuffered.
- Activity can be private to some members via `logActivity({ ..., audience: [userIds] })` (see
  `ctx` above). Messages uses it for "started the group chat …" (audience = the group's current
  participants, kept in sync when people are added/removed; the entry is deleted with the group).
