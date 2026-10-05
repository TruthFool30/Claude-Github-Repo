// Locator — family member locations, saved places (geofences) and check-in history.
// Mounted at /api/locator. Contract: docs/ARCHITECTURE.md; acceptance criteria: docs/MODULE_SPECS.md.
//
// Model
//   locator_places    saved places (Home, School…) drawn as circles; a check-in inside one "is at" it
//   locator_checkins  location reports: one-shot "Check in" (source 'checkin') or continuous sharing
//                     ('live'; repeated reports from the same spot are merged into one row)
//   locator_events    arrivals/departures detected when consecutive check-ins change place
//   locator_settings  per member + family privacy switch (pause sharing)
//
// Privacy: while a member has paused sharing, nobody else sees their location or history, and they
// cannot report new positions. History older than RETENTION_DAYS is pruned; members can delete
// single check-ins or clear their whole history.
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { cleanStr, firstName, httpError, isColor, toId } from '../util.js';
import { distanceMeters, nearestPlace, placeFor } from './locator/geo.js';

export const name = 'locator';

export const PLACE_ICONS = ['home', 'school', 'work', 'sport', 'shop', 'park', 'gym', 'health', 'food', 'heart', 'star', 'pin'];
const ICON_COLORS = {
  home: '#5B5BD6', school: '#FFB224', work: '#0090FF', sport: '#30A46C', shop: '#F76B15', park: '#12A594',
  gym: '#E5484D', health: '#D6409F', food: '#978365', heart: '#D6409F', star: '#8E4EC6', pin: '#E5484D',
};
export const HISTORY_DAYS = 7;
export const RETENTION_DAYS = 30;
const MAX_PLACES = 100;
/** A live report within this distance/time of the previous live report at the same place is merged. */
const MERGE_METERS = 30;
const MERGE_MS = 10 * 60 * 1000;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS locator_places (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     icon TEXT NOT NULL DEFAULT 'pin',
     color TEXT NOT NULL DEFAULT '#E5484D',
     lat REAL NOT NULL,
     lng REAL NOT NULL,
     radius INTEGER NOT NULL DEFAULT 150,
     address TEXT,
     notify INTEGER NOT NULL DEFAULT 1,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_locator_places_family ON locator_places(family_id)`,
  `CREATE TABLE IF NOT EXISTS locator_checkins (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     lat REAL NOT NULL,
     lng REAL NOT NULL,
     accuracy REAL,
     place_id INTEGER REFERENCES locator_places(id) ON DELETE SET NULL,
     source TEXT NOT NULL DEFAULT 'checkin' CHECK (source IN ('checkin', 'live')),
     note TEXT,
     battery INTEGER,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_locator_checkins_user ON locator_checkins(family_id, user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS locator_events (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     place_id INTEGER REFERENCES locator_places(id) ON DELETE SET NULL,
     place_name TEXT NOT NULL,
     place_icon TEXT NOT NULL DEFAULT 'pin',
     kind TEXT NOT NULL CHECK (kind IN ('arrived', 'left')),
     checkin_id INTEGER REFERENCES locator_checkins(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_locator_events_family ON locator_events(family_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS locator_settings (
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     sharing INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (family_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS idx_locator_events_checkin ON locator_events(checkin_id)`,
];

// ---------------------------------------------------------------------------------------------
// helpers

function num(value, field, { min, max, required = false, integer = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
  if (integer && !Number.isInteger(n)) throw httpError(400, `${field} must be a whole number`);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) throw httpError(400, `${field} must be between ${min} and ${max}`);
  return n;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function placeRow(p) {
  if (!p) return null;
  return { ...p, notify: !!p.notify };
}

function listPlaces(db, familyId) {
  return db.prepare('SELECT * FROM locator_places WHERE family_id = ? ORDER BY name COLLATE NOCASE, id').all(familyId).map(placeRow);
}

function getPlace(db, familyId, id) {
  const row = db.prepare('SELECT * FROM locator_places WHERE id = ? AND family_id = ?').get(id, familyId);
  if (!row) throw httpError(404, 'Place not found');
  return placeRow(row);
}

function members(db, familyId) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.color, u.avatar_url, m.role, m.nickname
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = ? ORDER BY m.created_at, u.id`,
    )
    .all(familyId);
}

function isMember(db, familyId, userId) {
  return !!db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?').get(familyId, userId);
}

function sharingOf(db, familyId, userId) {
  const row = db.prepare('SELECT sharing, updated_at FROM locator_settings WHERE family_id = ? AND user_id = ?').get(familyId, userId);
  return { sharing: row ? !!row.sharing : true, changed_at: row?.updated_at ?? null };
}

function lastCheckin(db, familyId, userId) {
  return db
    .prepare('SELECT * FROM locator_checkins WHERE family_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(familyId, userId);
}

/**
 * Remove a member's location traces from core tables: Wall activity (check-ins/arrivals) and the
 * arrival notifications other members got. `checkinId` limits it to one check-in.
 * Broadcasts `activity.removed` / `notification.removed` so open Walls and bells refresh.
 */
export function scrubTraces(ctx, familyId, userId, checkinId = null) {
  const { db } = ctx;
  const acts = db
    .prepare(
      `SELECT id FROM activity WHERE family_id = ? AND user_id = ? AND module = 'locator' AND verb IN ('checked_in', 'arrived')
         ${checkinId ? 'AND entity_id = ?' : ''}`,
    )
    .all(...[familyId, userId, ...(checkinId ? [checkinId] : [])]);
  const base = `/locator/member/${userId}`;
  const notes = db
    .prepare(`SELECT id, user_id FROM notifications WHERE family_id = ? AND module = 'locator' AND ${checkinId ? 'link = ?' : '(link = ? OR link LIKE ?)'}`)
    .all(...(checkinId ? [familyId, `${base}?c=${checkinId}`] : [familyId, base, `${base}?c=%`]));
  if (acts.length) db.prepare(`DELETE FROM activity WHERE id IN (${acts.map((a) => Number(a.id)).join(',')})`).run();
  for (const a of acts) ctx.broadcast(familyId, 'activity.removed', { id: a.id });
  ctx.removeNotifications(familyId, notes);
  return { activity: acts.length, notifications: notes.length };
}

/** Drop location data of people who are no longer in the family, and anything past retention. */
function cleanupFamily(db, familyId) {
  const notMember = 'user_id NOT IN (SELECT user_id FROM memberships WHERE family_id = ?)';
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
  db.prepare(`DELETE FROM locator_checkins WHERE family_id = ? AND (${notMember} OR updated_at < ?)`).run(familyId, familyId, cutoff);
  db.prepare(`DELETE FROM locator_events WHERE family_id = ? AND (${notMember} OR created_at < ?)`).run(familyId, familyId, cutoff);
  db.prepare(`DELETE FROM locator_settings WHERE family_id = ? AND ${notMember}`).run(familyId, familyId);
}

const placeBrief = (p) => (p ? { id: p.id, name: p.name, icon: p.icon, color: p.color } : null);

/** Public shape of a member's last location (current place computed against today's places). */
function locationOf(db, familyId, userId, places) {
  const c = lastCheckin(db, familyId, userId);
  if (!c) return null;
  const place = placeFor(places, c.lat, c.lng, c.place_id);
  let since = null;
  if (place) {
    since = db
      .prepare(
        `SELECT created_at FROM locator_events
          WHERE family_id = ? AND user_id = ? AND place_id = ? AND kind = 'arrived'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(familyId, userId, place.id)?.created_at ?? null;
    // Only trust the arrival if nothing moved them elsewhere afterwards.
    if (since) {
      const leftAfter = db
        .prepare(`SELECT 1 FROM locator_events WHERE family_id = ? AND user_id = ? AND place_id = ? AND kind = 'left' AND created_at > ?`)
        .get(familyId, userId, place.id, since);
      if (leftAfter) since = null;
    }
  }
  const near = place ? null : nearestPlace(places, c.lat, c.lng);
  return {
    checkin_id: c.id,
    lat: c.lat,
    lng: c.lng,
    accuracy: c.accuracy,
    source: c.source,
    note: c.note,
    battery: c.battery,
    created_at: c.created_at,
    updated_at: c.updated_at,
    place: placeBrief(place),
    since,
    nearest: near ? { ...placeBrief(near.place), meters: Math.round(near.meters) } : null,
  };
}

function memberView(db, familyId, m, places, viewerId) {
  const s = sharingOf(db, familyId, m.id);
  const visible = s.sharing || m.id === viewerId;
  return {
    id: m.id,
    name: m.name,
    color: m.color,
    avatar_url: m.avatar_url,
    role: m.role,
    sharing: s.sharing,
    sharing_changed_at: s.changed_at,
    location: visible ? locationOf(db, familyId, m.id, places) : null,
  };
}

/** Recent arrivals/departures (hides members who paused sharing, except the viewer). */
function recentEvents(db, familyId, viewerId, { hours = 48, limit = 20 } = {}) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const rows = db
    .prepare(
      `SELECT e.*, u.name AS user_name, u.color AS user_color, u.avatar_url AS user_avatar_url
         FROM locator_events e
         JOIN memberships m ON m.family_id = e.family_id AND m.user_id = e.user_id
         JOIN users u ON u.id = e.user_id
         LEFT JOIN locator_settings s ON s.family_id = e.family_id AND s.user_id = e.user_id
        WHERE e.family_id = ? AND e.created_at >= ? AND (COALESCE(s.sharing, 1) = 1 OR e.user_id = ?)
        ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .all(familyId, since, viewerId, limit);
  return rows.map(eventRow);
}

function eventRow(e) {
  const { user_name, user_color, user_avatar_url, ...rest } = e;
  return user_name !== undefined ? { ...rest, user: { id: e.user_id, name: user_name, color: user_color, avatar_url: user_avatar_url } } : rest;
}

/**
 * Group consecutive check-ins into visits: same saved place, or (outside places) within 150 m of
 * the visit's first point. Input and output are chronological.
 */
export function buildVisits(checkins, placesById) {
  const visits = [];
  for (const c of checkins) {
    const last = visits[visits.length - 1];
    const same = last && (c.place_id
      ? last.place_id === c.place_id
      : !last.place_id && distanceMeters(last.lat, last.lng, c.lat, c.lng) <= 150);
    if (same) {
      last.end = c.updated_at > last.end ? c.updated_at : last.end;
      last.points += 1;
      last.checkin_ids.push(c.id);
      if (c.note && !last.note) last.note = c.note;
      if (c.source === 'checkin') last.checked_in = true;
    } else {
      const p = c.place_id ? placesById.get(c.place_id) : null;
      visits.push({
        place_id: p ? p.id : null,
        place: placeBrief(p),
        lat: c.lat,
        lng: c.lng,
        start: c.created_at,
        end: c.updated_at,
        points: 1,
        checkin_ids: [c.id],
        note: c.note ?? null,
        checked_in: c.source === 'checkin',
      });
    }
  }
  return visits;
}

/**
 * Record a location report and detect place transitions. Shared by the route and the seed.
 * Returns { checkin, transitions, merged }.
 */
export function recordCheckin(ctx, {
  familyId, user, lat, lng, accuracy = null, source = 'checkin', note = null, battery = null,
  createdAt = null, silent = false, activity = !silent,
}) {
  const { db } = ctx;
  const at = createdAt ?? new Date().toISOString();
  const places = listPlaces(db, familyId);
  const prev = lastCheckin(db, familyId, user.id);
  const prevPlaceId = prev?.place_id && places.some((p) => p.id === prev.place_id) ? prev.place_id : null;
  const place = placeFor(places, lat, lng, prevPlaceId);
  const placeId = place ? place.id : null;

  return ctx.tx(db, () => {
    // Continuous sharing from the same spot: refresh the previous row instead of adding another.
    if (
      source === 'live' && prev && prev.source === 'live' && (prev.place_id ?? null) === placeId &&
      distanceMeters(prev.lat, prev.lng, lat, lng) <= MERGE_METERS &&
      Date.parse(at) - Date.parse(prev.updated_at) <= MERGE_MS && Date.parse(at) >= Date.parse(prev.updated_at)
    ) {
      db.prepare('UPDATE locator_checkins SET lat = ?, lng = ?, accuracy = ?, battery = COALESCE(?, battery), updated_at = ? WHERE id = ?')
        .run(lat, lng, accuracy, battery, at, prev.id);
      return { checkin: db.prepare('SELECT * FROM locator_checkins WHERE id = ?').get(prev.id), transitions: [], merged: true, place };
    }

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO locator_checkins (family_id, user_id, lat, lng, accuracy, place_id, source, note, battery, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(familyId, user.id, lat, lng, accuracy, placeId, source, note, battery, at, at);
    const checkin = db.prepare('SELECT * FROM locator_checkins WHERE id = ?').get(lastInsertRowid);

    const transitions = [];
    const addEvent = (p, kind) => {
      const { lastInsertRowid: eid } = db
        .prepare('INSERT INTO locator_events (family_id, user_id, place_id, place_name, place_icon, kind, checkin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(familyId, user.id, p.id, p.name, p.icon, kind, checkin.id, at);
      transitions.push({ ...db.prepare('SELECT * FROM locator_events WHERE id = ?').get(eid), notify: p.notify });
    };
    if (prevPlaceId && prevPlaceId !== placeId) addEvent(places.find((p) => p.id === prevPlaceId), 'left');
    if (place && placeId !== prevPlaceId) addEvent(place, 'arrived');

    // Keep history bounded.
    const cutoff = new Date(Date.parse(at) - RETENTION_DAYS * 864e5).toISOString();
    db.prepare('DELETE FROM locator_checkins WHERE family_id = ? AND updated_at < ?').run(familyId, cutoff);
    db.prepare('DELETE FROM locator_events WHERE family_id = ? AND created_at < ?').run(familyId, cutoff);

    const who = firstName(user.name);
    const link = `/locator/member/${user.id}`;
    const alerting = transitions.filter((t) => t.notify);
    if (!silent && alerting.length) {
      const left = alerting.find((t) => t.kind === 'left');
      const arrived = alerting.find((t) => t.kind === 'arrived');
      const title = left && arrived ? `${who} left ${left.place_name} and arrived at ${arrived.place_name}`
        : arrived ? `${who} arrived at ${arrived.place_name}` : `${who} left ${left.place_name}`;
      ctx.notify({
        familyId, userIds: members(db, familyId).map((m) => m.id), excludeUserId: user.id, module: 'locator',
        link: `${link}?c=${checkin.id}`, title, body: note ? `“${note}”` : null,
      });
    }
    if (activity) {
      const arrival = transitions.find((t) => t.kind === 'arrived');
      let summary = null;
      if (source === 'checkin') {
        const near = place ? null : nearestPlace(places, lat, lng);
        summary = place ? `checked in at ${place.name}`
          : near && near.meters < 400 ? `checked in near ${near.place.name}` : 'checked in';
        if (note) summary += ` — “${note.length > 80 ? `${note.slice(0, 79)}…` : note}”`;
      } else if (arrival) {
        summary = `arrived at ${arrival.place_name}`;
      }
      if (summary) {
        ctx.logActivity({ familyId, userId: user.id, module: 'locator', verb: source === 'checkin' ? 'checked_in' : 'arrived', entityId: checkin.id, summary, link, createdAt: createdAt ?? undefined });
      }
    }
    return { checkin, transitions: transitions.map(({ notify, ...t }) => t), merged: false, place };
  });
}

function parsePlaceBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) out.name = cleanStr(body.name, { field: 'Name', required: true, max: 60 });
  if (!partial || has('lat')) out.lat = round6(num(body.lat, 'Latitude', { min: -90, max: 90, required: true }));
  if (!partial || has('lng')) out.lng = round6(num(body.lng, 'Longitude', { min: -180, max: 180, required: true }));
  if (!partial || has('radius')) {
    const r = num(body.radius ?? (partial ? undefined : 150), 'Radius', { min: 25, max: 5000, required: true });
    out.radius = Math.round(r);
  }
  if (!partial || has('icon')) {
    const icon = body.icon ?? 'pin';
    if (!PLACE_ICONS.includes(icon)) throw httpError(400, 'Unknown place icon');
    out.icon = icon;
  }
  if (partial && has('icon') && !has('color')) out.color = ICON_COLORS[out.icon] ?? '#E5484D';
  if (!partial || has('color')) {
    if (body.color !== undefined && body.color !== null && !isColor(body.color)) throw httpError(400, 'Color must be a hex color like #5B5BD6');
    out.color = body.color ?? ICON_COLORS[out.icon ?? 'pin'] ?? '#E5484D';
  }
  if (!partial || has('address')) out.address = cleanStr(body.address, { field: 'Address', max: 200 });
  if (!partial || has('notify')) {
    if (body.notify !== undefined && typeof body.notify !== 'boolean') throw httpError(400, 'Notify must be true or false');
    out.notify = body.notify === undefined ? 1 : body.notify ? 1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// router

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const { db } = ctx;
  const r = Router();

  const overview = (req) => {
    cleanupFamily(db, req.family.id);
    const places = listPlaces(db, req.family.id);
    const list = members(db, req.family.id).map((m) => memberView(db, req.family.id, m, places, req.user.id));
    return {
      me: { user_id: req.user.id, ...sharingOf(db, req.family.id, req.user.id) },
      members: list,
      places,
      recent: recentEvents(db, req.family.id, req.user.id),
    };
  };

  r.get('/', (req, res) => res.json(overview(req)));

  // ---- places -------------------------------------------------------------------------------
  r.get('/places', (req, res) => res.json(listPlaces(db, req.family.id)));

  r.get('/places/:id', (req, res) => {
    const place = getPlace(db, req.family.id, toId(req.params.id));
    const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
    const visits = db
      .prepare(
        `SELECT e.*, u.name AS user_name, u.color AS user_color, u.avatar_url AS user_avatar_url
           FROM locator_events e
           JOIN memberships m ON m.family_id = e.family_id AND m.user_id = e.user_id
           JOIN users u ON u.id = e.user_id
           LEFT JOIN locator_settings s ON s.family_id = e.family_id AND s.user_id = e.user_id
          WHERE e.family_id = ? AND e.place_id = ? AND e.created_at >= ? AND (COALESCE(s.sharing, 1) = 1 OR e.user_id = ?)
          ORDER BY e.created_at DESC, e.id DESC LIMIT 30`,
      )
      .all(req.family.id, place.id, since, req.user.id)
      .map(eventRow);
    res.json({ ...place, events: visits });
  });

  r.post('/places', (req, res) => {
    const body = req.body ?? {};
    const data = parsePlaceBody(body);
    const count = db.prepare('SELECT COUNT(*) AS n FROM locator_places WHERE family_id = ?').get(req.family.id).n;
    if (count >= MAX_PLACES) throw httpError(400, `A family can save up to ${MAX_PLACES} places`);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO locator_places (family_id, name, icon, color, lat, lng, radius, address, notify, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.family.id, data.name, data.icon, data.color, data.lat, data.lng, data.radius, data.address, data.notify, req.user.id);
    const place = getPlace(db, req.family.id, Number(lastInsertRowid));
    ctx.broadcast(req.family.id, 'locator.place.created', place);
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'locator', verb: 'created', entityId: place.id,
      summary: `added the place ${place.name}`, link: `/locator/places/${place.id}`,
    });
    res.status(201).json(place);
  });

  const canManage = (req, place) => req.role !== 'child' || place.created_by === req.user.id;

  r.patch('/places/:id', (req, res) => {
    const place = getPlace(db, req.family.id, toId(req.params.id));
    if (!canManage(req, place)) throw httpError(403, 'Only grown-ups can change places added by someone else');
    const data = parsePlaceBody(req.body ?? {}, { partial: true });
    const keys = Object.keys(data);
    if (!keys.length) return res.json(place);
    db.prepare(`UPDATE locator_places SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND family_id = ?`)
      .run(...keys.map((k) => data[k]), new Date().toISOString(), place.id, req.family.id);
    const updated = getPlace(db, req.family.id, place.id);
    ctx.broadcast(req.family.id, 'locator.place.updated', updated);
    res.json(updated);
  });

  r.delete('/places/:id', (req, res) => {
    const place = getPlace(db, req.family.id, toId(req.params.id));
    if (!canManage(req, place)) throw httpError(403, 'Only grown-ups can delete places added by someone else');
    db.prepare('DELETE FROM locator_places WHERE id = ? AND family_id = ?').run(place.id, req.family.id);
    ctx.broadcast(req.family.id, 'locator.place.deleted', { id: place.id });
    res.json({ ok: true });
  });

  // ---- check-ins ----------------------------------------------------------------------------
  r.post('/checkins', (req, res) => {
    const body = req.body ?? {};
    if (!sharingOf(db, req.family.id, req.user.id).sharing) {
      throw httpError(409, 'Location sharing is paused. Turn it back on to check in.');
    }
    const lat = round6(num(body.lat, 'Latitude', { min: -90, max: 90, required: true }));
    const lng = round6(num(body.lng, 'Longitude', { min: -180, max: 180, required: true }));
    const accuracy = num(body.accuracy, 'Accuracy', { min: 0, max: 100000 });
    const battery = num(body.battery, 'Battery', { min: 0, max: 100 });
    const source = body.source ?? 'checkin';
    if (!['checkin', 'live'].includes(source)) throw httpError(400, 'Source must be "checkin" or "live"');
    const note = source === 'checkin' ? cleanStr(body.note, { field: 'Note', max: 140 }) : null;
    const result = recordCheckin(ctx, {
      familyId: req.family.id, user: req.user, lat, lng,
      accuracy: accuracy === null ? null : Math.round(accuracy), battery: battery === null ? null : Math.round(battery),
      source, note,
    });
    ctx.broadcast(req.family.id, 'locator.checkin', {
      user_id: req.user.id, checkin_id: result.checkin.id, merged: result.merged, transitions: result.transitions,
    });
    const places = listPlaces(db, req.family.id);
    const me = members(db, req.family.id).find((m) => m.id === req.user.id);
    res.status(result.merged ? 200 : 201).json({
      checkin: result.checkin,
      transitions: result.transitions,
      merged: result.merged,
      member: memberView(db, req.family.id, me, places, req.user.id),
    });
  });

  r.delete('/checkins/:id', (req, res) => {
    const id = toId(req.params.id);
    const row = db.prepare('SELECT * FROM locator_checkins WHERE id = ? AND family_id = ?').get(id, req.family.id);
    if (!row) throw httpError(404, 'Check-in not found');
    if (row.user_id !== req.user.id) throw httpError(403, 'You can only delete your own check-ins');
    ctx.tx(db, () => {
      db.prepare('DELETE FROM locator_checkins WHERE id = ?').run(id);
      scrubTraces(ctx, req.family.id, req.user.id, id);
    });
    ctx.broadcast(req.family.id, 'locator.checkin.deleted', { id, user_id: req.user.id });
    res.json({ ok: true });
  });

  r.delete('/history', (req, res) => {
    const n = ctx.tx(db, () => {
      db.prepare('DELETE FROM locator_events WHERE family_id = ? AND user_id = ?').run(req.family.id, req.user.id);
      const deleted = Number(db.prepare('DELETE FROM locator_checkins WHERE family_id = ? AND user_id = ?').run(req.family.id, req.user.id).changes);
      scrubTraces(ctx, req.family.id, req.user.id);
      return deleted;
    });
    ctx.broadcast(req.family.id, 'locator.history.cleared', { user_id: req.user.id });
    res.json({ ok: true, deleted: n });
  });

  // ---- history ------------------------------------------------------------------------------
  r.get('/history/:userId', (req, res) => {
    const userId = toId(req.params.userId, 'member');
    if (!isMember(db, req.family.id, userId)) throw httpError(404, 'Member not found');
    const days = req.query.days === undefined ? HISTORY_DAYS : num(req.query.days, 'Days', { min: 1, max: HISTORY_DAYS, integer: true });
    const s = sharingOf(db, req.family.id, userId);
    const hidden = !s.sharing && userId !== req.user.id;
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const places = listPlaces(db, req.family.id);
    const placesById = new Map(places.map((p) => [p.id, p]));
    const checkins = hidden ? [] : db
      .prepare('SELECT * FROM locator_checkins WHERE family_id = ? AND user_id = ? AND updated_at >= ? ORDER BY created_at, id')
      .all(req.family.id, userId, since);
    const events = hidden ? [] : db
      .prepare('SELECT * FROM locator_events WHERE family_id = ? AND user_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC')
      .all(req.family.id, userId, since);
    let meters = 0;
    for (let i = 1; i < checkins.length; i++) meters += distanceMeters(checkins[i - 1].lat, checkins[i - 1].lng, checkins[i].lat, checkins[i].lng);
    res.json({
      user_id: userId,
      days,
      sharing: s.sharing,
      hidden,
      checkins,
      visits: buildVisits(checkins, placesById),
      events,
      stats: { checkins: checkins.length, places_visited: new Set(checkins.filter((c) => c.place_id).map((c) => c.place_id)).size, meters: Math.round(meters) },
    });
  });

  r.get('/events', (req, res) => {
    const hours = req.query.hours === undefined ? 48 : num(req.query.hours, 'Hours', { min: 1, max: HISTORY_DAYS * 24, integer: true });
    res.json(recentEvents(db, req.family.id, req.user.id, { hours, limit: 50 }));
  });

  // ---- privacy ------------------------------------------------------------------------------
  r.get('/settings', (req, res) => res.json({ user_id: req.user.id, ...sharingOf(db, req.family.id, req.user.id) }));

  r.patch('/settings', (req, res) => {
    const sharing = req.body?.sharing;
    if (typeof sharing !== 'boolean') throw httpError(400, 'Sharing must be true or false');
    const now = new Date().toISOString();
    const before = sharingOf(db, req.family.id, req.user.id).sharing;
    db.prepare(
      `INSERT INTO locator_settings (family_id, user_id, sharing, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (family_id, user_id) DO UPDATE SET sharing = excluded.sharing, updated_at = excluded.updated_at`,
    ).run(req.family.id, req.user.id, sharing ? 1 : 0, now);
    // Pausing also takes back what was already shared on the Wall / in others' notifications.
    if (!sharing) scrubTraces(ctx, req.family.id, req.user.id);
    if (before !== sharing && req.role === 'child') {
      const admins = db.prepare("SELECT user_id FROM memberships WHERE family_id = ? AND role = 'admin'").all(req.family.id).map((r) => r.user_id);
      ctx.notify({
        familyId: req.family.id, userIds: admins, excludeUserId: req.user.id, module: 'locator', link: '/locator',
        title: sharing ? `${firstName(req.user.name)} turned location sharing back on` : `${firstName(req.user.name)} paused location sharing`,
      });
    }
    ctx.broadcast(req.family.id, 'locator.settings.updated', { user_id: req.user.id, sharing });
    res.json({ user_id: req.user.id, ...sharingOf(db, req.family.id, req.user.id) });
  });

  return r;
}

// ---------------------------------------------------------------------------------------------
// hooks

/** Someone left / was removed: their location data in this family goes with them, right away. */
export function onMemberLeft(ctx, { familyId, userId }) {
  const { db } = ctx;
  ctx.tx(db, () => {
    db.prepare('DELETE FROM locator_events WHERE family_id = ? AND user_id = ?').run(familyId, userId);
    db.prepare('DELETE FROM locator_checkins WHERE family_id = ? AND user_id = ?').run(familyId, userId);
    db.prepare('DELETE FROM locator_settings WHERE family_id = ? AND user_id = ?').run(familyId, userId);
    scrubTraces(ctx, familyId, userId);
  });
  ctx.broadcast(familyId, 'locator.history.cleared', { user_id: userId });
}

export function search(ctx, familyId, q) {
  return ctx.db
    .prepare(
      `SELECT id, name, address, radius FROM locator_places
        WHERE family_id = ? AND (search_match(name, ?) OR search_match(address, ?))
        ORDER BY name COLLATE NOCASE LIMIT 8`,
    )
    .all(familyId, q, q)
    .map((p) => ({ title: p.name, subtitle: p.address || `Saved place · ${p.radius} m radius`, link: `/locator/places/${p.id}` }));
}

/** Where is everyone? `{ members: [{ user_id, name, color, place, updated_at }] }` (sharing members only). */
export function dashboard(ctx, req) {
  const { db } = ctx;
  const familyId = req.family.id;
  const places = listPlaces(db, familyId);
  const out = [];
  for (const m of members(db, familyId)) {
    if (!sharingOf(db, familyId, m.id).sharing && m.id !== req.user.id) continue;
    const loc = locationOf(db, familyId, m.id, places);
    if (!loc) continue;
    out.push({ user_id: m.id, name: m.name, color: m.color, place: loc.place, updated_at: loc.updated_at });
  }
  return { members: out };
}

// ---------------------------------------------------------------------------------------------
// seed — the Riveras in Austin, TX

const SEED_PLACES = {
  home: { name: 'Home', icon: 'home', lat: 30.30052, lng: -97.75611, radius: 120, address: '2417 Windsor Rd, Austin' },
  school: { name: 'Maple Grove Elementary', icon: 'school', lat: 30.30921, lng: -97.74418, radius: 160, address: '2710 Exposition Blvd' },
  work: { name: 'Alex’s office', icon: 'work', lat: 30.26721, lng: -97.74306, radius: 180, address: '600 Congress Ave' },
  clinic: { name: 'Westlake Clinic', icon: 'health', lat: 30.28893, lng: -97.78012, radius: 150, address: 'Sam’s work' },
  soccer: { name: 'Zilker soccer fields', icon: 'sport', lat: 30.26695, lng: -97.77204, radius: 250, address: 'Zilker Park' },
  grandma: { name: 'Grandma Rosa’s', icon: 'heart', lat: 30.32884, lng: -97.73932, radius: 100, address: '4501 Avenue F' },
  library: { name: 'Central Library', icon: 'star', lat: 30.26588, lng: -97.75163, radius: 110, address: '710 W Cesar Chavez St' },
  grocery: { name: 'H-E-B Grocery', icon: 'shop', lat: 30.31302, lng: -97.73905, radius: 140, address: 'Lamar Blvd', notify: false },
  gym: { name: 'Riverside Gym', icon: 'gym', lat: 30.27871, lng: -97.74998, radius: 90, address: '1105 W 6th St', notify: false },
};

/** Deterministic pseudo-random numbers so the demo looks the same every time. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export async function seed(ctx, { familyId, users }) {
  const { db } = ctx;
  const ids = {};
  for (const [key, p] of Object.entries(SEED_PLACES)) {
    const creator = ['school', 'soccer', 'grandma'].includes(key) ? users.sam : users.alex;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO locator_places (family_id, name, icon, color, lat, lng, radius, address, notify, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(familyId, p.name, p.icon, ICON_COLORS[p.icon], p.lat, p.lng, p.radius, p.address, p.notify === false ? 0 : 1, creator.id,
        new Date(Date.now() - 60 * 864e5).toISOString(), new Date(Date.now() - 60 * 864e5).toISOString());
    ids[key] = { ...p, id: Number(lastInsertRowid) };
  }

  const rand = rng(20260929);
  const jitter = (p, spread = 0.35) => {
    const r = p.radius * spread * rand();
    const a = rand() * Math.PI * 2;
    return { lat: p.lat + (r * Math.cos(a)) / 111320, lng: p.lng + (r * Math.sin(a)) / (111320 * Math.cos((p.lat * Math.PI) / 180)) };
  };
  // Spots outside any saved place (coffee, lunch, errands).
  const SPOTS = {
    lunch: { lat: 30.26964, lng: -97.74017 },
    coffee: { lat: 30.29487, lng: -97.74203 },
    park: { lat: 30.28542, lng: -97.76720 },
    hardware: { lat: 30.32214, lng: -97.72611 },
    icecream: { lat: 30.27410, lng: -97.75480 },
  };

  // The Riveras live in Austin: build their days in America/Chicago local time (DST-aware).
  const ZONE = 'America/Chicago';
  const nowMs = Date.now();
  const localParts = (ms) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(new Date(ms));
    const g = (t) => f.find((x) => x.type === t)?.value;
    return { y: Number(g('year')), m: Number(g('month')), d: Number(g('day')), h: Number(g('hour')) + Number(g('minute')) / 60, wd: g('weekday') };
  };
  const today = localParts(nowMs);
  /** UTC ms of local midnight `daysAgo` days before today (offset looked up for that day). */
  const dayStart = (daysAgo) => {
    const guess = Date.UTC(today.y, today.m - 1, today.d - daysAgo, 12);
    const off = ctx.time.offsetMinutes(ZONE, new Date(guess));
    return Date.UTC(today.y, today.m - 1, today.d - daysAgo) - off * 60e3;
  };
  const at = (daysAgo, hour) => dayStart(daysAgo) + hour * 3600e3;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekdayOf = (daysAgo) => WD[localParts(dayStart(daysAgo) + 12 * 3600e3).wd];

  // Each plan entry: [hour, stop] where stop is a place key or a spot key.
  function plan(key, dow) {
    const weekend = dow === 0 || dow === 6;
    if (key === 'alex') {
      if (dow === 6) return [[8, 'home'], [10.2, 'grocery'], [11.3, 'home'], [15, 'grandma'], [18.2, 'home']];
      if (dow === 0) return [[9, 'home'], [10.5, 'park'], [12.8, 'home'], [16, 'hardware'], [16.9, 'home']];
      return [[6.5, 'home'], [8.5, 'work'], [12.2, 'lunch'], [13.1, 'work'], [17.6, dow % 2 ? 'gym' : 'work'], [19, 'home']];
    }
    if (key === 'sam') {
      if (dow === 6) return [[8, 'home'], [9.2, 'soccer'], [11.4, 'home'], [15, 'grandma'], [18.2, 'home']];
      if (dow === 0) return [[9, 'home'], [10.5, 'park'], [12.8, 'home'], [15.5, 'coffee'], [16.4, 'home']];
      const base = [[6.8, 'home'], [7.75, 'school'], [8.2, 'clinic'], [15, 'school']];
      return dow === 2 || dow === 4 ? [...base, [15.9, 'soccer'], [17.6, 'home']] : [...base, [15.5, 'home']];
    }
    if (key === 'mia') {
      if (weekend) return dow === 6 ? [[8, 'home'], [15, 'grandma'], [18.2, 'home']] : [[9, 'home'], [10.5, 'park'], [12.8, 'home'], [15, 'icecream'], [15.8, 'home']];
      return dow === 1 || dow === 3 ? [[6.8, 'home'], [7.75, 'school'], [15.1, 'library'], [17, 'home']] : [[6.8, 'home'], [7.75, 'school'], [15, 'home']];
    }
    // leo
    if (weekend) return dow === 6 ? [[8, 'home'], [9.2, 'soccer'], [11.4, 'home'], [15, 'grandma'], [18.2, 'home']] : [[9, 'home'], [10.5, 'park'], [12.8, 'home']];
    const base = [[6.8, 'home'], [7.75, 'school'], [15, 'school']];
    return dow === 2 || dow === 4 ? [...base, [15.9, 'soccer'], [17.6, 'home']] : [...base, [15.5, 'home']];
  }

  const now = nowMs;
  const setUpdated = db.prepare('UPDATE locator_checkins SET updated_at = ? WHERE id = ?');
  // Sam checks in by hand at the current stop; the others share live.
  const NOTES = {
    home: 'Home — dinner at 7 🍝', school: 'Drop-off done ✅', clinic: 'At work until 3', soccer: 'Practice running late ⚽',
    coffee: 'Grabbing coffee before pickup ☕', park: 'Picnic spot by the pond', grandma: 'Tamales at Grandma’s!',
  };
  const recent = [];

  for (const key of ['alex', 'sam', 'mia', 'leo']) {
    const user = users[key];
    // Every planned stop over the last week up to *now*: the last one is where they are right now.
    const stops = [];
    for (let d = HISTORY_DAYS; d >= 0; d--) {
      const dow = weekdayOf(d);
      for (const [hour, stop] of plan(key, dow)) {
        const t = at(d, hour) + (rand() - 0.5) * 9 * 60e3;
        if (t < now - 3 * 60e3 && t > now - HISTORY_DAYS * 864e5) stops.push({ t, stop });
      }
    }
    for (let i = 0; i < stops.length; i++) {
      const st = stops[i];
      const current = i === stops.length - 1;
      const place = ids[st.stop];
      const pos = place ? jitter(place) : { lat: SPOTS[st.stop].lat + (rand() - 0.5) * 0.0004, lng: SPOTS[st.stop].lng + (rand() - 0.5) * 0.0004 };
      const manual = current ? key === 'sam' : rand() < 0.2;
      const { checkin, transitions } = recordCheckin(ctx, {
        familyId, user, lat: round6(pos.lat), lng: round6(pos.lng), accuracy: Math.round(8 + rand() * 30),
        source: manual ? 'checkin' : 'live', note: current && manual ? NOTES[st.stop] ?? null : null,
        battery: null, createdAt: new Date(st.t).toISOString(), silent: true,
        activity: current || now - st.t < 12 * 3600e3, // today's comings and goings, plus where everyone is now (early mornings have none yet)
      });
      if (now - st.t < 6 * 3600e3 && transitions.some((t) => t.kind === 'arrived')) recent.push({ user, checkin, place: transitions.find((t) => t.kind === 'arrived').place_name });
      // They stayed until shortly before the next stop (live sharing kept refreshing the spot).
      const next = stops[i + 1];
      const end = current ? now - Math.round(1 + rand() * 9) * 60e3 : next ? next.t - 4 * 60e3 : st.t + 3600e3;
      if (end > st.t) setUpdated.run(new Date(end).toISOString(), checkin.id);
    }
  }

  // Fresh arrival notifications for the grown-ups (as live sharing would have sent them).
  for (const r of recent.slice(-3)) {
    ctx.notify({
      familyId, userIds: [users.alex.id, users.sam.id], excludeUserId: r.user.id, module: 'locator',
      link: `/locator/member/${r.user.id}?c=${r.checkin.id}`, title: `${firstName(r.user.name)} arrived at ${r.place}`,
    });
  }
}
