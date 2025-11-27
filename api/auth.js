const { authenticateUser, requireAuth } = require('./_auth');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const user = await authenticateUser();
      if (!user) {
        res.status(401).json({ error: 'ユーザーIDまたはパスワードが正しくありません' });
        return;
      }
      const expiresIn = Number(process.env.AUTH_TOKEN_TTL || 86400);
      const expiresAt = Date.now() + expiresIn * 1000;
      res.status(200).json({
        ok: true,
        token: null,
        userId: user.id,
        safeUserId: user.safeId,
        expiresIn,
        expiresAt
      });
    } catch (err) {
      console.error('auth login failed', err);
      res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
    return;
  }

  if (req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    const payload = req.authPayload || {};
    res.status(200).json({
      ok: true,
      userId: user.id,
      safeUserId: user.safeId,
      expiresAt: payload.exp ? payload.exp * 1000 : undefined
    });
    return;
  }

  res.status(405).json({ error: 'Method Not Allowed' });
};
