import crypto from 'node:crypto';

import {
  createOrgWithOwner,
  createPost,
  listPosts,
  getPost,
  updatePost,
  deletePost
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
    uid: `uid-a-${seed}`,
    email: `owner-a-${seed}@example.com`,
    orgName: `Org A ${seed}`,
    displayName: 'Owner A'
  });

  const orgB = await createOrgWithOwner({
    uid: `uid-b-${seed}`,
    email: `owner-b-${seed}@example.com`,
    orgName: `Org B ${seed}`,
    displayName: 'Owner B'
  });

  const postA = await createPost({
    topic: 'Post A',
    channel: 'facebook',
    content: 'Contingut A',
    status: 'draft',
    scheduledAt: null,
    mediaUrls: []
  }, { orgId: orgA.org.id });

  const postB = await createPost({
    topic: 'Post B',
    channel: 'facebook',
    content: 'Contingut B',
    status: 'draft',
    scheduledAt: null,
    mediaUrls: []
  }, { orgId: orgB.org.id });

  const postsA = await listPosts({ orgId: orgA.org.id });
  const postsB = await listPosts({ orgId: orgB.org.id });

  assert(postsA.some((p) => p.id === postA.id), 'Org A no veu el seu post.');
  assert(!postsA.some((p) => p.id === postB.id), 'Org A veu dades d Org B.');

  assert(postsB.some((p) => p.id === postB.id), 'Org B no veu el seu post.');
  assert(!postsB.some((p) => p.id === postA.id), 'Org B veu dades d Org A.');

  const crossRead = await getPost(postB.id, { orgId: orgA.org.id });
  assert(crossRead === null, 'Org A pot llegir un post d Org B.');

  const crossUpdate = await updatePost(postB.id, (prev) => ({ ...prev, topic: 'HACK' }), { orgId: orgA.org.id });
  assert(crossUpdate === null, 'Org A pot editar un post d Org B.');

  const crossDelete = await deletePost(postB.id, { orgId: orgA.org.id });
  assert(crossDelete === false, 'Org A pot eliminar un post d Org B.');

  console.log('[TENANCY TEST] OK');
}

main().catch((err) => {
  console.error('[TENANCY TEST] FAIL:', err?.message || err);
  process.exitCode = 1;
});
