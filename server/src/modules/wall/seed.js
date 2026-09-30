// Demo wall content for the Rivera family: a lived-in week and a half of posts, photos,
// reactions, threaded comments and one pinned reminder.
import { scenes } from './art.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function seedWall(ctx, { familyId, users }) {
  const { db } = ctx;
  const { alex, sam, mia, leo } = users;
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const photo = (scene) => ctx.storeFile(familyId, Buffer.from(scenes[scene](), 'utf8'), '.svg');

  const posts = [
    {
      key: 'grandparents', by: alex, ago: 26 * HOUR, pinned: true, mood: 'excited',
      body: 'Grandma & Grandpa land Friday at 6pm ✈️ Let\'s have the guest room ready by Thursday night.\n\n@Mia and @Leo — you\'re on towel duty. I\'ll handle the airport run.',
      reactions: { sam: '❤️', mia: '🎉', leo: '🎉' },
      comments: [
        { by: sam, ago: 25 * HOUR, body: "I'll make my lasagna for Friday dinner 🍝", replies: [{ by: alex, ago: 24 * HOUR, body: 'Best news all week.' }] },
        { by: leo, ago: 20 * HOUR, body: 'Can Grandpa sleep in my room? He tells the best stories' },
      ],
    },
    {
      key: 'pier', by: sam, ago: 2 * HOUR + 10 * MIN, mood: 'relaxed',
      body: 'Sunset walk on the pier tonight. The sky went full cotton candy 🌅',
      photos: ['pier', 'pierLate'],
      reactions: { alex: '❤️', mia: '😮' },
      comments: [
        { by: alex, ago: 100 * MIN, body: 'Gorgeous! Wish I had come along.', replies: [{ by: sam, ago: 90 * MIN, body: 'Next time — Thursday looks clear again 🙂' }] },
      ],
    },
    {
      key: 'science', by: mia, ago: 20 * HOUR, mood: 'proud',
      body: 'I GOT AN A ON MY SCIENCE PROJECT!!! 🔬🌋 Ms. Patel said the eruption was the best in the class.',
      photos: ['volcano'],
      reactions: { alex: '🎉', sam: '🎉', leo: '😮' },
      comments: [
        { by: alex, ago: 19 * HOUR, body: 'So proud of you, Mia! All those late nights with the baking soda paid off.' },
        { by: leo, ago: 18 * HOUR, body: 'can we make it erupt again', replies: [{ by: mia, ago: 17 * HOUR, body: '@Leo after dinner, outside this time 😅' }] },
        { by: sam, ago: 16 * HOUR, body: 'Ice cream to celebrate this weekend 🍦' },
      ],
    },
    {
      key: 'drawing', by: leo, ago: 2 * DAY + 3 * HOUR, mood: 'happy',
      body: 'I drew our house. Thats all of us in the front 🏠',
      photos: ['drawing'],
      reactions: { alex: '❤️', sam: '❤️', mia: '❤️' },
      comments: [
        { by: sam, ago: 2 * DAY + 2 * HOUR, body: "This is going straight on the fridge. Love that the sun has sunglasses energy ☀️" },
        { by: mia, ago: 2 * DAY + HOUR, body: 'why am I so small' , replies: [{ by: leo, ago: 2 * DAY, body: 'because your far away' }] },
      ],
    },
    {
      key: 'hike', by: alex, ago: 3 * DAY + 5 * HOUR, mood: 'adventurous',
      body: 'Eagle Lake loop — 6 miles and nobody complained (much) 😄 Leo spotted a heron, Mia found the best snack rock.',
      photos: ['eagleLake', 'ridge', 'summit', 'lakeShore', 'campfire', 'garden'],
      reactions: { sam: '❤️', mia: '👍', leo: '🎉' },
      comments: [
        { by: mia, ago: 3 * DAY + 3 * HOUR, body: 'The snack rock deserves its own photo album' },
        { by: sam, ago: 3 * DAY + 2 * HOUR, body: 'That campfire shot 😍 Framing it.' },
      ],
    },
    {
      key: 'cookie', by: sam, ago: 4 * DAY + 6 * HOUR, mood: 'curious',
      body: 'Who ate the last cookie? 🍪👀 Asking for a friend.',
      photos: ['cookies'],
      reactions: { alex: '😂', mia: '😂' },
      comments: [
        { by: leo, ago: 4 * DAY + 5 * HOUR, body: 'not me' },
        { by: mia, ago: 4 * DAY + 5 * HOUR - 20 * MIN, body: "Leo there are crumbs on your shirt", replies: [{ by: leo, ago: 4 * DAY + 5 * HOUR - 25 * MIN, body: 'those are old crumbs' }] },
        { by: alex, ago: 4 * DAY + 4 * HOUR, body: 'Case closed 😂' },
      ],
    },
    {
      key: 'pancakes', by: alex, ago: 6 * DAY + 2 * HOUR, mood: 'hungry',
      body: 'Sunday pancake tower, blueberry edition. Record: Leo ate five.',
      photos: ['pancakes'],
      reactions: { sam: '👍', leo: '🎉' },
      comments: [{ by: leo, ago: 6 * DAY, body: 'SIX' }],
    },
    {
      key: 'movie', by: sam, ago: 7 * DAY + 4 * HOUR, mood: null,
      body: 'Family movie night on Saturday! Vote in the comments:\n1. The Wild Robot\n2. Paddington in Peru\n3. Moana 2',
      reactions: { alex: '👍' },
      comments: [
        { by: mia, ago: 7 * DAY + 3 * HOUR, body: 'Wild Robot!!' },
        { by: leo, ago: 7 * DAY + 3 * HOUR - 10 * MIN, body: 'Moana 2 🌊' },
        { by: alex, ago: 7 * DAY + 2 * HOUR, body: 'Paddington — marmalade sandwiches included.' },
      ],
    },
    {
      key: 'soccer', by: mia, ago: 9 * DAY + 3 * HOUR, mood: 'celebrating',
      body: 'We won 3–1!!! ⚽ I scored the second goal.',
      photos: ['soccer1', 'soccer2'],
      reactions: { alex: '🎉', sam: '❤️', leo: '👍' },
      comments: [{ by: sam, ago: 9 * DAY + 2 * HOUR, body: 'What a strike! Coach Diaz was cheering louder than us.' }],
    },
  ];

  const insertPost = db.prepare(
    'INSERT INTO wall_posts (family_id, user_id, body, mood, pinned_at, pinned_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertPhoto = db.prepare('INSERT INTO wall_post_photos (post_id, url, position, width, height, created_at) VALUES (?, ?, ?, 1200, 900, ?)');
  const insertReaction = db.prepare('INSERT INTO wall_reactions (post_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
  const insertComment = db.prepare('INSERT INTO wall_comments (post_id, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)');
  const ids = {};

  ctx.tx(db, () => {
    for (const p of posts) {
      const created = at(p.ago);
      const { lastInsertRowid } = insertPost.run(
        familyId, p.by.id, p.body, p.mood ?? null, p.pinned ? at(p.ago - 30 * MIN) : null, p.pinned ? p.by.id : null, created, created,
      );
      const id = Number(lastInsertRowid);
      ids[p.key] = id;
      (p.photos ?? []).forEach((scene, i) => insertPhoto.run(id, photo(scene), i, created));
      Object.entries(p.reactions ?? {}).forEach(([who, emoji], i) => insertReaction.run(id, users[who].id, emoji, at(p.ago - (i + 1) * 7 * MIN)));
      for (const c of p.comments ?? []) {
        const cid = Number(insertComment.run(id, null, c.by.id, c.body, at(c.ago)).lastInsertRowid);
        for (const rep of c.replies ?? []) insertComment.run(id, cid, rep.by.id, rep.body, at(rep.ago));
      }
      const n = (p.photos ?? []).length;
      ctx.logActivity({
        familyId, userId: p.by.id, module: 'wall', verb: 'posted', entityId: id,
        summary: n ? `shared ${n === 1 ? 'a photo' : `${n} photos`}` : 'shared a post', link: `/home/post/${id}`, createdAt: created,
      });
    }
  });

  // A couple of unread wall notifications so the bell has something real to show.
  ctx.notify({ familyId, userIds: [alex.id], module: 'wall', title: 'Sam commented on your post', body: "I'll make my lasagna for Friday dinner 🍝", link: `/home/post/${ids.grandparents}` });
  ctx.notify({ familyId, userIds: [mia.id], module: 'wall', title: 'Alex mentioned you in a post', body: 'Grandma & Grandpa land Friday at 6pm ✈️', link: `/home/post/${ids.grandparents}` });
  ctx.notify({ familyId, userIds: [leo.id], module: 'wall', title: 'Mia replied to your comment', body: '@Leo after dinner, outside this time 😅', link: `/home/post/${ids.science}` });
  return ids;
}
