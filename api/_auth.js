const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const USERS_ENV = process.env.AUTH_USERS || process.env.APP_AUTH_USERS || '';
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.JWT_SECRET || process.env.AUTH_JWT_SECRET;
const ADMINS_ENV = process.env.AUTH_ADMINS || process.env.APP_AUTH_ADMINS || process.env.ADMIN_USERS || '';

let cachedUsers = null;
let cachedAdmins = null;

function sanitizeSegment(segment) {
  return String(segment || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeUserId(userId) {
  return sanitizeSegment(userId || '');
}

function parseUsers() {
  if (cachedUsers) return cachedUsers;
  const map = new Map();
  if (!USERS_ENV) {
    cachedUsers = map;
    return map;
  }
  try {
    const parsed = JSON.parse(USERS_ENV);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry) continue;
        const id = sanitizeSegment(entry.id || entry.user || entry.userId);
        const hash = entry.passwordHash || entry.hash || entry.password;
        if (id && hash) map.set(id, String(hash));
      }
    } else if (typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        const id = sanitizeSegment(key);
        if (id && value) map.set(id, String(value));
      }
    }
  } catch (err) {
    const pairs = USERS_ENV.split(/[,;\n\r]+/);
    for (const pair of pairs) {
      if (!pair) continue;
      const idx = pair.indexOf(':');
      if (idx === -1) continue;
      const id = sanitizeSegment(pair.slice(0, idx));
      const hash = pair.slice(idx + 1).trim();
      if (id && hash) map.set(id, hash);
    }
  }
  cachedUsers = map;
  return map;
}

function parseAdmins() {
  if (cachedAdmins) return cachedAdmins;
  const set = new Set();
  if (!ADMINS_ENV) {
    cachedAdmins = set;
    return set;
  }
  try {
    const parsed = JSON.parse(ADMINS_ENV);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry) continue;
        if (typeof entry === 'string') {
          const id = sanitizeSegment(entry);
          if (id) set.add(id);
          continue;
        }
        const id = sanitizeSegment(entry.id || entry.userId || entry.user || entry.name);
        if (id) set.add(id);
      }
    } else if (typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        const idFromKey = sanitizeSegment(key);
        if (value === true || value === 'admin' || value === 1) {
          if (idFromKey) set.add(idFromKey);
          continue;
        }
        if (value && typeof value === 'object') {
          const candidate = sanitizeSegment(value.id || value.userId || value.user || value.name || key);
          if (candidate) set.add(candidate);
          continue;
        }
        if (idFromKey) set.add(idFromKey);
      }
    }
  } catch (err) {
    const items = ADMINS_ENV.split(/[,;\n\r]+/);
    for (const raw of items) {
      const id = sanitizeSegment(raw);
      if (id) set.add(id);
    }
  }
  cachedAdmins = set;
  return set;
}

function isAdminUser(userId) {
  if (!userId) return false;
  const safeId = sanitizeUserId(userId);
  if (!safeId) return false;
  const admins = parseAdmins();
  return admins.has(safeId);
}

function getUserHash(userId) {
  const safeId = sanitizeUserId(userId);
  const map = parseUsers();
  return map.get(safeId) || null;
}

async function verifyUserPassword(userId, password) {
  if (!password) return false;
  const stored = getUserHash(userId);
  if (!stored) return false;
  const candidate = String(password);
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try {
      return await bcrypt.compare(candidate, stored);
    } catch (err) {
      console.warn('bcrypt compare failed', err);
      return false;
    }
  }
  if (stored.startsWith('plain:')) {
    return stored.slice('plain:'.length) === candidate;
  }
  return stored === candidate;
}

function base64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function base64urlDecode(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
}

function signToken(userId, expiresInSeconds = 3600) {
  if (!AUTH_SECRET) {
    throw new Error('AUTH_SECRET (or JWT_SECRET) env var is not set');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(userId),
    safeSub: sanitizeUserId(userId),
    iat: now,
    exp: now + Number(expiresInSeconds || 3600)
  };
  const headerPart = base64urlEncode(header);
  const payloadPart = base64urlEncode(payload);
  const data = `${headerPart}.${payloadPart}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return { token: `${data}.${signature}`, payload };
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyToken(token) {
  if (!AUTH_SECRET) {
    throw new Error('AUTH_SECRET (or JWT_SECRET) env var is not set');
  }
  if (!token) throw new Error('Token missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const [headerB64, payloadB64, signatureB64] = parts;
  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  if (!timingSafeEqual(signatureB64, expectedSig)) throw new Error('Invalid signature');
  const payload = base64urlDecode(payloadB64);
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('Token expired');
  return payload;
}

function extractToken(req) {
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  if (req.headers && req.headers.cookie) {
    const match = req.headers.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('auth_token='));
    if (match) return decodeURIComponent(match.slice('auth_token='.length));
  }
  return null;
}

function requireAuth(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
  const payload = verifyToken(token);
  const user = { id: payload.sub, safeId: sanitizeUserId(payload.safeSub || payload.sub) };
  req.user = user;
  req.authPayload = payload;
  return user;
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (isAdminUser(user.id) || isAdminUser(user.safeId)) {
    return user;
  }
  res.status(403).json({ error: 'Forbidden' });
  return null;
}

async function authenticateUser(userId, password) {
  if (!userId) return null;
  const ok = await verifyUserPassword(userId, password);
  if (!ok) return null;
  const safeId = sanitizeUserId(userId);
  return { id: String(userId), safeId };
}

function ensureUserScopedPrefix(userId, requestedPrefix) {
  const safeId = sanitizeUserId(userId);
  const segments = String(requestedPrefix || '')
    .split('/')
    .filter(Boolean)
    .map(sanitizeSegment);
  if (!segments.length || segments[0] !== safeId) segments.unshift(safeId);
  let combined = segments.join('/');
  if (!combined.endsWith('/')) combined += '/';
  return combined;
}

function ensureUserScopedKey(userId, rawKey) {
  const safeId = sanitizeUserId(userId);
  const segments = String(rawKey || '')
    .split('/')
    .filter(Boolean)
    .map(sanitizeSegment);
  if (!segments.length || segments[0] !== safeId) segments.unshift(safeId);
  return segments.join('/');
}

function keyBelongsToUser(userId, key) {
  const safeId = sanitizeUserId(userId);
  const normalized = String(key || '').replace(/^\/+/, '');
  if (!normalized.startsWith(`${safeId}/`)) return false;
  if (normalized.includes('..')) return false;
  return true;
}

module.exports = {
  authenticateUser,
  requireAuth,
  requireAdmin,
  signToken,
  verifyToken,
  sanitizeUserId,
  ensureUserScopedPrefix,
  ensureUserScopedKey,
  keyBelongsToUser,
  isAdminUser
};
