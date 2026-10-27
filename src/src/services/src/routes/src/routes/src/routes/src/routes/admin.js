/**
 * Admin routes — every handler sits behind requireAdmin (server-side role
 * check against the database). A client hitting these URLs gets 401/403.
 */
const express = require('express');
const db = require('../db');
const { requireAdmin, wrap } = require('../middleware');

const router = express.Router();
router.use(requireAdmin);

const STATUSES = ['pending', 'in_review', 'action_needed', 'completed', 'rejected', 'cancelled'];

// ---- Overview ----
router.get('/overview', wrap(async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'client') AS users,
      (SELECT COUNT(*) FROM service_requests WHERE status = 'pending') AS pending_requests,
      (SELECT COUNT(*) FROM service_requests WHERE status = 'in_review') AS active_requests,
      (SELECT COUNT(*) FROM payments WHERE status = 'pending') AS pending_payments,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE status='succeeded'
         AND (created_at AT TIME ZONE 'Africa/Nairobi')::date = (now() AT TIME ZONE 'Africa/Nairobi')::date) AS today_topups_cents,
      (SELECT COALESCE(SUM(reward_cents),0) FROM referral_rewards) AS referral_paid_cents`);
  const c = rows[0];
  res.json({
    users: Number(c.users), pendingRequests: Number(c.pending_requests),
    activeRequests: Number(c.active_requests), pendingPayments: Number(c.pending_payments),
    todayTopupsCents: Number(c.today_topups_cents), referralPaidCents: Number(c.referral_paid_cents)
  });
}));

// ---- Users ----
router.get('/users', wrap(async (req, res) => {
  const q = `%${(req.query.q || '').trim().toLowerCase()}%`;
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.is_active, u.created_at, w.balance_cents,
            (SELECT COUNT(*) FROM service_requests r WHERE r.user_id = u.id) AS request_count
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id
     WHERE LOWER(u.full_name) LIKE $1 OR LOWER(u.email) LIKE $1 OR u.phone LIKE $1
     ORDER BY u.created_at DESC LIMIT 200`, [q]
  );
  res.json({
    users: rows.map((u) => ({
      id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, role: u.role,
      isActive: u.is_active, balanceCents: u.balance_cents || 0, requestCount: Number(u.request_count), createdAt: u.created_at
    }))
  });
}));

// Deactivate/reactivate a CLIENT account. Role can never be changed here.
router.patch('/users/:id', wrap(async (req, res) => {
  if (typeof (req.body || {}).is_active !== 'boolean') return res.status(400).json({ error: 'Nothing to update.' });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own admin account.' });
  const { rowCount } = await db.query(`UPDATE users SET is_active = $1 WHERE id = $2 AND role = 'client'`,
    [req.body.is_active, Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Client account not found.' });
  res.json({ ok: true }); // deactivation takes effect immediately — attachUser re-checks the DB on every request
}));

// ---- Services ----
router.get('/services', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT id, slug, name, description, price_cents, is_active FROM services ORDER BY created_at ASC');
  res.json({ services: rows.map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, priceCents: s.price_cents, isActive: s.is_active })) });
}));

function validateService(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const priceKes = Number(body.priceKes);
  if (name.length < 4 || name.length > 80) return { error: 'Service name must be 4–80 characters.' };
  if (description.length < 20 || description.length > 600) return { error: 'Description must be 20–600 characters.' };
  if (!Number.isInteger(priceKes) || priceKes < 0 || priceKes > 1000000) return { error: 'Price must be a whole KSh amount.' };
  return { name, description, priceCents: priceKes * 100 };
}

router.post('/services', wrap(async (req, res) => {
  const v = validateService(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  let slug = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'service';
  if ((await db.query('SELECT 1 FROM services WHERE slug = $1', [slug])).rowCount) slug += `-${Date.now().toString(36).slice(-4)}`;
  const { rows } = await db.query('INSERT INTO services (slug, name, description, price_cents) VALUES ($1,$2,$3,$4) RETURNING id',
    [slug, v.name, v.description, v.priceCents]);
  res.status(201).json({ ok: true, id: rows[0].id });
}));

router.patch('/services/:id', wrap(async (req, res) => {
  const v = validateService(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (typeof (req.body || {}).isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be true or false.' });
  const { rowCount } = await db.query(
    'UPDATE services SET name=$1, description=$2, price_cents=$3, is_active=$4, updated_at=now() WHERE id=$5',
    [v.name, v.description, v.priceCents, req.body.isActive, Number(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Service not found.' });
  res.json({ ok: true });
}));

// ---- Requests ----
router.get('/requests', wrap(async (req, res) => {
  const status = req.query.status;
  const params = STATUSES.includes(status) ? [status] : [];
  const where = params.length ? 'WHERE r.status = $1' : '';
  const { rows } = await db.query(
    `SELECT r.*, s.name AS service_name, u.full_name, u.email, u.phone
     FROM service_requests r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id
     ${where} ORDER BY r.created_at DESC LIMIT 300`, params
  );
  res.json({
    requests: rows.map((r) => ({
      id: r.id, userId: r.user_id, userName: r.full_name, userEmail: r.email, userPhone: r.phone,
      serviceName: r.service_name, details: r.details, status: r.status, paymentStatus: r.payment_status,
      priceCents: r.price_cents_snapshot, adminNotes: r.admin_notes, createdAt: r.created_at
    }))
  });
}));

router.patch('/requests/:id', wrap(async (req, res) => {
  const { status, adminNotes } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  const notes = typeof adminNotes === 'string' && adminNotes.trim() ? adminNotes.trim().slice(0, 2000) : null;
  const { rowCount } = await db.query(
    'UPDATE service_requests SET status=$1, admin_notes=COALESCE($2, admin_notes), updated_at=now() WHERE id=$3',
    [status, notes, Number(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Request not found.' });
  res.json({ ok: true });
}));

// ---- Payments (provider-verified records) & full ledger ----
router.get('/payments', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.amount_cents, p.phone, p.status, p.mpesa_receipt, p.result_desc, p.created_at,
            u.full_name AS user_name, u.email AS user_email
     FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 300`
  );
  res.json({
    payments: rows.map((p) => ({
      id: p.id, userName: p.user_name, userEmail: p.user_email, phone: p.phone,
      amountCents: p.amount_cents, status: p.status, mpesaReceipt: p.mpesa_receipt,
      message: p.result_desc, createdAt: p.created_at
    }))
  });
}));

router.get('/transactions', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.kind, t.direction, t.amount_cents, t.description, t.reference, t.created_at,
            u.full_name AS user_name, u.email AS user_email
     FROM wallet_transactions t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 300`
  );
  res.json({
    transactions: rows.map((t) => ({
      kind: t.kind, direction: t.direction, amountCents: t.amount_cents, description: t.description,
      reference: t.reference, createdAt: t.created_at, userName: t.user_name, userEmail: t.user_email
    }))
  });
}));

// ---- Referral activity ----
router.get('/referrals', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT rr.reward_cents, rr.rewarded_at,
            a.full_name AS referrer_name, a.email AS referrer_email,
            b.full_name AS referee_name, b.email AS referee_email
     FROM referral_rewards rr
     JOIN users a ON a.id = rr.referrer_id
     JOIN users b ON b.id = rr.referee_id
     ORDER BY rr.rewarded_at DESC LIMIT 300`
  );
  res.json({
    rewards: rows.map((r) => ({
      rewardCents: r.reward_cents, rewardedAt: r.rewarded_at,
      referrerName: r.referrer_name, referrerEmail: r.referrer_email,
      refereeName: r.referee_name, refereeEmail: r.referee_email
    }))
  });
}));

module.exports = router;
