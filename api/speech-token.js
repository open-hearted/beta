// Vercel サーバーレス関数: Azure Speech の短期トークンを返す
// 必要な環境変数: AZURE_SPEECH_KEY, AZURE_REGION

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_REGION;
  if (!key || !region) return res.status(500).json({ error: 'Server misconfiguration' });

  try {
    const tokenRes = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key }
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      return res.status(502).json({ error: 'Failed to fetch token', detail: txt });
    }
    const accessToken = await tokenRes.text();
    // トークンは通常 10 分間有効
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token: accessToken, region });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
