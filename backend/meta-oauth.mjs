import crypto from 'node:crypto';

import { config } from './config.mjs';
import { createOauthState, consumeOauthState, upsertSocialIntegration } from './db.mjs';
import { encryptSecret } from './secret-crypto.mjs';

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function hmacSign(payloadText) {
  const secret = String(config.sessionSecret || '').trim();
  if (!secret) throw new Error('SESSION_SECRET obligatori per OAuth.');
  return base64urlEncode(crypto.createHmac('sha256', secret).update(payloadText).digest());
}

function issueSignedOAuthState(payload) {
  const payloadText = JSON.stringify(payload);
  const encodedPayload = base64urlEncode(payloadText);
  const signature = hmacSign(payloadText);
  return `${encodedPayload}.${signature}`;
}

function verifySignedOAuthState(stateToken) {
  const token = String(stateToken || '');
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  let payloadText = '';
  let payload = null;
  try {
    payloadText = base64urlDecode(encodedPayload);
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }

  const expected = hmacSign(payloadText);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
  return payload;
}

function requireMetaConfig() {
  if (!config.metaAppId || !config.metaAppSecret) {
    throw new Error('Falten META_APP_ID o META_APP_SECRET. No es pot connectar Meta OAuth.');
  }
}

function metaGraphBaseUrl() {
  const apiVersion = String(config.metaApiVersion || 'v22.0').trim() || 'v22.0';
  return `https://graph.facebook.com/${apiVersion}`;
}

function metaDialogUrl() {
  const apiVersion = String(config.metaApiVersion || 'v22.0').trim() || 'v22.0';
  return `https://www.facebook.com/${apiVersion}/dialog/oauth`;
}

function metaRedirectUri() {
  return `${String(config.appBaseUrl || '').replace(/\/$/, '')}/api/integrations/meta/callback`;
}

async function metaGet(pathName, params) {
  const url = new URL(`${metaGraphBaseUrl()}${pathName}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (typeof value === 'undefined' || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), { method: 'GET' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload?.error?.code || '';
    const message = payload?.error?.message || `Meta API HTTP ${response.status}`;
    throw new Error(`Meta OAuth error (${code || response.status}): ${message}`);
  }
  return payload;
}

function pickMetaPage(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return null;
  const withInstagram = list.find((page) => page?.instagram_business_account?.id);
  return withInstagram || list[0];
}

export async function buildMetaAuthorizationUrl({ orgId, uid, email }) {
  requireMetaConfig();

  const normalizedOrgId = String(orgId || '').trim();
  const normalizedUid = String(uid || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedOrgId || !normalizedUid || !normalizedEmail) {
    throw new Error('Dades de sessio incompletes per iniciar OAuth.');
  }

  const stateId = crypto.randomUUID();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const ttlSec = Math.max(120, Number(config.metaOauthStateTtlSec || 600));
  const exp = Date.now() + ttlSec * 1000;

  await createOauthState({
    id: stateId,
    provider: 'meta',
    orgId: normalizedOrgId,
    uid: normalizedUid,
    email: normalizedEmail,
    nonce,
    expiresAt: exp
  });

  const stateToken = issueSignedOAuthState({
    v: 1,
    sid: stateId,
    n: nonce,
    p: 'meta',
    orgId: normalizedOrgId,
    uid: normalizedUid,
    exp
  });

  const params = new URLSearchParams({
    client_id: config.metaAppId,
    redirect_uri: metaRedirectUri(),
    response_type: 'code',
    state: stateToken,
    scope: config.metaOauthScopes
  });

  return `${metaDialogUrl()}?${params.toString()}`;
}

export async function completeMetaOAuthCallback({ stateToken, code }) {
  requireMetaConfig();

  const signedState = verifySignedOAuthState(stateToken);
  if (!signedState || signedState.p !== 'meta') {
    throw new Error('Estat OAuth invalid.');
  }

  const persistedState = await consumeOauthState({
    id: String(signedState.sid || ''),
    provider: 'meta',
    nonce: String(signedState.n || '')
  });
  if (!persistedState) {
    throw new Error('Estat OAuth caducat o ja utilitzat.');
  }

  const redirectUri = metaRedirectUri();
  const shortLived = await metaGet('/oauth/access_token', {
    client_id: config.metaAppId,
    redirect_uri: redirectUri,
    client_secret: config.metaAppSecret,
    code
  });

  let userAccessToken = String(shortLived.access_token || '');
  let userTokenExpiresInSec = Number(shortLived.expires_in || 0);
  if (!userAccessToken) throw new Error('Meta no ha retornat access token.');

  try {
    const longLived = await metaGet('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: config.metaAppId,
      client_secret: config.metaAppSecret,
      fb_exchange_token: userAccessToken
    });
    if (longLived?.access_token) {
      userAccessToken = String(longLived.access_token);
      userTokenExpiresInSec = Number(longLived.expires_in || userTokenExpiresInSec || 0);
    }
  } catch {
    // Fallback to short-lived token; still functional.
  }

  const managed = await metaGet('/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: 200,
    access_token: userAccessToken
  });
  const pages = Array.isArray(managed?.data) ? managed.data : [];
  const page = pickMetaPage(pages);
  if (!page?.id || !page?.access_token) {
    throw new Error('No s ha trobat cap pagina gestionable amb accés de publicacio.');
  }

  const connectedAt = Date.now();
  const userTokenExpiresAt = userTokenExpiresInSec > 0 ? connectedAt + userTokenExpiresInSec * 1000 : null;

  const integration = await upsertSocialIntegration({
    orgId: persistedState.orgId,
    provider: 'meta',
    status: 'connected',
    facebookPageId: String(page.id),
    facebookPageName: String(page.name || ''),
    instagramBusinessAccountId: page?.instagram_business_account?.id ? String(page.instagram_business_account.id) : null,
    instagramUsername: page?.instagram_business_account?.username ? String(page.instagram_business_account.username) : null,
    pageAccessTokenEnc: encryptSecret(String(page.access_token)),
    userAccessTokenEnc: encryptSecret(userAccessToken),
    userAccessTokenExpiresAt,
    connectedByUid: String(persistedState.uid),
    connectedByEmail: String(persistedState.email),
    connectedAt,
    disconnectedAt: null,
    lastError: null
  }, { orgId: persistedState.orgId });

  return {
    orgId: String(integration.orgId),
    uid: String(persistedState.uid),
    email: String(persistedState.email),
    facebookPageId: String(integration.facebookPageId || ''),
    facebookPageName: String(integration.facebookPageName || ''),
    instagramBusinessAccountId: integration.instagramBusinessAccountId ? String(integration.instagramBusinessAccountId) : null,
    instagramUsername: integration.instagramUsername ? String(integration.instagramUsername) : null
  };
}
