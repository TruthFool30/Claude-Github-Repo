// Contacts & document vault — module "vault", mounted at /api/vault.
//
//   Contacts   shared family address book (categories, phones, emergency section) with
//              per-person favorites
//   Folders    one level of folders for documents
//   Documents  uploaded files (any type, 25 MB) with a visibility of "family", "adults" (admins +
//              members, hidden from children) or "private" (owner only); optional expiry date with a
//              reminder 30 days before
//   Notes      important-info cards (Wi-Fi, insurance numbers…) with the same visibilities; secret
//              field values are masked in every listing and only returned by GET /notes/:id/reveal
//
// Visibility is enforced in every query (other members get 404), in search/dashboard/folder counts,
// in live events (only the audience that can see an item hears about it) and on the Wall: only
// family-visible items create activity / notifications, and when an item stops being
// family-visible or is deleted its Wall entries and other people's notifications are scrubbed.
// Files are served exclusively through /api/vault/documents/:id/file (see vault/files.js).
//
// Encryption at rest (ctx.box): document files, document notes and info-card `fields` + `body` are
// stored sealed and decrypted when read (getDoc/getNote/openDoc/openNote). Document names and card
// titles/kinds stay plaintext so listings, sorting and search work in SQL. Data written before
// encryption is sealed in place at startup (sealLegacyVault).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { ISO_NOW } from '../db.js';
import { MAX_UPLOAD_BYTES } from '../uploads.js';
import { cleanStr, httpError, isDate, isEmail, parseJson, toId } from '../util.js';
import {
  contentDisposition, downloadName, extOf, fixFilename, kindOf, readVaultFile, removeVaultFile, sealLegacyFiles, serveTypeFor, vaultPath, writeVaultFile,
} from './vault/files.js';
import { seedVault } from './vault/seed.js';

export const name = 'vault';

export const CONTACT_CATEGORIES = ['medical', 'school', 'childcare', 'home', 'family', 'work', 'pets', 'emergency', 'other'];
export const FOLDER_ICONS = ['folder', 'medical', 'school', 'insurance', 'home', 'travel', 'car', 'finance', 'kids', 'pets', 'legal', 'work'];
export const NOTE_KINDS = ['wifi', 'insurance', 'medical', 'id', 'bank', 'code', 'vehicle', 'other'];
export const VISIBILITIES = ['family', 'adults', 'private'];
const FOLDER_COLORS = /^#[0-9a-fA-F]{6}$/;
const PHONE_RE = /^[+0-9][0-9 ()\-.#*/x]{1,30}$/i;
const EXPIRY_NOTICE_DAYS = 30;
const BURST_MS = 3 * 60_000;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS vault_contacts (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     category TEXT NOT NULL DEFAULT 'other',
     role TEXT,
     organization TEXT,
     phones TEXT NOT NULL DEFAULT '[]',
     email TEXT,
     address TEXT,
     website TEXT,
     notes TEXT,
     favorite INTEGER NOT NULL DEFAULT 0, -- legacy, unused: favorites are per person (vault_contact_favorites)
     emergency INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_vault_contacts_family ON vault_contacts(family_id, name)`,
  `CREATE TABLE IF NOT EXISTS vault_contact_favorites (
     contact_id INTEGER NOT NULL REFERENCES vault_contacts(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (contact_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS vault_folders (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#978365',
     icon TEXT NOT NULL DEFAULT 'folder',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_vault_folders_family ON vault_folders(family_id)`,
  `CREATE TABLE IF NOT EXISTS vault_documents (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     folder_id INTEGER REFERENCES vault_folders(id) ON DELETE SET NULL,
     name TEXT NOT NULL,
     original_name TEXT NOT NULL,
     ext TEXT NOT NULL DEFAULT '',
     mime TEXT NOT NULL DEFAULT 'application/octet-stream',
     size INTEGER NOT NULL DEFAULT 0,
     storage_key TEXT NOT NULL,
     owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     is_private INTEGER NOT NULL DEFAULT 0,
     notes TEXT,
     expires_on TEXT,
     expiry_notified_at TEXT,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_vault_documents_family ON vault_documents(family_id, folder_id)`,
  `CREATE TABLE IF NOT EXISTS vault_notes (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'other',
     fields TEXT NOT NULL DEFAULT '[]',
     body TEXT,
     is_private INTEGER NOT NULL DEFAULT 0,
     owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_vault_notes_family ON vault_notes(family_id)`,
  // "Adults only" visibility (admins + members; hidden from children).
  `ALTER TABLE vault_documents ADD COLUMN adults_only INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE vault_notes ADD COLUMN adults_only INTEGER NOT NULL DEFAULT 0`,
];

// ---------------------------------------------------------------------------------------------
// Shapes & visibility

const nowIso = () => new Date().toISOString();
/** JSON array column → array (`fallback` when missing, invalid or not an array). */
const parseList = (s, fallback) => {
  const v = parseJson(s, fallback);
  return Array.isArray(v) ? v : fallback;
};
/**
 * Rows as stored -> plaintext (sealed columns opened). A value that can't be decrypted (corrupted,
 * or sealed with another key) doesn't break the whole list: that item comes back empty with
 * `unreadable: true`, logged once per item. The placeholders are never written back: PATCH keeps
 * the stored ciphertext (409 for real new content), and the startup migration skips sealed values.
 */
const reported = new Set();
function openRow(table, row, open) {
  try {
    return open();
  } catch (err) {
    if (!reported.has(`${table}:${row.id}`)) console.error(`[vault] can't decrypt ${table} ${row.id}: ${err.message}`);
    reported.add(`${table}:${row.id}`);
    return null;
  }
}
const openDoc = (box, row) => openRow('vault_documents', row, () => ({ ...row, notes: box.open(row.notes) }))
  ?? { ...row, notes: null, unreadable: true };
const openNote = (box, row) => openRow('vault_notes', row, () => ({ ...row, fields: box.open(row.fields), body: box.open(row.body) }))
  ?? { ...row, fields: '[]', body: null, unreadable: true };
const isAdult = (req) => req.role === 'admin' || req.role === 'member';
const visibilityOf = (row) => (row.is_private ? 'private' : row.adults_only ? 'adults' : 'family');

/** SQL condition (+ args) for rows of a document/note table the requester may see. */
function visible(req, alias = '') {
  const a = alias ? `${alias}.` : '';
  return { sql: `(${a}owner_id = ? OR (${a}is_private = 0 AND (${a}adults_only = 0 OR ?)))`, args: [req.user.id, isAdult(req) ? 1 : 0] };
}

/** Adults may manage anything shared; children only what they created. Private items: owner only. */
function canManage(req, ownerId) {
  return ownerId === req.user.id || isAdult(req);
}

function contactOut(row, req) {
  const { favorite: _legacy, is_fav, ...rest } = row; // eslint-disable-line no-unused-vars
  return { ...rest, phones: parseList(row.phones, []), favorite: !!is_fav, emergency: !!row.emergency, can_edit: canManage(req, row.created_by) };
}

function documentOut(row, req) {
  const { storage_key, expiry_notified_at, ...rest } = row; // eslint-disable-line no-unused-vars
  return {
    ...rest,
    is_private: !!row.is_private,
    adults_only: !!row.adults_only,
    visibility: visibilityOf(row),
    kind: kindOf(row.ext, row.mime),
    url: `/api/vault/documents/${row.id}/file`,
    download_name: downloadName(row.name, row.ext),
    can_edit: canManage(req, row.owner_id),
    is_owner: row.owner_id === req.user.id,
  };
}

/** Listing shape: secret field values are withheld (null) until /reveal. */
function noteOut(row, req, { reveal = false } = {}) {
  const fields = parseList(row.fields, []).map((f) => ({
    label: String(f.label ?? ''),
    value: f.secret && !reveal ? null : String(f.value ?? ''),
    secret: !!f.secret,
  }));
  return {
    ...row,
    fields,
    is_private: !!row.is_private,
    adults_only: !!row.adults_only,
    visibility: visibilityOf(row),
    secret_count: fields.filter((f) => f.secret).length,
    revealed: reveal,
    can_edit: canManage(req, row.owner_id),
    is_owner: row.owner_id === req.user.id,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation

function bool(v, field) {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return !!v;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  throw httpError(400, `${field} must be true or false`);
}

/** `visibility` ('family' | 'adults' | 'private'), or the older `is_private` boolean. undefined = unchanged. */
function visibilityInput(body = {}, req = null) {
  const v = rawVisibility(body);
  // Children can't create items hidden from children (they'd be restricting adults' view of their own stuff oddly).
  if (v === 'adults' && req && !isAdult(req)) throw httpError(403, 'Only adults can make something adults-only');
  return v;
}
function rawVisibility(body = {}) {
  if (body.visibility !== undefined && body.visibility !== '') {
    if (!VISIBILITIES.includes(body.visibility)) throw httpError(400, 'Visibility must be family, adults or private');
    return body.visibility;
  }
  const priv = bool(body.is_private, 'Private');
  if (priv === undefined) return undefined;
  return priv ? 'private' : 'family';
}
const RANK = { private: 0, adults: 1, family: 2 };
const visibilityCols = (v) => ({ is_private: v === 'private' ? 1 : 0, adults_only: v === 'adults' ? 1 : 0 });

function cleanPhones(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'Phones must be a list');
  if (value.length > 6) throw httpError(400, 'A contact can have at most 6 phone numbers');
  const out = [];
  for (const p of value) {
    if (!p || typeof p !== 'object') throw httpError(400, 'Invalid phone number');
    const number = cleanStr(p.number, { field: 'Phone number', max: 32 });
    if (!number) continue;
    if (!PHONE_RE.test(number)) throw httpError(400, `“${number}” doesn't look like a phone number`);
    out.push({ label: cleanStr(p.label, { field: 'Phone label', max: 24 }) || 'Phone', number });
  }
  return out;
}

function cleanUrl(value) {
  const s = cleanStr(value, { field: 'Website', max: 300 });
  if (!s) return s;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('bad');
    return withProto;
  } catch {
    throw httpError(400, 'Website must be a valid web address');
  }
}

/** Parse a contact body. `partial` for PATCH (undefined = keep). `favorite` is handled separately (per person). */
function contactInput(body = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = cleanStr(body.name, { field: 'Name', required: true, max: 120 });
  if (!partial || body.category !== undefined) {
    const cat = body.category ?? 'other';
    if (!CONTACT_CATEGORIES.includes(cat)) throw httpError(400, 'Unknown contact category');
    out.category = cat;
  }
  for (const [key, label, max] of [['role', 'Role', 80], ['organization', 'Organization', 120], ['address', 'Address', 300], ['notes', 'Notes', 2000]]) {
    if (!partial || body[key] !== undefined) out[key] = cleanStr(body[key], { field: label, max });
  }
  if (!partial || body.email !== undefined) {
    const email = cleanStr(body.email, { field: 'Email', max: 200 });
    if (email && !isEmail(email)) throw httpError(400, 'Please enter a valid email address');
    out.email = email;
  }
  if (!partial || body.website !== undefined) out.website = cleanUrl(body.website);
  const phones = cleanPhones(body.phones);
  if (phones !== undefined) out.phones = JSON.stringify(phones);
  else if (!partial) out.phones = '[]';
  const emg = bool(body.emergency, 'Emergency');
  if (emg !== undefined) out.emergency = emg ? 1 : 0;
  return out;
}

function cleanNoteFields(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'Fields must be a list');
  if (value.length > 12) throw httpError(400, 'A note can have at most 12 fields');
  const out = [];
  for (const f of value) {
    if (!f || typeof f !== 'object') throw httpError(400, 'Invalid field');
    const label = cleanStr(f.label, { field: 'Field label', max: 60 });
    const val = cleanStr(f.value, { field: 'Field value', max: 500 });
    if (!label && !val) continue;
    if (!label) throw httpError(400, 'Every field needs a label');
    if (!val) throw httpError(400, `“${label}” needs a value`);
    out.push({ label, value: val, secret: !!bool(f.secret ?? false, 'Secret') });
  }
  return out;
}

function cleanExpiry(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isDate(v)) throw httpError(400, 'Expiry date must be a valid date (YYYY-MM-DD)');
  return v;
}

/** 'YYYY-MM-DD' shifted by n calendar days. */
export function shiftDate(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

// ---------------------------------------------------------------------------------------------
// Audience, Wall & notification hygiene

const memberIds = (db, familyId, { adultsOnly = false } = {}) =>
  db.prepare(`SELECT user_id FROM memberships WHERE family_id = ? ${adultsOnly ? "AND role IN ('admin','member')" : ''}`).all(familyId).map((m) => m.user_id);

/** Users who can see an item with this visibility. */
function audience(db, familyId, visibility, ownerId) {
  if (visibility === 'private') return [ownerId].filter(Boolean);
  if (visibility === 'adults') return [...new Set([...memberIds(db, familyId, { adultsOnly: true }), ownerId].filter(Boolean))];
  return memberIds(db, familyId);
}

/**
 * Remove notifications about `link` from everyone except `keepUserIds` and tell their bells to
 * refresh. Returns the number removed.
 */
function scrubNotifications(ctx, familyId, link, keepUserIds = []) {
  const keep = new Set(keepUserIds);
  const rows = ctx.db.prepare("SELECT id, user_id FROM notifications WHERE family_id = ? AND module = 'vault' AND link = ?").all(familyId, link)
    .filter((n) => !keep.has(n.user_id));
  ctx.removeNotifications(familyId, rows);
  return rows.length;
}

function removeActivity(ctx, familyId, ids) {
  if (!ids.length) return;
  const del = ctx.db.prepare('DELETE FROM activity WHERE id = ? AND family_id = ?');
  for (const id of ids) del.run(id, familyId);
  ctx.broadcast(familyId, 'activity.removed', { ids });
}

const familyVisibleDoc = 'is_private = 0 AND adults_only = 0';

/**
 * A document stopped being family-visible (made private / adults-only, or deleted): drop its Wall
 * entries, rewrite coalesced "uploaded N documents" entries it was part of, and remove other
 * people's notifications about it. `doc` is the row as it was before the change.
 */
function scrubDocument(ctx, familyId, doc, { keepUserIds = [] } = {}) {
  const { db } = ctx;
  const link = `/vault/docs/d/${doc.id}`;
  const removed = [];
  // Entries that point at this document directly ("shared X", single "uploaded X", or the anchor of a burst).
  const direct = db.prepare("SELECT * FROM activity WHERE family_id = ? AND module = 'vault' AND entity_id = ? AND verb IN ('uploaded','shared')").all(familyId, doc.id);
  // Bursts this document belongs to without being their anchor.
  const t = Date.parse(doc.created_at);
  const bursts = db.prepare(
    `SELECT * FROM activity WHERE family_id = ? AND module = 'vault' AND verb = 'uploaded' AND user_id IS ? AND summary LIKE 'uploaded % documents%'
       AND created_at BETWEEN ? AND ?`,
  ).all(familyId, doc.owner_id, new Date(t - BURST_MS - 60_000).toISOString(), new Date(t + 60_000).toISOString());
  const seen = new Set();
  for (const a of [...direct, ...bursts]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const isBurst = a.verb === 'uploaded' && /^uploaded \d+ documents/.test(a.summary);
    if (!isBurst) {
      removed.push(a.id);
      continue;
    }
    // Recount the burst from the documents that are still family-visible.
    const folderMatch = /^\/vault\/docs\/f\/(\d+)$/.exec(a.link ?? '');
    const folderId = folderMatch ? Number(folderMatch[1]) : null;
    const start = new Date(Date.parse(a.created_at) - 60_000).toISOString();
    const end = new Date(Date.parse(a.created_at) + BURST_MS + 60_000).toISOString();
    const rest = db.prepare(
      `SELECT d.id, d.name, f.name AS folder_name FROM vault_documents d LEFT JOIN vault_folders f ON f.id = d.folder_id
        WHERE d.family_id = ? AND d.owner_id IS ? AND d.folder_id IS ? AND d.${familyVisibleDoc.replace(/ AND /, ' AND d.')} AND d.id != ?
          AND d.created_at BETWEEN ? AND ? ORDER BY d.id`,
    ).all(familyId, a.user_id, folderId, doc.id, start, end);
    if (!rest.length) {
      removed.push(a.id);
    } else {
      const where = rest[0].folder_name ? ` to ${rest[0].folder_name}` : '';
      const [summary, entity, newLink] = rest.length === 1
        ? [`uploaded ${rest[0].name}${where}`, rest[0].id, `/vault/docs/d/${rest[0].id}`]
        : [`uploaded ${rest.length} documents${where}`, rest[0].id, a.link];
      db.prepare('UPDATE activity SET summary = ?, entity_id = ?, link = ? WHERE id = ?').run(summary, entity, newLink, a.id);
      ctx.broadcast(familyId, 'activity.updated', { id: a.id });
    }
  }
  removeActivity(ctx, familyId, removed);
  scrubNotifications(ctx, familyId, link, keepUserIds);
}

/** Drop Wall entries (and notifications) that point at a contact/folder/note being hidden or deleted. */
function scrubEntity(ctx, familyId, verbs, entityId, link, keepUserIds = []) {
  const rows = ctx.db.prepare(`SELECT id FROM activity WHERE family_id = ? AND module = 'vault' AND entity_id = ? AND verb IN (${verbs.map(() => '?').join(',')})`)
    .all(familyId, entityId, ...verbs);
  removeActivity(ctx, familyId, rows.map((r) => r.id));
  scrubNotifications(ctx, familyId, link, keepUserIds);
}

// ---------------------------------------------------------------------------------------------
// Router

export function router(ctx) {
  const r = Router();
  const { db, box } = ctx;
  sealLegacyVault(ctx);
  // Vault uploads stay in memory until sealed, so plaintext never touches the disk.
  // ponytail: up to 25 MB of RAM per upload in flight; fine for a family server, stream-encrypt if not.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  /** Seal user text. Text that already looks sealed is refused: it would be *opened* on read (a decryption oracle). */
  const sealInput = (v, field) => {
    if (box.isSealed(v)) throw httpError(400, `${field} can't start with “enc:v1:”`);
    return box.seal(v);
  };

  const contactSelect = `SELECT c.*, (SELECT 1 FROM vault_contact_favorites v WHERE v.contact_id = c.id AND v.user_id = ?) AS is_fav FROM vault_contacts c`;
  const getContact = (req, id) => {
    const row = db.prepare(`${contactSelect} WHERE c.id = ? AND c.family_id = ?`).get(req.user.id, toId(id), req.family.id);
    if (!row) throw httpError(404, 'Contact not found');
    return row;
  };
  const getFolder = (req, id) => {
    const row = db.prepare('SELECT * FROM vault_folders WHERE id = ? AND family_id = ?').get(toId(id, 'folder'), req.family.id);
    if (!row) throw httpError(404, 'Folder not found');
    return row;
  };
  const getDoc = (req, id) => {
    const v = visible(req, 'd');
    const row = db.prepare(`SELECT d.*, f.name AS folder_name, f.color AS folder_color FROM vault_documents d LEFT JOIN vault_folders f ON f.id = d.folder_id
                             WHERE d.id = ? AND d.family_id = ? AND ${v.sql}`).get(toId(id), req.family.id, ...v.args);
    if (!row) throw httpError(404, 'Document not found');
    return openDoc(box, row);
  };
  const getNote = (req, id) => {
    const v = visible(req);
    const row = db.prepare(`SELECT * FROM vault_notes WHERE id = ? AND family_id = ? AND ${v.sql}`).get(toId(id), req.family.id, ...v.args);
    if (!row) throw httpError(404, 'Note not found');
    return openNote(box, row);
  };
  const forbidUnless = (ok, msg = "You can't change something another family member added") => {
    if (!ok) throw httpError(403, msg);
  };
  /** Folder id from a body value: null/'' = unfiled, else must belong to this family. */
  const folderFromBody = (req, v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === 'null') return null;
    return getFolder(req, v).id;
  };
  /**
   * Live update for a visibility-aware item: only people who can see it hear about it. When its
   * audience shrank, everyone is told to drop it (`<type>.hidden`, id only).
   */
  const emit = (req, type, { id, visibility, ownerId, before = null }) => {
    const payload = { id };
    if (visibility === 'family') ctx.broadcast(req.family.id, type, payload);
    else ctx.sendToUsers(audience(db, req.family.id, visibility, ownerId ?? req.user.id), type, payload, req.family.id);
    if (before && RANK[visibility] < RANK[before]) ctx.broadcast(req.family.id, type.replace(/\.[a-z]+$/, '.hidden'), payload);
  };

  // ---- overview -------------------------------------------------------------------------------
  r.get('/', (req, res) => {
    const fid = req.family.id;
    const v = visible(req);
    res.json({
      contacts: db.prepare('SELECT COUNT(*) n FROM vault_contacts WHERE family_id = ?').get(fid).n,
      emergency: db.prepare('SELECT COUNT(*) n FROM vault_contacts WHERE family_id = ? AND emergency = 1').get(fid).n,
      folders: db.prepare('SELECT COUNT(*) n FROM vault_folders WHERE family_id = ?').get(fid).n,
      documents: db.prepare(`SELECT COUNT(*) n FROM vault_documents WHERE family_id = ? AND ${v.sql}`).get(fid, ...v.args).n,
      notes: db.prepare(`SELECT COUNT(*) n FROM vault_notes WHERE family_id = ? AND ${v.sql}`).get(fid, ...v.args).n,
      expiring: expiringDocs(ctx, req).map((d) => documentOut(openDoc(box, d), req)),
    });
  });

  // ---- contacts -------------------------------------------------------------------------------
  r.get('/contacts', (req, res) => {
    const where = ['c.family_id = ?'];
    const args = [req.user.id, req.family.id];
    const term = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    if (term) {
      where.push(`(c.name LIKE '%' || ? || '%' OR IFNULL(c.organization,'') LIKE '%' || ? || '%' OR IFNULL(c.role,'') LIKE '%' || ? || '%'
                  OR IFNULL(c.email,'') LIKE '%' || ? || '%' OR c.phones LIKE '%' || ? || '%' OR IFNULL(c.notes,'') LIKE '%' || ? || '%')`);
      args.push(term, term, term, term, term, term);
    }
    if (typeof req.query.category === 'string' && req.query.category) {
      if (!CONTACT_CATEGORIES.includes(req.query.category)) throw httpError(400, 'Unknown contact category');
      where.push('c.category = ?');
      args.push(req.query.category);
    }
    if (req.query.emergency === '1') where.push('c.emergency = 1');
    let rows = db.prepare(`${contactSelect} WHERE ${where.join(' AND ')} ORDER BY c.name COLLATE NOCASE, c.id`).all(...args);
    if (req.query.favorite === '1' || req.query.favorite === 'true') rows = rows.filter((c) => c.is_fav);
    res.json(rows.map((row) => contactOut(row, req)));
  });

  const setFavorite = (req, contactId, fav) => {
    if (fav) db.prepare('INSERT OR IGNORE INTO vault_contact_favorites (contact_id, user_id) VALUES (?, ?)').run(contactId, req.user.id);
    else db.prepare('DELETE FROM vault_contact_favorites WHERE contact_id = ? AND user_id = ?').run(contactId, req.user.id);
  };
  const notifyEmergency = (req, row) => ctx.notify({
    familyId: req.family.id, userIds: memberIds(db, req.family.id), module: 'vault', excludeUserId: req.user.id,
    title: `New emergency contact: ${row.name}`, body: row.role || row.organization || null, link: `/vault/contacts/${row.id}`,
  });

  r.post('/contacts', (req, res) => {
    const c = contactInput(req.body);
    const fav = bool(req.body?.favorite, 'Favorite');
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO vault_contacts (family_id, name, category, role, organization, phones, email, address, website, notes, emergency, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(req.family.id, c.name, c.category, c.role, c.organization, c.phones, c.email, c.address, c.website, c.notes, c.emergency ?? 0, req.user.id);
    if (fav) setFavorite(req, Number(lastInsertRowid), true);
    const row = getContact(req, lastInsertRowid);
    ctx.broadcast(req.family.id, 'vault.contact.created', { id: row.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'vault', verb: 'added_contact', entityId: row.id,
      summary: row.emergency ? `added ${row.name} to emergency contacts` : `added ${row.name} to Contacts`, link: `/vault/contacts/${row.id}`,
    });
    if (row.emergency) notifyEmergency(req, row);
    res.status(201).json(contactOut(row, req));
  });

  r.get('/contacts/:id', (req, res) => res.json(contactOut(getContact(req, req.params.id), req)));

  r.patch('/contacts/:id', (req, res) => {
    const before = getContact(req, req.params.id);
    const c = contactInput(req.body, { partial: true });
    const fav = bool(req.body?.favorite, 'Favorite');
    // Favorites are per person, so anyone (children too) may star a contact for themselves.
    const keys = Object.keys(c);
    if (keys.length) {
      forbidUnless(canManage(req, before.created_by));
      db.prepare(`UPDATE vault_contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND family_id = ?`)
        .run(...keys.map((k) => c[k]), nowIso(), before.id, req.family.id);
    }
    if (fav !== undefined) setFavorite(req, before.id, fav);
    const row = getContact(req, before.id);
    if (keys.length) ctx.broadcast(req.family.id, 'vault.contact.updated', { id: row.id });
    else ctx.sendToUsers([req.user.id], 'vault.contact.updated', { id: row.id }, req.family.id);
    if (row.emergency && !before.emergency) notifyEmergency(req, row);
    res.json(contactOut(row, req));
  });

  r.delete('/contacts/:id', (req, res) => {
    const row = getContact(req, req.params.id);
    forbidUnless(canManage(req, row.created_by), 'Only adults or the person who added this contact can delete it');
    db.prepare('DELETE FROM vault_contacts WHERE id = ? AND family_id = ?').run(row.id, req.family.id);
    scrubEntity(ctx, req.family.id, ['added_contact'], row.id, `/vault/contacts/${row.id}`);
    ctx.broadcast(req.family.id, 'vault.contact.deleted', { id: row.id });
    res.json({ ok: true });
  });

  // ---- folders --------------------------------------------------------------------------------
  const folderQuery = (req, extra = '') => {
    const v = visible(req, 'd');
    return {
      sql: `SELECT f.*, COUNT(d.id) AS doc_count, COALESCE(SUM(d.size), 0) AS total_size, MAX(d.created_at) AS last_upload_at
              FROM vault_folders f
              LEFT JOIN vault_documents d ON d.folder_id = f.id AND ${v.sql}
             WHERE f.family_id = ? ${extra} GROUP BY f.id ORDER BY f.name COLLATE NOCASE`,
      args: [...v.args, req.family.id],
    };
  };
  const folderOut = (row, req) => ({ ...row, can_edit: canManage(req, row.created_by) });
  const oneFolder = (req, id) => {
    const q = folderQuery(req, 'AND f.id = ?');
    return folderOut(db.prepare(q.sql).get(...q.args, id), req);
  };

  r.get('/folders', (req, res) => {
    const q = folderQuery(req);
    const v = visible(req);
    const unfiled = db.prepare(`SELECT COUNT(*) AS doc_count, COALESCE(SUM(size), 0) AS total_size FROM vault_documents
                                  WHERE family_id = ? AND folder_id IS NULL AND ${v.sql}`).get(req.family.id, ...v.args);
    res.json({ folders: db.prepare(q.sql).all(...q.args).map((f) => folderOut(f, req)), unfiled });
  });

  const folderInput = (body = {}, partial = false) => {
    const out = {};
    if (!partial || body.name !== undefined) out.name = cleanStr(body.name, { field: 'Folder name', required: true, max: 60 });
    if (!partial || body.color !== undefined) {
      const color = body.color ?? '#978365';
      if (!FOLDER_COLORS.test(color)) throw httpError(400, 'Color must be a hex color like #5B5BD6');
      out.color = color;
    }
    if (!partial || body.icon !== undefined) {
      const icon = body.icon ?? 'folder';
      if (!FOLDER_ICONS.includes(icon)) throw httpError(400, 'Unknown folder icon');
      out.icon = icon;
    }
    return out;
  };
  const assertUniqueFolder = (req, nameVal, exceptId = 0) => {
    const dup = db.prepare('SELECT id FROM vault_folders WHERE family_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(req.family.id, nameVal, exceptId);
    if (dup) throw httpError(409, `There is already a folder called “${nameVal}”`);
  };

  r.post('/folders', (req, res) => {
    const f = folderInput(req.body);
    assertUniqueFolder(req, f.name);
    const { lastInsertRowid } = db.prepare('INSERT INTO vault_folders (family_id, name, color, icon, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(req.family.id, f.name, f.color, f.icon, req.user.id);
    const row = oneFolder(req, lastInsertRowid);
    ctx.broadcast(req.family.id, 'vault.folder.created', { id: row.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'vault', verb: 'created_folder', entityId: row.id,
      summary: `created the folder ${row.name} in Documents`, link: `/vault/docs/f/${row.id}`,
    });
    res.status(201).json(row);
  });

  r.get('/folders/:id', (req, res) => res.json(oneFolder(req, getFolder(req, req.params.id).id)));

  r.patch('/folders/:id', (req, res) => {
    const before = getFolder(req, req.params.id);
    forbidUnless(canManage(req, before.created_by));
    const f = folderInput(req.body, true);
    if (f.name) assertUniqueFolder(req, f.name, before.id);
    const keys = Object.keys(f);
    if (keys.length) {
      db.prepare(`UPDATE vault_folders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND family_id = ?`)
        .run(...keys.map((k) => f[k]), nowIso(), before.id, req.family.id);
    }
    ctx.broadcast(req.family.id, 'vault.folder.updated', { id: before.id });
    res.json(oneFolder(req, before.id));
  });

  /** Deleting a folder never deletes files (some may be other people's private documents): they become unfiled. */
  r.delete('/folders/:id', (req, res) => {
    const f = getFolder(req, req.params.id);
    forbidUnless(canManage(req, f.created_by), 'Only adults or the person who created this folder can delete it');
    const moved = ctx.tx(db, () => {
      const n = Number(db.prepare('UPDATE vault_documents SET folder_id = NULL, updated_at = ? WHERE folder_id = ? AND family_id = ?').run(nowIso(), f.id, req.family.id).changes);
      db.prepare('DELETE FROM vault_folders WHERE id = ? AND family_id = ?').run(f.id, req.family.id);
      return n;
    });
    scrubEntity(ctx, req.family.id, ['created_folder'], f.id, `/vault/docs/f/${f.id}`);
    ctx.broadcast(req.family.id, 'vault.folder.deleted', { id: f.id });
    res.json({ ok: true, moved });
  });

  // ---- documents ------------------------------------------------------------------------------
  r.get('/documents', (req, res) => {
    const v = visible(req, 'd');
    const where = ['d.family_id = ?', v.sql];
    const args = [req.family.id, ...v.args];
    const folder = req.query.folder_id;
    if (folder === 'none' || folder === 'null') where.push('d.folder_id IS NULL');
    else if (folder !== undefined && folder !== '') {
      where.push('d.folder_id = ?');
      args.push(getFolder(req, folder).id);
    }
    // Notes are sealed, so the text filter runs in JS after decrypting.
    const term = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100).toLowerCase() : '';
    if (req.query.private === '1') where.push('d.is_private = 1');
    if (req.query.mine === '1') {
      where.push('d.owner_id = ?');
      args.push(req.user.id);
    }
    const sort = { name: 'd.name COLLATE NOCASE ASC', size: 'd.size DESC', recent: 'd.created_at DESC' }[req.query.sort] ?? 'd.created_at DESC';
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 500);
    // ponytail: with a search term every visible row is decrypted and filtered in JS (fine for a
    // family's few hundred documents); add a plaintext search index if vaults grow to many thousands.
    const rows = db.prepare(`SELECT d.*, f.name AS folder_name, f.color AS folder_color FROM vault_documents d LEFT JOIN vault_folders f ON f.id = d.folder_id
                              WHERE ${where.join(' AND ')} ORDER BY ${sort}, d.id DESC ${term ? '' : `LIMIT ${limit}`}`).all(...args)
      .map((row) => openDoc(box, row))
      .filter((d) => !term || [d.name, d.original_name, d.notes ?? ''].some((t) => t.toLowerCase().includes(term)))
      .slice(0, limit);
    res.json(rows.map((row) => documentOut(row, req)));
  });

  /** Coalesce a burst of uploads into one Wall entry ("uploaded 4 documents to Medical"). */
  function logUpload(req, doc) {
    const cutoff = new Date(Date.now() - BURST_MS).toISOString();
    const recent = db.prepare(
      `SELECT a.id, d.created_at AS anchor_at FROM activity a JOIN vault_documents d ON d.id = a.entity_id
        WHERE a.family_id = ? AND a.user_id = ? AND a.module = 'vault' AND a.verb = 'uploaded' AND a.created_at > ?
          AND d.folder_id IS ? AND d.${familyVisibleDoc.replace(/ AND /, ' AND d.')}
        ORDER BY a.id DESC LIMIT 1`,
    ).get(req.family.id, req.user.id, cutoff, doc.folder_id);
    const where = doc.folder_name ? ` to ${doc.folder_name}` : '';
    if (recent) {
      const n = db.prepare(`SELECT COUNT(*) n FROM vault_documents WHERE family_id = ? AND owner_id = ? AND folder_id IS ? AND ${familyVisibleDoc} AND created_at >= ?`)
        .get(req.family.id, req.user.id, doc.folder_id, recent.anchor_at).n;
      db.prepare('UPDATE activity SET summary = ?, link = ? WHERE id = ?')
        .run(`uploaded ${n} documents${where}`, doc.folder_id ? `/vault/docs/f/${doc.folder_id}` : '/vault/docs', recent.id);
      ctx.broadcast(req.family.id, 'activity.updated', { id: recent.id });
      return false;
    }
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'vault', verb: 'uploaded', entityId: doc.id,
      summary: `uploaded ${doc.name}${where}`, link: `/vault/docs/d/${doc.id}`,
    });
    return true;
  }

  function announceShared(req, doc) {
    ctx.notify({
      familyId: req.family.id, userIds: memberIds(db, req.family.id), module: 'vault', excludeUserId: req.user.id,
      title: `${req.user.name.split(' ')[0]} shared a document`, body: doc.folder_name ? `${doc.name} · ${doc.folder_name}` : doc.name,
      link: `/vault/docs/d/${doc.id}`,
    });
  }

  r.post('/documents', upload.single('file'), (req, res) => {
    if (!req.file) throw httpError(400, 'Please choose a file to upload');
    if (!req.file.size) throw httpError(400, 'That file is empty');
    const original = fixFilename(req.file.originalname).slice(0, 200) || 'Untitled';
    const ext = extOf(original);
    const baseName = ext ? original.slice(0, -(ext.length + 1)) : original;
    const docName = cleanStr(req.body?.name ?? baseName, { field: 'Name', max: 120 }) || 'Untitled';
    const folderId = folderFromBody(req, req.body?.folder_id) ?? null;
    const visibility = visibilityInput(req.body ?? {}, req) ?? 'family';
    const cols = visibilityCols(visibility);
    const notes = sealInput(cleanStr(req.body?.notes, { field: 'Notes', max: 1000 }), 'Notes');
    const expires = cleanExpiry(req.body?.expires_on || undefined) ?? null;
    const mime = typeof req.file.mimetype === 'string' ? req.file.mimetype.slice(0, 100) : 'application/octet-stream';

    const key = writeVaultFile(ctx.uploadDir, req.family.id, box, req.file.buffer, ext);
    let id;
    try {
      ({ lastInsertRowid: id } = db.prepare(
        `INSERT INTO vault_documents (family_id, folder_id, name, original_name, ext, mime, size, storage_key, owner_id, is_private, adults_only, notes, expires_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(req.family.id, folderId, docName, original, ext, mime, req.file.size, key, req.user.id, cols.is_private, cols.adults_only, notes, expires));
    } catch (err) {
      removeVaultFile(ctx.uploadDir, req.family.id, key);
      throw err;
    }
    const row = getDoc(req, id);
    emit(req, 'vault.document.created', { id: row.id, visibility, ownerId: req.user.id });
    if (visibility === 'family' && logUpload(req, row)) announceShared(req, row);
    res.status(201).json(documentOut(row, req));
  });

  r.get('/documents/:id', (req, res) => res.json(documentOut(getDoc(req, req.params.id), req)));

  r.get('/documents/:id/file', (req, res) => {
    const doc = getDoc(req, req.params.id);
    const abs = vaultPath(ctx.uploadDir, req.family.id, doc.storage_key);
    if (!abs || !fs.existsSync(abs)) throw httpError(404, 'This file is missing');
    const { type, inline } = serveTypeFor(doc.ext);
    const asDownload = req.query.download === '1' || !inline;
    res.set({
      'Content-Type': type,
      'Content-Disposition': contentDisposition(asDownload ? 'attachment' : 'inline', downloadName(doc.name, doc.ext)),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
      // PDFs need the browser's viewer (blocked under `sandbox`); everything else is fully sandboxed.
      'Content-Security-Policy': doc.ext === 'pdf'
        ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'"
        : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Accept-Ranges': 'bytes',
      // A stored file never changes (each upload gets a fresh key), so a hash of the key identifies the content.
      ETag: `"${crypto.createHash('sha256').update(doc.storage_key).digest('base64url').slice(0, 27)}"`,
    });
    if (req.fresh) return res.status(304).end(); // the browser's copy is current: skip decrypting
    const file = readVaultFile(ctx.uploadDir, req.family.id, box, doc.storage_key);
    if (!file) throw httpError(404, 'This file is missing');
    // Single byte ranges for media seeking / PDF viewers. Multi-range or malformed headers get the
    // whole file (allowed by RFC 9110), as does an If-Range that doesn't match our ETag.
    const ranges = req.headers['if-range'] && req.headers['if-range'] !== res.get('ETag') ? undefined : req.range(file.length, { combine: true });
    if (ranges === -1) {
      res.set('Content-Range', `bytes */${file.length}`);
      return res.status(416).end();
    }
    if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
      const { start, end } = ranges[0];
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${file.length}`);
      return res.send(file.subarray(start, end + 1));
    }
    res.send(file);
  });

  r.patch('/documents/:id', (req, res) => {
    const before = getDoc(req, req.params.id);
    const body = req.body ?? {};
    const isOwner = before.owner_id === req.user.id;
    forbidUnless(canManage(req, before.owner_id), 'Only adults or the person who uploaded this document can change it');
    const sets = {};
    if (body.name !== undefined) sets.name = cleanStr(body.name, { field: 'Name', required: true, max: 120 });
    const folderId = folderFromBody(req, body.folder_id);
    if (folderId !== undefined) sets.folder_id = folderId;
    if (body.notes !== undefined) {
      const notes = cleanStr(body.notes, { field: 'Notes', max: 1000 });
      if (!before.unreadable) sets.notes = sealInput(notes, 'Notes');
      // Unreadable: an empty value is just the placeholder sent back; anything else would destroy the ciphertext.
      else if (notes) throw httpError(409, "This document's notes can't be decrypted — restore the encryption key or a backup before editing them");
    }
    const expires = cleanExpiry(body.expires_on);
    if (expires !== undefined) {
      sets.expires_on = expires;
      if (expires !== before.expires_on) sets.expiry_notified_at = null;
    }
    const prevVis = visibilityOf(before);
    const vis = visibilityInput(body, req);
    if (vis !== undefined && vis !== prevVis) {
      forbidUnless(isOwner, 'Only the person who uploaded this document can change who sees it');
      Object.assign(sets, visibilityCols(vis));
    }
    const keys = Object.keys(sets);
    if (keys.length) {
      db.prepare(`UPDATE vault_documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND family_id = ?`)
        .run(...keys.map((k) => sets[k]), nowIso(), before.id, req.family.id);
    }
    const row = getDoc(req, before.id);
    const nowVis = visibilityOf(row);
    emit(req, 'vault.document.updated', { id: row.id, visibility: nowVis, ownerId: row.owner_id, before: prevVis });
    if (prevVis === 'family' && nowVis !== 'family') {
      scrubDocument(ctx, req.family.id, before, { keepUserIds: audience(db, req.family.id, nowVis, row.owner_id) });
    } else if (RANK[nowVis] < RANK[prevVis]) {
      // e.g. adults → only me: other adults' notifications (expiry reminders, "shared") must go too.
      scrubNotifications(ctx, req.family.id, `/vault/docs/d/${row.id}`, audience(db, req.family.id, nowVis, row.owner_id));
    } else if (prevVis !== 'family' && nowVis === 'family') {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'vault', verb: 'shared', entityId: row.id,
        summary: `shared ${row.name}${row.folder_name ? ` in ${row.folder_name}` : ''}`, link: `/vault/docs/d/${row.id}`,
      });
      announceShared(req, row);
    }
    res.json(documentOut(row, req));
  });

  r.delete('/documents/:id', (req, res) => {
    const doc = getDoc(req, req.params.id);
    forbidUnless(canManage(req, doc.owner_id), 'Only adults or the person who uploaded this document can delete it');
    db.prepare('DELETE FROM vault_documents WHERE id = ? AND family_id = ?').run(doc.id, req.family.id);
    removeVaultFile(ctx.uploadDir, req.family.id, doc.storage_key);
    scrubDocument(ctx, req.family.id, doc);
    emit(req, 'vault.document.deleted', { id: doc.id, visibility: visibilityOf(doc), ownerId: doc.owner_id });
    res.json({ ok: true });
  });

  // ---- notes ----------------------------------------------------------------------------------
  r.get('/notes', (req, res) => {
    const v = visible(req);
    const rows = db.prepare(`SELECT * FROM vault_notes WHERE family_id = ? AND ${v.sql} ORDER BY updated_at DESC, id DESC`).all(req.family.id, ...v.args);
    res.json(rows.map((row) => noteOut(openNote(box, row), req)));
  });

  const noteInput = (body = {}, partial = false) => {
    const out = {};
    if (!partial || body.title !== undefined) out.title = cleanStr(body.title, { field: 'Title', required: true, max: 80 });
    if (!partial || body.kind !== undefined) {
      const kind = body.kind ?? 'other';
      if (!NOTE_KINDS.includes(kind)) throw httpError(400, 'Unknown note type');
      out.kind = kind;
    }
    const fields = cleanNoteFields(body.fields);
    if (fields !== undefined) out.fields = JSON.stringify(fields);
    else if (!partial) out.fields = '[]';
    if (!partial || body.body !== undefined) out.body = cleanStr(body.body, { field: 'Note', max: 2000 });
    if (!partial && !JSON.parse(out.fields).length && !out.body) throw httpError(400, 'Add at least one field or some text');
    return out;
  };

  r.post('/notes', (req, res) => {
    const n = noteInput(req.body);
    const visibility = visibilityInput(req.body ?? {}, req) ?? 'family';
    const cols = visibilityCols(visibility);
    const { lastInsertRowid } = db.prepare('INSERT INTO vault_notes (family_id, title, kind, fields, body, is_private, adults_only, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.family.id, n.title, n.kind, box.seal(n.fields), sealInput(n.body, 'Note'), cols.is_private, cols.adults_only, req.user.id);
    const row = getNote(req, lastInsertRowid);
    emit(req, 'vault.note.created', { id: row.id, visibility, ownerId: req.user.id });
    if (visibility === 'family') {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'vault', verb: 'added_note', entityId: row.id,
        summary: `saved the info card ${row.title}`, link: `/vault/notes/${row.id}`,
      });
    }
    res.status(201).json(noteOut(row, req));
  });

  r.get('/notes/:id', (req, res) => res.json(noteOut(getNote(req, req.params.id), req)));
  r.get('/notes/:id/reveal', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(noteOut(getNote(req, req.params.id), req, { reveal: true }));
  });

  r.patch('/notes/:id', (req, res) => {
    const before = getNote(req, req.params.id);
    forbidUnless(canManage(req, before.owner_id), 'Only adults or the person who added this card can change it');
    const n = noteInput(req.body, true);
    const prevVis = visibilityOf(before);
    const vis = visibilityInput(req.body ?? {}, req);
    if (vis !== undefined && vis !== prevVis) {
      forbidUnless(before.owner_id === req.user.id, 'Only the person who added this card can change who sees it');
      Object.assign(n, visibilityCols(vis));
    }
    if (before.unreadable) {
      // Keep the stored ciphertext: empty fields/body are the placeholders sent back, real content is refused.
      if ((n.fields !== undefined && n.fields !== '[]') || n.body) {
        throw httpError(409, "This card can't be decrypted — restore the encryption key or a backup before editing its contents");
      }
      delete n.fields;
      delete n.body;
    }
    const merged = { fields: n.fields ?? before.fields, body: n.body !== undefined ? n.body : before.body };
    if (!before.unreadable && !parseList(merged.fields, []).length && !merged.body) throw httpError(400, 'Add at least one field or some text');
    if (n.fields !== undefined) n.fields = box.seal(n.fields);
    if (n.body !== undefined) n.body = sealInput(n.body, 'Note');
    const keys = Object.keys(n);
    if (keys.length) {
      db.prepare(`UPDATE vault_notes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND family_id = ?`)
        .run(...keys.map((k) => n[k]), nowIso(), before.id, req.family.id);
    }
    const row = getNote(req, before.id);
    const nowVis = visibilityOf(row);
    emit(req, 'vault.note.updated', { id: row.id, visibility: nowVis, ownerId: row.owner_id, before: prevVis });
    if (prevVis === 'family' && nowVis !== 'family') {
      scrubEntity(ctx, req.family.id, ['added_note'], row.id, `/vault/notes/${row.id}`, audience(db, req.family.id, nowVis, row.owner_id));
    } else if (RANK[nowVis] < RANK[prevVis]) {
      scrubNotifications(ctx, req.family.id, `/vault/notes/${row.id}`, audience(db, req.family.id, nowVis, row.owner_id));
    }
    res.json(noteOut(row, req));
  });

  r.delete('/notes/:id', (req, res) => {
    const row = getNote(req, req.params.id);
    forbidUnless(canManage(req, row.owner_id), 'Only adults or the person who added this card can delete it');
    db.prepare('DELETE FROM vault_notes WHERE id = ? AND family_id = ?').run(row.id, req.family.id);
    scrubEntity(ctx, req.family.id, ['added_note'], row.id, `/vault/notes/${row.id}`);
    emit(req, 'vault.note.deleted', { id: row.id, visibility: visibilityOf(row), ownerId: row.owner_id });
    res.json({ ok: true });
  });

  // Expiry reminders: a light hourly sweep (plus one shortly after boot).
  const sweep = () => {
    try {
      checkExpiries(ctx);
    } catch (err) {
      if (!/not open|closed/i.test(err.message)) console.error('[vault] expiry check failed:', err.message);
    }
  };
  setTimeout(sweep, 15_000).unref?.();
  setInterval(sweep, 60 * 60_000).unref?.();

  return r;
}

// ---------------------------------------------------------------------------------------------
// Encryption at rest: one-time migration

/**
 * Seal info cards, document notes and vault files stored before encryption at rest. Runs at every
 * startup but only touches plaintext (isSealed / sealed file header), so a second run is a no-op;
 * the DB part is one transaction and each file is replaced atomically, so a crash is harmless.
 * The old plaintext would linger in the database file's free pages, so the sealing transaction also
 * records `vacuum_pending` in app_meta, cleared only once VACUUM succeeded (retried every start).
 * ponytail: scans every note/document row and vault file header at startup (cheap for family-sized
 * vaults); keep a "done" flag in app_meta if that ever shows up in boot time.
 */
export function sealLegacyVault(ctx) {
  const { db, box } = ctx;
  let sealed = 0;
  ctx.tx(db, () => {
    const setNote = db.prepare('UPDATE vault_notes SET fields = ?, body = ? WHERE id = ?');
    for (const n of db.prepare('SELECT id, fields, body FROM vault_notes').all()) {
      if (!box.isSealed(n.fields) || (n.body != null && !box.isSealed(n.body))) sealed += Number(setNote.run(box.seal(n.fields), box.seal(n.body), n.id).changes);
    }
    const setDoc = db.prepare('UPDATE vault_documents SET notes = ? WHERE id = ?');
    for (const d of db.prepare('SELECT id, notes FROM vault_documents WHERE notes IS NOT NULL').all()) {
      if (!box.isSealed(d.notes)) sealed += Number(setDoc.run(box.seal(d.notes), d.id).changes);
    }
    if (sealed) db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('vacuum_pending', ?)").run(new Date().toISOString());
  });
  if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'vacuum_pending'").get()) {
    try {
      db.exec('VACUUM');
      db.exec("DELETE FROM app_meta WHERE key = 'vacuum_pending'");
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.error(`[vault] could not compact the database (old plaintext may remain until the next start): ${err.message}`);
    }
  }
  sealLegacyFiles(ctx.uploadDir, box);
}

// ---------------------------------------------------------------------------------------------
// Expiring documents

/** Documents the requester can see that expire within the notice window (or expired in the last 30 days). */
export function expiringDocs(ctx, req, days = EXPIRY_NOTICE_DAYS) {
  const today = ctx.time.today(req);
  const v = visible(req, 'd');
  return ctx.db.prepare(
    `SELECT d.*, f.name AS folder_name, f.color AS folder_color FROM vault_documents d LEFT JOIN vault_folders f ON f.id = d.folder_id
      WHERE d.family_id = ? AND ${v.sql} AND d.expires_on IS NOT NULL AND d.expires_on <= ? AND d.expires_on >= ?
      ORDER BY d.expires_on, d.id`,
  ).all(req.family.id, ...v.args, shiftDate(today, days), shiftDate(today, -30));
}

/**
 * Notify once per document when it enters the 30-day window (in the family's own time zone):
 * the owner for private documents, the owner + every adult for shared / adults-only ones.
 */
export function checkExpiries(ctx) {
  const candidates = ctx.db.prepare(
    'SELECT * FROM vault_documents WHERE expires_on IS NOT NULL AND expiry_notified_at IS NULL',
  ).all();
  let sent = 0;
  for (const d of candidates) {
    const today = ctx.time.todayForFamily(d.family_id);
    const days = daysBetween(today, d.expires_on);
    if (days > EXPIRY_NOTICE_DAYS || days < -1) continue;
    const when = days < 0 ? 'has expired' : days === 0 ? 'expires today' : days === 1 ? 'expires tomorrow' : `expires in ${days} days`;
    const recipients = d.is_private ? [d.owner_id].filter(Boolean) : audience(ctx.db, d.family_id, 'adults', d.owner_id);
    ctx.notify({ familyId: d.family_id, userIds: recipients, module: 'vault', title: `${d.name} ${when}`, body: `Renewal due ${d.expires_on}`, link: `/vault/docs/d/${d.id}` });
    ctx.db.prepare('UPDATE vault_documents SET expiry_notified_at = ? WHERE id = ?').run(nowIso(), d.id);
    sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------------------------------
// Hooks

export function search(ctx, familyId, term, req) {
  const like = term.slice(0, 100);
  const me = req?.user?.id ?? 0;
  const adult = req && isAdult(req) ? 1 : 0;
  const contacts = ctx.db.prepare(
    `SELECT c.id, c.name, c.role, c.organization, c.phones,
            (SELECT 1 FROM vault_contact_favorites v WHERE v.contact_id = c.id AND v.user_id = ?) AS fav
       FROM vault_contacts c
      WHERE c.family_id = ? AND (search_match(c.name, ?) OR search_match(IFNULL(c.organization,''), ?) OR search_match(IFNULL(c.role,''), ?) OR search_match(c.phones, ?))
      ORDER BY c.emergency DESC, fav DESC, c.name COLLATE NOCASE LIMIT 5`,
  ).all(me, familyId, like, like, like, like).map((c) => {
    const phone = parseList(c.phones, [])[0]?.number;
    return { title: c.name, subtitle: [c.role || c.organization, phone].filter(Boolean).join(' · ') || 'Contact', link: `/vault/contacts/${c.id}` };
  });
  const docs = ctx.db.prepare(
    `SELECT d.id, d.name, d.ext, d.is_private, d.adults_only, f.name AS folder_name FROM vault_documents d LEFT JOIN vault_folders f ON f.id = d.folder_id
      WHERE d.family_id = ? AND (d.owner_id = ? OR (d.is_private = 0 AND (d.adults_only = 0 OR ?)))
        AND (search_match(d.name, ?) OR search_match(d.original_name, ?))
      ORDER BY d.created_at DESC LIMIT 4`,
  ).all(familyId, me, adult, like, like).map((d) => ({
    title: d.name,
    subtitle: [d.ext ? d.ext.toUpperCase() : 'File', d.folder_name, d.is_private ? 'Private' : d.adults_only ? 'Adults only' : null].filter(Boolean).join(' · '),
    link: `/vault/docs/d/${d.id}`,
  }));
  const folders = ctx.db.prepare(`SELECT id, name FROM vault_folders WHERE family_id = ? AND search_match(name, ?) LIMIT 2`)
    .all(familyId, like).map((f) => ({ title: f.name, subtitle: 'Documents folder', link: `/vault/docs/f/${f.id}` }));
  // Info cards match on their title only — secret values are never searchable.
  const notes = ctx.db.prepare(
    `SELECT id, title, is_private, adults_only FROM vault_notes
      WHERE family_id = ? AND (owner_id = ? OR (is_private = 0 AND (adults_only = 0 OR ?))) AND search_match(title, ?) LIMIT 3`,
  ).all(familyId, me, adult, like).map((n) => ({
    title: n.title, subtitle: n.is_private ? 'Private info card' : n.adults_only ? 'Info card · adults only' : 'Info card', link: `/vault/notes/${n.id}`,
  }));
  return [...contacts, ...docs, ...folders, ...notes].slice(0, 8);
}

export function dashboard(ctx, req) {
  const emergency = ctx.db.prepare('SELECT id, name, role, organization, phones FROM vault_contacts WHERE family_id = ? AND emergency = 1 ORDER BY name COLLATE NOCASE LIMIT 6')
    .all(req.family.id).map((c) => ({ id: c.id, name: c.name, role: c.role || c.organization, phone: parseList(c.phones, [])[0]?.number ?? null }));
  const expiring = expiringDocs(ctx, req).map((d) => ({ id: d.id, name: d.name, expires_on: d.expires_on, visibility: visibilityOf(d) }));
  return { emergency, expiring };
}

export async function seed(ctx, args) {
  return seedVault(ctx, args);
}
