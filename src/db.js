/**
 * Database access layer. All money amounts are INTEGER cents (KES × 100) —
 * no floating-point arithmetic anywhere. The schema is created automatically
 * on first boot, so a fresh Render PostgreSQL database needs no manual SQL.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

const query = (text, params) => pool.query(text, params);

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','admin')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by   INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0)
);

CREATE TABLE IF NOT EXISTS services (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_requests (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  service_id           INTEGER NOT NULL REFERENCES services(id),
  details              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_review','action_needed','completed','rejected','cancelled')),
  payment_status       TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  price_cents_snapshot INTEGER NOT NULL,
  admin_notes          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('topup','request_payment','referral_reward')),
  direction       TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  description     TEXT NOT NULL,
  reference       TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  purpose             TEXT NOT NULL DEFAULT 'wallet_topup',
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  phone               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  provider            TEXT NOT NULL DEFAULT 'mpesa',
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  mpesa_receipt       TEXT,
  result_code         INTEGER,
  result_desc         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id           SERIAL PRIMARY KEY,
  referrer_id  INTEGER NOT NULL REFERENCES users(id),
  referee_id   INTEGER NOT NULL UNIQUE REFERENCES users(id),
  reward_cents INTEGER NOT NULL,
  rewarded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_user   ON service_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON service_requests (status);
CREATE INDEX IF NOT EXISTS idx_tx_user         ON wallet_transactions (user_id);

-- The real service catalogue (admin can edit prices / deactivate later).
INSERT INTO services (slug, name, description, price_cents) VALUES
('passport-application-assistance',
 'Passport Application Assistance',
 'We prepare and check your eCitizen passport application end to end: correct form data, photo and document checklist, fee guidance and submission support. Assistance only — the Immigration Department makes the final decision.', 150000),
('visa-application-assistance',
 'Visa Application Assistance',
 'Guided preparation for e-visa and embassy applications: form review, supporting documents, cover letters and submission checklists. Assistance only — the embassy or destination authority decides.', 250000),
('medical-report-coordination',
 'Medical Report Coordination (Travel)',
 'We coordinate pre-travel medical reports with accredited facilities — bookings, collection and correct formatting for embassies, schools or airlines. We do not issue or alter medical results.', 350000),
('ecitizen-form-filing',
 'eCitizen & Online Form Filing',
 'Accurate data entry and submission support for eCitizen services: good conduct, driving licence, business permits and more.', 100000),
('application-follow-up',
 'Application Follow-up & Tracking',
 'Filed an application through us? We track progress with the relevant office and keep your dashboard updated until a decision is issued.', 80000)
ON CONFLICT (slug) DO NOTHING;
`;

async function initSchema() { await pool.query(SCHEMA); }

module.exports = { pool, query, withTransaction, initSchema };
