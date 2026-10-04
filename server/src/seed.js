// Demo seed: `npm run seed` (uses DB_PATH / UPLOAD_DIR like the server).
// Recreates the "Rivera Family" from scratch, then calls every module's optional
// `seed(ctx, { familyId, users, userList })` hook.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { KEY_ERROR, createContext, defaultKeyFile, openBox } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { purge } from './purge.js';
import { modules as defaultModules, validateModules } from './modules/index.js';

export const DEMO_PASSWORD = 'hearth123';
export const DEMO_INVITE_CODE = 'HRTH-2026';
export const DEMO_USERS = [
  { key: 'alex', name: 'Alex Rivera', email: 'alex@hearth.test', role: 'admin', color: '#5B5BD6', birthday: '1986-04-12', phone: '+1 555 0101' },
  { key: 'sam', name: 'Sam Rivera', email: 'sam@hearth.test', role: 'member', color: '#D6409F', birthday: '1988-09-03', phone: '+1 555 0102' },
  { key: 'mia', name: 'Mia Rivera', email: 'mia@hearth.test', role: 'child', color: '#30A46C', birthday: '2014-06-21', phone: null },
  { key: 'leo', name: 'Leo Rivera', email: 'leo@hearth.test', role: 'child', color: '#F76B15', birthday: '2017-11-08', phone: null },
];

export { purge } from './purge.js';

/** Seed the demo family into an open db. Returns { familyId, users }. */
export async function seedDemo(ctx, modules = defaultModules, { log = console.log } = {}) {
  const { db, uploadDir } = ctx;
  // Only the demo family itself (identified by its fixed invite code) is wiped. Demo users are
  // reused (profile + password reset) so any other family they belong to stays intact.
  const demoFamilies = db.prepare('SELECT id FROM families WHERE invite_code = ?').all(DEMO_INVITE_CODE).map((r) => r.id);
  purge(db, { familyIds: demoFamilies });
  for (const id of demoFamilies) fs.rmSync(path.join(uploadDir, String(id)), { recursive: true, force: true });

  const users = {};
  const hash = hashPassword(DEMO_PASSWORD);
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, name, color, birthday, phone) VALUES (?, ?, ?, ?, ?, ?)');
  const resetUser = db.prepare('UPDATE users SET password_hash = ?, name = ?, color = ?, birthday = ?, phone = ?, avatar_url = NULL WHERE id = ?');
  for (const u of DEMO_USERS) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
    let id;
    if (existing) {
      resetUser.run(hash, u.name, u.color, u.birthday, u.phone, existing.id);
      fs.rmSync(path.join(uploadDir, 'users', String(existing.id)), { recursive: true, force: true });
      id = existing.id;
    } else {
      id = insertUser.run(u.email, hash, u.name, u.color, u.birthday, u.phone).lastInsertRowid;
    }
    users[u.key] = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  const { lastInsertRowid: fid } = db
    .prepare("INSERT INTO families (name, invite_code, currency, created_by, created_at) VALUES ('Rivera Family', ?, 'USD', ?, ?)")
    .run(DEMO_INVITE_CODE, users.alex.id, new Date(Date.now() - 90 * 864e5).toISOString());
  const familyId = Number(fid);
  const insertMember = db.prepare('INSERT INTO memberships (family_id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
  DEMO_USERS.forEach((u, i) => insertMember.run(familyId, users[u.key].id, u.role, new Date(Date.now() - (90 - i) * 864e5).toISOString()));

  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  ctx.logActivity({ familyId, userId: users.alex.id, module: 'family', verb: 'created', summary: 'created the Rivera Family', link: '/family', createdAt: ago(90) });
  ctx.logActivity({ familyId, userId: users.sam.id, module: 'family', verb: 'joined', summary: 'joined the family', link: '/family', createdAt: ago(89) });
  ctx.logActivity({ familyId, userId: users.alex.id, module: 'family', verb: 'added', summary: 'added Mia and Leo to the family', link: '/family', createdAt: ago(88) });
  ctx.notify({ familyId, userIds: [users.alex.id, users.sam.id, users.mia.id, users.leo.id], module: 'family', title: 'Welcome to Hearth!', body: 'Your family space is ready. Explore the calendar, lists and more.', link: '/home' });

  const userList = DEMO_USERS.map((u) => users[u.key]);
  for (const mod of modules) {
    if (typeof mod.seed !== 'function') continue;
    try {
      await mod.seed(ctx, { familyId, users, userList });
      log(`  seeded ${mod.name}`);
    } catch (err) {
      log(`  ! seeding ${mod.name} failed: ${err.stack || err.message}`);
      throw err;
    }
  }
  return { familyId, users };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateModules(defaultModules);
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = openDb(config.dbPath, defaultModules);
  const ctx = createContext({ db, uploadDir: config.uploadDir });
  try {
    ctx.box = openBox(db, defaultKeyFile(config.dbPath)); // same key as the server (vault data is sealed)
  } catch (err) {
    console.error(err.code === KEY_ERROR ? `Can't seed: ${err.message}` : err);
    process.exit(1);
  }
  console.log(`Seeding demo data into ${config.dbPath}`);
  const { familyId } = await seedDemo(ctx);
  ctx.hub.close();
  db.close();
  console.log(`Done. Rivera Family (id ${familyId}), invite code ${DEMO_INVITE_CODE}.`);
  console.log(`Log in as ${DEMO_USERS.map((u) => u.email).join(', ')} / ${DEMO_PASSWORD}`);
}
