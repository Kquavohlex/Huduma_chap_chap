/** Authentication & profile routes. Sessions live in PostgreSQL; bcrypt hashes. */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, wrap, isEmail, isName, normalizePhone, isPassword } = require('../middleware');

const router = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeReferralCode = () => {
  let code = '';
  for (const b of crypto.randomBytes(10)) code += ALPHABET[b % ALPHABET.length];
  return code.slice(0, 8);
};

const publicUser = (u) => ({ id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, role: u.role, referralCode: u.referral_code });

// POST /api/auth/register
router.post('/register', authLimiter, wrap(async (req, res) => {
  const { fullName, email, phone, password, referralCode } = req.body || {};
  if (!isName(fullName)) return res.status(400).json({ error: 'Please enter your full name (at least 3 characters).' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  const normPhone = normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'Please enter a valid Kenyan mobile number, e.g. 0712 345 678.' });
  if (!isPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });

  const cleanEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  // Resolve the referral BEFORE creating the account — a new account cannot
  // refer itself, and the code must belong to an existing user.
  let referredBy = null;
  if (referralCode && String(referralCode).trim()) {
    const ref = await db.query('SELECT id FROM users WHERE referral_code = $1', [String(referralCode).trim().toUpperCase()]);
    if (!ref.rows[0]) return res.status(400).json({ error: 'That referral code does not exist. Leave it blank or check the spelling.' });
    referredBy = ref.rows[0].id;
  }

  try {
    const user = await db.withTransaction(async (c) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const { rows } = await c.query(
            `INSERT INTO users (full_name, email, phone, password_hash, referral_code, referred_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, full_name, email, phone, role, referral_code`,
            [fullName.trim(), cleanEmail, normPhone, passwordHash, makeReferralCode(), referredBy]
          );
          await c.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [rows[0].id]);
          return rows[0];
        } catch (err) {
          if (err.code === '23505' && /referral_code/.test(err.detail || '')) continue; // code collision, retry
          if (err.code === '23505') throw new Error('EMAIL_TAKEN');
          throw err;
        }
      }
      throw new Error('EMAIL_TAKEN');
    });

    req.session.regenerate(() => {
      req.session.userId = user.id;
      res.status(201).json({ user: publicUser(user) });
    });
  } catch (err) {
    if (err.message === 'EMAIL_TAKEN') return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
    throw err;
  }
}));

// POST /api/auth/login
router.post('/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    // Same message for both cases — never reveal whether an email is registered.
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact support for help.' });
  req.session.regenerate(() => {
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
}));

// POST /api/auth/logout
router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// GET /api/auth/me
router.get('/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT balance_cents FROM wallets WHERE user_id = $1', [req.user.id]);
  res.json({ user: publicUser(req.user), balanceCents: rows[0] ? rows[0].balance_cents : 0 });
}));

// PATCH /api/auth/profile — name and phone (email stays fixed for auditability)
router.patch('/profile', requireAuth, wrap(async (req, res) => {
  const { fullName, phone } = req.body || {};
  if (!isName(fullName)) return res.status(400).json({ error: 'Please enter your full name.' });
  const normPhone = normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'Please enter a valid Kenyan mobile number.' });
  await db.query('UPDATE users SET full_name = $1, phone = $2 WHERE id = $3', [fullName.trim(), normPhone, req.user.id]);
  res.json({ ok: true, user: { fullName: fullName.trim(), phone: normPhone } });
}));

// PATCH /api/auth/password
router.patch('/password', requireAuth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!isPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword || '', rows[0].password_hash))) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 12), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
