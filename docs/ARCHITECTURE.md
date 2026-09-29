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
    index.js            # boot: create app, listen on PORT (default 3000)
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
  vite.config.ts        # proxy /api and /uploads -> http://localhost:${API_PORT||3000}
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
- `npm run dev` — server on :3000 (nodemon) + Vite on :5173 (proxying API).
- `npm run build` — builds client to `client/dist`; `npm start` serves API + `client/dist` on :3000.
- `npm run seed` — creates demo family (see Seed data) in the DB.
- `npm test` — server tests.
- Env vars: `PORT` (3000), `DB_PATH` (`./data/hearth.db`), `UPLOAD_DIR` (`./data/uploads`),
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
GET  /api/auth/me                    -> {user, families:[{id,name,role,...}], active_family_id}
PATCH /api/auth/me {name,color,birthday,phone,password?,current_password?}
POST /api/auth/me/avatar (multipart file) -> {user}
POST /api/families {name}            -> family (creator becomes admin, becomes active)
POST /api/families/join {invite_code} -> family
POST /api/families/:id/activate      -> sets session active_family_id
GET  /api/family                     -> active family + members [{id,name,color,avatar_url,role,birthday,...}]
PATCH /api/family {name,currency}    (admin)
POST /api/family/cover (multipart)   (admin)
POST /api/family/invite-code/rotate  (admin)
PATCH /api/family/members/:userId {role,nickname} (admin)
DELETE /api/family/members/:userId   (admin, or self = leave)
POST /api/family/members {name,email?,role:'child',password?}  (admin: add a child/managed member)
GET  /api/activity?before=<id>&limit=30  -> [{..., user}]
GET  /api/notifications              -> {items, unread}
POST /api/notifications/read {ids?}  (all if omitted)
GET  /api/stream                     -> SSE (event: message, data: {type,payload,at})
GET  /api/search?q=                  -> aggregated results (modules may register a `search(ctx, familyId, q)` export returning [{module,title,subtitle,link}])
```

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
- `useAuth()` → `{ user, family, members, families, role, isAdmin, refresh, switchFamily, logout }`.
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
recreates the demo family from scratch.
