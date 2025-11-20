'use strict';

const { requireAdmin, isAdminUser } = require('../_auth');
const quotaStore = require('../../lib/quota-store');

const LIMITS = {
  listening: Number(process.env.LISTENING_USAGE_LIMIT || 10),
  translation: Number(process.env.TRANSLATION_USAGE_LIMIT || 10),
  pronunciation: Number(process.env.PRONUNCIATION_USAGE_LIMIT || 10)
};

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

module.exports = async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      const items = await quotaStore.listUsage();
      const users = items.map(entry => ({
        id: entry.id,
        safeId: entry.safeId,
        quota: {
          listeningUsed: Number(entry.listeningUsed) || 0,
          translationUsed: Number(entry.translationUsed) || 0,
          pronunciationUsed: Number(entry.pronunciationUsed) || 0,
          resetAt: entry.resetAt || null,
          updatedAt: entry.updatedAt || null
        },
        isAdmin: isAdminUser(entry.id) || isAdminUser(entry.safeId)
      }));
      return res.status(200).json({ users, limit: LIMITS });
    }

    if (req.method === 'POST') {
      const body = parseBody(req.body);
      const userId = body.userId || body.id || body.safeId;
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }
      const result = await quotaStore.resetUsage(userId);
      return res.status(200).json({
        ok: true,
        user: {
          id: result.id,
          safeId: result.safeId,
          quota: {
            listeningUsed: Number(result.listeningUsed) || 0,
            translationUsed: Number(result.translationUsed) || 0,
            pronunciationUsed: Number(result.pronunciationUsed) || 0,
            resetAt: result.resetAt || null,
            updatedAt: result.updatedAt || null
          }
        }
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    console.error('admin quotas handler failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
