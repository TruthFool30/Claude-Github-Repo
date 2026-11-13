// Data access + JSON shaping for the messages module.
// Every function takes the DatabaseSync handle and is scoped by family / participant.
import { firstName, httpError } from '../../util.js';
import { isManagedEmail } from '../../auth.js';

export const KINDS = ['family', 'direct', 'group'];
export const PAGE_SIZE = 40;
export const MAX_BODY = 4000;
export const MAX_ATTACHMENTS = 6;
export const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/;

const snippet = (s, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export { snippet };

/** SQL: message `m` falls in a period when `viewer` was out of the group (bind the viewer id). */
export const NOT_HIDDEN = `NOT EXISTS (SELECT 1 FROM msg_gaps g WHERE g.conversation_id = m.conversation_id AND g.user_id = ?
  AND m.id > g.from_id AND (g.to_id IS NULL OR m.id <= g.to_id))`;

export function isHiddenFor(db, messageId, viewerId) {
  return !!db.prepare(`SELECT 1 FROM msg_messages m WHERE m.id = ? AND NOT (${NOT_HIDDEN})`).get(messageId, viewerId);
}

/** Public URL of an attachment: served by the module after a participant check. */
export const attachmentUrl = (id, familyId) => `/api/messages/attachments/${id}?family_id=${familyId}`;

/** Current family members (id, name, color, avatar_url, role, nickname, managed). */
export function familyMembers(db, familyId) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.color, u.avatar_url, u.email, m.role, m.nickname
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = ? ORDER BY m.created_at, u.id`,
    )
    .all(familyId)
    .map(({ email, ...u }) => ({ ...u, managed: !email || isManagedEmail(email) }));
}

/**
 * The auto-created "Family" conversation: created on first use and kept in sync with the
 * family's memberships (people who join later are added with nothing unread).
 */
/**
 * Membership "signature" per family (count + newest membership), per database. The participant
 * sync below only has work to do when memberships changed, so /unread polls skip it otherwise.
 */
const synced = new WeakMap();
function membershipSignature(db, familyId) {
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM memberships WHERE family_id = ?').get(familyId);
  return `${r.n}|${r.latest}`;
}

export function ensureFamilyConversation(db, familyId) {
  let conv = db.prepare("SELECT id FROM msg_conversations WHERE family_id = ? AND kind = 'family'").get(familyId);
  if (!conv) {
    const created = db.prepare('SELECT created_by FROM families WHERE id = ?').get(familyId);
    const { lastInsertRowid } = db
      .prepare("INSERT OR IGNORE INTO msg_conversations (family_id, kind, name, created_by) VALUES (?, 'family', 'Family', ?)")
      .run(familyId, created?.created_by ?? null);
    conv = lastInsertRowid
      ? { id: Number(lastInsertRowid) }
      : db.prepare("SELECT id FROM msg_conversations WHERE family_id = ? AND kind = 'family'").get(familyId);
  }
  let seen = synced.get(db);
  if (!seen) synced.set(db, (seen = new Map()));
  const sig = membershipSignature(db, familyId);
  if (seen.get(familyId) === `${conv.id}|${sig}`) return conv.id;
  syncRejoined(db, familyId);
  db.prepare(
    `INSERT OR IGNORE INTO msg_participants (conversation_id, user_id, last_read_id)
     SELECT ?, m.user_id, COALESCE((SELECT MAX(id) FROM msg_messages WHERE conversation_id = ?), 0)
       FROM memberships m WHERE m.family_id = ?`,
  ).run(conv.id, conv.id, familyId);
  seen.set(familyId, `${conv.id}|${sig}`);
  return conv.id;
}

/**
 * Lifecycle hook (core → module): someone left or was removed from the family. Open a hidden period
 * starting now in every conversation they were in, so nothing said while they are away is shown if
 * they come back. They are taken out of groups (re-adding closes the gap).
 */
export function recordMemberLeft(db, familyId, userId) {
  const rows = db
    .prepare(
      `SELECT p.conversation_id, c.kind FROM msg_participants p JOIN msg_conversations c ON c.id = p.conversation_id
        WHERE c.family_id = ? AND p.user_id = ?`,
    )
    .all(familyId, userId);
  const lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE conversation_id = ?');
  const openGap = db.prepare('INSERT INTO msg_gaps (conversation_id, user_id, from_id, to_id) VALUES (?, ?, ?, NULL)');
  const hasOpen = db.prepare('SELECT 1 FROM msg_gaps WHERE conversation_id = ? AND user_id = ? AND to_id IS NULL');
  const emptied = [];
  for (const r of rows) {
    if (!hasOpen.get(r.conversation_id, userId)) openGap.run(r.conversation_id, userId, lastId.get(r.conversation_id).id);
    if (r.kind !== 'group') continue;
    db.prepare('DELETE FROM msg_participants WHERE conversation_id = ? AND user_id = ?').run(r.conversation_id, userId);
    // Same rule as leaving a group explicitly: a group nobody (in the family) is left in is deleted.
    if (!participants(db, r.conversation_id, familyId).length) {
      const files = db
        .prepare('SELECT a.url FROM msg_attachments a JOIN msg_messages m ON m.id = a.message_id WHERE m.conversation_id = ?')
        .all(r.conversation_id)
        .map((f) => f.url);
      db.prepare('DELETE FROM msg_conversations WHERE id = ?').run(r.conversation_id);
      emptied.push({ conversationId: r.conversation_id, files });
    }
  }
  return emptied;
}

/** Lifecycle hook: someone (re)joined. Close their Family chat / DM gaps at the current message. */
export function recordMemberJoined(db, familyId, userId) {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT g.id, g.conversation_id FROM msg_gaps g JOIN msg_conversations c ON c.id = g.conversation_id
        WHERE c.family_id = ? AND g.user_id = ? AND g.to_id IS NULL AND c.kind IN ('family','direct')`,
    )
    .all(familyId, userId);
  for (const r of rows) {
    const lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE conversation_id = ?').get(r.conversation_id).id;
    db.prepare('UPDATE msg_gaps SET to_id = ? WHERE id = ?').run(lastId, r.id);
    // Fresh participant marker (so the fallback sync doesn't treat them as unhandled) and nothing unread.
    db.prepare('UPDATE msg_participants SET joined_at = ?, last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?')
      .run(now, lastId, r.conversation_id, userId);
  }
}

/**
 * People who left the family and joined again keep their old participant rows (the core deletes only
 * the membership). Detect them (membership newer than the participant row) and hide everything they
 * hadn't seen before leaving up to their return: a closed gap for the Family chat and DMs, and for
 * groups they are taken out (an open gap, closed if someone adds them back).
 */
export function syncRejoined(db, familyId) {
  const rows = db
    .prepare(
      `SELECT p.conversation_id, p.user_id, p.last_read_id, c.kind, m.created_at AS member_since
         FROM msg_participants p
         JOIN msg_conversations c ON c.id = p.conversation_id
         JOIN memberships m ON m.family_id = c.family_id AND m.user_id = p.user_id
        WHERE c.family_id = ? AND p.joined_at < m.created_at`,
    )
    .all(familyId);
  for (const r of rows) {
    const toId = db
      .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE conversation_id = ? AND created_at <= ?')
      .get(r.conversation_id, r.member_since).id;
    if (r.kind === 'group') {
      db.prepare('DELETE FROM msg_participants WHERE conversation_id = ? AND user_id = ?').run(r.conversation_id, r.user_id);
      db.prepare('INSERT INTO msg_gaps (conversation_id, user_id, from_id, to_id) VALUES (?, ?, ?, NULL)').run(r.conversation_id, r.user_id, r.last_read_id);
    } else {
      if (toId > r.last_read_id) {
        db.prepare('INSERT INTO msg_gaps (conversation_id, user_id, from_id, to_id) VALUES (?, ?, ?, ?)').run(r.conversation_id, r.user_id, r.last_read_id, toId);
      }
      db.prepare('UPDATE msg_participants SET joined_at = ?, last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?')
        .run(r.member_since, toId, r.conversation_id, r.user_id);
    }
  }
}

const PARTICIPANTS_SQL = `SELECT p.conversation_id, u.id, u.name, u.color, u.avatar_url, u.email, m.role, m.nickname, p.last_read_id, p.joined_at
   FROM msg_participants p
   JOIN users u ON u.id = p.user_id
   JOIN memberships m ON m.user_id = p.user_id AND m.family_id = ?`;
const participantOut = ({ conversation_id, email, ...u }) => ({ ...u, managed: !email || isManagedEmail(email) });

/** Participants of a conversation who are still members of its family. */
export function participants(db, conversationId, familyId) {
  return db
    .prepare(`${PARTICIPANTS_SQL} WHERE p.conversation_id = ? ORDER BY p.joined_at, u.id`)
    .all(familyId, conversationId)
    .map(participantOut);
}

export const participantIds = (db, conversationId, familyId) => participants(db, conversationId, familyId).map((p) => p.id);

/** Load a conversation the user takes part in, or throw 404. */
export function getConversationFor(db, { id, familyId, userId }) {
  const conv = db.prepare('SELECT * FROM msg_conversations WHERE id = ? AND family_id = ?').get(id, familyId);
  if (!conv) throw httpError(404, 'Conversation not found');
  ensureFamilyConversation(db, familyId); // also applies leave/rejoin gaps
  const me = db.prepare('SELECT * FROM msg_participants WHERE conversation_id = ? AND user_id = ?').get(id, userId);
  if (!me) throw httpError(404, 'Conversation not found');
  return { conv, me };
}

/** Display title from the viewer's perspective. */
export function titleFor(conv, people, viewerId) {
  if (conv.kind === 'family') return conv.name || 'Family';
  if (conv.kind === 'group') return conv.name;
  const other = people.find((p) => p.id !== viewerId);
  return other ? other.name : 'Former member';
}

/** SQL: unread text messages from others for participant row `p` (shared by the list and unreadSummary). */
const UNREAD_SQL = `(SELECT COUNT(*) FROM msg_messages m
  WHERE m.conversation_id = p.conversation_id AND m.id > p.last_read_id AND m.kind = 'text'
    AND m.deleted_at IS NULL AND (m.user_id IS NULL OR m.user_id != p.user_id))`;

function unreadFor(db, conversationId, userId, lastReadId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM msg_messages
        WHERE conversation_id = ? AND id > ? AND kind = 'text' AND deleted_at IS NULL
          AND (user_id IS NULL OR user_id != ?)`,
    )
    .get(conversationId, lastReadId, userId).n;
}

function lastMessage(db, conversationId, viewerId) {
  const m = db
    .prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM msg_attachments a WHERE a.message_id = m.id) AS n_attachments
         FROM msg_messages m WHERE m.conversation_id = ? AND ${NOT_HIDDEN} ORDER BY m.id DESC LIMIT 1`,
    )
    .get(conversationId, viewerId ?? 0);
  if (!m) return null;
  return {
    id: m.id,
    user_id: m.user_id,
    kind: m.kind,
    body: m.deleted_at ? '' : snippet(m.body, 140),
    deleted: !!m.deleted_at,
    attachments: m.n_attachments,
    created_at: m.created_at,
  };
}

/** Full conversation summary for one viewer (`pre` = { people, unread } when already loaded in bulk). */
export function shapeConversation(db, conv, viewerId, meRow, pre) {
  const people = pre?.people ?? participants(db, conv.id, conv.family_id);
  const me = meRow ?? db.prepare('SELECT * FROM msg_participants WHERE conversation_id = ? AND user_id = ?').get(conv.id, viewerId);
  return {
    id: conv.id,
    kind: conv.kind,
    name: conv.name,
    emoji: conv.emoji,
    color: conv.color,
    title: titleFor(conv, people, viewerId),
    created_by: conv.created_by,
    created_at: conv.created_at,
    last_activity_at: conv.last_activity_at,
    participants: people,
    last_message: lastMessage(db, conv.id, viewerId),
    unread: pre ? pre.unread : me ? unreadFor(db, conv.id, viewerId, me.last_read_id) : 0,
    last_read_id: me?.last_read_id ?? 0,
    muted: !!me?.muted,
  };
}

/** All of a user's conversations in a family, most recent first. */
export function listConversations(db, familyId, userId) {
  ensureFamilyConversation(db, familyId);
  const rows = db
    .prepare(
      `SELECT c.*, p.last_read_id AS p_last_read_id, p.muted AS p_muted, ${UNREAD_SQL} AS p_unread
         FROM msg_conversations c
         JOIN msg_participants p ON p.conversation_id = c.id AND p.user_id = ?
        WHERE c.family_id = ?
        ORDER BY c.last_activity_at DESC, c.id DESC`,
    )
    .all(userId, familyId);
  // Everyone in all of these conversations at once (same order as participants()).
  const people = new Map(rows.map((r) => [r.id, []]));
  for (const p of db
    .prepare(
      `${PARTICIPANTS_SQL} JOIN msg_conversations c ON c.id = p.conversation_id
        WHERE c.family_id = ? AND EXISTS (SELECT 1 FROM msg_participants me WHERE me.conversation_id = p.conversation_id AND me.user_id = ?)
        ORDER BY p.joined_at, u.id`,
    )
    .all(familyId, familyId, userId)) {
    people.get(p.conversation_id)?.push(participantOut(p));
  }
  return rows.map(({ p_last_read_id, p_muted, p_unread, ...c }) =>
    shapeConversation(db, c, userId, { last_read_id: p_last_read_id, muted: p_muted }, { people: people.get(c.id), unread: p_unread }),
  );
}

/** { total, muted_total, conversations: { [id]: n } } — total excludes muted conversations. */
export function unreadSummary(db, familyId, userId) {
  ensureFamilyConversation(db, familyId);
  const rows = db
    .prepare(
      `SELECT p.conversation_id AS id, p.muted, ${UNREAD_SQL} AS n
         FROM msg_participants p JOIN msg_conversations c ON c.id = p.conversation_id
        WHERE p.user_id = ? AND c.family_id = ?`,
    )
    .all(userId, familyId);
  const conversations = {};
  let total = 0;
  let mutedTotal = 0;
  for (const r of rows) {
    if (!r.n) continue;
    conversations[r.id] = r.n;
    if (r.muted) mutedTotal += r.n;
    else total += r.n;
  }
  return { total, muted_total: mutedTotal, conversations };
}

/** Hydrate message rows with attachments, reactions and the replied-to message. */
export function shapeMessages(db, rows, viewerId = null) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const atts = new Map();
  for (const a of db
    .prepare(`SELECT id, message_id, family_id, mime, width, height, size FROM msg_attachments WHERE message_id IN (${marks}) ORDER BY id`)
    .all(...ids)) {
    const { message_id, family_id, ...rest } = a;
    rest.url = attachmentUrl(a.id, family_id);
    if (!atts.has(message_id)) atts.set(message_id, []);
    atts.get(message_id).push(rest);
  }
  const reacts = new Map();
  for (const r of db
    .prepare(`SELECT message_id, user_id, emoji FROM msg_reactions WHERE message_id IN (${marks}) ORDER BY created_at, user_id`)
    .all(...ids)) {
    if (!reacts.has(r.message_id)) reacts.set(r.message_id, new Map());
    const byEmoji = reacts.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) {
    for (const m of db
      .prepare(
        `SELECT m.id, m.user_id, m.body, m.deleted_at,
                (SELECT COUNT(*) FROM msg_attachments a WHERE a.message_id = m.id) AS attachments
           FROM msg_messages m WHERE m.id IN (${replyIds.map(() => '?').join(',')})`,
      )
      .all(...replyIds)) {
      if (viewerId && isHiddenFor(db, m.id, viewerId)) {
        replies.set(m.id, { id: m.id, user_id: null, body: '', deleted: true, hidden: true, attachments: 0 });
        continue;
      }
      replies.set(m.id, {
        id: m.id,
        user_id: m.user_id,
        body: m.deleted_at ? '' : snippet(m.body, 160),
        deleted: !!m.deleted_at,
        attachments: m.attachments,
      });
    }
  }
  return rows.map((r) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    user_id: r.user_id,
    kind: r.kind,
    body: r.deleted_at ? '' : r.body,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted: !!r.deleted_at,
    reply_to: r.reply_to_id ? replies.get(r.reply_to_id) ?? { id: r.reply_to_id, user_id: null, body: '', deleted: true, attachments: 0 } : null,
    attachments: atts.get(r.id) ?? [],
    reactions: [...(reacts.get(r.id) ?? new Map())].map(([emoji, user_ids]) => ({ emoji, user_ids })),
  }));
}

export function getMessage(db, id, viewerId = null) {
  const row = db.prepare('SELECT * FROM msg_messages WHERE id = ?').get(id);
  return row ? shapeMessages(db, [row], viewerId)[0] : null;
}

/** Page of history: messages older than `before` (ascending order), plus has_more. */
export function pageMessages(db, conversationId, { before = null, after = null, limit = PAGE_SIZE, viewerId = 0 } = {}) {
  const base = `SELECT * FROM msg_messages m WHERE m.conversation_id = ? AND ${NOT_HIDDEN}`;
  if (after) {
    const rows = db.prepare(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT ?`).all(conversationId, viewerId, after, limit + 1);
    return { messages: shapeMessages(db, rows.slice(0, limit), viewerId), has_more: rows.length > limit };
  }
  const rows = before
    ? db.prepare(`${base} AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(conversationId, viewerId, before, limit + 1)
    : db.prepare(`${base} ORDER BY m.id DESC LIMIT ?`).all(conversationId, viewerId, limit + 1);
  return { messages: shapeMessages(db, rows.slice(0, limit).reverse(), viewerId), has_more: rows.length > limit };
}

/** Participants mentioned as @FirstName / @Nickname in a message body. */
export function mentionedIds(body, people) {
  const text = String(body ?? '').toLowerCase();
  if (!text.includes('@')) return [];
  const out = new Set();
  for (const p of people) {
    const names = [firstName(p.name, ''), p.nickname, p.name].filter(Boolean).map((n) => n.toLowerCase());
    for (const n of names) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u');
      if (re.test(text)) out.add(p.id);
    }
  }
  if (/(^|\s)@(all|everyone|family)\b/.test(text)) for (const p of people) out.add(p.id);
  return [...out];
}

/** Insert a message (used by the router and by the seed). Returns the new row id. */
export function insertMessage(db, { conversationId, familyId, userId, kind = 'text', body = '', replyToId = null, createdAt = null }) {
  const at = createdAt ?? new Date().toISOString();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO msg_messages (conversation_id, family_id, user_id, kind, body, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(conversationId, familyId, userId, kind, body, replyToId, at);
  db.prepare('UPDATE msg_conversations SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?').run(at, conversationId, at);
  return Number(lastInsertRowid);
}

export const directKey = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join(':');
