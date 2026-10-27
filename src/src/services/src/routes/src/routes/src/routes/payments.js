/**
 * Payment routes.
 *
 *  POST /api/payments/stk/initiate            (client)   start an M-Pesa top-up
 *  GET  /api/payments/stk/:checkoutId/status  (client)   poll — the server is the only source of truth
 *  POST /api/payments/mpesa/callback/:token   (Safaricom) server-to-server confirmation
 *
 * Security rules enforced here:
 *  - Success is NEVER taken from the browser. Only a verified provider
 *    callback (guarded by a secret URL token, compared in constant time)
 *    can credit a wallet.
 *  - Each payment is credited at most once: row lock + status transition +
 *    unique idempotency key on the ledger entry.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, wrap, normalizePhone } = require('../middleware');
const mpesa = require('../services/mpesa');
const ledger = require('../services/ledger');

const router = express.Router();

// POST /api/payments/stk/initiate
router.post('/stk/initiate', requireAuth, wrap(async (req, res) => {
  if (!mpesa.enabled()) {
    return res.status(503).json({
      code: 'PAYMENTS_DISABLED',
      error: 'M-Pesa top-ups are not switched on yet on this deployment. The wallet ledger, requests and rewards all work normally — top-ups open once the payment provider is connected and verified.'
    });
  }

  const amountKes = Number(req.body && req.body.amount);
  const phone = normalizePhone(req.body && req.body.phone);
  if (!Number.isInteger(amountKes) || amountKes < 1 || amountKes > 150000) {
    return res.status(400).json({ error: 'Enter a whole amount between KSh 1 and KSh 150,000.' });
  }
  if (!phone) return res.status(400).json({ error: 'Enter the Safaricom number to charge, e.g. 0712 345 678.' });

  let paymentId = null;
  try {
    const { rows } = await db.query(
      'INSERT INTO payments (user_id, amount_cents, phone) VALUES ($1, $2, $3) RETURNING id',
      [req.user.id, amountKes * 100, phone]
    );
    paymentId = rows[0].id;

    const push = await mpesa.stkPush({
      amountKes, phone,
      accountReference: `HCC-${paymentId}`,
      description: 'Huduma Chap Chap wallet top-up'
    });
    await db.query('UPDATE payments SET merchant_request_id = $1, checkout_request_id = $2 WHERE id = $3',
      [push.merchantRequestId, push.checkoutRequestId, paymentId]);

    res.status(202).json({ checkoutRequestId: push.checkoutRequestId, message: 'Check your phone and enter your M-Pesa PIN to complete the top-up.' });
  } catch (err) {
    if (err instanceof mpesa.MpesaNotConfigured) {
      return res.status(503).json({ code: 'PAYMENTS_DISABLED', error: 'M-Pesa credentials are not configured yet. Nothing was charged.' });
    }
    if (paymentId) await db.query(`UPDATE payments SET status='failed', result_desc=$1 WHERE id=$2 AND status='pending'`,
      [String(err.message).slice(0, 300), paymentId]);
    res.status(502).json({ error: 'We could not reach M-Pesa just now. No money has left your account — please try again.' });
  }
}));

// GET /api/payments/stk/:checkoutId/status — the browser may only READ state.
router.get('/stk/:checkoutId/status', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT status, mpesa_receipt, result_desc FROM payments WHERE checkout_request_id = $1 AND user_id = $2',
    [req.params.checkoutId, req.user.id]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Unknown payment.' });
  res.json({ status: p.status, mpesaReceipt: p.mpesa_receipt, message: p.result_desc });
}));

/**
 * Provider callback. The secret :token segment is configured on the Daraja
 * portal. Safaricom expects a quick 200 {"ResultCode":0} regardless of the
 * internal outcome, so we always answer that after processing.
 */
router.post('/mpesa/callback/:token', wrap(async (req, res) => {
  if (!mpesa.callbackTokenMatches(req.params.token)) return res.status(404).json({ ResultCode: 1, ResultDesc: 'Not found' });

  const cb = (req.body && req.body.Body && req.body.Body.stkCallback) || {};
  const checkoutId = cb.CheckoutRequestID;
  const resultCode = Number(cb.ResultCode);
  const meta = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const receipt = (meta.find((i) => i.Name === 'MpesaReceiptNumber') || {}).Value || null;

  if (checkoutId) {
    await db.withTransaction(async (c) => {
      // Row lock: two callbacks for the same payment are serialised here.
      const { rows } = await c.query('SELECT * FROM payments WHERE checkout_request_id = $1 FOR UPDATE', [checkoutId]);
      const payment = rows[0];
      if (!payment || payment.status !== 'pending') return; // already settled — idempotent no-op

      if (resultCode !== 0) {
        await c.query(`UPDATE payments SET status='failed', result_code=$1, result_desc=$2, updated_at=now() WHERE id=$3`,
          [resultCode, String(cb.ResultDesc || 'Payment failed').slice(0, 300), payment.id]);
        return;
      }

      await c.query(`UPDATE payments SET status='succeeded', mpesa_receipt=$1, result_code=$2, result_desc=$3, updated_at=now() WHERE id=$4`,
        [receipt, resultCode, String(cb.ResultDesc || 'Payment received').slice(0, 300), payment.id]);

      // Credit exactly once, then check referral rewards — same transaction.
      await ledger.credit(c, payment.user_id, 'topup', payment.amount_cents,
        'Wallet top-up via M-Pesa', receipt, `mpesa:${receipt || checkoutId}`);
      await ledger.maybeRewardReferrer(c, payment.user_id);
    });
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

module.exports = router;
