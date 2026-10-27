/**
 * Wallet ledger — the ONLY code allowed to move money.
 * Every movement writes an immutable wallet_transactions row (with a unique
 * idempotency_key) and updates the wallets balance inside the SAME DB
 * transaction. The DB CHECK (balance_cents >= 0) makes overdrafts impossible;
 * the UNIQUE idempotency key makes double-credits impossible.
 */
const REFERRAL_REWARD_CENTS = parseInt(process.env.REFERRAL_REWARD_CENTS || '5000', 10);

class InsufficientFunds extends Error {}
class AlreadyProcessed extends Error {}

async function credit(client, userId, kind, amountCents, description, reference, idempotencyKey) {
  const inserted = await client.query(
    `INSERT INTO wallet_transactions (user_id, kind, direction, amount_cents, description, reference, idempotency_key)
     VALUES ($1, $2, 'credit', $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [userId, kind, amountCents, description, reference, idempotencyKey]
  );
  if (inserted.rowCount === 0) return; // already applied — never credit twice
  await client.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id = $2', [amountCents, userId]);
}

async function debit(client, userId, kind, amountCents, description, reference, idempotencyKey) {
  const inserted = await client.query(
    `INSERT INTO wallet_transactions (user_id, kind, direction, amount_cents, description, reference, idempotency_key)
     VALUES ($1, $2, 'debit', $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [userId, kind, amountCents, description, reference, idempotencyKey]
  );
  if (inserted.rowCount === 0) throw new AlreadyProcessed();

  const updated = await client.query(
    `UPDATE wallets SET balance_cents = balance_cents - $1
     WHERE user_id = $2 AND balance_cents >= $1 RETURNING balance_cents`,
    [amountCents, userId]
  );
  if (updated.rowCount === 0) throw new InsufficientFunds();
  return updated.rows[0].balance_cents;
}

/**
 * Referral reward — issued exactly once per referred user, ONLY from trusted
 * server-side payment logic (a confirmed provider payment). UNIQUE(referee_id)
 * blocks repeated claims; self-referral is impossible because the referral code
 * is resolved against other users at signup, before the account exists.
 */
async function maybeRewardReferrer(client, refereeId) {
  const referee = await client.query(
    'SELECT referred_by FROM users WHERE id = $1 AND referred_by IS NOT NULL', [refereeId]
  );
  if (referee.rowCount === 0) return false;
  const referrerId = referee.rows[0].referred_by;
  if (referrerId === refereeId) return false;

  const inserted = await client.query(
    `INSERT INTO referral_rewards (referrer_id, referee_id, reward_cents)
     VALUES ($1, $2, $3) ON CONFLICT (referee_id) DO NOTHING RETURNING id`,
    [referrerId, refereeId, REFERRAL_REWARD_CENTS]
  );
  if (inserted.rowCount === 0) return false;

  await credit(client, referrerId, 'referral_reward', REFERRAL_REWARD_CENTS,
    'Referral reward — your invite completed their first confirmed payment', null, `referral:${refereeId}`);
  return true;
}

module.exports = { credit, debit, maybeRewardReferrer, InsufficientFunds, AlreadyProcessed, REFERRAL_REWARD_CENTS };
