'use strict';

const { requireAdmin, sanitizeUserId } = require('./_auth');
const {
  DEFAULT_LIMITS,
  PER_SECTION_LIMITS,
  SECTION_COUNT,
  listUsage,
  resetUsage,
  deleteUsage,
  getUsage,
  computeRemaining,
  isUsingMemoryStore
} = require('../lib/quota-store');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function formatEntry(entry) {
  const limits = {
    listening: DEFAULT_LIMITS.listening,
    translation: DEFAULT_LIMITS.translation,
    pronunciation: DEFAULT_LIMITS.pronunciation
  };
  const remaining = computeRemaining(entry, limits);
  return {
    id: entry.id,
    safeId: entry.safeId,
    listeningUsed: entry.listeningUsed,
    translationUsed: entry.translationUsed,
    pronunciationUsed: entry.pronunciationUsed,
    resetAt: entry.resetAt || null,
    updatedAt: entry.updatedAt || null,
    remaining
  };
}

module.exports = async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      const items = await listUsage();
      const formatted = items.map(formatEntry);
      return res.status(200).json({
        ok: true,
        items: formatted,
        limits: {
          listening: DEFAULT_LIMITS.listening,
          translation: DEFAULT_LIMITS.translation,
          pronunciation: DEFAULT_LIMITS.pronunciation
        },
        perSectionLimits: {
          listening: PER_SECTION_LIMITS.listening,
          translation: PER_SECTION_LIMITS.translation,
          pronunciation: PER_SECTION_LIMITS.pronunciation
        },
        sectionCount: SECTION_COUNT,
        storage: isUsingMemoryStore() ? 'memory' : 's3'
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req.body);
      const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'reset';
      const rawUserId = body.userId || body.id || body.safeId;
      const targetUserId = sanitizeUserId(rawUserId);
      if (!targetUserId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      if (action === 'reset') {
        const entry = await resetUsage(targetUserId);
        return res.status(200).json({ ok: true, item: formatEntry(entry) });
      }

      if (action === 'delete') {
        await deleteUsage(targetUserId);
        return res.status(200).json({ ok: true, deleted: true, userId: targetUserId });
      }

      if (action === 'get') {
        const entry = await getUsage(targetUserId);
        return res.status(200).json({ ok: true, item: formatEntry(entry) });
      }

      return res.status(400).json({ error: 'Unsupported action' });
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('usage-admin handler failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
