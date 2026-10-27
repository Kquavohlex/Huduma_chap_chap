/** Shared middleware + validation helpers. */
const { query } = require('./db');

/** Load the signed-in user fresh from the DB on every request.
 *  Role and active status are never taken from the session or the browser,
 *  so editing cookies or URLs cannot grant admin access. */
async function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      const { rows } = await query(
        'SELECT id, full_name, email, phone, role, is_active, referral_code FROM users WHERE id = $1',
        [req.session.userId]
      );
      if (rows[0] && rows[0].is_active) req.user = rows[0];
      else req.session.userId = null; // deactivated or deleted account
    } catch (err) { return next(err); }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}

/** Every administrative route is gated here, on the server. */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  next();
}

/** Wrap async handlers so rejected promises reach the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- validation helpers ----
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const isName = (s) => typeof s === 'string' && s.trim().length >= 3 && s.trim().length <= 80;
const isPassword = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 100;

/** Kenyan mobile: 07XX/01XX/+2547XX → normalised to 2547XXXXXXXX / 2541XXXXXXXX */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s-]/g, '');
  if (/^0(7|1)\d{8}$/.test(s)) s = '254' + s.slice(1);
  else if (/^\+254(7|1)\d{8}$/.test(s)) s = s.slice(1);
  else if (!/^254(7|1)\d{8}$/.test(s)) return null;
  return s;
}

module.exports = { attachUser, requireAuth, requireAdmin, wrap, isEmail, isName, isPassword, normalizePhone };
