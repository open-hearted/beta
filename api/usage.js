'use strict';

const { requireAuth } = require('./_auth');
const quotaStore = require('../lib/quota-store');

const LIMITS = {
  listening: Number(process.env.LISTENING_USAGE_LIMIT || 10),
  translation: Number(process.env.TRANSLATION_USAGE_LIMIT || 10),
  pronunciation: Number(process.env.PRONUNCIATION_USAGE_LIMIT || 10)
};

const ALLOWED_TYPES = new Set(['listening', 'translation', 'pronunciation']);

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow.join(', '));
  res.status(405).json({ error: 'Method Not Allowed' });
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

function formatQuota(entry) {
  if (!entry || typeof entry !== 'object') {
    return {
      listeningUsed: 0,
      translationUsed: 0,
      pronunciationUsed: 0,
      resetAt: null,
      updatedAt: null
    };
  }
  return {
    listeningUsed: Number(entry.listeningUsed) || 0,
    translationUsed: Number(entry.translationUsed) || 0,
    pronunciationUsed: Number(entry.pronunciationUsed) || 0,
    resetAt: entry.resetAt || null,
    updatedAt: entry.updatedAt || null
  };
}

module.exports = async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const usage = await quotaStore.getUsage(user.id);
      return res.status(200).json({
        ok: true,
        quota: formatQuota(usage),
        limit: LIMITS,
        userId: usage?.id || user.id,
        safeUserId: usage?.safeId || user.safeId
      });
    }

    if (req.method === 'POST') {
      const { type, amount } = parseBody(req.body);
      if (!ALLOWED_TYPES.has(type)) {
        return res.status(400).json({ error: 'invalid type' });
      }
      const updated = await quotaStore.incrementUsage(user.id, type, amount);
      return res.status(200).json({
        ok: true,
        quota: formatQuota(updated),
        limit: LIMITS,
        userId: updated.id,
        safeUserId: updated.safeId
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    console.error('usage handler failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
