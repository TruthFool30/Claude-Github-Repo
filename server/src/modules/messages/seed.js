// Demo content for the Rivera family: a lively Family chat, a few DMs and two group chats,
// with photos (generated SVG scenes), reactions, replies and realistic read states.
import { directKey, ensureFamilyConversation, insertMessage } from './store.js';

/** A soft illustrated scene (no network, no native deps). */
function scene(kind) {
  const W = 1200;
  const H = 900;
  const wrap = (defs, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;
  if (kind === 'tacos') {
    return wrap(
      `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD29D"/><stop offset="1" stop-color="#F76B15"/></linearGradient>
       <radialGradient id="plate" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#EDE6DD"/></radialGradient>`,
      `<rect width="${W}" height="${H}" fill="url(#bg)"/>
       <g opacity="0.18" fill="#fff"><circle cx="120" cy="140" r="60"/><circle cx="1080" cy="760" r="90"/><circle cx="1010" cy="120" r="40"/></g>
       <ellipse cx="600" cy="500" rx="430" ry="300" fill="#000" opacity="0.12"/>
       <ellipse cx="600" cy="470" rx="420" ry="290" fill="url(#plate)"/>
       ${[0, 1, 2].map((i) => {
         const x = 360 + i * 240;
         return `<g transform="translate(${x} 470) rotate(${-12 + i * 12})">
           <path d="M-120 40 A130 130 0 0 1 120 40 Z" fill="#F5C26B"/>
           <path d="M-105 30 Q-60 -40 0 -45 Q60 -40 105 30 Z" fill="#6BBF59"/>
           <circle cx="-50" cy="0" r="16" fill="#E5484D"/><circle cx="10" cy="-18" r="14" fill="#E5484D"/><circle cx="55" cy="5" r="15" fill="#E5484D"/>
           <path d="M-90 25 Q0 -10 90 25" stroke="#FFF3C4" stroke-width="10" fill="none" stroke-linecap="round"/>
           <path d="M-120 40 A130 130 0 0 1 120 40" stroke="#D9A441" stroke-width="8" fill="none"/></g>`;
       }).join('')}
       <g fill="#7C4A1E" opacity="0.9"><circle cx="820" cy="690" r="46" fill="#8B5A2B"/><circle cx="820" cy="690" r="34" fill="#E5484D"/></g>`,
    );
  }
  if (kind === 'soccer') {
    const stripes = Array.from({ length: 8 }, (_, i) => `<rect x="${i * 150}" y="380" width="75" height="520" fill="#fff" opacity="0.06"/>`).join('');
    return wrap(
      `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8EC5FF"/><stop offset="1" stop-color="#D8ECFF"/></linearGradient>
       <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#46A758"/><stop offset="1" stop-color="#2A7E3B"/></linearGradient>`,
      `<rect width="${W}" height="${H}" fill="url(#sky)"/>
       <circle cx="980" cy="150" r="70" fill="#FFE08A"/>
       <g fill="#fff" opacity="0.85"><ellipse cx="260" cy="150" rx="110" ry="36"/><ellipse cx="330" cy="130" rx="80" ry="34"/><ellipse cx="640" cy="210" rx="90" ry="28"/></g>
       <rect y="380" width="${W}" height="520" fill="url(#grass)"/>${stripes}
       <g stroke="#fff" stroke-width="10" fill="none" opacity="0.9"><path d="M820 380 V250 H1120 V380"/><path d="M820 250 L860 300 H1080 L1120 250" opacity="0.4"/></g>
       <path d="M0 640 H${W}" stroke="#fff" stroke-width="6" opacity="0.5"/>
       <ellipse cx="520" cy="720" rx="90" ry="16" fill="#000" opacity="0.18"/>
       <g transform="translate(520 640)"><circle r="80" fill="#fff" stroke="#1a1b26" stroke-width="5"/>
         <path d="M0 -30 L28 -9 L18 25 L-18 25 L-28 -9 Z" fill="#1a1b26"/>
         <path d="M0 -30 L0 -78 M28 -9 L74 -26 M18 25 L46 64 M-18 25 L-46 64 M-28 -9 L-74 -26" stroke="#1a1b26" stroke-width="5"/></g>`,
    );
  }
  // lake / camping
  return wrap(
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8E4EC6"/><stop offset="0.55" stop-color="#F76B15"/><stop offset="1" stop-color="#FFB224"/></linearGradient>
     <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3E63DD"/><stop offset="1" stop-color="#1B2B6B"/></linearGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>
     <circle cx="600" cy="520" r="120" fill="#FFE08A" opacity="0.95"/>
     <path d="M0 520 L180 330 L330 470 L520 260 L760 500 L930 340 L1200 520 Z" fill="#3B1F5C" opacity="0.85"/>
     <rect y="520" width="${W}" height="380" fill="url(#lake)"/>
     <g stroke="#FFE08A" stroke-width="6" opacity="0.6" stroke-linecap="round"><path d="M520 580 H680"/><path d="M550 620 H650"/><path d="M570 660 H630"/></g>
     <g fill="#14331F">${[80, 200, 1010, 1120].map((x) => `<path d="M${x} 560 L${x - 60} 700 H${x + 60} Z M${x} 500 L${x - 45} 610 H${x + 45} Z"/>`).join('')}</g>
     <path d="M820 700 L900 590 L980 700 Z" fill="#FFB224"/><path d="M900 590 L900 700" stroke="#8B4513" stroke-width="6"/>`,
  );
}

export async function seed(ctx, { familyId, users }) {
  const { db } = ctx;
  const { alex, sam, mia, leo } = users;
  const now = Date.now();
  /** ISO time `days` ago at local-ish hh:mm (clamped to the past). */
  const at = (days, hh, mm) => {
    const d = new Date(now - days * 864e5);
    d.setHours(hh, mm, 0, 0);
    return new Date(Math.min(d.getTime(), now - 60_000)).toISOString();
  };
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

  const addPhoto = (messageId, kind) => {
    const url = ctx.storeFile(familyId, Buffer.from(scene(kind)), '.svg');
    db.prepare('INSERT INTO msg_attachments (message_id, family_id, url, mime, width, height, size) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, familyId, url, 'image/svg+xml', 1200, 900, 0);
  };
  const react = (messageId, emoji, ...people) => {
    for (const p of people) db.prepare('INSERT OR IGNORE INTO msg_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, p.id, emoji, new Date(now).toISOString());
  };

  /** Write a script of [who, text, when, extra?] into a conversation; returns ids by label. */
  function script(conversationId, lines) {
    const ids = {};
    let last = null;
    for (const [who, body, when, opts = {}] of lines) {
      const id = insertMessage(db, {
        conversationId, familyId, userId: who.id, body, kind: opts.system ? 'system' : 'text',
        replyToId: opts.replyTo ? ids[opts.replyTo] : null, createdAt: when,
      });
      if (opts.photo) addPhoto(id, opts.photo);
      if (opts.label) ids[opts.label] = id;
      ids.$last = id;
      last = when;
    }
    db.prepare('UPDATE msg_conversations SET last_activity_at = ? WHERE id = ?').run(last, conversationId);
    return ids;
  }
  const setRead = (conversationId, user, lastReadId) =>
    db.prepare('UPDATE msg_participants SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?').run(lastReadId, conversationId, user.id);
  const newConv = (kind, { name = null, emoji = null, color = null, members, createdBy, createdAt }) => {
    const key = kind === 'direct' ? directKey(members[0].id, members[1].id) : null;
    const { lastInsertRowid } = db
      .prepare('INSERT INTO msg_conversations (family_id, kind, name, emoji, color, direct_key, created_by, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(familyId, kind, name, emoji, color, key, createdBy.id, createdAt, createdAt);
    const id = Number(lastInsertRowid);
    for (const m of members) db.prepare('INSERT INTO msg_participants (conversation_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, m.id, createdAt);
    return id;
  };

  // ---------------- Family chat ----------------
  const family = ensureFamilyConversation(db, familyId);
  db.prepare('UPDATE msg_conversations SET created_at = ? WHERE id = ?').run(at(90, 9, 0), family);
  const f = script(family, [
    [sam, "Who's home for dinner tonight? Making tacos 🌮", at(2, 17, 32), { label: 'tacos' }],
    [leo, 'MEEE 🙋‍♂️', at(2, 17, 34)],
    [mia, 'Me! Can we have the spicy salsa this time?', at(2, 17, 35)],
    [alex, 'Running 15 min late, save me some!', at(2, 17, 41), { label: 'late' }],
    [sam, 'No promises 😄', at(2, 17, 43), { replyTo: 'late' }],
    [sam, 'Dinner is served!', at(2, 18, 30), { label: 'tacoPhoto', photo: 'tacos' }],
    [alex, 'That looks amazing. Omw 🚗', at(2, 18, 33)],
    [alex, "Reminder: Leo has soccer at 4:30 today, I'll pick him up. @Sam can you grab Mia from piano?", at(1, 7, 40), { label: 'pickup' }],
    [sam, 'Yep, on it 👍', at(1, 7, 52), { replyTo: 'pickup' }],
    [mia, 'Can Emma come over after? We have a science project 🔬', at(1, 12, 5), { label: 'emma' }],
    [alex, 'Sure, as long as homework comes first 😉', at(1, 12, 20), { replyTo: 'emma' }],
    [leo, 'WE WON 3-1!!! ⚽️⚽️⚽️', at(1, 17, 10), { label: 'won' }],
    [leo, 'I scored 2 goals', at(1, 17, 10), { photo: 'soccer', label: 'field' }],
    [sam, 'Goal machine! So proud of you buddy 💪', at(1, 17, 18)],
    [mia, "ok that's actually really cool", at(1, 17, 25), { label: 'cool' }],
    [alex, "Grandma called — she's visiting on Saturday! 🎉 Let's plan something nice", ago(185), { label: 'grandma' }],
    [sam, 'Brunch at home? I can make my famous pancakes', ago(170), { label: 'brunch' }],
    [leo, 'PANCAKES 🥞🥞🥞', ago(166)],
    [mia, '@Alex can we go to the farmers market first? Grandma loves the flower stand 🌻', ago(120), { label: 'market' }],
    [alex, "Great idea — market in the morning, then brunch back home", ago(104), { replyTo: 'market', label: 'plan' }],
    [sam, 'Added berries and maple syrup to the grocery list 🫐', ago(42), { label: 'berries' }],
    [leo, 'Can I bring my new Lego spaceship to show Grandma?', ago(12), { label: 'lego' }],
    [mia, "Leo she's going to love it 😂", ago(5)],
  ]);
  react(f.tacos, '❤️', alex, mia);
  react(f.tacoPhoto, '😍', alex, mia, leo);
  react(f.tacoPhoto, '❤️', leo);
  react(f.won, '🎉', alex, sam, mia);
  react(f.field, '👏', alex, sam);
  react(f.grandma, '❤️', sam, mia, leo);
  react(f.brunch, '👍', alex, leo);
  react(f.plan, '👍', sam, mia);
  react(f.cool, '😂', leo);
  setRead(family, alex, f.berries); // 2 unread for Alex
  setRead(family, sam, f.$last);
  setRead(family, mia, f.$last);
  setRead(family, leo, f.lego);
  ctx.logActivity({ familyId, userId: sam.id, module: 'messages', verb: 'shared', entityId: f.tacoPhoto, summary: 'shared a photo in the Family chat', link: `/messages/${family}?m=${f.tacoPhoto}`, createdAt: at(2, 18, 30) });
  ctx.logActivity({ familyId, userId: leo.id, module: 'messages', verb: 'shared', entityId: f.field, summary: 'shared a photo in the Family chat', link: `/messages/${family}?m=${f.field}`, createdAt: at(1, 17, 10) });

  // ---------------- Direct: Alex ↔ Sam ----------------
  const as = newConv('direct', { members: [alex, sam], createdBy: sam, createdAt: at(30, 9, 0) });
  const asm = script(as, [
    [sam, 'Did you pay the water bill?', at(1, 9, 12)],
    [alex, 'Done this morning ✅', at(1, 9, 30), { label: 'paid' }],
    [sam, "You're the best ❤️", at(1, 9, 31)],
    [alex, 'Date night Friday? The new Thai place opened on Main St', at(1, 21, 4), { label: 'date' }],
    [sam, "Yes please! I'll ask Mrs. Patel if she can babysit", at(1, 21, 10)],
    [sam, 'Can you pick up the dry cleaning on the way home?', ago(25), { label: 'dry' }],
  ]);
  react(asm.date, '😍', sam);
  setRead(as, alex, asm.dry - 1); // 1 unread for Alex
  setRead(as, sam, asm.$last);

  // ---------------- Direct: Alex ↔ Mia ----------------
  const am = newConv('direct', { members: [alex, mia], createdBy: mia, createdAt: at(20, 16, 0) });
  const amm = script(am, [
    [mia, 'Can I get the new watercolor set for my art project? It’s $24', at(1, 15, 45), { label: 'art' }],
    [alex, "Let's look at it together tonight 🎨", at(1, 16, 2)],
    [mia, 'Thank youuuu', at(1, 16, 3), { label: 'thanks' }],
  ]);
  react(amm.thanks, '❤️', alex);
  setRead(am, alex, amm.$last);
  setRead(am, mia, amm.$last);

  // ---------------- Direct: Sam ↔ Leo ----------------
  const sl = newConv('direct', { members: [sam, leo], createdBy: leo, createdAt: at(10, 7, 0) });
  const slm = script(sl, [
    [leo, 'Mom where is my soccer jersey', at(1, 15, 50)],
    [sam, "In the dryer! Don't forget your water bottle", at(1, 15, 52)],
    [leo, 'found it 👍', at(1, 15, 58)],
  ]);
  setRead(sl, sam, slm.$last);
  setRead(sl, leo, slm.$last);

  // ---------------- Group: Parents HQ ----------------
  const hq = newConv('group', { name: 'Parents HQ', emoji: '🏡', color: '#5B5BD6', members: [alex, sam], createdBy: alex, createdAt: at(21, 20, 0) });
  const hqm = script(hq, [
    [alex, 'created the group “Parents HQ”', at(21, 20, 0), { system: true }],
    [sam, 'Parent-teacher conference is Thursday at 5pm', at(2, 13, 15), { label: 'ptc' }],
    [alex, "I'll take it — you have the late meeting", at(2, 13, 40), { replyTo: 'ptc' }],
    [sam, "Leo's birthday party ideas? Trampoline park? 🎈", ago(150), { label: 'party' }],
    [alex, "He'd love that. Let's book it for Sunday Nov 8", ago(80), { label: 'nov8' }],
  ]);
  react(hqm.nov8, '👍', sam);
  setRead(hq, alex, hqm.$last);
  setRead(hq, sam, hqm.$last);
  ctx.logActivity({ familyId, userId: alex.id, module: 'messages', verb: 'created', entityId: hq, summary: 'started the group chat “Parents HQ”', link: `/messages/${hq}`, createdAt: at(21, 20, 0) });

  // ---------------- Group: Lake trip ----------------
  const lake = newConv('group', { name: 'Lake trip', emoji: '⛺', color: '#12A594', members: [alex, sam, mia, leo], createdBy: alex, createdAt: at(4, 19, 0) });
  const lk = script(lake, [
    [alex, 'created the group “Lake trip”', at(4, 19, 0), { system: true }],
    [alex, "Who's excited for the lake trip in two weeks?", at(4, 19, 1), { label: 'excited', photo: 'lake' }],
    [leo, 'ME!!!!', at(4, 19, 3)],
    [mia, 'Can we bring marshmallows? And the kayak?', at(4, 19, 6), { label: 'smores' }],
    [alex, 'Obviously 🔥 kayak too', at(4, 19, 9), { replyTo: 'smores' }],
    [sam, "I'll check the tent and sleeping bags this weekend", at(3, 8, 20), { label: 'tent' }],
    [leo, 'Can I sleep in the hammock', at(3, 18, 2), { label: 'hammock' }],
  ]);
  react(lk.excited, '🎉', leo, mia, sam);
  react(lk.tent, '🙏', alex);
  react(lk.hammock, '😂', mia, sam);
  for (const u of [alex, sam, mia, leo]) setRead(lake, u, lk.$last);
  ctx.logActivity({ familyId, userId: alex.id, module: 'messages', verb: 'created', entityId: lake, summary: 'started the group chat “Lake trip”', link: `/messages/${lake}`, createdAt: at(4, 19, 0) });
}
