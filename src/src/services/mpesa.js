/**
 * M-Pesa Daraja (STK Push) integration layer.
 * Inert unless MPESA_ENABLED=true AND real credentials exist — until then
 * every call throws MpesaNotConfigured and the API answers with a clear
 * "payments not enabled yet" message. No simulated success, ever.
 */
const crypto = require('crypto');

class MpesaNotConfigured extends Error {}

function enabled() { return process.env.MPESA_ENABLED === 'true'; }

function config() {
  const c = {
    baseUrl: process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke',
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackBase: process.env.MPESA_CALLBACK_BASE_URL,
    callbackToken: process.env.MPESA_CALLBACK_TOKEN
  };
  if (!c.consumerKey || !c.consumerSecret || !c.shortcode || !c.passkey || !c.callbackBase || !c.callbackToken) {
    throw new MpesaNotConfigured();
  }
  return c;
}

let tokenCache = { token: null, expiresAt: 0 };
async function accessToken(c) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const auth = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64');
  const res = await fetch(`${c.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Daraja auth failed (${res.status})`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 30) * 1000 };
  return tokenCache.token;
}

/** Daraja expects a Nairobi-time (UTC+3) timestamp: yyyyMMddHHmmss */
function darajaTimestamp() {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Launch an STK Push. Returns { merchantRequestId, checkoutRequestId }. */
async function stkPush({ amountKes, phone, accountReference, description }) {
  const c = config();
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${c.shortcode}${c.passkey}${timestamp}`).toString('base64');
  const token = await accessToken(c);

  const res = await fetch(`${c.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: c.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amountKes,
      PartyA: phone,
      PartyB: c.shortcode,
      PhoneNumber: phone,
      CallBackURL: `${c.callbackBase.replace(/\/$/, '')}/api/payments/mpesa/callback/${c.callbackToken}`,
      AccountReference: accountReference,
      TransactionDesc: description
    })
  });
  const data = await res.json();
  if (!res.ok || data.errorCode || !data.CheckoutRequestID) {
    throw new Error(data.errorMessage || `Daraja STK push failed (${res.status})`);
  }
  return { merchantRequestId: data.MerchantRequestID, checkoutRequestId: data.CheckoutRequestID };
}

/** Constant-time comparison of the secret path token on provider callbacks. */
function callbackTokenMatches(supplied) {
  const expected = process.env.MPESA_CALLBACK_TOKEN || '';
  if (!expected || typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

module.exports = { enabled, stkPush, callbackTokenMatches, MpesaNotConfigured };
