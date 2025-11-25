'use strict';

const { requireAuth } = require('./_auth');
const {
  DEFAULT_LIMITS,
  PER_SECTION_LIMITS,
  SECTION_COUNT,
  getUsage,
  incrementUsage,
  computeRemaining,
  isUsingMemoryStore,
  QuotaExceededError
} = require('../lib/quota-store');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (err) {
      return {};
    }
  }
  return body;
}

function normalizeType(type) {
  const value = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (value === 'listen' || value === 'listening') return 'listening';
  if (value === 'translate' || value === 'translation') return 'translation';
  if (value === 'pronunciation' || value === 'speaking') return 'pronunciation';
  return '';
}

function buildUsagePayload(entry) {
  const usage = {
    listeningUsed: entry.listeningUsed,
    translationUsed: entry.translationUsed,
    pronunciationUsed: entry.pronunciationUsed,
    resetAt: entry.resetAt || null,
    updatedAt: entry.updatedAt || null
  };
  const limits = {
    listening: DEFAULT_LIMITS.listening,
    translation: DEFAULT_LIMITS.translation,
    pronunciation: DEFAULT_LIMITS.pronunciation
  };
  const remaining = computeRemaining(entry, limits);
  return {
    ok: true,
    usage,
    limits,
    perSectionLimits: PER_SECTION_LIMITS,
    sectionCount: SECTION_COUNT,
    remaining,
    storage: isUsingMemoryStore() ? 'memory' : 's3'
  };
}

module.exports = async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  try {
    if (req.method === 'GET') {
      const entry = await getUsage(user.id);
      return res.status(200).json(buildUsagePayload(entry));
    }

    if (req.method === 'POST') {
      const { type, amount } = parseBody(req.body);
      const normalizedType = normalizeType(type);
      if (!normalizedType) {
        return res.status(400).json({ error: 'type is required' });
      }
      const entry = await incrementUsage(user.id, normalizedType, amount);
      return res.status(200).json(buildUsagePayload(entry));
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      try {
        const entry = await getUsage(user.id);
        const payload = buildUsagePayload(entry);
        payload.error = 'Quota exceeded';
        payload.limitExceeded = {
          type: err.type,
          limit: err.limit,
          used: err.used
        };
        return res.status(429).json(payload);
      } catch (innerErr) {
        console.warn('fetch usage after quota error failed', innerErr);
      }
      return res.status(429).json({ error: 'Quota exceeded' });
    }
    console.error('usage handler failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
