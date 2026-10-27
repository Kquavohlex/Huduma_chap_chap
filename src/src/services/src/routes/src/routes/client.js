/**
 * Client routes: services, service requests, wallet, referrals.
 * Every query is scoped to req.user.id — a client can only see or touch
 * their own data, no matter what they send in the URL or body.
 */
const express = require('express');
const db = require('../db');
const ledger = require('../services/ledger');
const { requireAuth, wrap } = require('../middleware');

const router = express.Router();

// Public: the live catalogue with prices (the landing page uses this too).
router.get('/services', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT id, slug, name, description, price_cents FROM services WHERE is_active = TRUE ORDER BY price_cents ASC');
  res.json({ services: rows.map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, priceCents: s.price_cents })) });
}));

// Everything below requires a signed-in account.
router.use(requireAuth);

const mapRequest = (r) => ({
  id: r.id, serviceName: r.service_name, details: r.details, status: r.status,
  paymentStatus: r.payment_status, priceCents: r.price_cents_snapshot,
  adminNotes: r.admin_notes, createdAt: r.created_at, updatedAt: r.updated_at
});

// ---- Service requests ----
router.get('/requests', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.*, s.name AS service_name FROM service_requests r
     JOIN services s ON s.id = r.service_id WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json({ requests: rows.map(mapRequest) });
}));

router.post('/requests', wrap(async (req, res) => {
  const serviceId = Number(req.body && req.body.serviceId);
  const details = typeof (req.body && req.body.details) === 'string' ? req.body.details.trim() : '';
  if (!serviceId) return res.status(400).json({ error: 'Choose a service first.' });
  if (details.length < 20) return res.status(400).json({ error: 'Please describe what you need in at least 20 characters so we can help properly.' });
  if (details.length > 4000) return res.status(400).json({ error: 'Please keep your description under 4000 characters.' });

  const svc = await db.query('SELECT id, price_cents FROM services WHERE id = $1 AND is_active = TRUE', [serviceId]);
  if (!svc.rows[0]) return res.status(400).json({ error: 'That service is not available right now.' });

  const { rows } = await db.query(
    `INSERT INTO service_requests (user_id, service_id, details, price_cents_snapshot)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.user.id, serviceId, details, svc.rows[0].price_cents]
  );
  res.status(201).json({ ok: true, id: rows[0].id });
}));

// Pay for a request from wallet balance — atomic, ledger-backed, idempotent.
router.post('/requests/:id/pay', wrap(async (req, res) => {
  try {
    const result = await db.withTransaction(async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM service_requests WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [Number(req.params.id), req.user.id]
      );
      const r = rows[0];
      if (!r) throw Object.assign(new Error(), { status: 404, expose: 'Request not found.' });
      if (r.payment_status === 'paid') throw Object.assign(new Error(), { status: 409, expose: 'This request is already paid.' });
      if (r.status === 'cancelled' || r.status === 'rejected') throw Object.assign(new Error(), { status: 400, expose: 'This request can no longer be paid.' });

      const balance = await ledger.debit(c, req.user.id, 'request_payment', r.price_cents_snapshot,
        `Payment for request #${r.id}`, `request:${r.id}`, `request-payment:${r.id}`);
      await c.query(`UPDATE service_requests SET payment_status = 'paid', updated_at = now() WHERE id = $1`, [r.id]);
      return { balanceCents: balance };
    });
    res.json({ ok: true, balanceCents: result.balanceCents });
  } catch (err) {
    if (err instanceof ledger.InsufficientFunds) return res.status(400).json({ error: 'Your wallet balance is not enough for this request. Top up first from the Wallet tab.' });
    if (err instanceof ledger.AlreadyProcessed) return res.status(409).json({ error: 'This request is already paid.' });
    if (err.expose) return res.status(err.status).json({ error: err.expose });
    throw err;
  }
}));

router.post('/requests/:id/cancel', wrap(async (req, res) => {
  const { rowCount } = await db.query(
    `UPDATE service_requests SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [Number(req.params.id), req.user.id]
  );
  if (!rowCount) return res.status(400).json({ error: 'Only requests that are still pending can be cancelled.' });
  res.json({ ok: true });
}));

// ---- Wallet ----
router.get('/wallet', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT balance_cents FROM wallets WHERE user_id = $1', [req.user.id]);
  res.json({ balanceCents: rows[0] ? rows[0].balance_cents : 0 });
}));

router.get('/wallet/transactions', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT kind, direction, amount_cents, description, reference, created_at
     FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json({
    transactions: rows.map((t) => ({
      kind: t.kind, direction: t.direction, amountCents: t.amount_cents,
      description: t.description, reference: t.reference, createdAt: t.created_at
    }))
  });
}));

// ---- Referrals ----
router.get('/referrals', wrap(async (req, res) => {
  const invited = await db.query(
    `SELECT u.full_name, u.created_at, (rr.id IS NOT NULL) AS rewarded
     FROM users u LEFT JOIN referral_rewards rr ON rr.referee_id = u.id
     WHERE u.referred_by = $1 ORDER BY u.created_at DESC`,
    [req.user.id]
  );
  const totals = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents FROM wallet_transactions
     WHERE user_id = $1 AND kind = 'referral_reward'`,
    [req.user.id]
  );
  res.json({
    referralCode: req.user.referral_code,
    rewardCents: ledger.REFERRAL_REWARD_CENTS,
    totalEarnedCents: Number(totals.rows[0].total_cents),
    invited: invited.rows.map((i) => ({ name: i.full_name.split(' ')[0], joinedAt: i.created_at, rewarded: i.rewarded }))
  });
}));

module.exports = router;
