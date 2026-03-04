import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config, getAllowedChannels, getStartupWarnings, isApiRoleEnabled, isWorkerRoleEnabled } from './config.mjs';
import {
  loginWithFirebase,
  signupWithFirebase,
  evaluateLoginSecurity,
  createSessionTokenForUser,
  logout,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromRequest
} from './auth.mjs';
import {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  appendAudit,
  listDueApprovedPosts,
  createOrgWithOwner,
  resolveUserSessionContext,
  touchUserLogin,
  consumeAuthRateLimit,
  listSocialIntegrations,
  getSocialIntegration,
  disconnectSocialIntegration
} from './db.mjs';
import { generateWithGemini } from './gemini.mjs';
import { publishPost } from './publishers.mjs';
import { getRelevantQuotes, validatePostCitations, syncQuotesCatalog } from './quotes.mjs';
import { buildMetaAuthorizationUrl, completeMetaOAuthCallback } from './meta-oauth.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..', 'web');
const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');

let publishCycleRunning = false;
let gcpTokenCache = {
  token: '',
  expiresAtMs: 0
};

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function badRequest(res, message) {
  return json(res, 400, { ok: false, error: message });
}

function unauthorized(res) {
  return json(res, 401, { ok: false, error: 'No autoritzat.' });
}

function authFailure(res, err, code = 401) {
  return json(res, code, { ok: false, error: err?.message || 'No autoritzat.' });
}

function tooManyRequests(res, message, retryAfterSec) {
  if (retryAfterSec > 0) res.setHeader('Retry-After', String(retryAfterSec));
  return json(res, 429, { ok: false, error: message || 'Massa intents. Torna-ho a provar mes tard.' });
}

function notFound(res) {
  return json(res, 404, { ok: false, error: 'No trobat.' });
}

function serverError(res, err) {
  console.error(err);
  return json(res, 500, { ok: false, error: err?.message || 'Error intern.' });
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('Payload massa gran.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON invàlid.'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeChannel(channel) {
  const allowed = getAllowedChannels();
  return allowed.includes(channel) ? channel : null;
}

function parseDateTime(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

function encodePostsCursor(post) {
  if (!post || !post.id) return null;
  const payload = {
    c: Number(post.createdAt || 0),
    i: String(post.id)
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePostsCursor(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  try {
    const parsed = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
    if (!Number.isFinite(parsed.c) || !parsed.i) return null;
    return { createdAt: Number(parsed.c), id: String(parsed.i) };
  } catch {
    return null;
  }
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  const socketIp = String(req.socket?.remoteAddress || '').trim();
  return forwarded || socketIp || 'unknown';
}

function isPrivilegedRole(role) {
  return ['owner', 'admin'].includes(String(role || '').toLowerCase());
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function oauthResultRedirectUrl({ ok, message }) {
  const destination = new URL('/', config.appBaseUrl);
  destination.searchParams.set('oauth_status', ok ? 'ok' : 'error');
  if (message) destination.searchParams.set('oauth_message', message);
  return destination.toString();
}

function normalizeStatus(status) {
  return status === 'approved' ? 'scheduled' : status;
}

function toPublicPost(post) {
  const mediaUrls = Array.isArray(post.mediaUrls)
    ? post.mediaUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : (post.mediaUrl ? [String(post.mediaUrl).trim()] : []);

  return {
    id: post.id,
    topic: post.topic,
    channel: post.channel,
    content: post.content,
    status: normalizeStatus(post.status),
    scheduledAt: post.scheduledAt,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    approvedAt: post.approvedAt,
    approvedBy: post.approvedBy,
    publishedAt: post.publishedAt,
    failCount: post.failCount,
    lastError: post.lastError,
    providerMessage: post.providerMessage,
    mediaUrl: mediaUrls[0] || null,
    mediaUrls,
    quoteIdsUsed: Array.isArray(post.quoteIdsUsed) ? post.quoteIdsUsed : [],
    citationRefs: Array.isArray(post.citationRefs) ? post.citationRefs : []
  };
}

async function processOnePost(post) {
  try {
    const citationValidation = await validatePostCitations(post.content);
    if (!citationValidation.ok) {
      throw new Error(`Validacio de cites fallida abans de publicar: ${citationValidation.error}`);
    }

    const publishableContent = citationValidation.sanitizedContent || post.content;
    const postForPublish = {
      ...post,
      content: publishableContent,
      quoteIdsUsed: citationValidation.quoteIdsUsed,
      citationRefs: citationValidation.citationRefs
    };

    await updatePost(post.id, (prev) => ({
      ...prev,
      content: publishableContent,
      status: 'publishing',
      lastError: null,
      quoteIdsUsed: citationValidation.quoteIdsUsed,
      citationRefs: citationValidation.citationRefs
    }), { orgId: post.orgId });

    const publishResult = await publishPost(postForPublish);
    const saved = await updatePost(post.id, (prev) => ({
      ...prev,
      status: 'published',
      publishedAt: Date.now(),
      providerMessage: JSON.stringify(publishResult),
      lastError: null
    }), { orgId: post.orgId });

    await appendAudit({
      type: 'publish_success',
      postId: post.id,
      channel: post.channel,
      details: publishResult
    }, { orgId: post.orgId });

    return { ok: true, post: saved };
  } catch (err) {
    const retries = (post.failCount || 0) + 1;
    const retryDelayMs = 5 * 60 * 1000;
    const permanentFail = retries >= 3;

    const saved = await updatePost(post.id, (prev) => ({
      ...prev,
      status: permanentFail ? 'failed' : 'scheduled',
      failCount: retries,
      lastError: err?.message || 'Error desconegut',
      scheduledAt: permanentFail ? prev.scheduledAt : Date.now() + retryDelayMs
    }), { orgId: post.orgId });

    await appendAudit({
      type: permanentFail ? 'publish_failed_permanent' : 'publish_retry_scheduled',
      postId: post.id,
      channel: post.channel,
      details: { error: err?.message || 'Error desconegut', retries }
    }, { orgId: post.orgId });

    return { ok: false, error: err, post: saved };
  }
}

async function runPublishCycle(source = 'scheduler', { orgId = null } = {}) {
  if (publishCycleRunning) return { skipped: true, reason: 'already_running' };
  publishCycleRunning = true;
  try {
    const due = await listDueApprovedPosts(config.maxPostsPerCycle, { orgId });
    const results = [];
    for (const post of due) {
      // eslint-disable-next-line no-await-in-loop
      const result = await processOnePost(post);
      results.push({
        postId: post.id,
        ok: result.ok,
        error: result.ok ? null : result.error?.message || 'error'
      });
    }

    await appendAudit({
      type: 'publish_cycle',
      source,
      details: { processed: due.length, results }
    }, { orgId: orgId || null });

    return { skipped: false, processed: due.length, results };
  } finally {
    publishCycleRunning = false;
  }
}

async function runQuotesSync(source = 'interval', force = false) {
  const result = await syncQuotesCatalog({ force });
  if (force || result.changed) {
    await appendAudit({
      type: 'quotes_sync',
      source,
      details: {
        changed: result.changed,
        skipped: result.skipped,
        versionHash: result.versionHash,
        totalQuotes: result.totalQuotes
      }
    }, { orgId: null });
  }
  return result;
}

function ensureUploadsDir() {
  if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const proto = forwardedProto || new URL(config.appBaseUrl).protocol.replace(':', '') || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return config.appBaseUrl.replace(/\/$/, '');
  return `${proto}://${host}`;
}

function sanitizeUploadObjectName(pathname) {
  const decoded = decodeURIComponent(String(pathname || '').replace(/^\/uploads\//, ''));
  const normalized = path.posix.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!normalized || normalized.startsWith('/')) return null;
  if (normalized.split('/').some((part) => part === '.' || part === '..' || !part)) return null;
  return normalized;
}

function extensionForMime(mimeType) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return map[mimeType] || '';
}

function mimeForExtension(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeMediaUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith('/uploads/')) return raw;

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseMediaUrls(body) {
  const fromArray = Array.isArray(body.mediaUrls) ? body.mediaUrls : [];
  const fromSingle = body.mediaUrl ? [body.mediaUrl] : [];
  const merged = [...fromArray, ...fromSingle];

  const sanitized = [];
  for (const raw of merged) {
    const value = sanitizeMediaUrl(raw);
    if (!value) {
      return {
        ok: false,
        error: 'URL de la imatge invàlida. Usa http(s) o /uploads/...'
      };
    }
    if (!sanitized.includes(value)) sanitized.push(value);
  }

  return { ok: true, mediaUrls: sanitized };
}

async function getGcpAccessToken() {
  const now = Date.now();
  if (gcpTokenCache.token && gcpTokenCache.expiresAtMs > now + 30_000) {
    return gcpTokenCache.token;
  }

  const envToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || process.env.FIRESTORE_ACCESS_TOKEN || '';
  if (envToken) return envToken;

  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    method: 'GET',
    headers: { 'Metadata-Flavor': 'Google' }
  }).catch((err) => {
    throw new Error(`No s'ha pogut obtenir token de metadata server: ${err?.message || err}`);
  });
  if (!response.ok) {
    throw new Error(`Metadata server token error HTTP ${response.status}.`);
  }

  const data = await response.json();
  const token = String(data?.access_token || '');
  const expiresIn = Number.parseInt(String(data?.expires_in || '300'), 10);
  if (!token) throw new Error('Token de servei de GCP buit.');

  gcpTokenCache = {
    token,
    expiresAtMs: now + Math.max(60, expiresIn) * 1000
  };
  return token;
}

function buildUploadObjectName(ext) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const prefix = String(config.gcsUploadPrefix || 'uploads').replace(/^\/+|\/+$/g, '');
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  return `${prefix}/${yyyy}/${mm}/${fileName}`;
}

async function writeUploadGcs(objectName, mimeType, buffer) {
  const bucket = config.gcsUploadBucket;
  if (!bucket) throw new Error('GCS_UPLOAD_BUCKET no configurat.');

  const token = await getGcpAccessToken();
  const endpoint = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  endpoint.searchParams.set('uploadType', 'media');
  endpoint.searchParams.set('name', objectName);

  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType
    },
    body: buffer
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || `GCS upload error HTTP ${response.status}`;
    throw new Error(msg);
  }

  return {
    name: String(payload.name || objectName),
    bucket: String(payload.bucket || bucket)
  };
}

function writeUploadLocal(fileName, buffer) {
  ensureUploadsDir();
  const filePath = path.resolve(uploadsRoot, fileName);
  fs.writeFileSync(filePath, buffer);
}

async function uploadImageObject(ext, mimeType, buffer) {
  const objectName = buildUploadObjectName(ext);
  if (config.uploadsMode === 'gcs') {
    const uploaded = await writeUploadGcs(objectName, mimeType, buffer);
    return {
      objectName: uploaded.name,
      bucket: uploaded.bucket,
      storage: 'gcs'
    };
  }

  const localName = objectName.split('/').pop();
  writeUploadLocal(localName, buffer);
  return {
    objectName: localName,
    bucket: '',
    storage: 'local'
  };
}

function serveUploadLocal(safeObjectName, res) {
  ensureUploadsDir();
  const fileName = safeObjectName.split('/').pop();
  const filePath = path.resolve(uploadsRoot, fileName);
  if (!filePath.startsWith(uploadsRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeForExtension(ext);
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
  fs.createReadStream(filePath).pipe(res);
}

async function serveUploadGcs(safeObjectName, res) {
  const bucket = config.gcsUploadBucket;
  if (!bucket) {
    res.writeHead(500);
    res.end('Uploads bucket not configured');
    return;
  }

  const token = await getGcpAccessToken();
  const endpoint = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(safeObjectName)}`);
  endpoint.searchParams.set('alt', 'media');

  const response = await fetch(endpoint.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 404) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    res.writeHead(502);
    res.end(details || 'Upload backend error');
    return;
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
  const data = Buffer.from(await response.arrayBuffer());
  res.end(data);
}

async function serveUpload(pathname, res) {
  const safeObjectName = sanitizeUploadObjectName(pathname);
  if (!safeObjectName) {
    res.writeHead(400);
    res.end('Invalid upload path');
    return;
  }

  if (config.uploadsMode === 'gcs') {
    return serveUploadGcs(safeObjectName, res);
  }
  return serveUploadLocal(safeObjectName, res);
}

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
  const cleanPath = path.normalize(reqPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.resolve(webRoot, `.${cleanPath}`);

  if (!filePath.startsWith(webRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.resolve(webRoot, 'index.html');
    const html = fs.readFileSync(fallback);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res) {
  const url = new URL(req.url, config.appBaseUrl);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      role: config.appRole
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/internal/worker/tick') {
    if (!isWorkerRoleEnabled()) return notFound(res);
    const headerToken = String(req.headers['x-worker-token'] || '').trim();
    if (!config.workerTickToken || headerToken !== config.workerTickToken) return unauthorized(res);

    const cycle = await runPublishCycle('internal_tick');
    const quotes = await runQuotesSync('internal_tick', false);
    return json(res, 200, { ok: true, cycle, quotes });
  }

  if (!isApiRoleEnabled()) {
    return json(res, 503, { ok: false, error: 'API desactivada en aquest rol de servei.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/signup') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const orgName = String(body.orgName || '').trim();
    const displayName = String(body.displayName || '').trim();
    if (!email || !password || !orgName) {
      return badRequest(res, 'Cal email, contrasenya i nom d entitat.');
    }

    const signupLimit = await consumeAuthRateLimit({
      action: 'signup',
      email,
      ip: getClientIp(req),
      windowMs: Math.max(60_000, Number(config.authRateLimitWindowMs || 900_000)),
      maxAttempts: Math.max(3, Number(config.authRateLimitMaxAttempts || 10))
    });
    if (!signupLimit.allowed) {
      return tooManyRequests(res, 'Massa intents de registre. Torna-ho a provar mes tard.', signupLimit.retryAfterSec);
    }

    let authUser = null;
    try {
      authUser = await signupWithFirebase(email, password);
    } catch (err) {
      return authFailure(res, err, 400);
    }
    if (!authUser) return unauthorized(res);

    const created = await createOrgWithOwner({
      uid: authUser.uid,
      email: authUser.email,
      orgName,
      displayName: displayName || null
    });

    await appendAudit({
      type: 'signup',
      user: created.user.email,
      details: { orgName: created.org.name }
    }, { orgId: created.org.id });

    if (!config.requireEmailVerified) {
      let security = null;
      try {
        security = await evaluateLoginSecurity({
          idToken: authUser.idToken,
          role: created.membership.role
        });
      } catch (err) {
        return authFailure(res, err, 401);
      }

      const token = createSessionTokenForUser({
        uid: security.uid || created.user.id,
        email: security.email || created.user.email,
        orgId: created.org.id,
        role: created.membership.role,
        idToken: authUser.idToken,
        refreshToken: authUser.refreshToken
      });
      setSessionCookie(res, token);
    }

    return json(res, 201, {
      ok: true,
      user: {
        uid: created.user.id,
        email: created.user.email,
        orgId: created.org.id,
        orgName: created.org.name,
        role: created.membership.role
      },
      requiresEmailVerification: Boolean(config.requireEmailVerified),
      message: config.requireEmailVerified
        ? 'Compte creat. Revisa el correu i verifica l email abans d entrar.'
        : 'Compte creat correctament.'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const preferredOrgId = String(body.orgId || '').trim() || null;
    if (!email || !password) return badRequest(res, 'Cal email i contrasenya.');

    const loginLimit = await consumeAuthRateLimit({
      action: 'login',
      email,
      ip: getClientIp(req),
      windowMs: Math.max(60_000, Number(config.authRateLimitWindowMs || 900_000)),
      maxAttempts: Math.max(3, Number(config.authRateLimitMaxAttempts || 10))
    });
    if (!loginLimit.allowed) {
      return tooManyRequests(res, 'Massa intents de login. Torna-ho a provar mes tard.', loginLimit.retryAfterSec);
    }

    let authUser = null;
    try {
      authUser = await loginWithFirebase(email, password);
    } catch (err) {
      return authFailure(res, err, 401);
    }
    if (!authUser) return unauthorized(res);

    const ctx = await resolveUserSessionContext(authUser.uid, preferredOrgId);
    if (!ctx) return unauthorized(res);

    let security = null;
    try {
      security = await evaluateLoginSecurity({
        idToken: authUser.idToken,
        role: ctx.membership.role
      });
    } catch (err) {
      return authFailure(res, err, 401);
    }

    await touchUserLogin(authUser.uid);
    const token = createSessionTokenForUser({
      uid: security.uid || ctx.user.id,
      email: security.email || ctx.user.email,
      orgId: ctx.org.id,
      role: ctx.membership.role,
      idToken: authUser.idToken,
      refreshToken: authUser.refreshToken
    });
    setSessionCookie(res, token);

    await appendAudit({
      type: 'login',
      user: ctx.user.email,
      details: null
    }, { orgId: ctx.org.id });
    return json(res, 200, {
      ok: true,
      user: {
        uid: ctx.user.id,
        email: ctx.user.email,
        orgId: ctx.org.id,
        orgName: ctx.org.name,
        role: ctx.membership.role
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const session = await getSessionFromRequest(req).catch(() => null);
    if (session?.token) logout(session.token);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations/meta/callback') {
    const error = String(url.searchParams.get('error') || '').trim();
    const errorReason = String(url.searchParams.get('error_reason') || '').trim();
    const errorDescription = String(url.searchParams.get('error_description') || '').trim();
    if (error) {
      const message = errorDescription || errorReason || error;
      return redirect(res, oauthResultRedirectUrl({ ok: false, message: `Meta OAuth cancel lat: ${message}` }));
    }

    const code = String(url.searchParams.get('code') || '').trim();
    const stateToken = String(url.searchParams.get('state') || '').trim();
    if (!code || !stateToken) {
      return redirect(res, oauthResultRedirectUrl({ ok: false, message: 'Resposta OAuth incompleta.' }));
    }

    try {
      const result = await completeMetaOAuthCallback({ code, stateToken });
      await appendAudit({
        type: 'integration_connect',
        user: result.email,
        details: {
          provider: 'meta',
          facebookPageId: result.facebookPageId,
          facebookPageName: result.facebookPageName,
          instagramBusinessAccountId: result.instagramBusinessAccountId || null,
          instagramUsername: result.instagramUsername || null
        }
      }, { orgId: result.orgId });
      return redirect(res, oauthResultRedirectUrl({ ok: true, message: 'Meta connectat correctament.' }));
    } catch (err) {
      return redirect(res, oauthResultRedirectUrl({ ok: false, message: err?.message || 'No s ha pogut completar OAuth Meta.' }));
    }
  }

  let session = null;
  try {
    session = await getSessionFromRequest(req);
  } catch (err) {
    clearSessionCookie(res);
    return json(res, 401, { ok: false, error: err?.message || 'Sessio invalida.' });
  }
  if (!session) return unauthorized(res);
  if (session.refreshedToken) setSessionCookie(res, session.refreshedToken);
  const ctx = await resolveUserSessionContext(session.user.uid, session.user.orgId);
  if (!ctx) {
    clearSessionCookie(res);
    return unauthorized(res);
  }
  const currentUser = {
    uid: ctx.user.id,
    email: ctx.user.email,
    orgId: ctx.org.id,
    orgName: ctx.org.name,
    role: ctx.membership.role,
    emailVerified: Boolean(session.user.emailVerified),
    mfaAuthenticated: Boolean(session.user.mfaAuthenticated)
  };

  if (req.method === 'GET' && url.pathname === '/api/me') {
    return json(res, 200, { ok: true, user: currentUser });
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations') {
    const all = await listSocialIntegrations({ orgId: currentUser.orgId });
    const meta = all.find((entry) => String(entry.provider || '').toLowerCase() === 'meta') || null;
    const legacyFallback = Boolean(config.facebookPageId && config.facebookToken);

    return json(res, 200, {
      ok: true,
      integrations: {
        meta: {
          provider: 'meta',
          connected: Boolean(meta && meta.status === 'connected' && meta.facebookPageId && meta.pageAccessTokenEnc),
          status: meta?.status || 'disconnected',
          facebookPageId: meta?.facebookPageId || null,
          facebookPageName: meta?.facebookPageName || null,
          instagramBusinessAccountId: meta?.instagramBusinessAccountId || null,
          instagramUsername: meta?.instagramUsername || null,
          connectedAt: meta?.connectedAt || null,
          disconnectedAt: meta?.disconnectedAt || null,
          lastError: meta?.lastError || null,
          legacyFallback
        }
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations/meta/connect') {
    if (!isPrivilegedRole(currentUser.role)) {
      return json(res, 403, { ok: false, error: 'Nomes owner/admin pot connectar xarxes socials.' });
    }

    try {
      const authorizationUrl = await buildMetaAuthorizationUrl({
        orgId: currentUser.orgId,
        uid: currentUser.uid,
        email: currentUser.email
      });
      await appendAudit({
        type: 'integration_connect_start',
        user: currentUser.email,
        details: { provider: 'meta' }
      }, { orgId: currentUser.orgId });
      return redirect(res, authorizationUrl);
    } catch (err) {
      return badRequest(res, err?.message || 'No s ha pogut iniciar OAuth Meta.');
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/integrations/meta') {
    if (!isPrivilegedRole(currentUser.role)) {
      return json(res, 403, { ok: false, error: 'Nomes owner/admin pot desconnectar xarxes socials.' });
    }

    const existing = await getSocialIntegration('meta', { orgId: currentUser.orgId });
    if (!existing) return json(res, 200, { ok: true, disconnected: false });

    await disconnectSocialIntegration('meta', { orgId: currentUser.orgId });
    await appendAudit({
      type: 'integration_disconnect',
      user: currentUser.email,
      details: { provider: 'meta' }
    }, { orgId: currentUser.orgId });
    return json(res, 200, { ok: true, disconnected: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/capabilities') {
    return json(res, 200, {
      ok: true,
      channels: getAllowedChannels(),
      whatsappAutopublishEnabled: config.allowWhatsAppAutopublish
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/media/upload') {
    const maxUploadBytes = Math.max(100_000, Number(config.maxUploadBytes || 5_000_000));
    const maxPayloadBytes = Math.ceil(maxUploadBytes * 1.45) + 150_000;
    const body = await readBody(req, maxPayloadBytes);

    const mimeType = String(body.mimeType || '').trim().toLowerCase();
    const ext = extensionForMime(mimeType);
    if (!ext) return badRequest(res, 'Format d\'imatge no suportat. Formats: jpg, png, webp, gif.');

    const base64Raw = String(body.dataBase64 || '').trim();
    if (!base64Raw) return badRequest(res, 'Falta dataBase64.');

    const base64Payload = base64Raw.includes(',') ? base64Raw.split(',').pop() : base64Raw;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64Payload || '')) {
      return badRequest(res, 'Base64 invàlid.');
    }

    let binary = null;
    try {
      binary = Buffer.from(base64Payload || '', 'base64');
    } catch {
      return badRequest(res, 'No s\'ha pogut decodificar la imatge.');
    }

    if (!binary || !binary.length) return badRequest(res, 'Imatge buida.');
    if (binary.length > maxUploadBytes) {
      return badRequest(res, `Imatge massa gran. Maxim: ${Math.floor(maxUploadBytes / 1_000_000)}MB.`);
    }

    const uploaded = await uploadImageObject(ext, mimeType, binary);
    const mediaPath = `/uploads/${uploaded.objectName}`;
    const mediaUrl = `${getRequestBaseUrl(req)}${mediaPath}`;

    await appendAudit({
      type: 'media_upload',
      user: currentUser.email,
      details: {
        fileName: uploaded.objectName,
        storage: uploaded.storage,
        bucket: uploaded.bucket || null,
        mimeType,
        sizeBytes: binary.length
      }
    }, { orgId: currentUser.orgId });

    return json(res, 201, {
      ok: true,
      mediaPath,
      mediaUrl,
      mimeType,
      sizeBytes: binary.length
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const body = await readBody(req);
    const topic = String(body.topic || '').trim();
    const channel = sanitizeChannel(String(body.channel || ''));

    if (!topic) return badRequest(res, 'El tema és obligatori.');
    if (!channel) return badRequest(res, 'Canal invàlid o desactivat.');

    const allowedQuotes = await getRelevantQuotes(topic, 6);
    const generated = await generateWithGemini({
      topic,
      channel,
      allowedQuotes,
      organizationName: currentUser.orgName
    });

    const citationValidation = await validatePostCitations(generated.content);
    if (!citationValidation.ok) {
      return badRequest(res, `Generacio rebutjada per seguretat de cites: ${citationValidation.error}`);
    }

    const generatedIds = new Set(generated.quoteIdsUsed || []);
    const validatedIds = new Set(citationValidation.quoteIdsUsed || []);
    for (const id of generatedIds) {
      if (!validatedIds.has(id)) {
        return badRequest(res, `Gemini ha informat una cita no valida: ${id}`);
      }
    }

    await appendAudit({
      type: 'generate',
      user: currentUser.email,
      details: {
        channel,
        topicLength: topic.length,
        quoteIdsUsed: citationValidation.quoteIdsUsed
      }
    }, { orgId: currentUser.orgId });
    return json(res, 200, {
      ok: true,
      content: citationValidation.sanitizedContent,
      quoteIdsUsed: citationValidation.quoteIdsUsed,
      citationRefs: citationValidation.citationRefs,
      allowedQuotes: allowedQuotes.map((q) => ({
        id: q.id,
        text: q.text,
        sourceTitle: q.sourceTitle,
        sourceDoc: q.sourceDoc,
        location: q.location
      }))
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/posts') {
    const status = url.searchParams.get('status');
    const requestedLimit = Number.parseInt(String(url.searchParams.get('limit') || ''), 10);
    const defaultLimit = Math.max(10, Number(config.postsPageDefaultLimit || 50));
    const maxLimit = Math.max(defaultLimit, Number(config.postsPageMaxLimit || 200));
    const limit = Number.isFinite(requestedLimit) ? Math.min(maxLimit, Math.max(1, requestedLimit)) : defaultLimit;
    const cursor = decodePostsCursor(url.searchParams.get('cursor'));
    const allPosts = await listPosts({ orgId: currentUser.orgId });
    const filtered = allPosts.filter((p) => {
      if (!status || status === 'all') return true;
      if (status === 'scheduled') return ['scheduled', 'approved'].includes(p.status);
      return p.status === status;
    });

    let startIndex = 0;
    if (cursor) {
      const index = filtered.findIndex((p) => Number(p.createdAt || 0) === cursor.createdAt && p.id === cursor.id);
      if (index >= 0) startIndex = index + 1;
    }

    const page = filtered.slice(startIndex, startIndex + limit);
    const last = page.length ? page[page.length - 1] : null;
    const nextCursor = page.length === limit ? encodePostsCursor(last) : null;

    return json(res, 200, {
      ok: true,
      posts: page.map(toPublicPost),
      pagination: {
        limit,
        totalFiltered: filtered.length,
        nextCursor
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/posts') {
    const body = await readBody(req);
    const topic = String(body.topic || '').trim();
    const content = String(body.content || '').trim();
    const channel = sanitizeChannel(String(body.channel || ''));
    const scheduledAt = parseDateTime(body.scheduledAt);
    const hasScheduleInput = Object.prototype.hasOwnProperty.call(body, 'scheduledAt')
      && body.scheduledAt !== ''
      && body.scheduledAt !== null
      && typeof body.scheduledAt !== 'undefined';
    if (hasScheduleInput && scheduledAt === null) return badRequest(res, 'Data de programació invàlida.');

    const media = parseMediaUrls(body);

    if (!topic) return badRequest(res, 'El tema és obligatori.');
    if (!content) return badRequest(res, 'El contingut és obligatori.');
    if (!channel) return badRequest(res, 'Canal invàlid o desactivat.');
    if (!media.ok) return badRequest(res, media.error);

    const citationValidation = await validatePostCitations(content);
    if (!citationValidation.ok) return badRequest(res, citationValidation.error);

    const status = scheduledAt === null ? 'draft' : 'scheduled';
    const approvedAt = status === 'scheduled' ? Date.now() : null;
    const approvedBy = status === 'scheduled' ? currentUser.email : null;

    const post = await createPost({
      topic,
      channel,
      content: citationValidation.sanitizedContent,
      status,
      scheduledAt,
      mediaUrls: media.mediaUrls,
      approvedAt,
      approvedBy,
      quoteIdsUsed: citationValidation.quoteIdsUsed,
      citationRefs: citationValidation.citationRefs
    }, { orgId: currentUser.orgId });
    await appendAudit({
      type: 'post_create',
      user: currentUser.email,
      postId: post.id,
      details: { channel, quoteIdsUsed: citationValidation.quoteIdsUsed }
    }, { orgId: currentUser.orgId });
    return json(res, 201, { ok: true, post: toPublicPost(post) });
  }

  if (req.method === 'PUT' && /^\/api\/posts\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const body = await readBody(req);

    const existing = await getPost(id, { orgId: currentUser.orgId });
    if (!existing) return notFound(res);
    if (existing.status === 'published') return badRequest(res, 'No es pot editar un post publicat.');

    const topic = String(body.topic || '').trim();
    const content = String(body.content || '').trim();
    const channel = sanitizeChannel(String(body.channel || ''));
    const scheduledAt = parseDateTime(body.scheduledAt);
    const hasScheduleInput = Object.prototype.hasOwnProperty.call(body, 'scheduledAt')
      && body.scheduledAt !== ''
      && body.scheduledAt !== null
      && typeof body.scheduledAt !== 'undefined';
    if (hasScheduleInput && scheduledAt === null) return badRequest(res, 'Data de programació invàlida.');
    const media = parseMediaUrls(body);

    if (!topic) return badRequest(res, 'El tema és obligatori.');
    if (!content) return badRequest(res, 'El contingut és obligatori.');
    if (!channel) return badRequest(res, 'Canal invàlid o desactivat.');
    if (!media.ok) return badRequest(res, media.error);

    const citationValidation = await validatePostCitations(content);
    if (!citationValidation.ok) return badRequest(res, citationValidation.error);

    const nextStatus = scheduledAt === null ? 'draft' : 'scheduled';

    const next = await updatePost(id, (prev) => ({
      ...prev,
      topic,
      content: citationValidation.sanitizedContent,
      channel,
      scheduledAt,
      status: nextStatus,
      mediaUrl: media.mediaUrls[0] || null,
      mediaUrls: media.mediaUrls,
      approvedAt: nextStatus === 'scheduled' ? (prev.approvedAt || Date.now()) : null,
      approvedBy: nextStatus === 'scheduled' ? (prev.approvedBy || currentUser.email) : null,
      lastError: null,
      quoteIdsUsed: citationValidation.quoteIdsUsed,
      citationRefs: citationValidation.citationRefs
    }), { orgId: currentUser.orgId });

    await appendAudit({
      type: 'post_update',
      user: currentUser.email,
      postId: id,
      details: { channel, quoteIdsUsed: citationValidation.quoteIdsUsed }
    }, { orgId: currentUser.orgId });
    return json(res, 200, { ok: true, post: toPublicPost(next) });
  }

  if (req.method === 'DELETE' && /^\/api\/posts\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const deleted = await deletePost(id, { orgId: currentUser.orgId });
    if (!deleted) return notFound(res);
    await appendAudit({ type: 'post_delete', user: currentUser.email, postId: id, details: null }, { orgId: currentUser.orgId });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && /^\/api\/posts\/[^/]+\/approve$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const body = await readBody(req);
    const scheduledAt = parseDateTime(body.scheduledAt);
    if (scheduledAt === null) return badRequest(res, 'Cal indicar una data de programació vàlida.');

    const post = await getPost(id, { orgId: currentUser.orgId });
    if (!post) return notFound(res);
    if (post.status === 'published') return badRequest(res, 'Ja està publicat.');

    const citationValidation = await validatePostCitations(post.content);
    if (!citationValidation.ok) return badRequest(res, citationValidation.error);

    const updated = await updatePost(id, (prev) => ({
      ...prev,
      content: citationValidation.sanitizedContent,
      status: 'scheduled',
      scheduledAt,
      approvedAt: Date.now(),
      approvedBy: currentUser.email,
      lastError: null,
      quoteIdsUsed: citationValidation.quoteIdsUsed,
      citationRefs: citationValidation.citationRefs
    }), { orgId: currentUser.orgId });

    await appendAudit({ type: 'post_approve', user: currentUser.email, postId: id, details: { scheduledAt } }, { orgId: currentUser.orgId });
    return json(res, 200, { ok: true, post: toPublicPost(updated) });
  }

  if (req.method === 'POST' && /^\/api\/posts\/[^/]+\/publish-now$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const post = await getPost(id, { orgId: currentUser.orgId });
    if (!post) return notFound(res);

    await updatePost(id, (prev) => ({
      ...prev,
      status: 'scheduled',
      scheduledAt: Date.now(),
      approvedAt: prev.approvedAt || Date.now(),
      approvedBy: prev.approvedBy || currentUser.email,
      lastError: null
    }), { orgId: currentUser.orgId });

    const cycle = await runPublishCycle('manual_publish_now', { orgId: currentUser.orgId });
    return json(res, 200, { ok: true, cycle });
  }

  if (req.method === 'POST' && url.pathname === '/api/publish/run') {
    const cycle = await runPublishCycle('manual_api', { orgId: currentUser.orgId });
    return json(res, 200, { ok: true, cycle });
  }

  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url || '/', config.appBaseUrl);
    if (parsed.pathname.startsWith('/uploads/')) {
      return await serveUpload(parsed.pathname, res);
    }
    if (parsed.pathname.startsWith('/api/')) {
      return await handleApi(req, res);
    }
    return serveStatic(req, res);
  } catch (err) {
    return serverError(res, err);
  }
});

server.listen(config.port, () => {
  console.log(`Servidor actiu a ${config.appBaseUrl} (port ${config.port}) [role=${config.appRole}]`);
  for (const warning of getStartupWarnings()) {
    console.warn(`[WARN] ${warning}`);
  }
  if (isWorkerRoleEnabled()) {
    runQuotesSync('startup', true)
      .then((sync) => {
        console.log(`[QUOTES] Sync startup: ${sync.totalQuotes} cites (canvis=${sync.changed ? 'si' : 'no'}).`);
      })
      .catch((err) => {
        console.error('[QUOTES] Error sync startup:', err?.message || err);
      });
  }
});

if (isWorkerRoleEnabled()) {
  setInterval(async () => {
    try {
      const result = await runPublishCycle('interval');
      if (!result.skipped && result.processed > 0) {
        console.log(`[PUBLISH] Processats ${result.processed} posts.`);
      }
    } catch (err) {
      console.error('[PUBLISH] Error en cicle automatic:', err?.message || err);
    }
  }, config.publishIntervalMs);

  setInterval(async () => {
    try {
      const result = await runQuotesSync('interval', false);
      if (!result.skipped && result.changed) {
        console.log(`[QUOTES] Cataleg actualitzat. ${result.totalQuotes} cites disponibles.`);
      }
    } catch (err) {
      console.error('[QUOTES] Error en sync periodic:', err?.message || err);
    }
  }, config.quotesSyncIntervalMs);
}
