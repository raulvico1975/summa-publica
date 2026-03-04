import crypto from 'node:crypto';

import { config } from './config.mjs';

function base64urlEncodeBuffer(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecodeBuffer(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function resolveSecretMaterial() {
  const raw = String(config.sessionSecret || '').trim();
  if (!raw) {
    throw new Error('SESSION_SECRET obligatori per xifrar secrets d integracions socials.');
  }
  return raw;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(resolveSecretMaterial()).digest();
}

export function encryptSecret(plainValue) {
  const text = String(plainValue || '');
  if (!text) return null;

  const iv = crypto.randomBytes(12);
  const key = encryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${base64urlEncodeBuffer(iv)}.${base64urlEncodeBuffer(tag)}.${base64urlEncodeBuffer(encrypted)}`;
}

export function decryptSecret(encodedValue) {
  const raw = String(encodedValue || '').trim();
  if (!raw) return '';

  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Format de secret xifrat invalid.');
  }

  const iv = base64urlDecodeBuffer(parts[1]);
  const tag = base64urlDecodeBuffer(parts[2]);
  const encrypted = base64urlDecodeBuffer(parts[3]);

  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString('utf8');
}
