// Demo seed: `npm run seed` (uses DB_PATH / UPLOAD_DIR like the server).
// Recreates the "Rivera Family" from scratch, then calls every module's optional
// `seed(ctx, { familyId, users, userList })` hook.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { createContext } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { modules as defaultModules, validateModules } from './modules/index.js';

export const DEMO_PASSWORD = 'hearth123';
export const DEMO_INVITE_CODE = 'HRTH-2026';
export const DEMO_USERS = [
  { key: 'alex', name: 'Alex Rivera', email: 'alex@hearth.test', role: 'admin', color: '#5B5BD6', birthday: '1986-04-12', phone: '+1 555 0101' },
  { key: 'sam', name: 'Sam Rivera', email: 'sam@hearth.test', role: 'member', color: '#D6409F', birthday: '1988-09-03', phone: '+1 555 0102' },
  { key: 'mia', name: 'Mia Rivera', email: 'mia@hearth.test', role: 'child', color: '#30A46C', birthday: '2014-06-21', phone: null },
  { key: 'leo', name: 'Leo Rivera', email: 'leo@hearth.test', role: 'child', color: '#F76B15', birthday: '2017-11-08', phone: null },
];

const q = (name) => `"${name.replace(/"/g, '""')}"`;

/**
 * Delete families + users and everything that references them, generically: rows in any table
 * with a `family_id` column, then (repeatedly) rows whose single-column foreign key now points
 * at nothing (or SET NULL when the FK says so). Works for module tables without knowing them.
 */
export function purge(db, { familyIds = [], userIds = [] }) {
  if (!familyIds.length && !userIds.length) return;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    const inList = (ids) => `(${ids.map(Number).join(',')})`;
    if (familyIds.length) {
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name);
        if (cols.includes('family_id')) db.exec(`DELETE FROM ${q(t)} WHERE family_id IN ${inList(familyIds)}`);
      }
      db.exec(`DELETE FROM families WHERE id IN ${inList(familyIds)}`);
    }
    if (userIds.length) db.exec(`DELETE FROM users WHERE id IN ${inList(userIds)}`);
    for (let pass = 0; pass < 10; pass++) {
      let changes = 0;
      for (const t of tables) {
        const fks = db.prepare(`PRAGMA foreign_key_list(${q(t)})`).all();
        const groups = new Map();
        for (const fk of fks) groups.set(fk.id, [...(groups.get(fk.id) || []), fk]);
        for (const [, cols] of groups) {
          if (cols.length !== 1) continue;
          const fk = cols[0];
          const parentCol = fk.to || 'rowid';
          const orphan = `${q(fk.from)} IS NOT NULL AND ${q(fk.from)} NOT IN (SELECT ${q(parentCol)} FROM ${q(fk.table)})`;
          const sql = fk.on_delete === 'SET NULL'
            ? `UPDATE ${q(t)} SET ${q(fk.from)} = NULL WHERE ${orphan}`
            : `DELETE FROM ${q(t)} WHERE ${orphan}`;
          changes += Number(db.prepare(sql).run().changes);
        }
      }
      if (!changes) break;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Seed the demo family into an open db. Returns { familyId, users }. */
export async function seedDemo(ctx, modules = defaultModules, { log = console.log } = {}) {
  const { db, uploadDir } = ctx;
  const emails = DEMO_USERS.map((u) => u.email);
  const existingUsers = db.prepare(`SELECT id FROM users WHERE email IN (${emails.map(() => '?').join(',')})`).all(...emails).map((r) => r.id);
  const existingFamilies = db
    .prepare(`SELECT id FROM families WHERE invite_code = ? OR id IN (SELECT family_id FROM memberships WHERE user_id IN (${existingUsers.map(() => '?').join(',') || 'NULL'}))`)
    .all(DEMO_INVITE_CODE, ...existingUsers)
    .map((r) => r.id);
  purge(db, { familyIds: existingFamilies, userIds: existingUsers });
  for (const id of existingFamilies) fs.rmSync(path.join(uploadDir, String(id)), { recursive: true, force: true });
  for (const id of existingUsers) fs.rmSync(path.join(uploadDir, 'users', String(id)), { recursive: true, force: true });

  const users = {};
  const hash = hashPassword(DEMO_PASSWORD);
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, name, color, birthday, phone) VALUES (?, ?, ?, ?, ?, ?)');
  for (const u of DEMO_USERS) {
    const { lastInsertRowid } = insertUser.run(u.email, hash, u.name, u.color, u.birthday, u.phone);
    users[u.key] = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
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
  console.log(`Seeding demo data into ${config.dbPath}`);
  const { familyId } = await seedDemo(ctx);
  ctx.hub.close();
  db.close();
  console.log(`Done. Rivera Family (id ${familyId}), invite code ${DEMO_INVITE_CODE}.`);
  console.log(`Log in as ${DEMO_USERS.map((u) => u.email).join(', ')} / ${DEMO_PASSWORD}`);
}
