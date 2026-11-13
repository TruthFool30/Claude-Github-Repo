// Lockout escape hatch for the person running Hearth: turn off two-factor login for one account.
//   npm run reset-2fa -- someone@example.com      (uses DB_PATH like the server)
// The user can then sign in with just their password and turn 2FA on again from Settings.
import fs from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';

const email = String(process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run reset-2fa -- someone@example.com');
  process.exit(2);
}
if (!fs.existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath} — set DB_PATH to the server's database file.`);
  process.exit(1);
}
const db = openDb(config.dbPath);
const { changes } = db
  .prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_recovery = NULL WHERE email = ?')
  .run(email);
db.close();
if (!changes) {
  console.error(`No account with the email ${email} in ${config.dbPath}`);
  process.exit(1);
}
console.log(`Two-factor login is now off for ${email}. They can sign in with their password.`);
