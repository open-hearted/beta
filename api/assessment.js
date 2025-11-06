// /api/assessment.js
// 評価結果を S3 にサイドカー(JSON)として保存・取得するAPI
// 必要な環境変数: AWS_S3_BUCKET, AWS_REGION, (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)

const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { Readable } = require('node:stream');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.AWS_S3_BUCKET;

// NodeのReadableを文字列へ
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// 代表スコア抽出（Azure結果の差異に耐性を持たせる）
function summarize(resultJson) {
  const nb =
    resultJson?.result?.NBest?.[0] ||
    resultJson?.result?.result?.NBest?.[0] || // 念のため別階層にも対応
    null;
  const pa = nb?.PronunciationAssessment;
  const Acc  = (pa?.AccuracyScore ?? pa?.AccScore ?? nb?.AccuracyScore ?? nb?.AccScore);
  const Flu  = (pa?.FluencyScore ?? pa?.FluScore ?? nb?.FluencyScore ?? nb?.FluScore);
  const Comp = (pa?.CompletenessScore ?? pa?.CompScore ?? nb?.CompletenessScore ?? nb?.CompScore);
  const Pron = (pa?.PronunciationScore ?? pa?.PronScore ?? nb?.PronunciationScore ?? nb?.PronScore);
  const Pros = (
    pa?.ProsodyScore ?? pa?.Prosody?.Score ?? pa?.Prosody?.ProsodyScore ??
    nb?.ProsodyScore ?? nb?.Prosody?.Score ?? nb?.Prosody?.ProsodyScore
  );
  return { Acc, Flu, Comp, Pron, Pros };
}

module.exports = async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ error: 'S3_BUCKET not set' });

    // =========================
    // GET /api/assessment?key=<wavKey>.assessment.json
    // → サイドカーJSONを1件フル取得（円グラフ＆JSONトグル復元用）
    // =========================
    if (req.method === 'GET' && req.query && req.query.key) {
      const { key } = req.query;
      if (!key) return res.status(400).json({ error: 'key is required' });

      const obj = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: String(key) })
      );
      const text = await streamToString(
        obj.Body instanceof Readable ? obj.Body : Readable.from(obj.Body)
      );
      const json = JSON.parse(text); // { savedAt, key, referenceText, result }
      return res.json({ ok: true, item: json });
    }

    // =========================
    // GET /api/assessment?prefix=<PAGE_PREFIX>
    // → prefix配下の *.assessment.json を列挙し、summary を一括返却
    // =========================
    if (req.method === 'GET' && req.query && req.query.prefix) {
      const { prefix } = req.query;
      if (!prefix) return res.status(400).json({ error: 'prefix is required' });

      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: String(prefix)
        })
      );

      const keys = (list.Contents || [])
        .map(o => o.Key)
        .filter(k => k && k.endsWith('.assessment.json'));

      const items = {};
      for (const k of keys) {
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
        const text = await streamToString(
          obj.Body instanceof Readable ? obj.Body : Readable.from(obj.Body)
        );
        const json = JSON.parse(text);
        const wavKey = k.replace(/\.assessment\.json$/, '');
        items[wavKey] = { summary: summarize(json) };
      }

      return res.json({ ok: true, items });
    }

    // =========================
    // POST /api/assessment
    // body: { key: <wavKey>, result: <Azure結果JSON>, referenceText?: string }
    // → <wavKey>.assessment.json として保存し、summary も返す
    // =========================
    if (req.method === 'POST') {
      const body = (typeof req.body === 'string') ? JSON.parse(req.body) : (req.body || {});
      const { key, result, referenceText } = body;
      if (!key || !result) return res.status(400).json({ error: 'key and result are required' });

      const sidecarKey = `${key}.assessment.json`;
      const payload = {
        savedAt: new Date().toISOString(),
        key,
        referenceText: referenceText ?? '',
        result
      };

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: sidecarKey,
        Body: Buffer.from(JSON.stringify(payload)),
        ContentType: 'application/json',
        CacheControl: 'no-cache'
      }));

      return res.json({ ok: true, key: sidecarKey, summary: summarize(result) });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
