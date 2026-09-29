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
