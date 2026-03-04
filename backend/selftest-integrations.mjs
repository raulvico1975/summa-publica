import crypto from 'node:crypto';

import {
  createOrgWithOwner,
  upsertSocialIntegration,
  getSocialIntegration,
  listSocialIntegrations,
  disconnectSocialIntegration
} from './db.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if ((process.env.DATA_STORE || '').toLowerCase() !== 'local') {
    throw new Error('Aquest test s ha d executar amb DATA_STORE=local.');
  }

  const seed = crypto.randomUUID().slice(0, 8);

  const orgA = await createOrgWithOwner({
    uid: `oid-a-${seed}`,
    email: `owner-a-${seed}@example.com`,
    orgName: `Org IA ${seed}`,
    displayName: 'Owner A'
  });

  const orgB = await createOrgWithOwner({
    uid: `oid-b-${seed}`,
    email: `owner-b-${seed}@example.com`,
    orgName: `Org IB ${seed}`,
    displayName: 'Owner B'
  });

  await upsertSocialIntegration({
    orgId: orgA.org.id,
    provider: 'meta',
    status: 'connected',
    facebookPageId: '123',
    facebookPageName: 'Pagina A',
    pageAccessTokenEnc: 'v1.fake',
    connectedByUid: orgA.user.id,
    connectedByEmail: orgA.user.email,
    connectedAt: Date.now()
  }, { orgId: orgA.org.id });

  const aMeta = await getSocialIntegration('meta', { orgId: orgA.org.id });
  const bMeta = await getSocialIntegration('meta', { orgId: orgB.org.id });

  assert(aMeta && aMeta.facebookPageId === '123', 'Org A no recupera la seva integracio.');
  assert(bMeta === null, 'Org B veu la integracio d Org A.');

  const listA = await listSocialIntegrations({ orgId: orgA.org.id });
  const listB = await listSocialIntegrations({ orgId: orgB.org.id });
  assert(listA.length === 1, 'Org A hauria de tenir 1 integracio.');
  assert(listB.length === 0, 'Org B no hauria de tenir integracions.');

  const disconnected = await disconnectSocialIntegration('meta', { orgId: orgA.org.id });
  assert(disconnected === true, 'No s ha pogut desconnectar la integracio d Org A.');

  const after = await getSocialIntegration('meta', { orgId: orgA.org.id });
  assert(after && after.status === 'disconnected', 'L estat de desconnexio no s ha guardat.');
  assert(!after.pageAccessTokenEnc, 'El token xifrat s hauria d eliminar en desconnectar.');

  console.log('[INTEGRATIONS TEST] OK');
}

main().catch((err) => {
  console.error('[INTEGRATIONS TEST] FAIL:', err?.message || err);
  process.exitCode = 1;
});
