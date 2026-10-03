// Family messaging — module "messages", mounted at /api/messages.
//
// Conversations: the auto-created "Family" group (every member), direct messages between two
// members, and custom groups. Messages support image attachments, emoji reactions, replies, edit
// and delete (soft), read receipts, typing indicators and @mentions. Every realtime event is sent
// only to the conversation's participants (sendToUsers), never family-wide.
//
// REST (all under /api/messages):
//   GET    /                                   conversations (same as /conversations)
//   GET    /conversations                      my conversations, most recent first
//   POST   /conversations                      {kind:'direct', user_id} (find-or-create) | {kind:'group', name, member_ids, emoji?, color?}
//   GET    /conversations/:id                  one conversation
//   PATCH  /conversations/:id                  group: {name?, emoji?, color?}
//   DELETE /conversations/:id                  group: creator or admin
//   POST   /conversations/:id/members          group: {user_ids}
//   DELETE /conversations/:id/members/:userId  group: self (leave), creator or admin
//   PUT    /conversations/:id/mute             {muted}
//   POST   /conversations/:id/read             {last_read_id?}
//   POST   /conversations/:id/typing
//   GET    /conversations/:id/messages         ?before=<id>|after=<id>&limit=
//   POST   /conversations/:id/messages         JSON {body, reply_to_id?, client_id?} or multipart (files[], body, reply_to_id, dims)
//   PATCH  /messages/:id                       {body} (own text messages)
//   DELETE /messages/:id                       own message (admins: any)
//   POST   /messages/:id/reactions             {emoji} toggles my reaction
//   GET    /unread                             {total, muted_total, conversations}
import { Router } from 'express';
import { ISO_NOW, searchMatch } from '../db.js';
import { activityAudience, emitActivityEvent } from '../activity.js';
import { cleanStr, httpError, isColor, toId } from '../util.js';
import {
  IMAGE_TYPES, MAX_ATTACHMENTS, MAX_BODY, PAGE_SIZE, directKey, ensureFamilyConversation, familyMembers,
  getConversationFor, getMessage, insertMessage, listConversations, mentionedIds, pageMessages, participantIds,
  participants, shapeConversation, snippet, titleFor, unreadSummary, isHiddenFor, NOT_HIDDEN, recordMemberJoined, recordMemberLeft,
} from './messages/store.js';
import fs from 'node:fs';
import path from 'node:path';

export { seed } from './messages/seed.js';

export const name = 'messages';

/** Membership lifecycle (core hooks): exact leave/rejoin gaps. */
export function onMemberLeft(ctx, { familyId, userId }) {
  const emptied = ctx.tx(ctx.db, () => recordMemberLeft(ctx.db, familyId, userId));
  for (const g of emptied) for (const url of g.files) ctx.removeFile(url);
}
export function onMemberJoined(ctx, { familyId, userId }) {
  ctx.tx(ctx.db, () => recordMemberJoined(ctx.db, familyId, userId));
}

export const migrations = [
  `CREATE TABLE IF NOT EXISTS msg_conversations (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('family','direct','group')),
     name TEXT,
     emoji TEXT,
     color TEXT,
     direct_key TEXT,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     last_activity_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS msg_conv_family_one ON msg_conversations(family_id) WHERE kind = 'family'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS msg_conv_direct ON msg_conversations(family_id, direct_key) WHERE kind = 'direct'`,
  `CREATE INDEX IF NOT EXISTS msg_conv_activity ON msg_conversations(family_id, last_activity_at)`,
  `CREATE TABLE IF NOT EXISTS msg_participants (
     conversation_id INTEGER NOT NULL REFERENCES msg_conversations(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     last_read_id INTEGER NOT NULL DEFAULT 0,
     muted INTEGER NOT NULL DEFAULT 0,
     joined_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (conversation_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS msg_part_user ON msg_participants(user_id)`,
  `CREATE TABLE IF NOT EXISTS msg_messages (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES msg_conversations(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system')),
     body TEXT NOT NULL DEFAULT '',
     reply_to_id INTEGER REFERENCES msg_messages(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     edited_at TEXT,
     deleted_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS msg_messages_conv ON msg_messages(conversation_id, id)`,
  `CREATE TABLE IF NOT EXISTS msg_attachments (
     id INTEGER PRIMARY KEY,
     message_id INTEGER NOT NULL REFERENCES msg_messages(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     url TEXT NOT NULL,
     mime TEXT,
     width INTEGER,
     height INTEGER,
     size INTEGER)`,
  `CREATE INDEX IF NOT EXISTS msg_att_message ON msg_attachments(message_id)`,
  // Periods a participant was out of a group (left/removed, later re-added): messages with
  // from_id < id <= to_id stay hidden from them. to_id is NULL while they are still out.
  `CREATE TABLE IF NOT EXISTS msg_gaps (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES msg_conversations(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     from_id INTEGER NOT NULL,
     to_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS msg_gaps_conv ON msg_gaps(conversation_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS msg_reactions (
     message_id INTEGER NOT NULL REFERENCES msg_messages(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     emoji TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (message_id, user_id, emoji))`,
];

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
function cleanEmoji(value, { field = 'Emoji', required = false } = {}) {
  const e = cleanStr(value, { field, required, max: 16 });
  if (e === null) return null;
  if (!EMOJI_RE.test(e) || /[A-Za-z0-9<>]/.test(e)) throw httpError(400, `${field} must be an emoji`);
  return e;
}

function idList(value, field) {
  if (!Array.isArray(value)) throw httpError(400, `${field} must be a list`);
  return [...new Set(value.map((v) => toId(v, field)))];
}

export function router(ctx) {
  const { db, tx } = ctx;
  const r = Router();

  /** Send an event to the conversation's participants (plus any extra users). */
  const emit = (conv, type, payload, extra = []) => {
    const ids = new Set([...participantIds(db, conv.id, conv.family_id), ...extra]);
    ctx.sendToUsers([...ids], type, payload, conv.family_id);
  };
  /** Send a message event; per-viewer payloads when someone has a hidden period (reply previews). */
  const emitMessage = (conv, type, messageId, extra = {}) => {
    const ids = participantIds(db, conv.id, conv.family_id);
    const gaps = db.prepare('SELECT DISTINCT user_id FROM msg_gaps WHERE conversation_id = ?').all(conv.id).map((g) => g.user_id);
    const plain = getMessage(db, messageId);
    const others = ids.filter((id) => !gaps.includes(id));
    if (others.length) ctx.sendToUsers(others, type, { conversation_id: conv.id, message: plain, ...extra }, conv.family_id);
    for (const uid of ids.filter((id) => gaps.includes(id))) {
      if (isHiddenFor(db, messageId, uid)) continue; // never reveal away-period messages (edits, reactions, deletes)
      ctx.sendToUsers([uid], type, { conversation_id: conv.id, message: getMessage(db, messageId, uid), ...extra }, conv.family_id);
    }
    return plain;
  };
  /** Push a per-viewer conversation summary to each participant (titles/unread differ per person). */
  const emitConversation = (conv, type) => {
    for (const uid of participantIds(db, conv.id, conv.family_id)) {
      ctx.sendToUsers([uid], type, shapeConversation(db, conv, uid), conv.family_id);
    }
  };
  const reload = (id) => db.prepare('SELECT * FROM msg_conversations WHERE id = ?').get(id);

  /**
   * Group-chat activity ("started the group chat …") is private to the group: its audience tracks
   * the current participants, and the entry disappears with the conversation.
   */
  function syncGroupActivity(convId, familyId) {
    const rows = db.prepare("SELECT * FROM activity WHERE family_id = ? AND module = 'messages' AND entity_id = ? AND verb = 'created'").all(familyId, convId);
    if (!rows.length) return;
    const conv = reload(convId);
    for (const row of rows) {
      if (!conv) {
        db.prepare('DELETE FROM activity WHERE id = ?').run(row.id);
        emitActivityEvent(ctx.hub, row, 'activity.removed', { id: row.id, ids: [row.id] });
        continue;
      }
      const ids = participantIds(db, convId, familyId);
      const before = activityAudience(row) ?? [];
      // Keep the summary on the group's current name, so a renamed chat never shows its old name.
      const summary = `started the group chat “${conv.name}”`;
      db.prepare('UPDATE activity SET audience = ?, summary = ? WHERE id = ?').run(JSON.stringify(ids), summary, row.id);
      if (summary !== row.summary) {
        emitActivityEvent(ctx.hub, { ...row, audience: JSON.stringify(ids) }, 'activity.updated', { id: row.id, summary });
      }
      const gone = before.filter((id) => !ids.includes(id));
      if (gone.length) ctx.sendToUsers(gone, 'activity.removed', { id: row.id, ids: [row.id] }, familyId);
    }
  }
  const memberOf = (familyId) => new Map(familyMembers(db, familyId).map((m) => [m.id, m]));
  const canManage = (req, conv) => req.role === 'admin' || conv.created_by === req.user.id;

  function systemMessage(conv, actorId, body) {
    const id = insertMessage(db, { conversationId: conv.id, familyId: conv.family_id, userId: actorId, kind: 'system', body });
    // The actor has obviously seen their own system message.
    db.prepare('UPDATE msg_participants SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?').run(id, conv.id, actorId);
    return emitMessage(conv, 'messages.message.created', id);
  }

  const list = (req, res) => res.json(listConversations(db, req.family.id, req.user.id));
  r.get('/', list);
  r.get('/conversations', list);

  r.get('/unread', (req, res) => res.json(unreadSummary(db, req.family.id, req.user.id)));

  // ---- create conversations ----
  r.post('/conversations', (req, res) => {
    const kind = req.body?.kind;
    const familyId = req.family.id;
    const members = memberOf(familyId);

    if (kind === 'direct') {
      const otherId = toId(req.body?.user_id, 'user_id');
      if (otherId === req.user.id) throw httpError(400, "You can't start a conversation with yourself");
      const other = members.get(otherId);
      if (!other) throw httpError(404, 'That person is not in this family');
      if (other.managed) throw httpError(400, `${other.name} doesn't have their own login yet`);
      ensureFamilyConversation(db, familyId); // apply leave/rejoin gaps before reusing an old DM
      const key = directKey(req.user.id, otherId);
      const existing = db.prepare("SELECT * FROM msg_conversations WHERE family_id = ? AND kind = 'direct' AND direct_key = ?").get(familyId, key);
      if (existing) {
        // Re-add either side if they had been removed somehow (e.g. left and rejoined the family).
        db.prepare('INSERT OR IGNORE INTO msg_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)').run(existing.id, req.user.id, existing.id, otherId);
        return res.json(shapeConversation(db, existing, req.user.id));
      }
      const conv = tx(db, () => {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO msg_conversations (family_id, kind, direct_key, created_by) VALUES (?, 'direct', ?, ?)")
          .run(familyId, key, req.user.id);
        const id = Number(lastInsertRowid);
        db.prepare('INSERT INTO msg_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)').run(id, req.user.id, id, otherId);
        return reload(id);
      });
      emitConversation(conv, 'messages.conversation.created');
      return res.status(201).json(shapeConversation(db, conv, req.user.id));
    }

    if (kind === 'group') {
      const title = cleanStr(req.body?.name, { field: 'Group name', required: true, max: 60 });
      const emoji = cleanEmoji(req.body?.emoji, { field: 'Group emoji' });
      const color = req.body?.color == null || req.body.color === '' ? null : req.body.color;
      if (color !== null && !isColor(color)) throw httpError(400, 'Color must be a hex color like #8E4EC6');
      const ids = idList(req.body?.member_ids ?? [], 'member_ids').filter((id) => id !== req.user.id);
      for (const id of ids) {
        const m = members.get(id);
        if (!m) throw httpError(400, 'Everyone in a group must be in this family');
        if (m.managed) throw httpError(400, `${m.name} doesn't have their own login yet`);
      }
      if (!ids.length) throw httpError(400, 'Pick at least one other person for the group');
      const conv = tx(db, () => {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO msg_conversations (family_id, kind, name, emoji, color, created_by) VALUES (?, 'group', ?, ?, ?, ?)")
          .run(familyId, title, emoji, color, req.user.id);
        const id = Number(lastInsertRowid);
        const add = db.prepare('INSERT INTO msg_participants (conversation_id, user_id) VALUES (?, ?)');
        add.run(id, req.user.id);
        for (const uid of ids) add.run(id, uid);
        return reload(id);
      });
      systemMessage(conv, req.user.id, `created the group “${title}”`);
      emitConversation(reload(conv.id), 'messages.conversation.created');
      ctx.notify({
        familyId, userIds: ids, module: 'messages', excludeUserId: req.user.id,
        title: `${req.user.name} added you to “${title}”`, body: 'Say hi to the group!', link: `/messages/${conv.id}`,
      });
      ctx.logActivity({
        familyId, userId: req.user.id, module: 'messages', verb: 'created', entityId: conv.id,
        summary: `started the group chat “${title}”`, link: `/messages/${conv.id}`,
        audience: participantIds(db, conv.id, familyId),
      });
      return res.status(201).json(shapeConversation(db, reload(conv.id), req.user.id));
    }

    throw httpError(400, "kind must be 'direct' or 'group'");
  });

  // ---- one conversation ----
  r.get('/conversations/:id', (req, res) => {
    const { conv, me } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    res.json(shapeConversation(db, conv, req.user.id, me));
  });

  r.patch('/conversations/:id', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    if (conv.kind !== 'group') throw httpError(400, 'Only group chats can be renamed');
    const body = req.body ?? {};
    const sets = [];
    const vals = [];
    let renamed = null;
    if ('name' in body) {
      const title = cleanStr(body.name, { field: 'Group name', required: true, max: 60 });
      if (title !== conv.name) renamed = title;
      sets.push('name = ?');
      vals.push(title);
    }
    if ('emoji' in body) {
      sets.push('emoji = ?');
      vals.push(cleanEmoji(body.emoji, { field: 'Group emoji' }));
    }
    if ('color' in body) {
      const color = body.color == null || body.color === '' ? null : body.color;
      if (color !== null && !isColor(color)) throw httpError(400, 'Color must be a hex color like #8E4EC6');
      sets.push('color = ?');
      vals.push(color);
    }
    if (!sets.length) throw httpError(400, 'Nothing to update');
    db.prepare(`UPDATE msg_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, conv.id);
    const next = reload(conv.id);
    if (renamed) {
      systemMessage(next, req.user.id, `renamed the group to “${renamed}”`);
      syncGroupActivity(conv.id, req.family.id);
    }
    emitConversation(next, 'messages.conversation.updated');
    res.json(shapeConversation(db, next, req.user.id));
  });

  r.delete('/conversations/:id', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    if (conv.kind !== 'group') throw httpError(400, 'Only group chats can be deleted');
    if (!canManage(req, conv)) throw httpError(403, 'Only the person who created this group or a family admin can delete it');
    const ids = participantIds(db, conv.id, conv.family_id);
    const files = db
      .prepare('SELECT a.url FROM msg_attachments a JOIN msg_messages m ON m.id = a.message_id WHERE m.conversation_id = ?')
      .all(conv.id);
    db.prepare('DELETE FROM msg_conversations WHERE id = ?').run(conv.id);
    for (const f of files) ctx.removeFile(f.url);
    syncGroupActivity(conv.id, conv.family_id);
    ctx.sendToUsers(ids, 'messages.conversation.removed', { conversation_id: conv.id, reason: 'deleted', by: req.user.id }, conv.family_id);
    res.json({ ok: true });
  });

  r.post('/conversations/:id/members', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    if (conv.kind !== 'group') throw httpError(400, 'People can only be added to group chats');
    const members = memberOf(req.family.id);
    const current = new Set(participantIds(db, conv.id, conv.family_id));
    const ids = idList(req.body?.user_ids, 'user_ids').filter((id) => !current.has(id));
    for (const id of ids) {
      const m = members.get(id);
      if (!m) throw httpError(400, 'Everyone in a group must be in this family');
      if (m.managed) throw httpError(400, `${m.name} doesn't have their own login yet`);
    }
    if (!ids.length) throw httpError(400, 'Everyone you picked is already in the group');
    tx(db, () => {
      // Remove stale rows of people who left the family earlier, then add fresh.
      const lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE conversation_id = ?').get(conv.id).id;
      const del = db.prepare('DELETE FROM msg_participants WHERE conversation_id = ? AND user_id = ?');
      const add = db.prepare('INSERT INTO msg_participants (conversation_id, user_id, last_read_id) VALUES (?, ?, ?)');
      const closeGap = db.prepare('UPDATE msg_gaps SET to_id = ? WHERE conversation_id = ? AND user_id = ? AND to_id IS NULL');
      for (const uid of ids) {
        del.run(conv.id, uid);
        add.run(conv.id, uid, lastId);
        closeGap.run(lastId, conv.id, uid);
      }
    });
    syncGroupActivity(conv.id, conv.family_id);
    const names = ids.map((id) => members.get(id).name.split(/\s+/)[0]);
    systemMessage(conv, req.user.id, `added ${joinNames(names)}`);
    emitConversation(reload(conv.id), 'messages.conversation.updated');
    ctx.notify({
      familyId: req.family.id, userIds: ids, module: 'messages', excludeUserId: req.user.id,
      title: `${req.user.name} added you to “${conv.name}”`, link: `/messages/${conv.id}`,
    });
    res.json(shapeConversation(db, reload(conv.id), req.user.id));
  });

  r.delete('/conversations/:id/members/:userId', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    if (conv.kind !== 'group') throw httpError(400, conv.kind === 'family' ? 'Everyone in the family is in the Family chat' : "You can't leave a direct conversation");
    const uid = toId(req.params.userId, 'user id');
    const self = uid === req.user.id;
    if (!self && !canManage(req, conv)) throw httpError(403, 'Only the person who created this group or a family admin can remove people');
    const target = db.prepare('SELECT 1 FROM msg_participants WHERE conversation_id = ? AND user_id = ?').get(conv.id, uid);
    if (!target) throw httpError(404, 'That person is not in this group');
    const targetUser = db.prepare('SELECT name FROM users WHERE id = ?').get(uid);
    tx(db, () => {
      const lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE conversation_id = ?').get(conv.id).id;
      db.prepare('DELETE FROM msg_participants WHERE conversation_id = ? AND user_id = ?').run(conv.id, uid);
      db.prepare('INSERT INTO msg_gaps (conversation_id, user_id, from_id) VALUES (?, ?, ?)').run(conv.id, uid, lastId);
    });
    ctx.sendToUsers([uid], 'messages.conversation.removed', { conversation_id: conv.id, reason: self ? 'left' : 'removed', by: req.user.id }, conv.family_id);
    const remaining = participantIds(db, conv.id, conv.family_id);
    if (!remaining.length) {
      const files = db.prepare('SELECT a.url FROM msg_attachments a JOIN msg_messages m ON m.id = a.message_id WHERE m.conversation_id = ?').all(conv.id);
      db.prepare('DELETE FROM msg_conversations WHERE id = ?').run(conv.id);
      for (const f of files) ctx.removeFile(f.url);
      syncGroupActivity(conv.id, conv.family_id);
      return res.json({ ok: true, deleted: true });
    }
    syncGroupActivity(conv.id, conv.family_id);
    systemMessage(conv, req.user.id, self ? 'left the group' : `removed ${targetUser?.name?.split(/\s+/)[0] ?? 'someone'}`);
    emitConversation(reload(conv.id), 'messages.conversation.updated');
    res.json({ ok: true, deleted: false });
  });

  r.put('/conversations/:id/mute', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    if (typeof req.body?.muted !== 'boolean') throw httpError(400, 'muted must be true or false');
    db.prepare('UPDATE msg_participants SET muted = ? WHERE conversation_id = ? AND user_id = ?').run(req.body.muted ? 1 : 0, conv.id, req.user.id);
    const out = shapeConversation(db, conv, req.user.id);
    ctx.sendToUsers([req.user.id], 'messages.conversation.updated', out, conv.family_id);
    res.json(out);
  });

  r.post('/conversations/:id/read', (req, res) => {
    const { conv, me } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE conversation_id = ?').get(conv.id).id;
    const wanted = req.body?.last_read_id == null ? latest : Math.min(toId(req.body.last_read_id, 'last_read_id'), latest);
    const next = Math.max(me.last_read_id, wanted);
    if (next !== me.last_read_id) {
      db.prepare('UPDATE msg_participants SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?').run(next, conv.id, req.user.id);
      emit(conv, 'messages.read', { conversation_id: conv.id, user_id: req.user.id, last_read_id: next });
    }
    res.json({ conversation_id: conv.id, last_read_id: next, unread: unreadSummary(db, req.family.id, req.user.id) });
  });

  r.post('/conversations/:id/typing', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    const others = participantIds(db, conv.id, conv.family_id).filter((id) => id !== req.user.id);
    ctx.sendToUsers(others, 'messages.typing', { conversation_id: conv.id, user_id: req.user.id, name: req.user.name }, conv.family_id);
    res.json({ ok: true });
  });

  // ---- messages ----
  r.get('/conversations/:id/messages', (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    const before = req.query.before ? toId(req.query.before, 'before') : null;
    const after = req.query.after ? toId(req.query.after, 'after') : null;
    const limit = req.query.limit ? Math.min(100, toId(req.query.limit, 'limit')) : PAGE_SIZE;
    res.json(pageMessages(db, conv.id, { before, after, limit, viewerId: req.user.id }));
  });

  // multipart only when the client sends files; plain JSON otherwise.
  const maybeFiles = (req, res, next) => (req.is('multipart/form-data') ? ctx.upload.array('files', 20)(req, res, next) : next());

  r.post('/conversations/:id/messages', maybeFiles, (req, res) => {
    const { conv } = getConversationFor(db, { id: toId(req.params.id), familyId: req.family.id, userId: req.user.id });
    const files = req.files ?? [];
    if (files.length > MAX_ATTACHMENTS) throw httpError(400, `You can attach up to ${MAX_ATTACHMENTS} photos per message`);
    for (const f of files) if (!IMAGE_TYPES.test(f.mimetype)) throw httpError(400, 'Only photos (JPEG, PNG, WebP, GIF, HEIC) can be attached');
    const text = cleanStr(req.body?.body, { field: 'Message', max: MAX_BODY }) ?? '';
    if (!text && !files.length) throw httpError(400, 'Write a message or attach a photo');
    const people = participants(db, conv.id, conv.family_id);
    if (conv.kind === 'direct' && people.length < 2) throw httpError(400, 'This person is no longer in the family');

    let replyToId = null;
    let replyTarget = null;
    if (req.body?.reply_to_id != null && req.body.reply_to_id !== '') {
      replyToId = toId(req.body.reply_to_id, 'reply_to_id');
      replyTarget = db.prepare("SELECT * FROM msg_messages WHERE id = ? AND conversation_id = ? AND kind = 'text'").get(replyToId, conv.id);
      if (!replyTarget || isHiddenFor(db, replyToId, req.user.id)) throw httpError(400, 'The message you replied to is not in this conversation');
    }
    let dims = [];
    if (req.body?.dims) {
      try {
        dims = typeof req.body.dims === 'string' ? JSON.parse(req.body.dims) : req.body.dims;
      } catch {
        dims = [];
      }
      if (!Array.isArray(dims)) dims = [];
    }
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id.slice(0, 64) : null;

    const id = tx(db, () => {
      const mid = insertMessage(db, { conversationId: conv.id, familyId: conv.family_id, userId: req.user.id, body: text, replyToId });
      const add = db.prepare('INSERT INTO msg_attachments (message_id, family_id, url, mime, width, height, size) VALUES (?, ?, ?, ?, ?, ?, ?)');
      files.forEach((f, i) => {
        const [w, h] = Array.isArray(dims[i]) ? dims[i].map(Number) : [];
        const okDim = (n) => (Number.isInteger(n) && n > 0 && n <= 20000 ? n : null);
        add.run(mid, conv.family_id, f.url, f.mimetype, okDim(w), okDim(h), f.size);
      });
      db.prepare('UPDATE msg_participants SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?').run(mid, conv.id, req.user.id);
      return mid;
    });
    emitMessage(conv, 'messages.message.created', id, { client_id: clientId });
    const message = getMessage(db, id, req.user.id);

    // Notifications: @mentions and replies (the unread badge covers everything else).
    const title = titleFor(conv, people, null);
    const where = conv.kind === 'direct' ? 'a message' : `“${title}”`;
    const preview = text ? snippet(text, 120) : `📷 ${files.length === 1 ? 'Photo' : `${files.length} photos`}`;
    const mentioned = mentionedIds(text, people).filter((uid) => uid !== req.user.id);
    if (mentioned.length) {
      ctx.notify({
        familyId: conv.family_id, userIds: mentioned, module: 'messages', excludeUserId: req.user.id,
        title: `${req.user.name} mentioned you in ${where}`, body: preview, link: `/messages/${conv.id}?m=${id}`,
      });
    }
    if (replyTarget?.user_id && replyTarget.user_id !== req.user.id && !mentioned.includes(replyTarget.user_id)) {
      ctx.notify({
        familyId: conv.family_id, userIds: [replyTarget.user_id], module: 'messages', excludeUserId: req.user.id,
        title: `${req.user.name} replied to your message`, body: preview, link: `/messages/${conv.id}?m=${id}`,
      });
    }
    if (files.length && conv.kind === 'family') {
      ctx.logActivity({
        familyId: conv.family_id, userId: req.user.id, module: 'messages', verb: 'shared', entityId: id,
        summary: `shared ${files.length === 1 ? 'a photo' : `${files.length} photos`} in the Family chat`, link: `/messages/${conv.id}?m=${id}`,
      });
    }
    res.status(201).json({ ...message, client_id: clientId });
  });

  /** Load a message (and its conversation) the user can see, or 404. */
  function messageFor(req) {
    const row = db.prepare('SELECT * FROM msg_messages WHERE id = ? AND family_id = ?').get(toId(req.params.id), req.family.id);
    if (!row) throw httpError(404, 'Message not found');
    try {
      const { conv } = getConversationFor(db, { id: row.conversation_id, familyId: req.family.id, userId: req.user.id });
      if (isHiddenFor(db, row.id, req.user.id)) throw httpError(404, 'Message not found');
      return { row, conv };
    } catch {
      throw httpError(404, 'Message not found');
    }
  }

  r.patch('/messages/:id', (req, res) => {
    const { row, conv } = messageFor(req);
    if (row.kind !== 'text' || row.deleted_at) throw httpError(400, "This message can't be edited");
    if (row.user_id !== req.user.id) throw httpError(403, 'You can only edit your own messages');
    const text = cleanStr(req.body?.body, { field: 'Message', max: MAX_BODY }) ?? '';
    const hasPhotos = db.prepare('SELECT COUNT(*) AS n FROM msg_attachments WHERE message_id = ?').get(row.id).n > 0;
    if (!text && !hasPhotos) throw httpError(400, 'Message is required');
    if (text !== row.body) {
      db.prepare('UPDATE msg_messages SET body = ?, edited_at = ? WHERE id = ?').run(text, new Date().toISOString(), row.id);
    }
    emitMessage(conv, 'messages.message.updated', row.id);
    const message = getMessage(db, row.id, req.user.id);
    res.json(message);
  });

  r.delete('/messages/:id', (req, res) => {
    const { row, conv } = messageFor(req);
    if (row.kind !== 'text') throw httpError(400, "This message can't be deleted");
    if (row.user_id !== req.user.id && req.role !== 'admin') throw httpError(403, 'You can only delete your own messages');
    if (!row.deleted_at) {
      const files = db.prepare('SELECT url FROM msg_attachments WHERE message_id = ?').all(row.id);
      tx(db, () => {
        db.prepare("UPDATE msg_messages SET body = '', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
        db.prepare('DELETE FROM msg_attachments WHERE message_id = ?').run(row.id);
        db.prepare('DELETE FROM msg_reactions WHERE message_id = ?').run(row.id);
      });
      for (const f of files) ctx.removeFile(f.url);
    }
    emitMessage(conv, 'messages.message.updated', row.id);
    const message = getMessage(db, row.id, req.user.id);
    res.json(message);
  });

  r.post('/messages/:id/reactions', (req, res) => {
    const { row, conv } = messageFor(req);
    if (row.kind !== 'text' || row.deleted_at) throw httpError(400, "You can't react to this message");
    const emoji = cleanEmoji(req.body?.emoji, { field: 'Emoji', required: true });
    const has = db.prepare('SELECT 1 FROM msg_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(row.id, req.user.id, emoji);
    if (has) {
      db.prepare('DELETE FROM msg_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(row.id, req.user.id, emoji);
    } else {
      const count = db.prepare('SELECT COUNT(*) AS n FROM msg_reactions WHERE message_id = ? AND user_id = ?').get(row.id, req.user.id).n;
      if (count >= 6) throw httpError(400, 'That’s plenty of reactions for one message');
      db.prepare('INSERT INTO msg_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(row.id, req.user.id, emoji);
    }
    emitMessage(conv, 'messages.message.updated', row.id);
    const message = getMessage(db, row.id, req.user.id);
    res.json({ ...message, reacted: !has });
  });

  // Photos are served here (participant check) rather than from the family-wide /uploads path.
  const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif' };
  r.get('/attachments/:id', (req, res) => {
    const a = db
      .prepare('SELECT a.*, m.conversation_id FROM msg_attachments a JOIN msg_messages m ON m.id = a.message_id WHERE a.id = ? AND a.family_id = ? AND m.deleted_at IS NULL')
      .get(toId(req.params.id), req.family.id);
    if (!a) throw httpError(404, 'Photo not found');
    getConversationFor(db, { id: a.conversation_id, familyId: req.family.id, userId: req.user.id }); // 404 for non-participants
    if (isHiddenFor(db, a.message_id, req.user.id)) throw httpError(404, 'Photo not found');
    const root = path.resolve(ctx.uploadDir);
    const abs = path.resolve(root, String(a.url).replace(/^\/uploads\//, ''));
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) throw httpError(404, 'Photo not found');
    res.set({
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || a.mime || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(abs, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Photo not found' });
    });
  });

  return r;
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Global search: messages and group names in conversations the viewer takes part in. */
export function search(ctx, familyId, q, req) {
  const { db } = ctx;
  const userId = req?.user?.id;
  if (!userId) return [];
  ensureFamilyConversation(db, familyId);
  const convs = db
    .prepare(
      `SELECT c.* FROM msg_conversations c JOIN msg_participants p ON p.conversation_id = c.id AND p.user_id = ?
        WHERE c.family_id = ?`,
    )
    .all(userId, familyId);
  const byId = new Map(convs.map((c) => [c.id, c]));
  const titleCache = new Map();
  const title = (c) => {
    if (!titleCache.has(c.id)) titleCache.set(c.id, titleFor(c, participants(db, c.id, familyId), userId));
    return titleCache.get(c.id);
  };
  const out = [];
  for (const c of convs) {
    if (c.kind === 'group' && searchMatch(c.name, q)) {
      out.push({ title: `${c.emoji ? `${c.emoji} ` : ''}${c.name}`, subtitle: 'Group chat', link: `/messages/${c.id}` });
    }
  }
  if (!convs.length) return out;
  const rows = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.body, m.created_at, u.name AS author
         FROM msg_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.family_id = ? AND m.kind = 'text' AND m.deleted_at IS NULL AND ${NOT_HIDDEN}
          AND m.conversation_id IN (${convs.map(() => '?').join(',')})
          AND search_match(m.body, ?)
        ORDER BY m.id DESC LIMIT 8`,
    )
    .all(familyId, userId, ...convs.map((c) => c.id), q);
  for (const m of rows) {
    const c = byId.get(m.conversation_id);
    const at = new Date(m.created_at);
    const when = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    out.push({
      title: snippet(m.body, 90),
      subtitle: `${(m.author ?? 'Someone').split(/\s+/)[0]} · ${c.kind === 'direct' ? 'Direct message' : title(c)} · ${when}`,
      link: `/messages/${c.id}?m=${m.id}`,
    });
  }
  return out.slice(0, 8);
}

/** Wall dashboard: my unread count and the latest conversations with news. */
export function dashboard(ctx, req) {
  const { db } = ctx;
  const unread = unreadSummary(db, req.family.id, req.user.id);
  const recent = listConversations(db, req.family.id, req.user.id)
    .filter((c) => c.last_message)
    .slice(0, 3)
    .map((c) => ({
      conversation_id: c.id,
      title: c.title,
      kind: c.kind,
      unread: c.unread,
      preview: c.last_message.deleted ? 'Message deleted' : c.last_message.body || (c.last_message.attachments ? '📷 Photo' : ''),
      user_id: c.last_message.user_id,
      at: c.last_message.created_at,
    }));
  return { unread: unread.total, recent };
}
