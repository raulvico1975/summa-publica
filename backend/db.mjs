import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { config } from './config.mjs';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.resolve(DATA_DIR, 'db.json');

const initialDb = {
  orgs: [],
  users: [],
  memberships: [],
  rateLimits: [],
  socialIntegrations: [],
  oauthStates: [],
  posts: [],
  audit: [],
  quotesCatalog: {
    versionHash: null,
    updatedAt: null,
    sourceSheets: [],
    quotes: []
  },
  meta: {
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
};

let writeQueue = Promise.resolve();
let firestoreTokenCache = {
  token: null,
  expiresAtMs: 0
};

function ensureLocalDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2));
  }
}

function ensureArrayField(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
}

function readLocalDbUnsafe() {
  ensureLocalDb();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  ensureArrayField(parsed, 'orgs');
  ensureArrayField(parsed, 'users');
  ensureArrayField(parsed, 'memberships');
  ensureArrayField(parsed, 'rateLimits');
  ensureArrayField(parsed, 'socialIntegrations');
  ensureArrayField(parsed, 'oauthStates');
  ensureArrayField(parsed, 'posts');
  ensureArrayField(parsed, 'audit');

  if (!parsed.quotesCatalog || typeof parsed.quotesCatalog !== 'object') {
    parsed.quotesCatalog = { versionHash: null, updatedAt: null, sourceSheets: [], quotes: [] };
  }
  if (!Array.isArray(parsed.quotesCatalog.sourceSheets)) parsed.quotesCatalog.sourceSheets = [];
  if (!Array.isArray(parsed.quotesCatalog.quotes)) parsed.quotesCatalog.quotes = [];

  if (!parsed.meta || typeof parsed.meta !== 'object') {
    parsed.meta = { createdAt: Date.now(), updatedAt: Date.now() };
  }

  return parsed;
}

function writeLocalDbUnsafe(data) {
  data.meta = data.meta || { createdAt: Date.now(), updatedAt: Date.now() };
  data.meta.updatedAt = Date.now();

  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function withWriteLock(fn) {
  writeQueue = writeQueue.then(async () => fn());
  return writeQueue;
}

function isFirestoreMode() {
  return config.dataStore === 'firestore';
}

function collectionName(name) {
  return `${config.firestoreCollectionPrefix}_${name}`;
}

function firestoreBaseUrl() {
  const project = config.firestoreProjectId;
  if (!project) throw new Error('FIRESTORE_PROJECT_ID no configurat.');
  const database = encodeURIComponent(config.firestoreDatabase || '(default)');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/${database}/documents`;
}

async function getFirestoreAccessToken() {
  const envToken = process.env.FIRESTORE_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
  if (envToken) return envToken;

  const now = Date.now();
  if (firestoreTokenCache.token && firestoreTokenCache.expiresAtMs > now + 30_000) {
    return firestoreTokenCache.token;
  }

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
  const token = data.access_token;
  const expiresInSec = Number.parseInt(String(data.expires_in || '300'), 10);

  if (!token) throw new Error('Token de servei de GCP buit.');

  firestoreTokenCache = {
    token,
    expiresAtMs: now + Math.max(60, expiresInSec) * 1000
  };
  return token;
}

async function firestoreRequest(method, url, { jsonBody, expectedStatus } = {}) {
  const token = await getFirestoreAccessToken();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(jsonBody ? { 'Content-Type': 'application/json' } : {})
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined
  });

  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};

  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus || 200];
  if (!expected.includes(response.status)) {
    const message = payload?.error?.message || `Firestore HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return payload;
}

function toFirestoreValue(value) {
  if (value === null || typeof value === 'undefined') return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => toFirestoreValue(item)) } };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (typeof value !== 'object' || value === null) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return Boolean(value.booleanValue);
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return String(value.stringValue);
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) {
    const n = Number(value.integerValue);
    return Number.isFinite(n) ? n : 0;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) {
    const n = Number(value.doubleValue);
    return Number.isFinite(n) ? n : 0;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
    return values.map((entry) => fromFirestoreValue(entry));
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    const fields = value.mapValue?.fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function fromFirestoreDocument(doc) {
  if (!doc) return null;
  const fields = doc.fields || {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromFirestoreValue(v);
  }
  if (!out.id && doc.name) {
    out.id = doc.name.split('/').pop();
  }
  return out;
}

function firestoreDocumentBody(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

async function firestoreListCollection(collectionId, pageSize = 1000) {
  const base = firestoreBaseUrl();
  const docs = [];
  let pageToken = '';

  do {
    const url = new URL(`${base}/${collectionId}`);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    // eslint-disable-next-line no-await-in-loop
    const data = await firestoreRequest('GET', url.toString(), { expectedStatus: [200] });
    const pageDocs = Array.isArray(data.documents) ? data.documents : [];
    docs.push(...pageDocs.map((doc) => fromFirestoreDocument(doc)));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return docs;
}

async function firestoreGetDocument(pathName) {
  const url = `${firestoreBaseUrl()}/${pathName}`;
  try {
    const data = await firestoreRequest('GET', url, { expectedStatus: [200] });
    return fromFirestoreDocument(data);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function firestoreGetDocumentWithMeta(pathName) {
  const url = `${firestoreBaseUrl()}/${pathName}`;
  try {
    const rawDoc = await firestoreRequest('GET', url, { expectedStatus: [200] });
    return {
      data: fromFirestoreDocument(rawDoc),
      updateTime: String(rawDoc.updateTime || ''),
      name: String(rawDoc.name || '')
    };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function firestoreCreateDocument(collectionId, docId, data) {
  const url = new URL(`${firestoreBaseUrl()}/${collectionId}`);
  url.searchParams.set('documentId', docId);
  const payload = firestoreDocumentBody(data);
  const created = await firestoreRequest('POST', url.toString(), {
    jsonBody: payload,
    expectedStatus: [200]
  });
  return fromFirestoreDocument(created);
}

async function firestoreUpsertDocument(pathName, data) {
  const url = `${firestoreBaseUrl()}/${pathName}`;
  const updated = await firestoreRequest('PATCH', url, {
    jsonBody: firestoreDocumentBody(data),
    expectedStatus: [200]
  });
  return fromFirestoreDocument(updated);
}

async function firestoreUpsertDocumentWithPrecondition(pathName, data, precondition = {}) {
  const url = new URL(`${firestoreBaseUrl()}/${pathName}`);
  if (typeof precondition.exists === 'boolean') {
    url.searchParams.set('currentDocument.exists', precondition.exists ? 'true' : 'false');
  }
  if (precondition.updateTime) {
    url.searchParams.set('currentDocument.updateTime', String(precondition.updateTime));
  }

  const updated = await firestoreRequest('PATCH', url.toString(), {
    jsonBody: firestoreDocumentBody(data),
    expectedStatus: [200]
  });
  return fromFirestoreDocument(updated);
}

async function firestoreDeleteDocument(pathName) {
  const url = `${firestoreBaseUrl()}/${pathName}`;
  try {
    await firestoreRequest('DELETE', url, { expectedStatus: [200] });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

function nowTs() {
  return Date.now();
}

function hashRateLimitKey(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeOrgName(value) {
  return String(value || '').trim() || 'Nova entitat';
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function slugify(value) {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || `org-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveOrgId(value) {
  const raw = String(value || '').trim();
  return raw || config.defaultOrgId;
}

function withResolvedOrg(record) {
  if (!record || typeof record !== 'object') return record;
  if (record.orgId) return record;
  return { ...record, orgId: config.defaultOrgId };
}

function hasOrgAccess(record, orgId) {
  if (!record || typeof record !== 'object') return false;
  return resolveOrgId(record.orgId) === resolveOrgId(orgId);
}

function buildOrg(payload = {}) {
  const now = nowTs();
  const name = normalizeOrgName(payload.name);
  return {
    id: String(payload.id || crypto.randomUUID()),
    name,
    slug: slugify(payload.slug || name),
    createdAt: now,
    updatedAt: now
  };
}

function buildUser(payload = {}) {
  const now = nowTs();
  return {
    id: String(payload.id || ''),
    email: normalizeEmail(payload.email),
    displayName: String(payload.displayName || '').trim() || null,
    status: String(payload.status || 'active'),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: payload.lastLoginAt ?? null
  };
}

function buildMembership(payload = {}) {
  const now = nowTs();
  const scopedOrgId = resolveOrgId(payload.orgId);
  const userId = String(payload.userId || '');
  const defaultId = userId && scopedOrgId ? `${userId}_${scopedOrgId}` : crypto.randomUUID();
  return {
    id: String(payload.id || defaultId),
    orgId: scopedOrgId,
    userId,
    role: String(payload.role || 'member'),
    createdAt: now,
    updatedAt: now
  };
}

function buildSocialIntegration(payload = {}) {
  const now = nowTs();
  const orgId = resolveOrgId(payload.orgId);
  const provider = normalizeProvider(payload.provider);
  if (!provider) throw new Error('Provider d integracio obligatori.');

  return {
    id: String(payload.id || `${provider}_${orgId}`),
    orgId,
    provider,
    status: String(payload.status || 'connected'),
    facebookPageId: payload.facebookPageId ? String(payload.facebookPageId) : null,
    facebookPageName: payload.facebookPageName ? String(payload.facebookPageName) : null,
    instagramBusinessAccountId: payload.instagramBusinessAccountId ? String(payload.instagramBusinessAccountId) : null,
    instagramUsername: payload.instagramUsername ? String(payload.instagramUsername) : null,
    pageAccessTokenEnc: payload.pageAccessTokenEnc ? String(payload.pageAccessTokenEnc) : null,
    userAccessTokenEnc: payload.userAccessTokenEnc ? String(payload.userAccessTokenEnc) : null,
    userAccessTokenExpiresAt: Number.isFinite(payload.userAccessTokenExpiresAt) ? Number(payload.userAccessTokenExpiresAt) : null,
    connectedByUid: payload.connectedByUid ? String(payload.connectedByUid) : null,
    connectedByEmail: payload.connectedByEmail ? normalizeEmail(payload.connectedByEmail) : null,
    connectedAt: Number.isFinite(payload.connectedAt) ? Number(payload.connectedAt) : now,
    disconnectedAt: Number.isFinite(payload.disconnectedAt) ? Number(payload.disconnectedAt) : null,
    lastError: payload.lastError ? String(payload.lastError) : null,
    createdAt: now,
    updatedAt: now
  };
}

function buildOauthState(payload = {}) {
  const now = nowTs();
  const id = String(payload.id || crypto.randomUUID());
  const provider = normalizeProvider(payload.provider);
  const orgId = resolveOrgId(payload.orgId);
  const uid = String(payload.uid || '').trim();
  const email = normalizeEmail(payload.email);
  const nonce = String(payload.nonce || '').trim();
  const expiresAt = Number(payload.expiresAt || 0);

  if (!provider || !uid || !email || !nonce || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error('OAuth state invalid.');
  }

  return {
    id,
    provider,
    orgId,
    uid,
    email,
    nonceHash: hashRateLimitKey(nonce),
    createdAt: now,
    updatedAt: now,
    expiresAt,
    consumedAt: null
  };
}

// orgs
async function getOrgLocal(orgId) {
  const db = readLocalDbUnsafe();
  return db.orgs.find((o) => o.id === orgId) || null;
}

async function getOrgFirestore(orgId) {
  return firestoreGetDocument(`${collectionName('orgs')}/${orgId}`);
}

export async function getOrg(orgId) {
  if (!orgId) return null;
  if (isFirestoreMode()) return getOrgFirestore(orgId);
  return getOrgLocal(orgId);
}

async function listOrgsLocal() {
  const db = readLocalDbUnsafe();
  return [...db.orgs].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function listOrgsFirestore() {
  const orgs = await firestoreListCollection(collectionName('orgs'));
  return orgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function listOrgs() {
  if (isFirestoreMode()) return listOrgsFirestore();
  return listOrgsLocal();
}

async function createOrgLocal(payload) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const org = buildOrg(payload);
    db.orgs.push(org);
    writeLocalDbUnsafe(db);
    return org;
  });
}

async function createOrgFirestore(payload) {
  const org = buildOrg(payload);
  return firestoreCreateDocument(collectionName('orgs'), org.id, org);
}

export async function createOrg(payload) {
  if (isFirestoreMode()) return createOrgFirestore(payload);
  return createOrgLocal(payload);
}

export async function findOrgBySlug(slug) {
  const normalized = slugify(slug);
  const orgs = await listOrgs();
  return orgs.find((org) => org.slug === normalized) || null;
}

// users
async function getUserByUidLocal(uid) {
  const db = readLocalDbUnsafe();
  return db.users.find((u) => u.id === uid) || null;
}

async function getUserByUidFirestore(uid) {
  return firestoreGetDocument(`${collectionName('users')}/${uid}`);
}

export async function getUserByUid(uid) {
  if (!uid) return null;
  if (isFirestoreMode()) return getUserByUidFirestore(uid);
  return getUserByUidLocal(uid);
}

async function getUserByEmailLocal(email) {
  const needle = normalizeEmail(email);
  const db = readLocalDbUnsafe();
  return db.users.find((u) => normalizeEmail(u.email) === needle) || null;
}

async function getUserByEmailFirestore(email) {
  const needle = normalizeEmail(email);
  const users = await firestoreListCollection(collectionName('users'));
  return users.find((u) => normalizeEmail(u.email) === needle) || null;
}

export async function getUserByEmail(email) {
  if (!email) return null;
  if (isFirestoreMode()) return getUserByEmailFirestore(email);
  return getUserByEmailLocal(email);
}

async function upsertUserLocal(payload) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const uid = String(payload.id || '');
    if (!uid) throw new Error('User id obligatori.');

    const idx = db.users.findIndex((u) => u.id === uid);
    if (idx === -1) {
      const user = buildUser(payload);
      db.users.push(user);
      writeLocalDbUnsafe(db);
      return user;
    }

    const prev = db.users[idx];
    const next = {
      ...prev,
      email: normalizeEmail(payload.email || prev.email),
      displayName: typeof payload.displayName === 'undefined' ? prev.displayName : (payload.displayName || null),
      status: payload.status || prev.status || 'active',
      updatedAt: nowTs(),
      lastLoginAt: Object.prototype.hasOwnProperty.call(payload, 'lastLoginAt') ? (payload.lastLoginAt ?? null) : prev.lastLoginAt
    };

    db.users[idx] = next;
    writeLocalDbUnsafe(db);
    return next;
  });
}

async function upsertUserFirestore(payload) {
  const uid = String(payload.id || '');
  if (!uid) throw new Error('User id obligatori.');

  const existing = await getUserByUidFirestore(uid);
  if (!existing) {
    const user = buildUser(payload);
    return firestoreCreateDocument(collectionName('users'), uid, user);
  }

  const next = {
    ...existing,
    email: normalizeEmail(payload.email || existing.email),
    displayName: typeof payload.displayName === 'undefined' ? existing.displayName : (payload.displayName || null),
    status: payload.status || existing.status || 'active',
    updatedAt: nowTs(),
    lastLoginAt: Object.prototype.hasOwnProperty.call(payload, 'lastLoginAt') ? (payload.lastLoginAt ?? null) : existing.lastLoginAt
  };

  return firestoreUpsertDocument(`${collectionName('users')}/${uid}`, next);
}

export async function upsertUser(payload) {
  if (isFirestoreMode()) return upsertUserFirestore(payload);
  return upsertUserLocal(payload);
}

// memberships
async function listMembershipsLocal() {
  const db = readLocalDbUnsafe();
  return [...db.memberships];
}

async function listMembershipsFirestore() {
  return firestoreListCollection(collectionName('memberships'));
}

async function listMemberships() {
  if (isFirestoreMode()) return listMembershipsFirestore();
  return listMembershipsLocal();
}

async function createMembershipLocal(payload) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const existing = db.memberships.find((m) => m.userId === payload.userId && resolveOrgId(m.orgId) === resolveOrgId(payload.orgId));
    if (existing) return existing;

    const membership = buildMembership(payload);
    db.memberships.push(membership);
    writeLocalDbUnsafe(db);
    return membership;
  });
}

async function createMembershipFirestore(payload) {
  const current = await listMembershipsFirestore();
  const existing = current.find((m) => m.userId === payload.userId && resolveOrgId(m.orgId) === resolveOrgId(payload.orgId));
  if (existing) return existing;

  const membership = buildMembership(payload);
  return firestoreCreateDocument(collectionName('memberships'), membership.id, membership);
}

export async function createMembership(payload) {
  if (isFirestoreMode()) return createMembershipFirestore(payload);
  return createMembershipLocal(payload);
}

export async function getMembership(userId, orgId) {
  const memberships = await listMemberships();
  return memberships.find((m) => m.userId === userId && resolveOrgId(m.orgId) === resolveOrgId(orgId)) || null;
}

export async function listMembershipsByUser(userId) {
  const memberships = await listMemberships();
  return memberships
    .filter((m) => m.userId === userId)
    .map((m) => ({ ...m, orgId: resolveOrgId(m.orgId) }));
}

export async function resolveUserSessionContext(uid, preferredOrgId = null) {
  const user = await getUserByUid(uid);
  if (!user) return null;

  const memberships = await listMembershipsByUser(uid);
  if (!memberships.length) return null;

  const requestedOrg = preferredOrgId ? resolveOrgId(preferredOrgId) : '';
  const membership = memberships.find((m) => m.orgId === requestedOrg) || memberships[0];
  const org = await getOrg(membership.orgId);
  if (!org) return null;

  return {
    user,
    org,
    membership
  };
}

export async function createOrgWithOwner({ uid, email, orgName, displayName }) {
  const cleanUid = String(uid || '').trim();
  const cleanEmail = normalizeEmail(email);
  const cleanOrgName = normalizeOrgName(orgName);
  if (!cleanUid || !cleanEmail || !cleanOrgName) throw new Error('Falten dades per crear l\'entitat.');

  const baseSlug = slugify(cleanOrgName);
  let slug = baseSlug;
  let counter = 1;
  while (await findOrgBySlug(slug)) {
    counter += 1;
    slug = `${baseSlug}-${counter}`;
  }

  const org = await createOrg({ name: cleanOrgName, slug });
  const user = await upsertUser({
    id: cleanUid,
    email: cleanEmail,
    displayName: displayName || null,
    status: 'active',
    lastLoginAt: nowTs()
  });
  const membership = await createMembership({
    orgId: org.id,
    userId: user.id,
    role: 'owner'
  });

  return { org, user, membership };
}

export async function touchUserLogin(uid) {
  const user = await getUserByUid(uid);
  if (!user) return null;
  return upsertUser({ ...user, lastLoginAt: nowTs() });
}

// distributed auth rate limit
async function consumeAuthRateLimitLocal({ key, windowMs, maxAttempts }) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const now = nowTs();
    const keyHash = hashRateLimitKey(key);
    const idx = db.rateLimits.findIndex((entry) => entry.keyHash === keyHash);
    const existing = idx >= 0 ? db.rateLimits[idx] : null;

    let windowStart = now;
    let count = 1;
    if (existing && Number(existing.windowStart || 0) + windowMs > now) {
      windowStart = Number(existing.windowStart || now);
      count = Number(existing.count || 0) + 1;
    }

    const next = {
      keyHash,
      keyPreview: String(key).slice(0, 80),
      windowStart,
      count,
      updatedAt: now
    };

    if (idx >= 0) db.rateLimits[idx] = next;
    else db.rateLimits.push(next);

    const minKeepTs = now - windowMs * 3;
    db.rateLimits = db.rateLimits.filter((entry) => Number(entry.updatedAt || 0) >= minKeepTs).slice(-5000);
    writeLocalDbUnsafe(db);

    if (count <= maxAttempts) return { allowed: true, retryAfterSec: 0 };
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  });
}

function isPreconditionConflict(err) {
  const message = String(err?.message || '');
  if (err?.status === 409 || err?.status === 412) return true;
  return message.includes('FAILED_PRECONDITION') || message.includes('ABORTED') || message.includes('already exists');
}

async function consumeAuthRateLimitFirestore({ key, windowMs, maxAttempts }) {
  const now = nowTs();
  const keyHash = hashRateLimitKey(key);
  const docPath = `${collectionName('rate_limits')}/${keyHash}`;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await firestoreGetDocumentWithMeta(docPath);
    const current = existing?.data || null;

    let windowStart = now;
    let count = 1;
    if (current && Number(current.windowStart || 0) + windowMs > now) {
      windowStart = Number(current.windowStart || now);
      count = Number(current.count || 0) + 1;
    }

    const next = {
      id: keyHash,
      keyHash,
      keyPreview: String(key).slice(0, 80),
      windowStart,
      count,
      updatedAt: now,
      expiresAt: windowStart + windowMs * 3
    };

    try {
      if (!existing) {
        // eslint-disable-next-line no-await-in-loop
        await firestoreCreateDocument(collectionName('rate_limits'), keyHash, next);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await firestoreUpsertDocumentWithPrecondition(docPath, next, { updateTime: existing.updateTime });
      }

      if (count <= maxAttempts) return { allowed: true, retryAfterSec: 0 };
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    } catch (err) {
      if (isPreconditionConflict(err) && attempt < 5) continue;
      throw err;
    }
  }

  return { allowed: false, retryAfterSec: 3 };
}

export async function consumeAuthRateLimit({ action, email, ip, windowMs, maxAttempts }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedIp = String(ip || 'unknown').trim() || 'unknown';
  const key = `${String(action || 'auth')}|${normalizedIp}|${normalizedEmail}`;

  if (!isFirestoreMode() || !config.authRateLimitDistributed) {
    return consumeAuthRateLimitLocal({ key, windowMs, maxAttempts });
  }
  return consumeAuthRateLimitFirestore({ key, windowMs, maxAttempts });
}

// social integrations
async function listSocialIntegrationsLocal() {
  const db = readLocalDbUnsafe();
  return [...db.socialIntegrations].map(withResolvedOrg);
}

async function listSocialIntegrationsFirestore() {
  const docs = await firestoreListCollection(collectionName('social_integrations'));
  return docs.map(withResolvedOrg);
}

async function listSocialIntegrationsAll() {
  if (isFirestoreMode()) return listSocialIntegrationsFirestore();
  return listSocialIntegrationsLocal();
}

export async function listSocialIntegrations({ orgId } = {}) {
  const all = await listSocialIntegrationsAll();
  if (!orgId) return all;
  return all.filter((entry) => hasOrgAccess(entry, orgId));
}

async function upsertSocialIntegrationLocal(payload) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const next = buildSocialIntegration(payload);
    const idx = db.socialIntegrations.findIndex((entry) => entry.id === next.id);
    if (idx === -1) {
      db.socialIntegrations.push(next);
    } else {
      const prev = withResolvedOrg(db.socialIntegrations[idx]);
      db.socialIntegrations[idx] = {
        ...prev,
        ...next,
        createdAt: Number(prev.createdAt || next.createdAt || nowTs()),
        updatedAt: nowTs()
      };
    }
    writeLocalDbUnsafe(db);
    return db.socialIntegrations.find((entry) => entry.id === next.id) || next;
  });
}

async function upsertSocialIntegrationFirestore(payload) {
  const next = buildSocialIntegration(payload);
  const pathName = `${collectionName('social_integrations')}/${next.id}`;
  const existing = await firestoreGetDocument(pathName);
  if (!existing) {
    return firestoreCreateDocument(collectionName('social_integrations'), next.id, next);
  }

  const merged = {
    ...withResolvedOrg(existing),
    ...next,
    createdAt: Number(existing.createdAt || next.createdAt || nowTs()),
    updatedAt: nowTs()
  };
  return firestoreUpsertDocument(pathName, merged);
}

export async function upsertSocialIntegration(payload, { orgId } = {}) {
  const scopedOrgId = resolveOrgId(orgId || payload?.orgId);
  if (!scopedOrgId) throw new Error('orgId obligatori per integracio social.');
  const normalizedProvider = normalizeProvider(payload?.provider);
  if (!normalizedProvider) throw new Error('provider obligatori per integracio social.');

  const next = {
    ...payload,
    orgId: scopedOrgId,
    provider: normalizedProvider
  };

  if (isFirestoreMode()) return upsertSocialIntegrationFirestore(next);
  return upsertSocialIntegrationLocal(next);
}

export async function getSocialIntegration(provider, { orgId } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return null;
  const scopedOrgId = resolveOrgId(orgId);
  const all = await listSocialIntegrations({ orgId: scopedOrgId });
  return all.find((entry) => normalizeProvider(entry.provider) === normalizedProvider) || null;
}

export async function disconnectSocialIntegration(provider, { orgId } = {}) {
  const current = await getSocialIntegration(provider, { orgId });
  if (!current) return false;

  await upsertSocialIntegration({
    ...current,
    status: 'disconnected',
    facebookPageId: null,
    facebookPageName: null,
    instagramBusinessAccountId: null,
    instagramUsername: null,
    pageAccessTokenEnc: null,
    userAccessTokenEnc: null,
    userAccessTokenExpiresAt: null,
    disconnectedAt: nowTs(),
    lastError: null
  }, { orgId: current.orgId });
  return true;
}

// oauth state
async function createOauthStateLocal(payload) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const state = buildOauthState(payload);
    db.oauthStates.push(state);
    const minKeepTs = nowTs() - 24 * 60 * 60 * 1000;
    db.oauthStates = db.oauthStates
      .filter((entry) => Number(entry.createdAt || 0) >= minKeepTs)
      .slice(-10_000);
    writeLocalDbUnsafe(db);
    return state;
  });
}

async function createOauthStateFirestore(payload) {
  const state = buildOauthState(payload);
  await firestoreCreateDocument(collectionName('oauth_states'), state.id, state);
  return state;
}

export async function createOauthState(payload) {
  if (isFirestoreMode()) return createOauthStateFirestore(payload);
  return createOauthStateLocal(payload);
}

async function consumeOauthStateLocal({ id, provider, nonce }) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const idx = db.oauthStates.findIndex((entry) => entry.id === id);
    if (idx === -1) return null;

    const current = db.oauthStates[idx];
    if (normalizeProvider(current.provider) !== normalizeProvider(provider)) return null;
    if (current.consumedAt) return null;
    if (!Number.isFinite(current.expiresAt) || current.expiresAt < nowTs()) return null;
    if (current.nonceHash !== hashRateLimitKey(nonce)) return null;

    const next = {
      ...current,
      consumedAt: nowTs(),
      updatedAt: nowTs()
    };
    db.oauthStates[idx] = next;
    writeLocalDbUnsafe(db);
    return next;
  });
}

async function consumeOauthStateFirestore({ id, provider, nonce }) {
  const pathName = `${collectionName('oauth_states')}/${id}`;
  const existing = await firestoreGetDocumentWithMeta(pathName);
  if (!existing?.data) return null;

  const current = existing.data;
  if (normalizeProvider(current.provider) !== normalizeProvider(provider)) return null;
  if (current.consumedAt) return null;
  if (!Number.isFinite(current.expiresAt) || current.expiresAt < nowTs()) return null;
  if (current.nonceHash !== hashRateLimitKey(nonce)) return null;

  const next = {
    ...current,
    consumedAt: nowTs(),
    updatedAt: nowTs()
  };

  try {
    await firestoreUpsertDocumentWithPrecondition(pathName, next, { updateTime: existing.updateTime });
    return next;
  } catch (err) {
    if (isPreconditionConflict(err)) return null;
    throw err;
  }
}

export async function consumeOauthState({ id, provider, nonce }) {
  const cleanId = String(id || '').trim();
  const cleanProvider = normalizeProvider(provider);
  const cleanNonce = String(nonce || '').trim();
  if (!cleanId || !cleanProvider || !cleanNonce) return null;

  if (isFirestoreMode()) return consumeOauthStateFirestore({ id: cleanId, provider: cleanProvider, nonce: cleanNonce });
  return consumeOauthStateLocal({ id: cleanId, provider: cleanProvider, nonce: cleanNonce });
}

// posts
function buildPost(payload, orgId) {
  const now = nowTs();
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : (payload.mediaUrl ? [String(payload.mediaUrl).trim()] : []);
  const primaryMediaUrl = mediaUrls[0] || null;

  return {
    id: crypto.randomUUID(),
    orgId: resolveOrgId(orgId),
    topic: payload.topic,
    channel: payload.channel,
    content: payload.content,
    status: payload.status || 'draft',
    scheduledAt: payload.scheduledAt ?? null,
    createdAt: now,
    updatedAt: now,
    approvedAt: payload.approvedAt ?? null,
    approvedBy: payload.approvedBy ?? null,
    publishedAt: null,
    failCount: 0,
    lastError: null,
    providerMessage: null,
    mediaUrl: primaryMediaUrl,
    mediaUrls,
    quoteIdsUsed: Array.isArray(payload.quoteIdsUsed) ? payload.quoteIdsUsed : [],
    citationRefs: Array.isArray(payload.citationRefs) ? payload.citationRefs : []
  };
}

async function listPostsLocal() {
  const db = readLocalDbUnsafe();
  return [...db.posts].map(withResolvedOrg).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function listPostsFirestore() {
  const posts = await firestoreListCollection(collectionName('posts'));
  return posts.map(withResolvedOrg).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function listPosts({ orgId } = {}) {
  const all = isFirestoreMode() ? await listPostsFirestore() : await listPostsLocal();
  if (!orgId) return all;
  return all.filter((post) => hasOrgAccess(post, orgId));
}

async function getPostLocal(postId) {
  const db = readLocalDbUnsafe();
  const found = db.posts.find((p) => p.id === postId) || null;
  return withResolvedOrg(found);
}

async function getPostFirestore(postId) {
  const found = await firestoreGetDocument(`${collectionName('posts')}/${postId}`);
  return withResolvedOrg(found);
}

export async function getPost(postId, { orgId } = {}) {
  const post = isFirestoreMode() ? await getPostFirestore(postId) : await getPostLocal(postId);
  if (!post) return null;
  if (!orgId) return post;
  return hasOrgAccess(post, orgId) ? post : null;
}

async function createPostLocal(payload, orgId) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const post = buildPost(payload, orgId);
    db.posts.push(post);
    writeLocalDbUnsafe(db);
    return post;
  });
}

async function createPostFirestore(payload, orgId) {
  const post = buildPost(payload, orgId);
  return firestoreCreateDocument(collectionName('posts'), post.id, post);
}

export async function createPost(payload, { orgId } = {}) {
  const scopedOrgId = resolveOrgId(orgId);
  if (isFirestoreMode()) return createPostFirestore(payload, scopedOrgId);
  return createPostLocal(payload, scopedOrgId);
}

async function updatePostLocal(postId, updater, orgId) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const idx = db.posts.findIndex((p) => p.id === postId);
    if (idx === -1) return null;

    const prev = withResolvedOrg(db.posts[idx]);
    if (!hasOrgAccess(prev, orgId)) return null;

    const next = typeof updater === 'function' ? updater({ ...prev }) : { ...prev, ...updater };
    next.orgId = resolveOrgId(next.orgId || prev.orgId);
    next.updatedAt = nowTs();

    db.posts[idx] = next;
    writeLocalDbUnsafe(db);
    return next;
  });
}

async function updatePostFirestore(postId, updater, orgId) {
  const existing = await getPostFirestore(postId);
  if (!existing || !hasOrgAccess(existing, orgId)) return null;

  const next = typeof updater === 'function' ? updater({ ...existing }) : { ...existing, ...updater };
  next.orgId = resolveOrgId(next.orgId || existing.orgId);
  next.updatedAt = nowTs();

  return firestoreUpsertDocument(`${collectionName('posts')}/${postId}`, next);
}

export async function updatePost(postId, updater, { orgId } = {}) {
  const scopedOrgId = resolveOrgId(orgId);
  if (isFirestoreMode()) return updatePostFirestore(postId, updater, scopedOrgId);
  return updatePostLocal(postId, updater, scopedOrgId);
}

async function deletePostLocal(postId, orgId) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const before = db.posts.length;
    db.posts = db.posts.filter((p) => !(p.id === postId && hasOrgAccess(withResolvedOrg(p), orgId)));
    writeLocalDbUnsafe(db);
    return db.posts.length !== before;
  });
}

async function deletePostFirestore(postId, orgId) {
  const existing = await getPostFirestore(postId);
  if (!existing || !hasOrgAccess(existing, orgId)) return false;
  return firestoreDeleteDocument(`${collectionName('posts')}/${postId}`);
}

export async function deletePost(postId, { orgId } = {}) {
  const scopedOrgId = resolveOrgId(orgId);
  if (isFirestoreMode()) return deletePostFirestore(postId, scopedOrgId);
  return deletePostLocal(postId, scopedOrgId);
}

// audit
async function appendAuditLocal(entry, orgId) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    db.audit.push({
      id: crypto.randomUUID(),
      orgId: orgId ? resolveOrgId(orgId) : null,
      at: nowTs(),
      ...entry
    });
    if (db.audit.length > 4000) {
      db.audit = db.audit.slice(db.audit.length - 4000);
    }
    writeLocalDbUnsafe(db);
    return true;
  });
}

async function appendAuditFirestore(entry, orgId) {
  const doc = {
    id: crypto.randomUUID(),
    orgId: orgId ? resolveOrgId(orgId) : null,
    at: nowTs(),
    ...entry
  };
  await firestoreCreateDocument(collectionName('audit'), doc.id, doc);
  return true;
}

export async function appendAudit(entry, { orgId } = {}) {
  if (isFirestoreMode()) return appendAuditFirestore(entry, orgId || null);
  return appendAuditLocal(entry, orgId || null);
}

// scheduler
async function listDueApprovedPostsLocal(limit = 10, orgId = null) {
  const now = nowTs();
  const db = readLocalDbUnsafe();
  const scoped = db.posts
    .map(withResolvedOrg)
    .filter((p) => ['scheduled', 'approved'].includes(p.status) && typeof p.scheduledAt === 'number' && p.scheduledAt <= now)
    .filter((p) => (!orgId ? true : hasOrgAccess(p, orgId)))
    .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  return scoped.slice(0, limit);
}

async function listDueApprovedPostsFirestore(limit = 10, orgId = null) {
  const now = nowTs();
  const posts = await listPostsFirestore();
  const scoped = posts
    .filter((p) => ['scheduled', 'approved'].includes(p.status) && typeof p.scheduledAt === 'number' && p.scheduledAt <= now)
    .filter((p) => (!orgId ? true : hasOrgAccess(p, orgId)))
    .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  return scoped.slice(0, limit);
}

export async function listDueApprovedPosts(limit = 10, { orgId } = {}) {
  const scopedOrgId = orgId ? resolveOrgId(orgId) : null;
  if (isFirestoreMode()) return listDueApprovedPostsFirestore(limit, scopedOrgId);
  return listDueApprovedPostsLocal(limit, scopedOrgId);
}

// quotes catalog (global)
async function getQuotesCatalogLocal() {
  const db = readLocalDbUnsafe();
  return db.quotesCatalog || { versionHash: null, updatedAt: null, sourceSheets: [], quotes: [] };
}

async function getQuotesCatalogFirestore() {
  const doc = await firestoreGetDocument(`${collectionName('meta')}/quotes_catalog`);
  if (!doc) return { versionHash: null, updatedAt: null, sourceSheets: [], quotes: [] };
  return {
    versionHash: doc.versionHash || null,
    updatedAt: doc.updatedAt || null,
    sourceSheets: Array.isArray(doc.sourceSheets) ? doc.sourceSheets : [],
    quotes: Array.isArray(doc.quotes) ? doc.quotes : []
  };
}

export async function getQuotesCatalog() {
  if (isFirestoreMode()) return getQuotesCatalogFirestore();
  return getQuotesCatalogLocal();
}

async function upsertQuotesCatalogLocal(payload) {
  return withWriteLock(() => {
    const db = readLocalDbUnsafe();
    const now = nowTs();
    db.quotesCatalog = {
      versionHash: payload.versionHash || null,
      updatedAt: now,
      sourceSheets: Array.isArray(payload.sourceSheets) ? payload.sourceSheets : [],
      quotes: Array.isArray(payload.quotes) ? payload.quotes : []
    };
    writeLocalDbUnsafe(db);
    return db.quotesCatalog;
  });
}

async function upsertQuotesCatalogFirestore(payload) {
  const now = nowTs();
  return firestoreUpsertDocument(`${collectionName('meta')}/quotes_catalog`, {
    id: 'quotes_catalog',
    versionHash: payload.versionHash || null,
    updatedAt: now,
    sourceSheets: Array.isArray(payload.sourceSheets) ? payload.sourceSheets : [],
    quotes: Array.isArray(payload.quotes) ? payload.quotes : []
  });
}

export async function upsertQuotesCatalog(payload) {
  if (isFirestoreMode()) return upsertQuotesCatalogFirestore(payload);
  return upsertQuotesCatalogLocal(payload);
}

// migration helpers
export async function ensureDefaultOrg() {
  const existing = await getOrg(config.defaultOrgId);
  if (existing) return existing;

  try {
    return await createOrg({
      id: config.defaultOrgId,
      name: 'Legacy Default Org',
      slug: 'legacy-default-org'
    });
  } catch (err) {
    const maybe = await getOrg(config.defaultOrgId);
    if (maybe) return maybe;
    throw err;
  }
}

export async function backfillOrgIdForLegacyData(orgId = config.defaultOrgId) {
  const targetOrgId = resolveOrgId(orgId);
  let postsUpdated = 0;
  let auditUpdated = 0;

  if (!isFirestoreMode()) {
    await withWriteLock(() => {
      const db = readLocalDbUnsafe();
      db.posts = db.posts.map((post) => {
        if (post.orgId) return post;
        postsUpdated += 1;
        return { ...post, orgId: targetOrgId };
      });
      db.audit = db.audit.map((entry) => {
        if (entry.orgId) return entry;
        auditUpdated += 1;
        return { ...entry, orgId: targetOrgId };
      });
      writeLocalDbUnsafe(db);
      return true;
    });
    return { postsUpdated, auditUpdated };
  }

  const posts = await firestoreListCollection(collectionName('posts'));
  for (const post of posts) {
    if (post.orgId) continue;
    // eslint-disable-next-line no-await-in-loop
    await firestoreUpsertDocument(`${collectionName('posts')}/${post.id}`, {
      ...post,
      orgId: targetOrgId
    });
    postsUpdated += 1;
  }

  const audit = await firestoreListCollection(collectionName('audit'));
  for (const entry of audit) {
    if (entry.orgId) continue;
    // eslint-disable-next-line no-await-in-loop
    await firestoreUpsertDocument(`${collectionName('audit')}/${entry.id}`, {
      ...entry,
      orgId: targetOrgId
    });
    auditUpdated += 1;
  }

  return { postsUpdated, auditUpdated };
}
