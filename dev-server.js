// dev-server.js - simple local dev server to serve static files and mount /api handlers
// Usage: node dev-server.js
// Requires: npm install express dotenv

const path = require('path');
const express = require('express');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 8000;
const PROJECT_ROOT = path.join(__dirname);
const API_DIR = path.join(PROJECT_ROOT, 'api');

// Serve static files from project root
app.use(express.static(PROJECT_ROOT, { index: ['index.html'] }));

// Mount /api/upload WITHOUT bodyParser so formidable can parse multipart
app.all('/api/upload', (req, res) => {
  const handlerPath = path.join(API_DIR, 'upload.js');
  if (!fs.existsSync(handlerPath)) return res.status(500).json({ error: 'upload handler not found' });
  try {
    const handler = require(handlerPath);
    // Some handlers export config; we ignore that here
    return handler(req, res);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// For other API routes, parse JSON first
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Generic API mount for files in ./api
app.all('/api/:name', (req, res) => {
  const name = req.params.name;
  const handlerPath = path.join(API_DIR, name + '.js');
  if (!fs.existsSync(handlerPath)) return res.status(404).json({ error: 'not found' });
  try {
    // clear require cache so edits are reflected without restart
    delete require.cache[require.resolve(handlerPath)];
    const handler = require(handlerPath);
    return handler(req, res);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}/`);
  console.log('Serving static files from', PROJECT_ROOT);
  console.log('API handlers mounted from', API_DIR);
});
