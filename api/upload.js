// /api/upload.js - root-level Vercel Function for S3 uploads
// Env vars required: AWS_REGION, AWS_S3_BUCKET (or BUCKET_NAME), optional AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

const formidable = require('formidable');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports.config = { api: { bodyParser: false } };

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const BUCKET = process.env.AWS_S3_BUCKET || process.env.BUCKET_NAME;

const s3 = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
});

async function put(key, buffer, contentType) {
  return s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType || 'audio/wav' }));
}

async function del(key) {
  return s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
async function list(prefix) {
  return s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
}
async function head(key) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); } catch { return null; }
}

function sanitizePrefix(p) {
  if (!p) p = 'uploads/';
  // strip protocol if accidentally included
  p = p.replace(/^https?:\/\//i,'');
  // collapse multiple slashes
  p = p.replace(/\/+/, '/');
  // ensure trailing slash removed then re-added for normalization
  if (p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
  if (!p.endsWith('/')) p += '/';
  // replace disallowed chars
  p = p.replace(/[^A-Za-z0-9._\-/]/g,'_');
  // length guard
  const MAX = 150;
  if (p.length > MAX) {
    const h = crypto.createHash('sha1').update(p).digest('hex').slice(0,8);
    // keep first 110 chars (avoid cutting mid path segment abruptly)
    p = p.slice(0,110).replace(/[^A-Za-z0-9._\-/]/g,'_');
    if (!p.endsWith('/')) p += '/';
    p += '_' + h + '/';
  }
  // disallow starting slash to keep S3 console tidy
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}

module.exports = async (req, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'Missing S3 bucket env (AWS_S3_BUCKET or BUCKET_NAME)' });

  if (req.method === 'GET') {
    let requestedPrefix = (req.query && req.query.prefix) ? String(req.query.prefix) : null;
    const prefix = sanitizePrefix(requestedPrefix);
    const singleKey = req.query && req.query.key ? String(req.query.key) : null;
    try {
      if (singleKey) {
        if (!singleKey.startsWith(prefix)) return res.status(403).json({ error: 'key not under prefix' });
        const presigned = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: singleKey }), { expiresIn: 600 });
        return res.status(200).json({ key: singleKey, presignedUrl: presigned, prefixUsed: prefix });
      }
      const out = await list(prefix);
      const contents = out.Contents || [];
      const items = [];
      for (const o of contents) {
        if (!o.Key || !/\.wav$/i.test(o.Key)) continue;
        let presignedUrl = null;
        try {
          presignedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: o.Key }), { expiresIn: 600 });
        } catch {}
        items.push({
          key: o.Key,
            size: o.Size,
            lastModified: o.LastModified,
            url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/` + o.Key.split('/').map(encodeURIComponent).join('/'),
            presignedUrl
        });
      }
      return res.status(200).json({ items, prefixUsed: prefix, expiresIn: 600 });
    } catch(e){
      return res.status(500).json({ error: 'List failed', detail: e.message });
    }
  }

  if (req.method === 'DELETE') {
    const { key, prefix: qp } = req.query;
    if (!key) return res.status(400).json({ error: 'key query required' });
    const prefix = sanitizePrefix(qp || key.split('/').slice(0,-1).join('/')+'/');
    if (!key.startsWith(prefix)) return res.status(403).json({ error: 'key not under prefix' });
    try {
      await del(key);
      return res.status(200).json({ deleted: key });
    } catch (e) {
      return res.status(500).json({ error: 'Delete failed', detail: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const form = new formidable.IncomingForm({
    uploadDir: os.tmpdir(),
    keepExtensions: true,
    maxFileSize: 50 * 1024 * 1024,
    multiples: false
  });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: 'Parse error', detail: String(err) });
    const file = files.file || Object.values(files)[0];
    if (!file) return res.status(400).json({ error: 'No file' });
    try {
      const filePath = file.filepath || file.path;
      const buf = await fs.promises.readFile(filePath);
      const originalName = file.originalFilename || file.name || 'recording.wav';
      const ext = path.extname(originalName) || '.wav';
      const rawPrefix = Array.isArray(fields.prefix)?fields.prefix[0]:fields.prefix;
      const prefix = sanitizePrefix(rawPrefix);
      const key = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
      await put(key, buf, file.mimetype || 'audio/wav');
      try { await fs.promises.unlink(filePath); } catch {}
      const safeKey = key.split('/').map(encodeURIComponent).join('/');
      const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${safeKey}`;
      let presignedUrl = null;
      try { presignedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 600 }); } catch {}
      return res.status(200).json({ message: 'ok', key, url, presignedUrl, bucket: BUCKET, prefixUsed: prefix });
    } catch (e) {
      return res.status(500).json({ error: 'Upload failed', detail: e.message });
    }
  });
};
