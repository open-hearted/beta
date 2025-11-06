// /api/azure-assess.js - Azure Speech Pronunciation Assessment proxy
// Env vars: AZURE_SPEECH_KEY, AZURE_REGION
// POST body: { audioUrl, referenceText?, language? }

const { requireAuth } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_REGION;
  if (!key || !region) return res.status(500).json({ error: 'Azure speech env missing' });
  try {
  const { audioUrl, referenceText = '', language = 'en-US' } = req.body || {};
  // 文字列をそのまま保持 (末尾改行等含む) 検証用に raw も返す
  const rawReferenceText = typeof referenceText === 'string' ? referenceText : String(referenceText||'');
    if (!audioUrl) return res.status(400).json({ error: 'audioUrl required' });

    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      const t = await audioResp.text();
      return res.status(502).json({ error: 'Fetch audio failed', status: audioResp.status, body: t.slice(0,200) });
    }
    const audioBuf = Buffer.from(await audioResp.arrayBuffer());

    const paConfig = {
      ReferenceText: rawReferenceText, // 変換せずそのまま
      GradingSystem: 'HundredMark',
      Dimension: 'Comprehensive',
      EnableMiscue: true,
      Granularity: 'Phoneme',       // Prosody算出細粒度
      EnableProsodyAssessment: true // Prosodyスコア有効化
    };
    const paHeader = Buffer.from(JSON.stringify(paConfig)).toString('base64');
    const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': paHeader,
        'Accept': 'application/json;text/xml'
      },
      body: audioBuf
    });
    const text = await upstream.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Azure error', detail: json });
    return res.status(200).json({
      result: json,
      referenceText: rawReferenceText,
      language,
      debug: {
        paConfig,
        paHeaderBase64: paHeader
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
