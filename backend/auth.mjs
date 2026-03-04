import crypto from 'node:crypto';

import { config } from './config.mjs';

const firebaseCertsCache = {
  certsByKid: {},
  expiresAtMs: 0
};

const firebaseRevocationCache = new Map();

function nowMs() {
  return Date.now();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toExpiryMs() {
  return nowMs() + config.sessionTtlHours * 60 * 60 * 1000;
}

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

function base64urlDecodeBuffer(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function sessionSecretMaterial() {
  return config.sessionSecret || config.firebaseApiKey || 'summa-default-session-secret';
}

function signPayload(payloadText) {
  return base64urlEncode(
    crypto
      .createHmac('sha256', sessionSecretMaterial())
      .update(payloadText)
      .digest()
  );
}

function issueSessionToken(payload) {
  const payloadText = JSON.stringify(payload);
  const payloadEncoded = base64urlEncode(payloadText);
  const signature = signPayload(payloadText);
  return `${payloadEncoded}.${signature}`;
}

function verifySignedSessionToken(token) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payloadEncoded, signature] = parts;
  if (!payloadEncoded || !signature) return null;

  let payloadText = '';
  let payload = null;
  try {
    payloadText = base64urlDecode(payloadEncoded);
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }

  const expectedSig = signPayload(payloadText);
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs()) return null;

  return payload;
}

function decodeJwtParts(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64urlDecode(parts[0]));
    const payload = JSON.parse(base64urlDecode(parts[1]));
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2]
    };
  } catch {
    return null;
  }
}

function parseCacheMaxAgeSec(cacheControlHeader) {
  const raw = String(cacheControlHeader || '');
  const match = raw.match(/max-age=(\d+)/i);
  if (!match) return 300;
  const sec = Number.parseInt(match[1], 10);
  if (!Number.isFinite(sec) || sec <= 0) return 300;
  return sec;
}

async function firebaseAuthRequest(path, body) {
  if (!config.firebaseApiKey) throw new Error('Firebase API key no configurada.');

  const url = new URL(`${config.firebaseAuthBaseUrl}${path}`);
  url.searchParams.set('key', config.firebaseApiKey);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(payload?.error?.message || 'AUTH_ERROR');
    const map = {
      EMAIL_NOT_FOUND: 'Credencials invalides.',
      INVALID_PASSWORD: 'Credencials invalides.',
      USER_DISABLED: 'Usuari desactivat.',
      EMAIL_EXISTS: 'Aquest email ja existeix.',
      INVALID_EMAIL: 'Email invalid.',
      WEAK_PASSWORD: 'Contrasenya massa feble.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'Massa intents. Torna-ho a provar mes tard.',
      INVALID_ID_TOKEN: 'Sessio Firebase invalida.',
      TOKEN_EXPIRED: 'Sessio Firebase caducada.'
    };
    throw new Error(map[code] || `Error Firebase Auth: ${code}`);
  }

  return payload;
}

async function fetchFirebaseUserByIdToken(idToken) {
  const lookup = await firebaseAuthRequest('/accounts:lookup', { idToken });
  const user = Array.isArray(lookup?.users) ? lookup.users[0] : null;
  if (!user) throw new Error('No s ha pogut obtenir dades d usuari Firebase.');
  return user;
}

async function refreshFirebaseIdToken(refreshToken) {
  if (!config.firebaseApiKey) throw new Error('Firebase API key no configurada.');
  const url = new URL(`${config.firebaseSecureTokenBaseUrl}/token`);
  url.searchParams.set('key', config.firebaseApiKey);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken || '')
  });

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(payload?.error?.message || payload?.error || 'TOKEN_REFRESH_FAILED');
    throw new Error(`No s ha pogut refrescar la sessio Firebase: ${code}`);
  }

  if (!payload?.id_token || !payload?.refresh_token) {
    throw new Error('Resposta de refresh Firebase incompleta.');
  }

  return {
    idToken: String(payload.id_token),
    refreshToken: String(payload.refresh_token),
    uid: String(payload.user_id || '')
  };
}

async function sendVerificationEmail(idToken) {
  try {
    await firebaseAuthRequest('/accounts:sendOobCode', {
      requestType: 'VERIFY_EMAIL',
      idToken
    });
  } catch {
    // Non-blocking: we still return user creation success.
  }
}

async function getFirebasePublicCerts() {
  const now = nowMs();
  if (firebaseCertsCache.expiresAtMs > now && Object.keys(firebaseCertsCache.certsByKid).length) {
    return firebaseCertsCache.certsByKid;
  }

  const response = await fetch(config.firebaseCertsUrl, { method: 'GET' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new Error('No s han pogut obtenir els certificats publics de Firebase.');
  }

  const maxAgeSec = parseCacheMaxAgeSec(response.headers.get('cache-control'));
  firebaseCertsCache.certsByKid = payload;
  firebaseCertsCache.expiresAtMs = now + Math.max(30, maxAgeSec) * 1000;
  return firebaseCertsCache.certsByKid;
}

async function verifyFirebaseIdTokenSignatureAndClaims(idToken) {
  if (!config.firebaseProjectId) {
    throw new Error('FIREBASE_PROJECT_ID no configurat.');
  }

  const parsed = decodeJwtParts(idToken);
  if (!parsed) throw new Error('ID token Firebase invalid.');

  const { header, payload, signingInput, signature } = parsed;
  if (header.alg !== 'RS256') throw new Error('Algoritme de token no suportat.');
  if (!header.kid) throw new Error('Token sense kid.');

  const certs = await getFirebasePublicCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('No hi ha certificat public per aquest token.');

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  const validSignature = verifier.verify(pem, base64urlDecodeBuffer(signature));
  if (!validSignature) throw new Error('Firma Firebase ID token invalida.');

  const now = nowSec();
  const skewSec = 30;
  const expectedIssuer = `https://securetoken.google.com/${config.firebaseProjectId}`;
  if (payload.iss !== expectedIssuer) throw new Error('Issuer invalid al Firebase token.');
  if (payload.aud !== config.firebaseProjectId) throw new Error('Audience invalida al Firebase token.');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('Subject invalid al Firebase token.');
  if (!Number.isFinite(payload.iat) || payload.iat > now + skewSec) throw new Error('iat invalid al Firebase token.');
  if (!Number.isFinite(payload.exp) || payload.exp < now - skewSec) throw new Error('Firebase token caducat.');

  return payload;
}

function getRevocationCacheEntry(uid) {
  const cached = firebaseRevocationCache.get(uid);
  if (!cached) return null;
  const ttlMs = Math.max(5, Number(config.authRevocationCacheSec || 60)) * 1000;
  if (cached.checkedAtMs + ttlMs < nowMs()) {
    firebaseRevocationCache.delete(uid);
    return null;
  }
  return cached;
}

async function checkFirebaseRevocationAndUserStatus(idToken, claims) {
  if (!config.authRevocationCheckEnabled) {
    return {
      revoked: false,
      disabled: false,
      emailVerified: Boolean(claims.email_verified)
    };
  }

  const uid = String(claims.user_id || claims.sub || '');
  const fromCache = uid ? getRevocationCacheEntry(uid) : null;
  if (fromCache) {
    return {
      revoked: Number(claims.iat || 0) < Number(fromCache.validSinceSec || 0),
      disabled: Boolean(fromCache.disabled),
      emailVerified: Boolean(fromCache.emailVerified)
    };
  }

  const user = await fetchFirebaseUserByIdToken(idToken);
  const validSinceSec = Number.parseInt(String(user.validSince || '0'), 10) || 0;
  const disabled = Boolean(user.disabled);
  const emailVerified = Boolean(user.emailVerified);

  if (uid) {
    firebaseRevocationCache.set(uid, {
      checkedAtMs: nowMs(),
      validSinceSec,
      disabled,
      emailVerified
    });
  }

  return {
    revoked: Number(claims.iat || 0) < validSinceSec,
    disabled,
    emailVerified
  };
}

function requiresTokenRefresh(idToken) {
  const parsed = decodeJwtParts(idToken);
  if (!parsed?.payload?.exp) return true;
  const now = nowSec();
  return Number(parsed.payload.exp) <= now + 120;
}

async function verifySessionPayload(sessionPayload) {
  if (!sessionPayload || typeof sessionPayload !== 'object') return null;
  if (!sessionPayload.idToken || !sessionPayload.refreshToken) return null;
  if (typeof sessionPayload.orgId !== 'string' || !sessionPayload.orgId) return null;
  if (typeof sessionPayload.role !== 'string' || !sessionPayload.role) return null;

  const next = { ...sessionPayload };
  let rotated = false;

  if (requiresTokenRefresh(next.idToken)) {
    const refreshed = await refreshFirebaseIdToken(next.refreshToken);
    next.idToken = refreshed.idToken;
    next.refreshToken = refreshed.refreshToken;
    rotated = true;
  }

  const claims = await verifyFirebaseIdTokenSignatureAndClaims(next.idToken);
  const revocation = await checkFirebaseRevocationAndUserStatus(next.idToken, claims);

  if (revocation.disabled) throw new Error('Usuari desactivat.');
  if (revocation.revoked) throw new Error('Sessio revocada. Torna a iniciar sessio.');

  const emailVerified = revocation.emailVerified || Boolean(claims.email_verified);
  if (config.requireEmailVerified && !emailVerified) {
    throw new Error('Cal verificar l email abans d entrar.');
  }

  const mfaAuthenticated = Boolean(claims?.firebase?.sign_in_second_factor);
  if (config.enforceMfaForPrivilegedRoles && ['owner', 'admin'].includes(String(sessionPayload.role || ''))) {
    if (!mfaAuthenticated) throw new Error('Cal autenticacio MFA per aquest rol.');
  }

  return {
    rotated,
    nextSessionPayload: next,
    claims,
    emailVerified,
    mfaAuthenticated
  };
}

export function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    result[k] = decodeURIComponent(rest.join('='));
  }
  return result;
}

export function setSessionCookie(res, token) {
  const maxAge = config.sessionTtlHours * 60 * 60;
  const secure = config.appBaseUrl.startsWith('https://') ? '; Secure' : '';
  const value = `${config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  res.setHeader('Set-Cookie', value);
}

export function clearSessionCookie(res) {
  const secure = config.appBaseUrl.startsWith('https://') ? '; Secure' : '';
  const value = `${config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  res.setHeader('Set-Cookie', value);
}

export async function loginWithFirebase(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const rawPassword = String(password || '');
  if (!normalizedEmail || !rawPassword) return null;

  const payload = await firebaseAuthRequest('/accounts:signInWithPassword', {
    email: normalizedEmail,
    password: rawPassword,
    returnSecureToken: true
  });

  if (!payload?.localId || !payload?.email || !payload?.idToken || !payload?.refreshToken) return null;

  let emailVerified = Boolean(payload.emailVerified);
  if (!emailVerified || config.authRevocationCheckEnabled || config.requireEmailVerified) {
    const user = await fetchFirebaseUserByIdToken(String(payload.idToken));
    emailVerified = Boolean(user.emailVerified);
  }

  return {
    uid: String(payload.localId),
    email: String(payload.email).toLowerCase(),
    idToken: String(payload.idToken),
    refreshToken: String(payload.refreshToken),
    emailVerified
  };
}

export async function signupWithFirebase(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const rawPassword = String(password || '');
  if (!normalizedEmail || !rawPassword) return null;

  const payload = await firebaseAuthRequest('/accounts:signUp', {
    email: normalizedEmail,
    password: rawPassword,
    returnSecureToken: true
  });

  if (!payload?.localId || !payload?.email || !payload?.idToken || !payload?.refreshToken) return null;

  await sendVerificationEmail(String(payload.idToken));

  return {
    uid: String(payload.localId),
    email: String(payload.email).toLowerCase(),
    idToken: String(payload.idToken),
    refreshToken: String(payload.refreshToken),
    emailVerified: false
  };
}

export async function evaluateLoginSecurity({ idToken, role = 'member' }) {
  const claims = await verifyFirebaseIdTokenSignatureAndClaims(idToken);
  const revocation = await checkFirebaseRevocationAndUserStatus(idToken, claims);
  if (revocation.disabled) throw new Error('Usuari desactivat.');
  if (revocation.revoked) throw new Error('Sessio revocada. Torna a iniciar sessio.');

  const emailVerified = revocation.emailVerified || Boolean(claims.email_verified);
  if (config.requireEmailVerified && !emailVerified) {
    throw new Error('Cal verificar l email abans d entrar.');
  }

  const mfaAuthenticated = Boolean(claims?.firebase?.sign_in_second_factor);
  if (config.enforceMfaForPrivilegedRoles && ['owner', 'admin'].includes(String(role || ''))) {
    if (!mfaAuthenticated) throw new Error('Cal autenticacio MFA per aquest rol.');
  }

  return {
    uid: String(claims.user_id || claims.sub || ''),
    email: String(claims.email || '').toLowerCase(),
    emailVerified,
    mfaAuthenticated
  };
}

export function createSessionTokenForUser(user) {
  const payload = {
    v: 2,
    uid: String(user.uid || ''),
    email: String(user.email || '').toLowerCase(),
    orgId: String(user.orgId || ''),
    role: String(user.role || 'member'),
    idToken: String(user.idToken || ''),
    refreshToken: String(user.refreshToken || ''),
    exp: toExpiryMs()
  };

  if (!payload.uid || !payload.email || !payload.orgId || !payload.role || !payload.idToken || !payload.refreshToken) {
    throw new Error('No es pot crear sessio: falten dades de seguretat.');
  }

  return issueSessionToken(payload);
}

export function logout(token) {
  void token;
}

export function getRawSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[config.sessionCookieName] || '';
  if (!token) return null;
  const payload = verifySignedSessionToken(token);
  if (!payload) return null;
  return { token, payload };
}

export async function getSessionFromRequest(req) {
  const raw = getRawSessionFromRequest(req);
  if (!raw) return null;

  const verified = await verifySessionPayload(raw.payload);
  if (!verified) return null;

  const nextPayload = {
    ...verified.nextSessionPayload,
    exp: Math.min(Number(raw.payload.exp || 0), toExpiryMs())
  };

  const refreshedToken = verified.rotated ? issueSessionToken(nextPayload) : null;
  return {
    token: raw.token,
    refreshedToken,
    user: {
      uid: String(verified.claims.user_id || verified.claims.sub || nextPayload.uid),
      email: String(verified.claims.email || nextPayload.email || '').toLowerCase(),
      orgId: nextPayload.orgId,
      role: nextPayload.role,
      emailVerified: verified.emailVerified,
      mfaAuthenticated: verified.mfaAuthenticated
    }
  };
}
