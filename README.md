# Hearth

**Hearth is a private, self-hosted hub for your family** — a warm, modern alternative to apps like
FamilyWall. One place for everything a household shares:

- **Home** — a family wall with the latest news and what's coming up
- **Calendar** — color-coded events and birthdays for everyone
- **Lists** — groceries, to-dos and chores, synced live
- **Messages** — family and group chat
- **Photos** — shared albums
- **Meals** — recipes and a weekly meal plan
- **Budget** — shared spending and expenses
- **Locator** — places and check-ins on a map
- **Contacts & Docs** — important contacts and a document vault

Everything updates in real time across devices (Server-Sent Events), works great on phones
(installable as a PWA, bottom navigation, bottom sheets) and on desktop, and supports light and
dark mode. A single Node process serves the API and the web app; data lives in one SQLite file.

## Quick start

Requirements: **Node 22.5+** (uses the built-in `node:sqlite`). No native dependencies.

```bash
npm install
npm run seed      # optional: creates the demo "Rivera Family"
npm run dev       # API on http://localhost:3000 + web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with a demo account, or create your own account and family.

### Production

```bash
npm install
npm run build     # builds the web app into client/dist
npm start         # serves API + web app on http://localhost:3000
```

Put it behind any reverse proxy with HTTPS (set `COOKIE_SECURE=1` so the session cookie is
marked `Secure`). SSE needs response buffering disabled on the proxy for `/api/stream`
(Hearth already sends `X-Accel-Buffering: no` for nginx).

## Demo logins

After `npm run seed` (password for all: **`hearth123`**):

| Person | Email | Role |
|---|---|---|
| Alex Rivera | `alex@hearth.test` | admin |
| Sam Rivera | `sam@hearth.test` | member |
| Mia Rivera | `mia@hearth.test` | child |
| Leo Rivera | `leo@hearth.test` | child |

The demo family's invite code is `HRTH-2026`. Re-running the seed recreates the demo family from
scratch (other families are left untouched).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (nodemon, port 3000) + Vite dev server (port 5173, proxies `/api` and `/uploads`) |
| `npm run build` | Type-checks and builds the client into `client/dist` |
| `npm start` | Runs the server; serves `client/dist` with SPA fallback when it exists |
| `npm test` | Server API tests (`node --test server/test/*.test.js`) |
| `npm run seed` | Creates/recreates the demo family in the database |
| `npm run typecheck` | `tsc --noEmit -p client` |
| `npm run e2e` | Playwright regression checks against a running seeded instance (`BASE=http://localhost:3000`) |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/hearth.db` | SQLite database file |
| `UPLOAD_DIR` | `./data/uploads` | Uploaded files (served only to family members) |
| `CLIENT_DIST` | `client/dist` | Built web app to serve |
| `COOKIE_SECURE` | unset | `1` to mark the session cookie `Secure` (HTTPS) |
| `HEARTH_RATE_LIMITS` | on | `off` disables login/register/join rate limiting (test instances only) |
| `API_PORT` | `3000` | (dev only) where Vite proxies API calls |

Relative paths resolve against the repository root. Back up by copying the `data/` folder.

## Tech

Node 22 + Express 5 + `node:sqlite`, cookie sessions with scrypt password hashing, SSE for live
updates · React 19 + TypeScript + Vite + Tailwind CSS v4 + TanStack Query + React Router 7 ·
Leaflet maps · Recharts charts.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the architecture, API contract and the
module author guide.
