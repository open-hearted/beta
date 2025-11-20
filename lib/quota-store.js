'use strict';

const fs = require('fs/promises');
const path = require('path');
const { sanitizeUserId } = require('../api/_auth');

const STORE_PATH = process.env.QUOTA_STORE_PATH
  ? path.resolve(process.env.QUOTA_STORE_PATH)
  : path.join(process.cwd(), 'data', 'quota-store.json');
const DATA_DIR = path.dirname(STORE_PATH);

const DEFAULT_QUOTA = Object.freeze({
  listeningUsed: 0,
  translationUsed: 0,
  pronunciationUsed: 0,
  resetAt: null
});

const ALLOWED_TYPES = new Set(['listening', 'translation', 'pronunciation']);

let useMemoryStore = false;
let memoryStore = { users: {} };
let memoryNoticeLogged = false;

const ADMIN_STORE_MODE = (process.env.ADMIN_STORE_MODE || '').toLowerCase();

if (ADMIN_STORE_MODE === 'memory') {
  useMemoryStore = true;
  logMemoryFallback('forced memory mode via ADMIN_STORE_MODE');
}

function cloneStore(store) {
  return JSON.parse(JSON.stringify(store || { users: {} }));
}

function logMemoryFallback(err) {
  if (memoryNoticeLogged) return;
  memoryNoticeLogged = true;
  const reason = err && err.code ? `${err.code}: ${err.message || ''}` : String(err || 'unknown');
  console.warn('[quota-store] Falling back to in-memory storage. Changes will not persist across deployments.', reason);
}

function isReadOnlyError(err) {
  const code = err && err.code;
  return code === 'EROFS' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EPERM';
}

function normalizeQuota(quota) {
  if (!quota || typeof quota !== 'object') return { ...DEFAULT_QUOTA };
  return {
    listeningUsed: toCount(quota.listeningUsed),
    translationUsed: toCount(quota.translationUsed),
    pronunciationUsed: toCount(quota.pronunciationUsed),
    resetAt: quota.resetAt || null,
    updatedAt: quota.updatedAt || null
  };
}

function toCount(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

async function ensureFileStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (!isReadOnlyError(err) && err.code !== 'EEXIST') throw err;
    if (isReadOnlyError(err)) {
      useMemoryStore = true;
      logMemoryFallback(err);
      return cloneStore(memoryStore);
    }
  }
  try {
    const data = await fs.readFile(STORE_PATH, 'utf8');
    return normalizeStore(JSON.parse(data));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const seed = { users: {} };
      try {
        await fs.writeFile(STORE_PATH, JSON.stringify(seed, null, 2));
      } catch (writeErr) {
        if (isReadOnlyError(writeErr)) {
          useMemoryStore = true;
          memoryStore = seed;
          logMemoryFallback(writeErr);
          return cloneStore(memoryStore);
        }
        throw writeErr;
      }
      return seed;
    }
    if (isReadOnlyError(err)) {
      useMemoryStore = true;
      logMemoryFallback(err);
      return cloneStore(memoryStore);
    }
    throw err;
  }
}

function normalizeStore(store) {
  const users = store && store.users && typeof store.users === 'object' ? store.users : {};
  const normalized = {};
  for (const [key, value] of Object.entries(users)) {
    const safeId = sanitizeUserId(key);
    normalized[safeId] = normalizeUserEntry(safeId, value);
  }
  return { users: normalized };
}

function normalizeUserEntry(safeId, entry) {
  const id = entry && entry.id ? String(entry.id).trim() : safeId;
  const quota = normalizeQuota(entry);
  quota.resetAt = quota.resetAt || null;
  quota.updatedAt = entry && entry.updatedAt ? entry.updatedAt : null;
  return {
    id,
    safeId,
    listeningUsed: quota.listeningUsed,
    translationUsed: quota.translationUsed,
    pronunciationUsed: quota.pronunciationUsed,
    resetAt: quota.resetAt,
    updatedAt: quota.updatedAt
  };
}

async function loadStore() {
  if (useMemoryStore) {
    return cloneStore(memoryStore);
  }
  const store = await ensureFileStore();
  return store;
}

async function saveStore(store) {
  const clean = normalizeStore(store);
  if (useMemoryStore) {
    memoryStore = clean;
    return cloneStore(memoryStore);
  }
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(clean, null, 2));
    return clean;
  } catch (err) {
    if (isReadOnlyError(err)) {
      useMemoryStore = true;
      memoryStore = clean;
      logMemoryFallback(err);
      return cloneStore(memoryStore);
    }
    throw err;
  }
}

function ensureUserEntry(store, userId) {
  if (!store.users || typeof store.users !== 'object') store.users = {};
  const safeId = sanitizeUserId(userId);
  if (!safeId) throw new Error('userId is required');
  if (!store.users[safeId]) {
    store.users[safeId] = {
      id: String(userId),
      safeId,
      listeningUsed: 0,
      translationUsed: 0,
      pronunciationUsed: 0,
      resetAt: null,
      updatedAt: null
    };
  }
  return store.users[safeId];
}

function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

async function getUsage(userId) {
  const store = await loadStore();
  const entry = ensureUserEntry(store, userId);
  return cloneEntry(entry);
}

async function incrementUsage(userId, type, amount = 1) {
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`Unsupported quota type: ${type}`);
  }
  const delta = Number(amount);
  const incrementBy = Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 1;
  const store = await loadStore();
  const entry = ensureUserEntry(store, userId);
  const field = `${type}Used`;
  entry[field] = toCount(entry[field]) + incrementBy;
  entry.updatedAt = new Date().toISOString();
  const saved = await saveStore(store);
  const updated = ensureUserEntry(saved, userId);
  return cloneEntry(updated);
}

async function resetUsage(userId) {
  const store = await loadStore();
  const entry = ensureUserEntry(store, userId);
  entry.listeningUsed = 0;
  entry.translationUsed = 0;
  entry.pronunciationUsed = 0;
  entry.resetAt = new Date().toISOString();
  entry.updatedAt = entry.resetAt;
  const saved = await saveStore(store);
  const updated = ensureUserEntry(saved, userId);
  return cloneEntry(updated);
}

async function listUsage() {
  const store = await loadStore();
  return Object.values(store.users || {}).map(entry => cloneEntry(entry));
}

module.exports = {
  getUsage,
  incrementUsage,
  resetUsage,
  listUsage,
  DEFAULT_QUOTA: { ...DEFAULT_QUOTA }
};
