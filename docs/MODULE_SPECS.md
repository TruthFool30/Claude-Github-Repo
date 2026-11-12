# Hearth — module specifications (acceptance criteria)

Each module must feel like a polished FamilyWall-class feature: complete CRUD, live updates across
devices (SSE), responsive mobile + desktop, dark mode, empty/loading/error states, realistic seed data,
server tests, and Wall activity entries for meaningful actions.

## wall — "Home"
- Dashboard at `/home`: greeting with the user's name + date, "Today" card (today's events from
  `/api/dashboard` calendar key), "Tasks due" card (lists key), upcoming birthdays (from members),
  meal of the day (meals key), quick actions (new post, event, list item, photo).
- Family feed: posts (text + up to 10 photos, optional), mixed with activity entries from other modules
  (`/api/activity`), infinite scroll / "load more". Reactions (❤️ 👍 😂 🎉 😮) with counts + who reacted,
  threaded comments, edit/delete own post (admins can delete any), pinned posts at top.
- Composer with photo attach (ImageUploader), mood/emoji, live updates when others post.
- Server: `wall_posts`, `wall_post_photos`, `wall_reactions`, `wall_comments`; `dashboard` export not
  required (wall consumes others). Notify post author on comment/reaction.

## calendar
- Views: Month (grid with colored event chips, "+N more"), Week (time grid with all-day row, overlapping
  events side-by-side, current-time line), Day, Agenda (list grouped by day). Toolbar: today/prev/next,
  view switch, member filter (show/hide by member color).
- Events: title, all-day or start/end datetime, location, notes, color (defaults to creator's color),
  attendees (members), recurrence (none/daily/weekly (choose weekdays)/monthly/yearly, interval, until or
  count) with occurrences expanded server-side for a requested range (`GET /api/calendar/events?from&to`),
  edit/delete "this occurrence" vs "all" (exceptions table), reminders (minutes before → in-app
  notification via `notify`, a lightweight interval checker on the server).
- Birthdays of members shown automatically as all-day yearly events. Click an empty slot/day to create.
- `dashboard` export: today's + next 7 days' events. `search` export. Seed: realistic week (school
  run, soccer practice, dentist, date night, recurring piano lessons, family dinner).

## lists (lists & tasks)
- Multiple lists with type: `shopping`, `todo`, `other`; icon/emoji + color; list overview grid with
  progress (x/y done). Items: text, quantity/notes, category (shopping: auto-grouped by aisle categories
  like Produce, Dairy, Bakery, Meat, Pantry, Frozen, Household, Other — auto-guess from name with a
  keyword map), assignee (member), due date, done by/at. Fast add bar (Enter adds, keeps focus),
  optimistic check/uncheck with satisfying animation, drag-to-reorder (or up/down), clear completed,
  show/hide completed, rename/delete list.
- "My tasks" view: all undone todo items assigned to me across lists, grouped Overdue/Today/Upcoming.
- Endpoint for other modules: `POST /api/lists/:id/items/bulk {items:[{text,quantity,category}]}` and
  `GET /api/lists?type=shopping` (meals uses this to push ingredients).
- `dashboard` export: tasks due today/overdue for the user + count per list. `search`. Seed: Groceries,
  Weekend chores (assigned to kids), Packing list.

## messages
- Conversations: an auto-created "Family" group (all members), direct messages between any two members,
  custom groups (name + members). Sidebar list with last message preview, time, unread badge; chat pane
  with grouped bubbles (own on right in primary color), avatars, day separators, image attachments
  (lightbox), emoji reactions on messages, reply-to, delete own message, typing indicator (SSE), read
  receipts ("Seen by"), unread counts in nav (a `GET /api/messages/unread` total). Real-time via SSE —
  only deliver to conversation participants. Mobile: list → chat stacked navigation with back button.
- Paginated history (load older on scroll up). `search` export. Seed: lively family chat.

## photos
- Albums grid (cover, title, count, date), "All photos" timeline grouped by month, album detail with
  masonry/justified grid, multi-upload with progress (client-side resize), captions, set album cover,
  move/remove photos, delete album, lightbox with caption, uploader, date, comments & likes, download.
- Shared by the whole family; activity entries "added 5 photos to Beach Trip". Seed: 2–3 albums using
  generated placeholder images (e.g. create simple gradient/SVG-rendered JPEG/PNG files at seed time; no
  network downloads).

## meals
- Recipe box: recipes with photo, title, description, servings, prep/cook time, tags, ingredients (with
  quantity/unit/name), steps; search/filter by tag; favorite. Recipe detail page with nice layout and a
  "cook mode" (large steps, checkable ingredients).
- Weekly meal planner: 7-day grid × (breakfast, lunch, dinner, snack); assign a recipe or free text;
  navigate weeks; copy last week; "Add week's ingredients to shopping list" → choose a shopping list
  (from lists module API/table) and bulk-add aggregated ingredients.
- `dashboard` export: today's meals. Seed: ~8 recipes + this week's plan.

## budget
- Transactions (expense/income): amount, category, description, date, paid by (member), optional receipt
  photo; categories with icon/color (defaults: Groceries, Housing, Utilities, Transport, Kids, Health,
  Dining, Entertainment, Shopping, Savings, Other; custom allowed).
- Monthly view: totals (income, spent, balance), per-category budget limits with progress bars (over
  budget in red), donut chart by category, 6-month trend bar chart (recharts), transaction list with
  filters (category, member, search) and month navigation. Recurring monthly bills (template that
  auto-generates each month, or "mark paid"). Currency from family settings (`fmtMoney`).
- Kids' allowance / savings goals (goal name, target, saved, progress). Seed: 2 months of data.
- Automatic monthly contributions (opt-in per goal, needs a target date; whoever can edit the goal can
  toggle it). Goal API fields: `auto_monthly` (bool, accepted on POST/PATCH `/api/budget/goals`; 400
  without a target date) and read-only `auto_last_month` (`YYYY-MM`, the latest month already handled,
  returned whether or not the option is on). Amount: `ceil(left_cents / months)` where `months` counts
  the current month through the target date's month inclusive — the last month pays everything left,
  never more; a target date earlier in the current month still counts, so everything left is added
  then. Nothing after the target month (the UI shows "Past its date").
  Once per goal per month (`budget_goal_runs`, PK `(goal_id, month)`): on the 1st in the family's time
  zone (first 10-minute sweep after midnight) every auto goal whose target month hasn't passed claims
  the month — reached goals and zero amounts too — and only goals still short of their target get an
  entry (`source: 'auto'`, note "Monthly contribution · Oct 2026"). So a deleted automatic entry
  isn't re-created, and a reached goal that dips below target mid-month waits for the next 1st. Past
  months are not backfilled. Creating a goal with the option on, or switching it on, handles the
  current month right away (if not claimed yet) and is logged like a normal deposit by that person.
  Reaching the target this way fires the usual "goal reached" activity + notification. Each sweep that
  adds money sends one summary ("Saved $350.00 automatically: …", verb `auto_saved`, no actor) to
  adults plus the owners of the goals in it, as a notification and an audience-limited Wall entry.
  Not done: counting contributions as spending; yearly refilling goals.
- **Bank statement import** (grown-ups only; parsing/categorising in `budget/import.js`). Supported:
  DBS/POSB and UOB account statements as PDF e-statements (incl. password-protected), CSV exports and
  Excel `.xlsx`; legacy `.xls` (BIFF) → `UNSUPPORTED` "export CSV instead" (no safe maintained reader —
  the npm `xlsx` package has unfixed CVEs on untrusted files). Credit-card statements aren't supported.
  Layout sources: DBS iBanking CSV ("Account Details For:" preamble, `Transaction Date, Reference,
  Debit Amount, Credit Amount, Transaction Ref1–3`; github.com/adib/BankConverter, benjaminheng/bankparse),
  UOB account-history export (`Transaction Date | Transaction Description | Withdrawal | Deposit |
  Available Balance`, "Statement Period"; gist xaethos/93a2b6539cc340a69f28), PDF tables per the
  open-source parser github.com/benjamin-awd/monopoly (DBS consolidated: "Details as at", "Account No.",
  `Date Description Withdrawal (-) Deposit (+) Balance`, "Balance Brought/Carried Forward", dd/mm/yyyy;
  UOB: "Period: … to …", `Withdrawals Deposits Balance`, "BALANCE B/F", "01 Nov" dates). Bank is detected
  from the text before the table (UOB / United Overseas Bank, POSB, DBS); anything else → `UNSUPPORTED`.
  Synthetic fixtures for every bank × format: `server/test/fixtures/statements/` (`node …/index.js` rewrites them).
  - Limits: 10 MB, 5000 rows, 60 PDF pages (20 000 text items each), 40 MB unzipped. Parsing runs in a
    short-lived child process (no environment, output dropped) capped at 320 MB resident memory (PDF
    decompression bombs: pdf.js inflates outside V8's heap) with a 256 MB heap, parsing on a worker thread
    inside it; 20 s. ≤ 2 parses at once, ≤ 4 waiting, one per person: more → `429 { code: 'BUSY' }`.
    30 previews per person per 10 min (`import-user` rate limit). xlsx XML is scanned with indexOf (linear
    on broken XML). pdf.js's native `@napi-rs/canvas` is never loaded (blocked in the parser; removed from
    the Docker image). Errors: `400 { error, code }`, code `UNSUPPORTED | PASSWORD_REQUIRED | BAD_PASSWORD
    | EMPTY | TOO_LARGE` (timeouts/zip bombs/out of memory → `TOO_LARGE`).
  - Masking (imports, manual transactions on POST/PATCH, bill names): NFKC, format characters (zero-width
    space, soft hyphen) dropped, every Unicode digit as 0–9, whitespace collapsed; NRIC/FIN (`S1234567A`,
    `s 1234567 a`, `S1234567`) → `•••••••••`; ≥ 8 digits with up to 3 separator characters (space . , - / _ *
    dashes) between digits → `••` + last 4 (a trailing `.00` is not part of the number). Inside such a run,
    space-separated amounts (`1,234.56`, `12.30`) and dates (`01/11/2026`, `2026-11-01`) are kept unless they
    follow ≥ 4 digits of the number (`4111 1111 1111 1111.00` → `••1111`). The holder's name — from a "Name:"
    header line, or the unlabelled first line of the PDF address block (all capitals, then an address line
    with a number) — becomes "(you)", its words in any order.
  - `POST /api/budget/imports/preview` (multipart `file`, `password?`) → the contract's preview (token,
    bank, format, account `{label,last4}|null`, currency `SGD`, period, opening/closing balance, rows with
    `row_id, date, description, merchant, amount, kind, balance, category_id, category_source
    ('rule'|'learned'|'none'), duplicate, recurring_group`, `recurring` suggestions, `summary` (income /
    spending over the non-duplicate rows), `warnings`). Kept in memory for 15 min (≤ 3 per person).
  - `POST /api/budget/imports/:token/commit { visibility: 'adults'|'private', rows: [{row_id, category_id?,
    include?}], bills: [{group, description?, amount?, day_of_month?, category_id?}] }` → `201 { import,
    created, skipped_duplicates, excluded, bills_created }`. Duplicates are re-checked at commit and
    skipped unless that row says `include: true`; `excluded` counts other rows with `include: false`. Unknown
    / expired / someone else's token → `410 { code: 'EXPIRED' }`; nothing left to import → `400 { code: 'EMPTY' }`.
    Bills are manual (not auto-created) bills with the import's visibility, starting the month of the
    latest payment, which is linked as that month's payment; suggestions matching an existing bill
    (`existing_bill_id`) are skipped.
  - `GET /api/budget/imports` → ImportOut[]; `DELETE /api/budget/imports/:id` → `{ ok, removed }` (soft-deletes
    its transactions — restoring one alone → 409 — removes its Wall entry; bills stay).
  - Duplicates: same account last-4 + date + amount + kind + merchant key as an earlier import; manual
    rows (e.g. a bill marked paid by hand): same kind + amount within ±4 days and the same merchant (or
    the bill the row pays; keys match when equal, sharing a first word, or one contained in the other),
    each manual row absorbing one line — among rows the importer can see; within one file, an identical
    line unless the running balances differ.
  - Transfers: rows have `transfer` (preview + commit rows + POST/PATCH /transactions, boolean; txOut
    `transfer`). Pre-flagged for "TO/FROM OWN …", "OWN ACCOUNT" lines and for the opposite amount in another of
    the importer's imported accounts within ±3 days when either side has a transfer-like word (TRANSFER, TRF,
    FAST, PAYNOW, IBG, GIRO … TO/FROM OWN, OWN ACCOUNT, TO/FROM A/C). Such preview rows carry `pair:
    { account_label, date, amount, description }` — the existing row that is ALSO marked a transfer on commit;
    `amount` is that row's signed amount (income positive, expense negative). Commit rows accept `pair: false`
    to leave it alone; the import that flagged it is remembered (`transfer_by_import`) and undo clears it.
    Fixtures: `dbs-pair.csv` (DBS ••4821, −1,500.00 "FUNDS TRANSFER TO UOB A/C" on 10 Oct) then
    `uob-pair.csv` (UOB ••7890, +1,500.00 "FUNDS TRANSFER FROM DBS" on 11 Oct). Transfers stay listed but count in
    no income/spending total (summary, charts, category totals/limits, dashboard, insights, import totals,
    preview summary) and aren't bill/recurring candidates.
  - Dates `a/b/yyyy`: month-first when any second part > 12, else day-first; all ≤ 12 → day-first plus a
    warning when rows then fall outside the statement's dates (or > 2 months before its end date).
    Balance-only lines (BALANCE B/F, opening/closing balance) are skipped without a warning.
  - Bills: commit marks existing bills paid by the statement line that pays them (the recurring group's
    `existing_bill_id`, else same merchant + amount ±10% + due day ±5) when that month isn't paid/skipped
    yet; a private import never pays a shared bill. New bills from suggestions start the month after their
    latest payment, with every payment seen linked as a paid month. Undo removes paid months pointing at the
    import's rows (the bills stay). Bill status `expected` (bills from an import): a month whose due date is
    after the latest statement of that account, until 5 days after the due date — never `overdue` meanwhile.
  - txOut `merchant`: clean merchant name for imported rows (FOREIGN/AMT/currency codes and amounts dropped),
    null for manual rows.
  - Learned rules carry the import's visibility: from an 'adults' import all grown-ups' previews use it,
    from a 'private' one only the importer's (whose private rule wins over a shared one). Undoing an import
    deletes the rules it last set; someone leaving takes their private rules.
  - Visibility changes: only the creator may widen a row's visibility, and only the importer may change an
    imported row's at all (managers may still narrow manual rows to 'adults'). Other grown-ups may re-file an
    imported row (category, amount, date, paid by, notes) but not change its description or transfer flag (403).
  - Bill links: a transaction pays a bill only when everyone who can see the row can see the bill — a
    private row only its owner's private bill and vice versa; an adults row may pay an adults or family bill
    (others then see the month paid with `transaction_id`/`paid_amount`/`paid_date` null). An import links
    only the importer's own rows (recurring history is built from them alone; transfer pairing too), and its
    paid months remember it (`budget_recurring_runs.import_id`): undo removes them and unlinks every row it
    linked. Taking back a month's payment (skip / undo paid) unlinks an imported row instead of deleting it.
    txOut `recurring_id` is null when the viewer can't see that bill, `?recurring_id=` 404s for such a bill,
    and duplicate detection only uses bill names the importer can see.
  - Encryption at rest also covers adults-only/private manual rows (description, notes) and bills made from
    an import (description, notes); legacy rows are sealed at startup (`sealLegacyBudget`). Their Wall line
    and bill reminders leave the name out. Budget turns on `PRAGMA secure_delete` (connection-wide) and
    truncates the WAL after member removal, purges and the legacy sealing.
  - The parser child runs under Node's permission model: `--permission`, read access only to
    `server/src/modules/budget`, `server/package.json` and `pdfjs-dist`, `--allow-worker` for its one parsing
    thread; no writes, child processes or addons.
  - Categories: learned per family (`budget_merchant_rules`, merchant key sealed) beat built-in Singapore
    rules mapped onto existing categories by name (NTUC/FairPrice/Cold Storage/Sheng Siong/Giant →
    Groceries; Grab/Gojek/ComfortDelGro/SimplyGo/TransitLink/EZ-Link/BUS/MRT/fuel → Transport; Singtel/
    StarHub/M1/SP → Utilities; Shopee/Lazada/Amazon → Shopping; Netflix/Spotify/Disney → Entertainment;
    AIA/Prudential/Great Eastern/NTUC Income → Insurance, else Health; GrabFood/Foodpanda/… → Dining;
    clinics/pharmacies → Health; HDB/town council → Housing; IRAS → Taxes, else Other; CPF/SRS → Savings;
    salary/payroll → Salary; interest → Side income; refunds → Gifts & refunds). No categories are added.
    The commit learns every choice that differs from the built-in rule.
  - Recurring: same kind + merchant key paid the same number of times every month (else everyday
    spending), grouped by amount (10% steps); one a month → amount within 10% of the latest, ≥ 2
    consecutive months (one gap allowed), day of month within ±7; 2–3 a month (two Singtel plans) → split by
    size into series within 2% and ±3 days. Over the statement plus 7 earlier months of visible transactions.
  - Transactions gain `visibility` ('family'|'adults'|'private'; existing rows 'family'), `import_id`,
    `import_label` ("DBS ••4821"), `balance`. `POST`/`PATCH /transactions` accept `visibility` (grown-ups
    only; only the creator may make a row private); a change moves its Wall entry to the new audience.
    `GET /transactions?import_id=` filters one import. Search (list `q` and global search) also matches
    sealed descriptions (decrypted in JS, latest 5000 imported rows).
  - Every budget read path filters by visibility (lists, single rows, summary, charts, category totals,
    dashboard, search, bills, badge, insights, live events, activity, bill reminders); over-budget alerts
    count only non-private spending.
- **Insights** `GET /api/budget/insights?months=3` (1–12, grown-ups): the contract's shape, from every
  transaction the requester can see. `months[]` = the last N full months + the current one with
  `partial: true`; averages over the full months that have any transaction (`full_months` says how many);
  `today` (the family-local date used); categories (expense) with `avg`, `avg_to_date` (what earlier full
  months had spent by today's day of the month — cumulative, so a mortgage on the 1st is usual all month),
  `this_month`, `change_pct` (this month vs `avg_to_date`); top 8 merchants over the window; spikes = this
  month ≥ 1.3 × and ≥ 50 (currency units) above `usual_by_now` (= `avg_to_date`, included in each spike); recurring = active visible expense bills; balances = latest
  closing balance per imported account with `statement_to` (newest import's period end) and `stale` (that
  newest import had no closing balance, so an older one's is shown); goals: `needed_monthly` = Σ `autoAmount`
  of active dated goals whose target month hasn't passed (an auto goal already paid this month counts from
  next month), `overdue` = `[{id, name, emoji, target_date, left}]` for those whose target date has passed,
  status `on_track | short | no_data`, `shortfall`, `suggestions` = alternatives, best first, each a complete
  sentence (push the biggest goal's date — closes the gap; or trim one non-essential category by ≤ 25%,
  worded like spikes: "Dining: $344.90 so far — usually $213.28 by now (+62%). Spending $X less on Dining each
  month would …" — never a percentage against a full month),
  `remaining_gap` = what's still short after the best one (0 when on track).

## locator
- Map (react-leaflet, OSM tiles) with member pins (avatar in member color) at their last shared
  location + "updated 5 min ago"; member list sidebar with address-less coordinates / place name when
  inside a saved place, battery N/A. "Share my location" uses browser geolocation (one-shot "Check in"
  and optional continuous sharing while the app is open), with explicit privacy toggle per user
  (pause sharing).
- Places: name, icon, lat/lng, radius (Home, School, Work…) drawn as circles; create by clicking the map.
  When a check-in enters/leaves a place, log history + notify family ("Mia arrived at School").
- Location history timeline per member (last 7 days). Graceful fallback when tiles can't load (offline):
  show list view. Seed: places + recent check-ins around a city.

## vault — "Contacts & Docs"
- Contacts: shared family address book (doctor, school, babysitter, plumber…) with name, category,
  phones, email, address, notes, favorite; search; tap-to-call/mail links; category filter chips;
  quick "Emergency" section pinned at top.
- Documents: folders + files (upload any file, 25 MB), preview images/PDF inline, download, rename,
  move, delete; mark as "private to me" vs family-shared; important info notes (e.g. Wi-Fi password,
  insurance numbers) as secure-ish note cards (hidden until tapped).
- `search` export. Seed: ~10 contacts, a few folders and notes.
