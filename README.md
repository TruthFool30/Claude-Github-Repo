# Hearth

**Hearth is a private, self-hosted hub for your family** — a warm, modern alternative to apps like
FamilyWall. One place for everything a household shares:

- **Home** — a family wall with the latest news and what's coming up
- **Calendar** — color-coded events and birthdays for everyone
- **Lists** — groceries, to-dos and chores, synced live
- **Messages** — family and group chat
- **Photos** — shared albums
- **Meals** — recipes and a weekly meal plan
- **Budget** — shared spending, monthly bills and savings goals (each goal can top itself up
  automatically every month to hit its target date)
- **Locator** — places and check-ins on a map
- **Contacts & Docs** — important contacts and a document vault

Everything updates in real time across devices (Server-Sent Events), works great on phones
(installable as a PWA, bottom navigation, bottom sheets) and on desktop, and supports light and
dark mode. A single Node process serves the API and the web app; data lives in one SQLite file.

## Quick start

Requirements: **Node 22.13+** (uses the built-in `node:sqlite`, incl. custom SQL functions). No native dependencies.

```bash
npm install
npm run seed      # optional: creates the demo "Rivera Family"
npm run dev       # API on http://localhost:8080 + web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with a demo account, or create your own account and family.

### Production

```bash
npm install
npm run build     # builds the web app into client/dist
npm start         # serves API + web app on http://localhost:8080
```

Put it behind any reverse proxy with HTTPS (set `COOKIE_SECURE=1` so the session cookie is
marked `Secure`). SSE needs response buffering disabled on the proxy for `/api/stream`
(Hearth already sends `X-Accel-Buffering: no` for nginx).

## Docker

```bash
docker compose up -d                 # builds the image and serves http://localhost:8080
# optional: load the demo Rivera family into the volume
docker compose run --rm hearth node --disable-warning=ExperimentalWarning server/src/seed.js
```

Everything Hearth stores (the SQLite database and uploaded files) lives in the `hearth-data`
volume mounted at `/app/data`, so it survives rebuilds and restarts — back that volume up. The
vault's encryption key is generated into that volume too (`/app/data/hearth.key`) unless you set
`HEARTH_ENCRYPTION_KEY` in `docker-compose.yml` — see [Encryption at rest](#encryption-at-rest).
The container runs as the unprivileged `node` user and has a health check on `/api/health`.
Behind an HTTPS reverse proxy set `COOKIE_SECURE=1`, and `TRUST_PROXY` (e.g. `1`) if the proxy is
another container or host, in `docker-compose.yml`.

Without Compose: `docker build -t hearth . && docker run -d -p 8080:8080 -v hearth-data:/app/data hearth`.

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

## Two-factor login

Anyone can turn on two-factor login under **Settings → Two-factor login**: scan the QR code with an
authenticator app (Google Authenticator, 1Password, Authy, …), enter a code, and save the 10 one-time
recovery codes. After that, signing in asks for a code from the app (or a recovery code) after the password.
Turning it on signs out your other devices.

Locked out (lost phone *and* recovery codes)? Whoever runs the server can turn it off for that account:

```bash
npm run reset-2fa -- someone@example.com        # uses the same DB_PATH as the server
# Docker: docker compose exec hearth node --disable-warning=ExperimentalWarning server/src/reset-2fa.js someone@example.com
```

Authenticator secrets are stored encrypted with the instance key (`HEARTH_ENCRYPTION_KEY` or the key
file next to the database); if that key is lost, reset 2FA the same way.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (nodemon, port 8080) + Vite dev server (port 5173, proxies `/api` and `/uploads`) |
| `npm run build` | Type-checks and builds the client into `client/dist` |
| `npm start` | Runs the server; serves `client/dist` with SPA fallback when it exists |
| `npm test` | Server API tests (`node --test server/test/*.test.js`) |
| `npm run seed` | Creates/recreates the demo family in the database |
| `npm run reset-2fa -- <email>` | Turns off two-factor login for one account (lockout escape hatch) |
| `npm run typecheck` | `tsc --noEmit -p client` |
| `npm run e2e` | Playwright regression checks against a running seeded instance (`BASE=http://localhost:8080`) |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/hearth.db` | SQLite database file |
| `UPLOAD_DIR` | `./data/uploads` | Uploaded files (served only to family members) |
| `CLIENT_DIST` | `client/dist` | Built web app to serve |
| `COOKIE_SECURE` | unset | `1` to mark the session cookie `Secure` (HTTPS) |
| `TRUST_PROXY` | `loopback` | Which reverse proxies may set `X-Forwarded-For` (used for rate limiting): `true`, `false`, a hop count like `1`, or a comma list of names/subnets (`loopback, 10.0.0.0/8`) |
| `HEARTH_ENCRYPTION_KEY` | unset | Encryption-at-rest key, 32 bytes as 64 hex chars or base64 (`openssl rand -base64 32`). Unset: a key file is used (see [Encryption at rest](#encryption-at-rest)) |
| `KEY_FILE` | `hearth.key` next to `DB_PATH` | Where the generated key file lives when `HEARTH_ENCRYPTION_KEY` is unset |
| `HEARTH_RATE_LIMITS` | on | `off` disables login/register/join rate limiting (test instances only) |
| `API_PORT` | `8080` | (dev only) where Vite proxies API calls |

Relative paths resolve against the repository root. Back up by copying the `data/` folder
(but read the next section about the key).

## Encryption at rest

The most sensitive data, in **Contacts & Docs**, is encrypted on disk with AES-256-GCM:

- **Encrypted:** every document file in the vault, the free-text notes on documents, and the
  contents (fields, secret or not, and text) of every info card.
- **Not encrypted:** document names and info-card titles/types (listings and search need them),
  contacts, photos, receipts, avatars, messages and everything else in the database.

The key comes from `HEARTH_ENCRYPTION_KEY` if set. Otherwise Hearth creates a random key on first
start in `hearth.key` next to the database (mode 0600; override the location with `KEY_FILE`).
Data from older versions is encrypted automatically on the next start (backups taken before that
still hold it unencrypted). Replaced plaintext files are deleted, but the filesystem frees their old
disk blocks without wiping them, so disk images taken before the upgrade may still contain them. A
vault file Hearth can't rewrite (e.g. wrong permissions) is left unencrypted and logged at startup.

- **Losing the key means losing those files and cards** — there is no recovery. Keep a copy of the
  key somewhere safe (e.g. your password manager).
- Hearth checks the key on every start and refuses to run with the wrong one, or when `hearth.key`
  is missing for a database that already holds encrypted data, rather than creating a new key.
  Restore the original key to fix it.
- For real protection keep the key **out of your backups**: anyone holding a backup that includes
  `hearth.key` can decrypt everything. Set `HEARTH_ENCRYPTION_KEY` from your host's secret store,
  or point `KEY_FILE` at a Docker secret (e.g. `/run/secrets/hearth_key`), or exclude `hearth.key` when backing up
  `data/` and store the key separately. To move an existing install to the env var, set
  `HEARTH_ENCRYPTION_KEY` to the contents of its `hearth.key` (then move the file out of `data/`).

## Tech

Node 22 + Express 5 + `node:sqlite`, cookie sessions with scrypt password hashing, SSE for live
updates · React 19 + TypeScript + Vite + Tailwind CSS v4 + TanStack Query + React Router 7 ·
Leaflet maps · Recharts charts.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the architecture, API contract and the
module author guide.
