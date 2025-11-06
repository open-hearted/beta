// Vercel Serverless Function: api/chat.js
// - 受け取った JSON ボディ（model, messages）を OpenAI に転送します
// - API キーは Vercel の環境変数 OPENAI_API_KEY から読み込みます
// - このファイルをデプロイすると、クライアントは /api/chat を呼ぶだけで済み、
//   クライアント側に API キーを置く必要がなくなります。

// Use global fetch available in Node 18+; if not available, attempt a dynamic import fallback
let localFetch = global.fetch;
try {
  if (!localFetch) {
    // dynamic import of node-fetch for older runtimes
    // eslint-disable-next-line global-require
    const nf = require('node-fetch');
    localFetch = nf;
  }
} catch (e) {
  // ignore - we'll error later if fetch is truly unavailable
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not configured in environment' });
    return;
  }

  try {
    const body = req.body || {};

    // 基本的なバリデーション
    if (!body.model || !body.messages) {
      res.status(400).json({ error: 'Missing required fields: model, messages' });
      return;
    }

    // Ensure fetch is available
    if (!localFetch) {
      throw new Error('Fetch API is not available in this runtime');
    }

    // OpenAI の Chat Completions エンドポイントへ転送
    const openaiRes = await localFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    const text = await openaiRes.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    // If upstream failed, include more detail in our response
    if (!openaiRes.ok) {
      res.status(openaiRes.status).json({ error: 'OpenAI API error', status: openaiRes.status, body: data });
      return;
    }

    // ステータスコードをそのまま返す
    res.status(200).json(data);
  } catch (err) {
    // Include stack for debugging in non-production environments
    const payload = { error: err.message };
    if (process.env.NODE_ENV !== 'production') payload.stack = err.stack;
    res.status(500).json(payload);
  }
};
