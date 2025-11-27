const { authenticateUser, requireAuth, signToken, isPasswordOptionalUser } = require('./_auth');

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
      const { userId, password } = parseBody(req.body);
      const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
      const passwordValue = typeof password === 'string' ? password : '';
      const needsPassword = !isPasswordOptionalUser(normalizedUserId);
      const passwordProvided = passwordValue.length > 0;
      if (!normalizedUserId || (needsPassword && !passwordProvided)) {
        res.status(400).json({ error: 'userId と password は必須です' });
        return;
      }
      const user = await authenticateUser(normalizedUserId, needsPassword ? passwordValue : '');
      if (!user) {
        res.status(401).json({ error: 'ユーザーIDまたはパスワードが正しくありません' });
        return;
      }
      const expiresIn = Number(process.env.AUTH_TOKEN_TTL || 3600);
      const { token, payload } = signToken(user.id, expiresIn);
      res.status(200).json({
        ok: true,
        token,
        userId: user.id,
        safeUserId: user.safeId,
        expiresIn,
        expiresAt: payload.exp * 1000
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
