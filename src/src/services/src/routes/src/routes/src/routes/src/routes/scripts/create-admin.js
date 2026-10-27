/**
 * Creates the first administrator account. Secrets come from the environment —
 * never hard-code them. Run on Render (one-off Job) or locally against the
 * Render database:
 *   ADMIN_NAME="..." ADMIN_EMAIL="..." ADMIN_PHONE="07..." ADMIN_PASSWORD="..." node scripts/create-admin.js
 */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { isEmail, isName, normalizePhone, isPassword } = require('../src/middleware');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => {
  let code = '';
  for (const b of crypto.randomBytes(10)) code += ALPHABET[b % ALPHABET.length];
  return code.slice(0, 8);
};

async function main() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
  if (!isName(ADMIN_NAME) || !isEmail(ADMIN_EMAIL) || !isPassword(ADMIN_PASSWORD)) {
    console.error('Set ADMIN_NAME, ADMIN_EMAIL (valid) and ADMIN_PASSWORD (min 8 chars) in the environment.');
    process.exit(1);
  }
  const phone = normalizePhone(ADMIN_PHONE || '');
  if (!phone) { console.error('Set ADMIN_PHONE to a valid Kenyan mobile number.'); process.exit(1); }

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const user = await db.withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, referral_code)
       VALUES ($1,$2,$3,$4,'admin',$5) RETURNING id, email`,
      [ADMIN_NAME.trim(), ADMIN_EMAIL.trim().toLowerCase(), phone, hash, makeCode()]
    );
    await c.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [rows[0].id]);
    return rows[0];
  });
  console.log(`Admin created: ${user.email} — sign in on /login.html and open /admin.html`);
  await db.pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
