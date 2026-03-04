import fs from 'node:fs';
import path from 'node:path';

function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof process.env[key] === 'undefined') process.env[key] = value;
  }
}

loadLocalEnv();

const toInt = (value, fallback) => {
  const num = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(num) ? num : fallback;
};

const toBool = (value, fallback) => {
  if (typeof value === 'undefined') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'si', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const recipients = (process.env.WHATSAPP_RECIPIENTS || '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

const quoteSheetGids = (process.env.QUOTES_SHEET_GIDS || '1335524648,1883032053,1388745196')
  .split(',')
  .map((gid) => gid.trim())
  .filter(Boolean);

const defaultQuotesUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRKxv-dpVXZLAuhRDj_mQrxdMlnir4kLze6IsvfUwm7kA_Q_5fN_IK-IBEjthLLJr0ZVCCu-Y_6cIvE/pub?output=csv';

export const config = {
  port: toInt(process.env.PORT, 8080),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:8080',
  sessionTtlHours: toInt(process.env.SESSION_TTL_HOURS, 12),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'summa_session',
  sessionSecret: process.env.SESSION_SECRET || '',
  appRole: process.env.APP_ROLE || 'all',

  dataStore: process.env.DATA_STORE || 'firestore',
  firestoreProjectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '',
  firestoreDatabase: process.env.FIRESTORE_DATABASE || '(default)',
  firestoreCollectionPrefix: process.env.FIRESTORE_COLLECTION_PREFIX || 'summa_publica',
  defaultOrgId: process.env.DEFAULT_ORG_ID || 'org_default',

  firebaseApiKey: process.env.FIREBASE_API_KEY || '',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '',
  firebaseAuthBaseUrl: process.env.FIREBASE_AUTH_BASE_URL || 'https://identitytoolkit.googleapis.com/v1',
  firebaseSecureTokenBaseUrl: process.env.FIREBASE_SECURE_TOKEN_BASE_URL || 'https://securetoken.googleapis.com/v1',
  firebaseCertsUrl: process.env.FIREBASE_CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
  requireEmailVerified: toBool(process.env.REQUIRE_EMAIL_VERIFIED, true),
  enforceMfaForPrivilegedRoles: toBool(process.env.ENFORCE_MFA_FOR_PRIVILEGED_ROLES, false),
  authRevocationCheckEnabled: toBool(process.env.AUTH_REVOCATION_CHECK_ENABLED, true),
  authRevocationCacheSec: toInt(process.env.AUTH_REVOCATION_CACHE_SEC, 60),

  authRateLimitWindowMs: toInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  authRateLimitMaxAttempts: toInt(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, 10),
  authRateLimitDistributed: toBool(process.env.AUTH_RATE_LIMIT_DISTRIBUTED, true),

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  metaApiVersion: process.env.META_API_VERSION || 'v22.0',
  metaAppId: process.env.META_APP_ID || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaOauthScopes: process.env.META_OAUTH_SCOPES || 'pages_show_list,pages_manage_posts,instagram_basic,instagram_content_publish,business_management',
  metaOauthStateTtlSec: toInt(process.env.META_OAUTH_STATE_TTL_SEC, 600),

  facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
  facebookToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',

  instagramBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '',
  instagramToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
  instagramDefaultImageUrl: process.env.INSTAGRAM_DEFAULT_IMAGE_URL || '',
  allowWhatsAppAutopublish: toBool(process.env.ALLOW_WHATSAPP_AUTOPUBLISH, false),

  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  whatsappToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  whatsappRecipients: recipients,

  quotesSheetCsvUrl: process.env.QUOTES_SHEET_CSV_URL || defaultQuotesUrl,
  quotesSheetGids: quoteSheetGids,
  quotesCacheTtlMin: toInt(process.env.QUOTES_CACHE_TTL_MIN, 30),
  quotesMinConfidence: process.env.QUOTES_MIN_CONFIDENCE || 'MITJA',
  requireReferencedQuotes: toBool(process.env.REQUIRE_REFERENCED_QUOTES, true),
  quotesSyncIntervalMs: toInt(process.env.QUOTES_SYNC_INTERVAL_MS, 120000),
  maxUploadBytes: toInt(process.env.MAX_UPLOAD_BYTES, 5_000_000),
  uploadsMode: process.env.UPLOADS_MODE || 'local',
  gcsUploadBucket: process.env.GCS_UPLOAD_BUCKET || '',
  gcsUploadPrefix: process.env.GCS_UPLOAD_PREFIX || 'uploads',

  publishIntervalMs: toInt(process.env.PUBLISH_INTERVAL_MS, 60000),
  maxPostsPerCycle: toInt(process.env.MAX_POSTS_PER_CYCLE, 10),
  postsPageDefaultLimit: toInt(process.env.POSTS_PAGE_DEFAULT_LIMIT, 50),
  postsPageMaxLimit: toInt(process.env.POSTS_PAGE_MAX_LIMIT, 200),
  workerTickToken: process.env.WORKER_TICK_TOKEN || ''
};

export function getStartupWarnings() {
  const warnings = [];
  if (!config.sessionSecret) {
    warnings.push('SESSION_SECRET missing. Fallback secret will be used.');
  }
  if (!['local', 'firestore'].includes(config.dataStore)) warnings.push(`DATA_STORE invalid: ${config.dataStore}. Expected local|firestore.`);
  if (config.dataStore === 'firestore' && !config.firestoreProjectId) warnings.push('FIRESTORE_PROJECT_ID is missing while DATA_STORE=firestore.');
  if (!config.firebaseApiKey) warnings.push('FIREBASE_API_KEY is missing. Login/signup will fail.');
  if (!config.firebaseProjectId) warnings.push('FIREBASE_PROJECT_ID missing. Firebase ID token verification will fail.');
  if (!config.metaAppId || !config.metaAppSecret) warnings.push('META_APP_ID / META_APP_SECRET missing. Meta OAuth connect is disabled.');
  if ((config.metaAppId || config.metaAppSecret) && !config.sessionSecret) warnings.push('SESSION_SECRET missing. OAuth token encryption requires SESSION_SECRET.');
  if (isWorkerRoleEnabled() && !config.workerTickToken) warnings.push('WORKER_TICK_TOKEN missing. Internal worker tick endpoint is unprotected.');
  if (!['local', 'gcs'].includes(config.uploadsMode)) warnings.push(`UPLOADS_MODE invalid: ${config.uploadsMode}. Expected local|gcs.`);
  if (config.uploadsMode === 'gcs' && !config.gcsUploadBucket) warnings.push('GCS_UPLOAD_BUCKET missing while UPLOADS_MODE=gcs.');
  if (!config.geminiApiKey) warnings.push('GEMINI_API_KEY is missing. Content generation will fail.');
  if (!config.quotesSheetCsvUrl) warnings.push('QUOTES_SHEET_CSV_URL is missing. Citation validation will fail.');
  if (!config.quotesSheetGids.length) warnings.push('QUOTES_SHEET_GIDS is empty. Citation validation will fail.');
  return warnings;
}

export function isApiRoleEnabled() {
  return ['api', 'all'].includes(String(config.appRole || 'all').toLowerCase());
}

export function isWorkerRoleEnabled() {
  return ['worker', 'all'].includes(String(config.appRole || 'all').toLowerCase());
}

export function getAllowedChannels() {
  const channels = ['facebook', 'instagram', 'meta'];
  if (config.allowWhatsAppAutopublish) channels.push('whatsapp');
  return channels;
}
