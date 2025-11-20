const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const USERS_ENV = process.env.AUTH_USERS || process.env.APP_AUTH_USERS || '';
const ADMIN_USERS_ENV = process.env.ADMIN_USERS || process.env.AUTH_ADMINS || '';
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.JWT_SECRET || process.env.AUTH_JWT_SECRET;
const PASSWORD_OPTIONAL_PREFIX = 'acg2_';

let cachedUsers = null;
let cachedAdmins = null;

function sanitizeSegment(segment) {
  return String(segment || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeUserId(userId) {
  return sanitizeSegment(userId || '');
}

function isPasswordOptionalUser(userId) {
  return typeof userId === 'string' && userId.startsWith(PASSWORD_OPTIONAL_PREFIX);
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

function getUserHash(userId) {
  const safeId = sanitizeUserId(userId);
  const map = parseUsers();
  return map.get(safeId) || null;
}

function parseAdmins() {
  if (cachedAdmins) return cachedAdmins;
  const set = new Set();
  if (ADMIN_USERS_ENV) {
    ADMIN_USERS_ENV.split(/[\s,]+/)
      .map(entry => entry && entry.trim())
      .filter(Boolean)
      .forEach(entry => set.add(sanitizeUserId(entry)));
  }
  if (!set.size) {
    set.add(sanitizeUserId('admin'));
  }
  cachedAdmins = set;
  return set;
}

function isAdminUser(userId) {
  if (!userId) return false;
  const safeId = sanitizeUserId(userId);
  return parseAdmins().has(safeId);
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
  if (!isAdminUser(user.id) && !isAdminUser(user.safeId)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return user;
}

async function authenticateUser(userId, password) {
  if (!userId) return null;
  if (isPasswordOptionalUser(userId)) {
    const safeIdOptional = sanitizeUserId(userId);
    return { id: String(userId), safeId: safeIdOptional };
  }
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
  isPasswordOptionalUser,
  isAdminUser,
  sanitizeUserId,
  ensureUserScopedPrefix,
  ensureUserScopedKey,
  keyBelongsToUser
};
