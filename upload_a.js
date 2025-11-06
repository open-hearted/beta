const formidable = require('formidable');
const os = require('os');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');

module.exports.config = { api: { bodyParser: false } };

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const BUCKET = process.env.AWS_S3_BUCKET || process.env.BUCKET_NAME;

const s3 = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
});

async function uploadBufferToS3(buffer, key, contentType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'audio/wav',
    // Removed ACL option as it is not supported by the bucket
  });
  return s3.send(command);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  if (!BUCKET) {
    console.error('AWS_S3_BUCKET / BUCKET_NAME not configured');
    res.status(500).json({ error: 'Server not configured: missing S3 bucket env var' });
    return;
  }

  const form = new formidable.IncomingForm({
    uploadDir: os.tmpdir(),
    keepExtensions: true,
    maxFileSize: 50 * 1024 * 1024,
    multiples: false,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('form.parse error', err);
      res.status(500).json({ error: 'File parse failed', details: String(err) });
      return;
    }

    const file = files.file || Object.values(files)[0];
    if (!file) {
      console.error('No file field found in parsed files', files);
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    try {
      const filePath = file.filepath || file.path || file.file;
      console.log('Parsed upload file object keys:', Object.keys(file));
      console.log('Temporary file path:', filePath);

      const fileBuffer = await fs.promises.readFile(filePath);
      console.log('Read file buffer length:', fileBuffer.length);

      const originalName = file.originalFilename || file.name || 'recording.wav';
      const ext = path.extname(originalName) || '.wav';
      const key = `uploads/${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;

  console.log('Uploading to S3 with key:', key, 'and contentType:', file.mimetype || 'audio/wav');
          const result = await uploadBufferToS3(fileBuffer, key, file.mimetype || 'audio/wav');
          console.log('S3 upload result:', result);

          // Encode path segments but keep slashes so S3 path resolves correctly
          const safeKey = String(key).split('/').map(encodeURIComponent).join('/');
          const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${safeKey}`;

          // Also provide a presigned URL for private buckets (valid for 10 minutes)
          let presignedUrl = null;
          try {
            presignedUrl = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET, Key: key }),
              { expiresIn: 600 }
            );
          } catch (e) {
            console.warn('Failed to create presigned URL:', e);
          }
      console.log('File uploaded to S3 at url:', url);

      try { await fs.promises.unlink(filePath); } catch (e) { console.warn('Failed to unlink temp file', e); }

  res.status(200).json({ message: 'File uploaded successfully', url, presignedUrl, key, bucket: BUCKET });
    } catch (e) {
      console.error('S3 upload error', e);
      res.status(500).json({ error: 'S3 upload failed', details: String(e) });
    }
  });
};
