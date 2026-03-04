import { consumeAuthRateLimit } from './db.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if ((process.env.DATA_STORE || '').toLowerCase() !== 'local') {
    throw new Error('Aquest test s ha d executar amb DATA_STORE=local.');
  }

  const action = `login-test-${Date.now()}`;
  const email = `user-${Date.now()}@example.com`;
  const ip = '127.0.0.1';

  const one = await consumeAuthRateLimit({ action, email, ip, windowMs: 5_000, maxAttempts: 2 });
  const two = await consumeAuthRateLimit({ action, email, ip, windowMs: 5_000, maxAttempts: 2 });
  const three = await consumeAuthRateLimit({ action, email, ip, windowMs: 5_000, maxAttempts: 2 });

  assert(one.allowed === true, 'Primer intent hauria de ser valid.');
  assert(two.allowed === true, 'Segon intent hauria de ser valid.');
  assert(three.allowed === false, 'Tercer intent hauria de quedar bloquejat.');
  assert(Number(three.retryAfterSec || 0) > 0, 'retryAfterSec ha de ser > 0 quan bloqueja.');

  console.log('[RATE LIMIT TEST] OK');
}

main().catch((err) => {
  console.error('[RATE LIMIT TEST] FAIL:', err?.message || err);
  process.exitCode = 1;
});
