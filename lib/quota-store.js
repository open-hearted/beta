'use strict';

const { Readable } = require('node:stream');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { sanitizeUserId } = require('../api/_auth');

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-northeast-1';
const USAGE_S3_BUCKET = process.env.USAGE_S3_BUCKET || process.env.AWS_S3_BUCKET || '';
const RAW_PREFIX = process.env.USAGE_S3_PREFIX || 'quota';
const USAGE_S3_PREFIX = RAW_PREFIX.replace(/^\/+/, '').replace(/\/+$/, '') || 'quota';

function parseLimitInput(value, fallback, { allowZeroAsInfinity = true } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'unlimited') return Infinity;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return fallback;
  if (num === 0 && allowZeroAsInfinity) return Infinity;
  if (num === 0 && !allowZeroAsInfinity) return 0;
  return Math.floor(num);
}

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

const SECTION_COUNT = parsePositiveInt(
  process.env.SECTION_COUNT ||
  process.env.LESSON_SECTION_COUNT ||
  process.env.CARD_SECTION_COUNT ||
  process.env.SENTENCE_COUNT ||
  17,
  17
);

const PER_SECTION_LIMITS = Object.freeze({
  listening: parseLimitInput(process.env.LISTENING_SECTION_LIMIT ?? process.env.LISTENING_USAGE_LIMIT ?? 10, 10),
  translation: parseLimitInput(process.env.TRANSLATION_SECTION_LIMIT ?? process.env.TRANSLATION_USAGE_LIMIT ?? 10, 10),
  pronunciation: parseLimitInput(process.env.PRONUNCIATION_SECTION_LIMIT ?? process.env.PRONUNCIATION_USAGE_LIMIT ?? 10, 10)
});

function computeGlobalLimit(perSectionLimit) {
  if (!Number.isFinite(perSectionLimit) || perSectionLimit <= 0) return Infinity;
  return perSectionLimit * Math.max(1, SECTION_COUNT);
}

const DEFAULT_LIMITS = Object.freeze({
  listening: computeGlobalLimit(PER_SECTION_LIMITS.listening),
  translation: computeGlobalLimit(PER_SECTION_LIMITS.translation),
  pronunciation: computeGlobalLimit(PER_SECTION_LIMITS.pronunciation)
});

class QuotaExceededError extends Error {
  constructor(type, limit, used) {
    super(`quota exceeded for ${type}`);
    this.name = 'QuotaExceededError';
    this.type = type;
    this.limit = limit;
    this.used = used;
    this.statusCode = 429;
  }
}

function resolveLimitForType(type, limits = DEFAULT_LIMITS) {
  const source = limits && Object.prototype.hasOwnProperty.call(limits, type)
    ? limits[type]
    : DEFAULT_LIMITS[type];
  const raw = Number(source);
  if (!Number.isFinite(raw) || raw <= 0) return Infinity;
  return Math.floor(raw);
}

let s3Client = null;
let useMemoryStore = !USAGE_S3_BUCKET;
let memoryStore = {};
let memoryNoticeLogged = false;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({ region: AWS_REGION });
  }
  return s3Client;
}

function logMemoryFallback(reason) {
  if (memoryNoticeLogged) return;
  memoryNoticeLogged = true;
  console.warn('[quota-store] Falling back to in-memory storage. Data will not persist across deployments.', reason);
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const readable = stream instanceof Readable ? stream : Readable.from(stream);
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    readable.on('error', reject);
    readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function buildKey(safeId) {
  return `${USAGE_S3_PREFIX}/${safeId}.json`;
}

function createEntry(userId, safeId) {
  const now = new Date().toISOString();
  return {
    id: String(userId),
    safeId,
    listeningUsed: 0,
    translationUsed: 0,
    pronunciationUsed: 0,
    resetAt: null,
    updatedAt: now
  };
}

function normalizeEntry(entry, userId, safeId) {
  if (!entry || typeof entry !== 'object') return createEntry(userId, safeId);
  return {
    id: String(entry.id || userId),
    safeId,
    listeningUsed: toCount(entry.listeningUsed),
    translationUsed: toCount(entry.translationUsed),
    pronunciationUsed: toCount(entry.pronunciationUsed),
    resetAt: entry.resetAt || null,
    updatedAt: entry.updatedAt || null
  };
}

function toCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

async function readEntryFromS3(safeId) {
  const key = buildKey(safeId);
  try {
    const resp = await getS3Client().send(new GetObjectCommand({ Bucket: USAGE_S3_BUCKET, Key: key }));
    const text = await streamToString(resp.Body);
    return JSON.parse(text);
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404)) {
      return null;
    }
    if (err && err.name === 'AccessDenied') {
      useMemoryStore = true;
      logMemoryFallback('S3 AccessDenied');
      return null;
    }
    throw err;
  }
}

async function writeEntryToS3(safeId, entry) {
  const key = buildKey(safeId);
  await getS3Client().send(new PutObjectCommand({
    Bucket: USAGE_S3_BUCKET,
    Key: key,
    Body: Buffer.from(JSON.stringify(entry, null, 2), 'utf8'),
    ContentType: 'application/json',
    CacheControl: 'no-cache'
  }));
  return entry;
}

function getMemoryEntry(safeId, userId) {
  if (!memoryStore[safeId]) {
    memoryStore[safeId] = createEntry(userId, safeId);
  }
  return memoryStore[safeId];
}

function saveMemoryEntry(safeId, entry) {
  memoryStore[safeId] = entry;
  return entry;
}

async function loadEntry(userId) {
  const safeId = sanitizeUserId(userId);
  if (!safeId) throw new Error('userId is required');

  if (useMemoryStore) {
    return { entry: getMemoryEntry(safeId, userId), safeId };
  }

  const existing = await readEntryFromS3(safeId);
  if (existing) {
    return { entry: normalizeEntry(existing, userId, safeId), safeId };
  }
  const initial = createEntry(userId, safeId);
  await writeEntryToS3(safeId, initial);
  return { entry: initial, safeId };
}

async function saveEntry(userId, entry) {
  const safeId = sanitizeUserId(userId);
  if (!safeId) throw new Error('userId is required');
  const normalized = normalizeEntry(entry, userId, safeId);
  normalized.updatedAt = new Date().toISOString();

  if (useMemoryStore) {
    saveMemoryEntry(safeId, normalized);
    return normalized;
  }

  try {
    await writeEntryToS3(safeId, normalized);
    return normalized;
  } catch (err) {
    if (err && err.name === 'AccessDenied') {
      useMemoryStore = true;
      logMemoryFallback('S3 AccessDenied during write');
      saveMemoryEntry(safeId, normalized);
      return normalized;
    }
    throw err;
  }
}

async function getUsage(userId) {
  const { entry } = await loadEntry(userId);
  return normalizeEntry(entry, userId, sanitizeUserId(userId));
}

async function incrementUsage(userId, type, amount = 1) {
  const safeId = sanitizeUserId(userId);
  if (!safeId) throw new Error('userId is required');
  if (!['listening', 'translation', 'pronunciation'].includes(type)) {
    throw new Error(`unsupported quota type: ${type}`);
  }
  const delta = Number(amount);
  const incrementBy = Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 1;
  const { entry } = await loadEntry(userId);
  const field = `${type}Used`;
  const current = toCount(entry[field]);
  const limit = resolveLimitForType(type);
  if (limit !== Infinity && current + incrementBy > limit) {
    throw new QuotaExceededError(type, limit, current);
  }
  entry[field] = current + incrementBy;
  entry.updatedAt = new Date().toISOString();
  const saved = await saveEntry(userId, entry);
  return saved;
}

async function resetUsage(userId) {
  const safeId = sanitizeUserId(userId);
  if (!safeId) throw new Error('userId is required');
  const { entry } = await loadEntry(userId);
  entry.listeningUsed = 0;
  entry.translationUsed = 0;
  entry.pronunciationUsed = 0;
  entry.resetAt = new Date().toISOString();
  entry.updatedAt = entry.resetAt;
  const saved = await saveEntry(userId, entry);
  return saved;
}

async function deleteUsage(userId) {
  const safeId = sanitizeUserId(userId);
  if (!safeId) return;
  if (useMemoryStore) {
    delete memoryStore[safeId];
    return;
  }
  const key = buildKey(safeId);
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: USAGE_S3_BUCKET, Key: key }));
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey')) return;
    throw err;
  }
}

async function listUsage() {
  if (useMemoryStore) {
    return Object.values(memoryStore).map(entry => ({ ...entry }));
  }
  const results = [];
  let continuationToken;
  do {
    const resp = await getS3Client().send(new ListObjectsV2Command({
      Bucket: USAGE_S3_BUCKET,
      Prefix: `${USAGE_S3_PREFIX}/`,
      ContinuationToken: continuationToken
    }));
    const keys = (resp.Contents || []).map(item => item.Key).filter(Boolean);
    for (const key of keys) {
      const safeId = key.replace(`${USAGE_S3_PREFIX}/`, '').replace(/\.json$/, '');
      try {
        const entry = await readEntryFromS3(safeId);
        if (entry) {
          results.push(normalizeEntry(entry, entry.id || safeId, safeId));
        }
      } catch (err) {
        console.warn('[quota-store] failed to load entry', key, err);
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return results;
}

function computeRemaining(entry, limits = DEFAULT_LIMITS) {
  const listeningLimit = resolveLimitForType('listening', limits);
  const translationLimit = resolveLimitForType('translation', limits);
  const pronunciationLimit = resolveLimitForType('pronunciation', limits);
  const listeningRemaining = listeningLimit === Infinity ? Infinity : Math.max(0, listeningLimit - toCount(entry.listeningUsed));
  const translationRemaining = translationLimit === Infinity ? Infinity : Math.max(0, translationLimit - toCount(entry.translationUsed));
  const pronunciationRemaining = pronunciationLimit === Infinity ? Infinity : Math.max(0, pronunciationLimit - toCount(entry.pronunciationUsed));
  return {
    listening: listeningRemaining,
    translation: translationRemaining,
    pronunciation: pronunciationRemaining
  };
}

function isUsingMemoryStore() {
  return useMemoryStore;
}

module.exports = {
  DEFAULT_LIMITS,
  PER_SECTION_LIMITS,
  SECTION_COUNT,
  getUsage,
  incrementUsage,
  resetUsage,
  deleteUsage,
  listUsage,
  computeRemaining,
  resolveLimitForType,
  isUsingMemoryStore,
  QuotaExceededError
};
