require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const crypto     = require('crypto');
const Pusher     = require('pusher');
const path       = require('path');
const mongoose   = require('mongoose');
const compression = require('compression');
let firebaseAdmin = null;
try {
  firebaseAdmin = require('firebase-admin');
} catch (_err) {}

const Report      = require('./models/Report');
const Counter     = require('./models/Counter');
const Admin       = require('./models/Admin');
const Dispatcher  = require('./models/Dispatcher');
const AuditLog    = require('./models/AuditLog');
const Alert       = require('./models/Alert');
const DeviceToken = require('./models/DeviceToken');
const Session     = require('./models/Session');
const LoginAttempt = require('./models/LoginAttempt');

const app    = express();
const STATIC_CACHE_OPTIONS = { maxAge: '1d' };
const server = http.createServer(app);
app.use(compression());
// Basic CORS so Flutter web/other origins can call the API.
const ALLOW_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  return next();
});
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const SESSION_REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const ADMIN_REPORTS_PAGE_SIZE = 20;
const ADMIN_AUDIT_PAGE_SIZE = 20;
const COOKIE_NAME_LEGACY = 'auth_token';
const ROLE_COOKIE_NAMES = {
  admin: 'auth_token_admin',
  dispatcher: 'auth_token_dispatcher',
};
const REALTIME_CHANNEL = process.env.PUSHER_CHANNEL || 'mdrrmo-reports';
const VALID_REPORT_STATUSES = new Set(['new', 'verifying', 'dispatched', 'resolved', 'false-report']);
const VALID_EMERGENCY_TYPES = new Set(['Fire', 'Flood', 'Medical', 'Accident', 'Landslide', 'Other', 'PANIC SOS']);
const VALID_SEVERITIES = new Set(['Zion','High', 'Medium', 'Low']);
const VALID_REPORT_TAGS = [
  'people_trapped',
  'injured',
  'road_blocked',
  'power_out',
  'rising_water',
  'fire_spreading',
  'hazmat',
  'structure_damage',
  'blocked_access',
  'missing_persons',
  'medical_needed',
  'evac_needed',
  'missing_Zion',
];
const SIGNED_SESSION_PREFIX = 'v1.';
let dbInitPromise = null;
const LOGIN_ATTEMPT_LIMIT = 7;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const loginAttemptStore = new Map(); // in-memory cache (best effort; persisted via Mongo below)
const WEB_CALL_TTL_MS = 10 * 60 * 1000; // 10 minutes
// In-memory signal store for ad-hoc WebRTC calls keyed by reportId.
const webCallSignals = new Map();
mongoose.set('strictQuery', true);
const pusher = process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER
  ? new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true,
  })
  : null;
let firebaseAdminApp = undefined;

const SUPABASE_CONFIG = {
  url: String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, ''),
  anonKey: String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim(),
  bucket: String(process.env.SUPABASE_BUCKET || 'svs_photo').trim(),
};
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_ALERTS_TABLE = String(process.env.SUPABASE_ALERTS_TABLE || 'admin_alerts').trim();
const SUPABASE_DEVICE_TOKENS_TABLE = String(process.env.SUPABASE_DEVICE_TOKENS_TABLE || 'device_tokens').trim();
const MOBILE_ALERTS_BASE_URL = String(
  process.env.MOBILE_ALERTS_BASE_URL
  || process.env.MOBILE_APP_BASE_URL
  || process.env.BASE_URL
  || ''
).trim().replace(/\/+$/, '');

// ── Database connection ──────────────────────────────────────────────────────
async function initDatabase() {
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = (async () => {
    try {
      const mongoUri = String(
        process.env.MONGODB_URI
        || process.env.MONGO_URI
        || process.env.DATABASE_URL
        || ''
      ).trim();
      const mongoDb = String(
        process.env.MONGODB_DB
        || process.env.MONGO_DB
        || process.env.DB_NAME
        || extractDbNameFromMongoUri(mongoUri)
        || ''
      ).trim();
      if (!mongoUri) {
        throw new Error('Mongo URI is not configured (set MONGODB_URI or DATABASE_URL)');
      }
      const envTls = String(process.env.MONGODB_SSL || process.env.MONGO_SSL || '').toLowerCase();
      let wantTls = /^mongodb\+srv:/i.test(mongoUri) || /ssl=true/i.test(mongoUri);
      if (envTls === 'true') wantTls = true;
      if (envTls === 'false') wantTls = false;
      const connectOptions = {
        dbName: mongoDb || undefined,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        retryWrites: true,
        w: 'majority',
        ssl: wantTls,
        tlsAllowInvalidCertificates: wantTls ? false : undefined,
      };
      await mongoose.connect(mongoUri, connectOptions);
      console.log(`  ✔  MongoDB connected${mongoDb ? ` (db: ${mongoDb})` : ''}`);
      await ensureDefaultAdmin();
    } catch (err) {
      console.error('  ✘  MongoDB connection error:', err.message);
      logMongoConnectionHints(err, mongoUri);
      dbInitPromise = null;
      if (require.main === module) process.exit(1);
      throw err;
    }
  })();
  return dbInitPromise;
}
void initDatabase();

async function ensureDbReady() {
  await initDatabase();
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database is not connected');
  }
}

function extractDbNameFromMongoUri(uriRaw) {
  const uri = String(uriRaw || '').trim();
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    const rawPath = String(parsed.pathname || '').replace(/^\//, '').trim();
    if (!rawPath) return '';
    // Ignore directCollection path, keep first segment as db name.
    return rawPath.split('/')[0].trim();
  } catch (_err) {
    return '';
  }
}

function summarizeMongoTarget(uriRaw) {
  const uri = String(uriRaw || '').trim();
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    return parsed.host || '';
  } catch (_err) {
    return '';
  }
}

function logMongoConnectionHints(err, mongoUri) {
  const message = String(err?.message || '');
  const target = summarizeMongoTarget(mongoUri);
  const hints = [];

  if (/Could not connect to any servers|Server selection timed out/i.test(message)) {
    hints.push('Verify the Atlas cluster is running and reachable from this network.');
  }
  if (/whitelist|access list|IP that isn\'t whitelisted/i.test(message)) {
    hints.push('Add your current public IP to Atlas Network Access, or temporarily allow 0.0.0.0/0 for testing.');
  }
  if (/auth|Authentication failed|bad auth/i.test(message)) {
    hints.push('Recheck the Atlas database username, password, and special-character escaping in MONGODB_URI.');
  }
  if (/ENOTFOUND|EREFUSED|ECONNRESET|ETIMEDOUT|querySrv/i.test(message)) {
    hints.push('Check local DNS, firewall, proxy, or VPN settings. Atlas SRV lookups must be allowed from this machine.');
  }
  if (/certificate|TLS|SSL/i.test(message)) {
    hints.push('Confirm TLS inspection or antivirus is not blocking Atlas certificates.');
  }

  if (!hints.length) {
    hints.push('Check Atlas Network Access, cluster status, database user credentials, and DNS reachability.');
  }

  if (target) {
    console.error(`    target: ${target}`);
  }
  hints.forEach((hint) => console.error(`    hint: ${hint}`));
}

function normalizeBaseUrl(input) {
  return String(input || '').trim().replace(/\/+$/, '');
}

function looksLocalBaseUrl(input) {
  const value = normalizeBaseUrl(input).toLowerCase();
  return (
    value.includes('://localhost') ||
    value.includes('://127.0.0.1') ||
    value.includes('://0.0.0.0') ||
    value.includes('://10.0.2.2')
  );
}

function getSupabaseApiKey(preferServiceRole = false) {
  if (preferServiceRole && SUPABASE_SERVICE_ROLE_KEY) return SUPABASE_SERVICE_ROLE_KEY;
  return SUPABASE_CONFIG.anonKey || SUPABASE_SERVICE_ROLE_KEY || '';
}

function getSupabaseRestUrl(pathWithQuery) {
  if (!SUPABASE_CONFIG.url) return '';
  const cleanPath = String(pathWithQuery || '').replace(/^\/+/, '');
  return `${SUPABASE_CONFIG.url}/rest/v1/${cleanPath}`;
}

function getSupabaseHeaders({ preferServiceRole = false, preferRepresentation = false, upsert = false } = {}) {
  const apiKey = getSupabaseApiKey(preferServiceRole);
  if (!apiKey) return null;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (preferRepresentation) {
    headers.Prefer = 'return=representation';
  }
  if (upsert) {
    headers.Prefer = headers.Prefer
      ? `${headers.Prefer},resolution=merge-duplicates`
      : 'resolution=merge-duplicates';
  }
  return headers;
}

function hasSupabaseRestAccess() {
  return Boolean(SUPABASE_CONFIG.url && getSupabaseApiKey(true));
}

async function upsertSupabaseAlert(alertPayload) {
  if (!hasSupabaseRestAccess()) {
    return {
      ok: false,
      message: 'Supabase alert sync skipped because SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.',
    };
  }

  const url = getSupabaseRestUrl(`${encodeURIComponent(SUPABASE_ALERTS_TABLE)}?on_conflict=source_id&select=id`);
  const headers = getSupabaseHeaders({
    preferServiceRole: true,
    preferRepresentation: true,
    upsert: true,
  });
  const payload = {
    source_id: String(alertPayload.id || '').trim(),
    title: String(alertPayload.title || '').trim() || 'Emergency alert',
    message: String(alertPayload.message || '').trim(),
    disaster_type: String(alertPayload.disasterType || 'General').trim(),
    severity: String(alertPayload.severity || 'High').trim(),
    active: alertPayload.active !== false,
    sent_by: String(alertPayload.sentBy || 'Admin').trim(),
    created_at: alertPayload.createdAt || new Date().toISOString(),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[supabase] alert sync failed: ${response.status} ${body}`.trim());
      return { ok: false, message: `Supabase alert sync failed (${response.status}).` };
    }
    return { ok: true, message: 'Alert synced to Supabase.' };
  } catch (err) {
    console.warn('[supabase] alert sync failed:', err && err.message ? err.message : err);
    return { ok: false, message: 'Supabase alert sync failed because the REST API is unreachable.' };
  }
}

async function syncDeviceTokenToSupabase(tokenRecord) {
  if (!hasSupabaseRestAccess()) return;
  const token = String(tokenRecord && tokenRecord.token || '').trim();
  if (!token) return;

  const url = getSupabaseRestUrl(`${encodeURIComponent(SUPABASE_DEVICE_TOKENS_TABLE)}?on_conflict=token`);
  const headers = getSupabaseHeaders({ preferServiceRole: true, upsert: true });
  const payload = {
    token,
    platform: String(tokenRecord.platform || 'unknown').trim() || 'unknown',
    device_label: String(tokenRecord.deviceLabel || '').trim(),
    is_active: tokenRecord.isActive !== false,
    last_seen_at: new Date().toISOString(),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[supabase] device token sync failed: ${response.status} ${body}`.trim());
    }
  } catch (err) {
    console.warn('[supabase] device token sync failed:', err && err.message ? err.message : err);
  }
}

async function deactivateSupabaseDeviceToken(token) {
  if (!hasSupabaseRestAccess()) return;
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return;
  const url = getSupabaseRestUrl(`${encodeURIComponent(SUPABASE_DEVICE_TOKENS_TABLE)}?token=eq.${encodeURIComponent(cleanToken)}`);
  const headers = getSupabaseHeaders({ preferServiceRole: true });
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        is_active: false,
        last_seen_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[supabase] device token deactivate failed: ${response.status} ${body}`.trim());
    }
  } catch (err) {
    console.warn('[supabase] device token deactivate failed:', err && err.message ? err.message : err);
  }
}

async function getSupabaseDeviceTokens() {
  if (!hasSupabaseRestAccess()) return [];
  const url = getSupabaseRestUrl(
    `${encodeURIComponent(SUPABASE_DEVICE_TOKENS_TABLE)}?select=token&is_active=eq.true`
  );
  const headers = getSupabaseHeaders({ preferServiceRole: true });
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[supabase] device token fetch failed: ${response.status} ${body}`.trim());
      return [];
    }
    const rows = await response.json().catch(() => []);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => String((row && row.token) || '').trim())
      .filter(Boolean);
  } catch (err) {
    console.warn('[supabase] device token fetch failed:', err && err.message ? err.message : err);
    return [];
  }
}

async function syncAlertToMobileBackend(alertPayload) {
  const targetBaseUrl = normalizeBaseUrl(MOBILE_ALERTS_BASE_URL);
  if (!targetBaseUrl) {
    return {
      ok: false,
      message: 'Mobile sync skipped because MOBILE_ALERTS_BASE_URL is not configured.',
    };
  }
  if (looksLocalBaseUrl(targetBaseUrl)) {
    return {
      ok: false,
      message: 'Mobile sync skipped because MOBILE_ALERTS_BASE_URL points to a local-only address.',
    };
  }

  try {
    const response = await fetch(`${targetBaseUrl}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: String(alertPayload.title || '').trim(),
        message: String(alertPayload.message || '').trim(),
        disasterType: String(alertPayload.disasterType || 'General').trim(),
        severity: String(alertPayload.severity || 'High').trim(),
        active: alertPayload.active !== false,
        sentBy: String(alertPayload.sentBy || 'Admin').trim(),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[alerts] mobile sync failed: ${response.status} ${body}`.trim());
      return {
        ok: false,
        message: `Mobile sync failed (${response.status}).`,
      };
    }

    console.log(`[alerts] mirrored alert to mobile backend: ${targetBaseUrl}`);
    return { ok: true, message: 'Alert published' };
  } catch (err) {
    console.warn('[alerts] mobile sync failed:', err && err.message ? err.message : err);
    return {
      ok: false,
      message: 'Mobile sync failed because the mobile backend is unreachable.',
    };
  }
}

async function recordLoginAttempt(key) {
  loginAttemptStore.set(key, [...(loginAttemptStore.get(key) || []), Date.now()]);
  try {
    await LoginAttempt.create({ key });
  } catch (_e) {}
}

async function resetLoginAttempts(key) {
  loginAttemptStore.delete(key);
  try {
    await LoginAttempt.deleteMany({ key });
  } catch (_e) {}
}

async function countRecentAttempts(key) {
  const now = Date.now();
  const recentMemory = (loginAttemptStore.get(key) || []).filter(ts => now - ts < LOGIN_ATTEMPT_WINDOW_MS);
  if (recentMemory.length) loginAttemptStore.set(key, recentMemory);
  let recentDb = 0;
  try {
    recentDb = await LoginAttempt.countDocuments({
      key,
      createdAt: { $gte: new Date(now - LOGIN_ATTEMPT_WINDOW_MS) },
    });
  } catch (_e) { recentDb = 0; }
  return Math.max(recentMemory.length, recentDb);
}

async function guardDispatcherLoginRate(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection.remoteAddress || 'unknown';
  const key = `dispatcher:${ip}`;
  const attempts = await countRecentAttempts(key);
  if (attempts >= LOGIN_ATTEMPT_LIMIT) {
    const retryMin = Math.ceil(LOGIN_ATTEMPT_WINDOW_MS / 60000);
    return res.status(429).render('dispatcher-login', { error: `Too many attempts. Please try again in about ${retryMin} minute(s).` });
  }
  res.locals.loginRateKey = key;
  next();
}

async function guardAdminLoginRate(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection.remoteAddress || 'unknown';
  const key = `admin:${ip}`;
  const attempts = await countRecentAttempts(key);
  if (attempts >= LOGIN_ATTEMPT_LIMIT) {
    const retryMin = Math.ceil(LOGIN_ATTEMPT_WINDOW_MS / 60000);
    return res.status(429).render('login', { error: `Too many attempts. Please try again in about ${retryMin} minute(s).` });
  }
  res.locals.loginRateKey = key;
  next();
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    if (String(req.path || '').startsWith('/api/')) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    return res.status(413).send('Payload too large');
  }
  if (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body')) {
    if (String(req.path || '').startsWith('/api/')) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    return res.status(400).send('Invalid request body');
  }
  return next(err);
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  next();
});
app.use(async (req, res, next) => {
  const roleOrder = preferredRolesForPath(req.path);
  const candidates = [];

  for (const role of roleOrder) {
    const token = getCookie(req, cookieNameForRole(role));
    if (token) candidates.push({ role, token, cookieName: cookieNameForRole(role) });
  }

  // Backward compatibility for older single-cookie sessions.
  const legacyToken = getCookie(req, COOKIE_NAME_LEGACY);
  if (legacyToken) candidates.push({ role: '', token: legacyToken, cookieName: COOKIE_NAME_LEGACY });

  if (!candidates.length) return next();
  try {
    for (const candidate of candidates) {
      const query = candidate.role
        ? { token: candidate.token, role: candidate.role }
        : { token: candidate.token };
      const session = await Session.findOne(query).lean();
      if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
        await Session.deleteOne({ token: candidate.token });
        clearSessionCookie(res, session && session.role ? session.role : null, candidate.cookieName, req);
        continue;
      }

      const ttlMs = Number(session.ttlMs) > 0
        ? Number(session.ttlMs)
        : (session.remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS);
      const expiresAt = new Date(Date.now() + ttlMs);
      await Session.updateOne(
        { token: candidate.token },
        { $set: { expiresAt, ttlMs, remember: !!session.remember } }
      );
      req.auth = {
        role: session.role,
        userId: session.userId,
        username: session.username,
        fullName: session.fullName,
        expiresAt: expiresAt.getTime(),
      };
      req.authToken = candidate.token;
      req.authCookieName = cookieNameForRole(session.role);
      res.locals.auth = req.auth;
      break;
    }
  } catch (err) {
    console.error('[auth] session lookup failed:', err && err.message ? err.message : err);
  }
  next();
});
app.use((req, res, next) => {
  res.locals.realtime = {
    provider: 'pusher',
    key: process.env.PUSHER_KEY || '',
    cluster: process.env.PUSHER_CLUSTER || '',
    channel: REALTIME_CHANNEL,
  };
  next();
});
app.use((req, res, next) => {
  res.locals.supaConfig = SUPABASE_CONFIG;
  next();
});
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = String(req.get('origin') || '').trim();
  if (!origin) return next();

  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch (_e) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  const requestHost = String(req.get('x-forwarded-host') || req.get('host') || '').trim();
  if (!originHost || !requestHost || originHost !== requestHost) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  return next();
});
app.use(express.static(path.join(__dirname, 'public'), STATIC_CACHE_OPTIONS));
app.use(express.static(path.join(__dirname, 'views', 'public'), STATIC_CACHE_OPTIONS));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Prevent cached protected pages from showing after logout (back button issue).
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── Pages ────────────────────────────────────────────────────────────────────
// Landing page -> SOS screen for everyone
app.get('/', (_req, res) => res.render('sos'));
// Friendly shortcut: /dispatcher -> dispatcher login
app.get('/dispatcher', (_req, res) => res.redirect('/dispatcher/login'));
// Vercel safety: if /api-prefixed page paths slip through, normalize them.
app.all('/api/dispatcher/login', (_req, res) => res.redirect(308, '/dispatcher/login'));
app.all('/api/dashboard', (_req, res) => res.redirect(308, '/dashboard'));
app.all('/api/admin', (_req, res) => res.redirect(308, '/admin'));

app.get('/login', async (req, res) => {
  // Clear any existing admin session to force fresh login
  await destroySession(req, res, 'admin');
  res.render('login', { error: '' });
});

app.post('/login', guardAdminLoginRate, async (req, res) => {
  try {
    await ensureDbReady();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      if (res.locals.loginRateKey) await recordLoginAttempt(res.locals.loginRateKey);
      return res.status(400).render('login', { error: 'Invalid login details.' });
    }
    const admin = await Admin.findOne({ username });
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      if (res.locals.loginRateKey) await recordLoginAttempt(res.locals.loginRateKey);
      return res.status(401).render('login', { error: 'Invalid admin credentials.' });
    }
    await createSession(req, res, {
      role: 'admin',
      userId: String(admin._id),
      username: admin.username,
      fullName: admin.fullName || admin.username,
    });
    if (res.locals.loginRateKey) await resetLoginAttempts(res.locals.loginRateKey);
    return res.redirect('/admin');
  } catch (err) {
    console.error('[login] admin login failed:', err && err.message ? err.message : err);
    return res.status(500).render('login', { error: 'Login failed. Please try again.' });
  }
});

app.get('/dispatcher/login', async (req, res) => {
  // Clear dispatcher session cookie to avoid auto-login on cached tokens
  await destroySession(req, res, 'dispatcher');
  res.render('dispatcher-login', { error: '' });
});

app.post('/dispatcher/login', guardDispatcherLoginRate, async (req, res) => {
  try {
    await ensureDbReady();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
      const remember = String(req.body.remember || '').toLowerCase() === 'on'
      || String(req.body.remember || '').toLowerCase() === 'true';
    if (!username || !password) {
      if (res.locals.loginRateKey) await recordLoginAttempt(res.locals.loginRateKey);
      return res.status(400).render('dispatcher-login', { error: 'Invalid login details.' });
    }

    const dispatcher = await Dispatcher.findOne({ username });
    if (!dispatcher || !dispatcher.isActive || !verifyPassword(password, dispatcher.passwordHash)) {
      if (res.locals.loginRateKey) await recordLoginAttempt(res.locals.loginRateKey);
      return res.status(401).render('dispatcher-login', { error: 'Invalid dispatcher credentials.' });
    }

    await createSession(req, res, {
      role: 'dispatcher',
      userId: String(dispatcher._id),
      username: dispatcher.username,
      fullName: dispatcher.fullName || dispatcher.username,
    }, { remember });
    if (res.locals.loginRateKey) await resetLoginAttempts(res.locals.loginRateKey);
    await logAudit({
      actorRole: 'dispatcher',
      actorId: String(dispatcher._id),
      actorName: dispatcher.fullName || dispatcher.username,
      action: 'LOGIN',
      targetType: 'AUTH',
      targetId: '-',
      details: 'Dispatcher logged in',
    });
    return res.redirect('/dashboard');
  } catch (err) {
    console.error('[login] dispatcher login failed:', err && err.message ? err.message : err);
    res.status(500).render('dispatcher-login', { error: 'Login failed. Please try again.' });
  }
});

app.get('/dispatcher/reset', (_req, res) => {
  res.render('dispatcher-reset', { error: '', success: '' });
});

app.post('/dispatcher/reset', async (req, res) => {
  try {
    await ensureDbReady();
    const username = String(req.body.username || '').trim();
    const phone = String(req.body.phone || '').trim();
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!username || !phone || !newPassword || !confirmPassword) {
      return res.status(400).render('dispatcher-reset', { error: 'All fields are required.', success: '' });
    }
    if (newPassword.length < 6) {
      return res.status(400).render('dispatcher-reset', { error: 'New password must be at least 6 characters.', success: '' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).render('dispatcher-reset', { error: 'Passwords do not match.', success: '' });
    }

    const normalizePhone = (val) => String(val || '').replace(/[\s-]/g, '');
    const dispatcher = await Dispatcher.findOne({ username, isActive: true });

    if (!dispatcher || normalizePhone(dispatcher.phone) !== normalizePhone(phone)) {
      return res.status(404).render('dispatcher-reset', { error: 'Account not found or phone does not match.', success: '' });
    }

    dispatcher.passwordHash = hashPassword(newPassword);
    await dispatcher.save();

    await Session.deleteMany({ role: 'dispatcher', userId: String(dispatcher._id) });

    await logAudit({
      actorRole: 'dispatcher',
      actorId: String(dispatcher._id),
      actorName: dispatcher.fullName || dispatcher.username,
      action: 'PASSWORD_RESET',
      targetType: 'DISPATCHER',
      targetId: String(dispatcher._id),
      details: 'Dispatcher reset password via username + phone',
    });

    res.render('dispatcher-reset', { error: '', success: 'Password updated. You can sign in with your new password.' });
  } catch (err) {
    console.error('[reset] dispatcher password reset failed:', err && err.message ? err.message : err);
    res.status(500).render('dispatcher-reset', { error: 'Could not reset password. Please try again.', success: '' });
  }
});

app.get('/admin/login', (req, res) => {
  const suffix = String(req.query.force || '') === '1' ? '?force=1' : '';
  return res.redirect(`/login${suffix}`);
});

app.post('/admin/login', async (req, res) => {
  try {
    await ensureDbReady();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).render('login', { error: 'Invalid login details.' });
    }
    const admin = await Admin.findOne({ username });
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).render('login', { error: 'Invalid admin credentials.' });
    }
    await createSession(req, res, {
      role: 'admin',
      userId: String(admin._id),
      username: admin.username,
      fullName: admin.fullName || admin.username,
    });
    return res.redirect('/admin');
  } catch (err) {
    console.error('[login] admin/login failed:', err && err.message ? err.message : err);
    res.status(500).render('login', { error: 'Login failed. Please try again.' });
  }
});

app.post('/logout', async (req, res) => {
  await destroyAllSessions(req, res);
  res.redirect('/login');
});

async function handleAdminLogout(req, res) {
  await destroySession(req, res, 'admin');
  res.redirect('/admin/login');
}
app.post('/admin/logout', handleAdminLogout);
app.get('/admin/logout', handleAdminLogout);
app.all('/admin/logout', handleAdminLogout);

async function handleDispatcherLogout(req, res) {
  await destroySession(req, res, 'dispatcher');
  res.redirect('/dispatcher/login');
}
app.post('/dispatcher/logout', handleDispatcherLogout);
app.get('/dispatcher/logout', handleDispatcherLogout);
app.all('/dispatcher/logout', handleDispatcherLogout);

app.get('/logout', async (req, res) => {
  await destroyAllSessions(req, res);
  res.redirect('/dispatcher/login');
});

app.get('/about', (_req, res) => res.render('about'));
app.get('/sos', (_req, res) => res.render('sos'));
app.get('/faq', (_req, res) => res.render('faq'));
app.get('/report', (_req, res) => res.render('report'));

app.all('/dashboard', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
  if (req.method !== 'GET') return res.redirect(303, '/dashboard');
  try {
    const reports = await Report.find(buildReportVisibilityQuery(req.auth)).sort({ timestamp: -1 }).lean({ virtuals: true });
    const dispatcher = await Dispatcher.findById(req.auth.userId).lean();
    if (!dispatcher) return res.redirect('/logout');
    if (!dispatcher.isActive) return res.redirect('/dispatcher/logout');
    const activeDispatchers = await Dispatcher.find({ isActive: true }).sort({ fullName: 1, username: 1 }).lean();
    res.render('dashboard', {
      reports,
      currentUser: req.auth,
      activeDispatchers: activeDispatchers.map(d => ({
        id: String(d._id),
        username: d.username || '',
        fullName: d.fullName || d.username || '',
      })),
      dispatcherProfile: {
        username: dispatcher.username || '',
        fullName: dispatcher.fullName || '',
        phone: dispatcher.phone || '',
      },
    });
  } catch (err) {
    console.error('Dashboard load error:', err && err.message ? err.message : err);
    res.status(200).render('dashboard', {
      reports: [],
      currentUser: req.auth || {},
      activeDispatchers: [],
      dispatcherProfile: { username: '', fullName: '', phone: '' },
      error: 'Unable to load reports right now. Please check your connection or try again later.',
    });
  }
});

app.get('/dispatcher/profile', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
  try {
    const dispatcher = await Dispatcher.findById(req.auth.userId).lean();
    if (!dispatcher) return res.redirect('/logout');
    res.render('dispatcher-profile', { dispatcher, error: '', success: '' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load profile');
  }
});

app.post('/dispatcher/profile', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    const dispatcher = await Dispatcher.findById(req.auth.userId);
    if (!dispatcher) return res.redirect('/logout');

    if (newPassword) {
      if (!currentPassword || !verifyPassword(currentPassword, dispatcher.passwordHash)) {
        return res.status(400).render('dispatcher-profile', { dispatcher: dispatcher.toObject(), error: 'Current password is incorrect.', success: '' });
      }
      if (newPassword.length < 6) {
        return res.status(400).render('dispatcher-profile', { dispatcher: dispatcher.toObject(), error: 'New password must be at least 6 characters.', success: '' });
      }
      dispatcher.passwordHash = hashPassword(newPassword);
    }

    dispatcher.fullName = fullName;
    dispatcher.phone = phone;
    await dispatcher.save();

    if (req.authToken) {
      await Session.updateOne(
        { token: req.authToken },
        { $set: { fullName: dispatcher.fullName || dispatcher.username } }
      );
    }

    await logAudit({
      actorRole: 'dispatcher',
      actorId: String(dispatcher._id),
      actorName: dispatcher.fullName || dispatcher.username,
      action: 'PROFILE_UPDATE',
      targetType: 'DISPATCHER',
      targetId: String(dispatcher._id),
      details: 'Updated dispatcher profile',
    });

    res.render('dispatcher-profile', { dispatcher: dispatcher.toObject(), error: '', success: 'Profile updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update profile');
  }
});

app.post('/api/dispatcher/profile', requireRolesApi(['dispatcher']), async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    const dispatcher = await Dispatcher.findById(req.auth.userId);
    if (!dispatcher) return res.status(401).json({ error: 'Unauthorized' });

    if (newPassword) {
      if (!currentPassword || !verifyPassword(currentPassword, dispatcher.passwordHash)) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }
      dispatcher.passwordHash = hashPassword(newPassword);
    }

    dispatcher.fullName = fullName;
    dispatcher.phone = phone;
    await dispatcher.save();

    if (req.authToken) {
      await Session.updateOne(
        { token: req.authToken },
        { $set: { fullName: dispatcher.fullName || dispatcher.username } }
      );
    }

    await logAudit({
      actorRole: 'dispatcher',
      actorId: String(dispatcher._id),
      actorName: dispatcher.fullName || dispatcher.username,
      action: 'PROFILE_UPDATE',
      targetType: 'DISPATCHER',
      targetId: String(dispatcher._id),
      details: 'Updated dispatcher profile',
    });

    return res.json({
      success: true,
      message: 'Profile updated.',
      profile: {
        username: dispatcher.username || '',
        fullName: dispatcher.fullName || '',
        phone: dispatcher.phone || '',
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not update profile' });
  }
});

app.all('/admin', requireRolesPage(['admin'], '/login'), async (req, res) => {
  if (req.method !== 'GET') return res.redirect(303, '/admin');
  try {
    return renderAdminPage(req, res, {
      error: String(req.query.err || ''),
      success: String(req.query.ok || ''),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load admin page');
  }
});

app.get('/api/admin/live', requireRolesApi(['admin']), async (req, res) => {
  try {
    const data = await getAdminViewData(req);
    return res.json({
      reports: data.reports,
      auditLogs: data.auditLogs,
      stats: data.stats,
      reportPagination: data.reportPagination,
      auditPagination: data.auditPagination,
      reportLimit: data.reportLimit,
      auditLimit: data.auditLimit,
      from: data.from,
      to: data.to,
      tab: data.tab,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not load admin live data' });
  }
});

app.post('/admin/dispatchers', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return renderAdminPage(req, res, { error: 'Username and password are required.' }, 400);
    }
    if (password.length < 6) {
      return renderAdminPage(req, res, { error: 'Password must be at least 6 characters.' }, 400);
    }
    await Dispatcher.create({
      username,
      fullName,
      phone,
      passwordHash: hashPassword(password),
      isActive: true,
    });
    return res.redirect(adminRedirectUrl(req, { ok: 'Dispatcher created' }));
  } catch (err) {
    console.error(err);
    const msg = err && err.code === 11000 ? 'Username already exists.' : 'Could not create dispatcher.';
    return renderAdminPage(req, res, { error: msg }, 500);
  }
});

app.post('/admin/dispatchers/:id/update', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    const dispatcher = await Dispatcher.findById(req.params.id);
    if (!dispatcher) return res.redirect(adminRedirectUrl(req, { err: 'Dispatcher not found' }));

    dispatcher.username = String(req.body.username || '').trim();
    dispatcher.fullName = String(req.body.fullName || '').trim();
    dispatcher.phone = String(req.body.phone || '').trim();
    dispatcher.isActive = req.body.isActive === 'on';
    const newPassword = String(req.body.newPassword || '');
    if (newPassword) {
      if (newPassword.length < 6) return res.redirect(adminRedirectUrl(req, { err: 'Password must be at least 6 characters' }));
      dispatcher.passwordHash = hashPassword(newPassword);
    }
    await dispatcher.save();
    res.redirect(adminRedirectUrl(req, { ok: 'Dispatcher updated' }));
  } catch (err) {
    console.error(err);
    const msg = err && err.code === 11000 ? 'Username already exists.' : 'Could not update dispatcher.';
    res.redirect(adminRedirectUrl(req, { err: msg }));
  }
});

app.post('/admin/dispatchers/:id/delete', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    await Dispatcher.findByIdAndDelete(req.params.id);
    res.redirect(adminRedirectUrl(req, { ok: 'Dispatcher deleted' }));
  } catch (err) {
    console.error(err);
    res.redirect(adminRedirectUrl(req, { err: 'Could not delete dispatcher' }));
  }
});

app.post('/admin/alerts', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const message = String(req.body.message || '').trim();
    const disasterType = String(req.body.disasterType || 'General').trim() || 'General';
    const severity = String(req.body.severity || 'High').trim() || 'High';

    if (!title && !message) {
      return renderAdminPage(req, res, { error: 'Alert title or message is required.' }, 400);
    }

    const alert = await Alert.create({
      title: title || `${disasterType} alert`,
      message: message || title,
      disasterType,
      severity,
      active: req.body.active !== 'false',
      sentBy: String(req.auth.fullName || req.auth.username || 'Admin').trim(),
    });

    await logAudit({
      actorRole: 'admin',
      actorId: String(req.auth.userId || ''),
      actorName: String(req.auth.fullName || req.auth.username || 'Admin'),
      action: 'ALERT_CREATE',
      targetType: 'alert',
      targetId: String(alert._id),
      details: `${alert.disasterType} ${alert.severity} alert published`,
    });

    const realtimeAlert = formatAlertPayload(alert);
    await emitRealtime('alert-created', realtimeAlert);
    await emitRealtime('admin-alert-created', realtimeAlert);
    const supabaseResult = await upsertSupabaseAlert(realtimeAlert);
    await sendPushAlertToDevices(realtimeAlert);
    const mirrorResult = await syncAlertToMobileBackend(realtimeAlert);

    return res.redirect(adminRedirectUrl(req, {
      ok: supabaseResult.ok && mirrorResult.ok
        ? 'Alert published'
        : `Alert published locally. ${supabaseResult.ok ? '' : `${supabaseResult.message} `}${mirrorResult.ok ? '' : mirrorResult.message}`.trim(),
    }));
  } catch (err) {
    console.error(err);
    return renderAdminPage(req, res, { error: 'Could not publish alert.' }, 500);
  }
});

app.get('/api/alerts/latest', async (_req, res) => {
  try {
    await ensureDbReady();
    const latestAlert = await Alert.findOne({ active: true }).sort({ timestamp: -1 }).lean();
    return res.json({
      success: true,
      alert: latestAlert ? formatAlertPayload(latestAlert) : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Could not fetch latest alert.' });
  }
});

app.get('/api/alerts', async (_req, res) => {
  try {
    await ensureDbReady();
    const alerts = await Alert.find().sort({ timestamp: -1 }).limit(20).lean();
    return res.json({
      success: true,
      alerts: alerts.map(formatAlertPayload),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Could not fetch alerts.' });
  }
});

app.post('/api/device-tokens/register', async (req, res) => {
  try {
    await ensureDbReady();
    const token = String(req.body.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Device token is required.' });
    }
    const platform = String(req.body.platform || 'unknown').trim() || 'unknown';
    const deviceLabel = String(req.body.deviceLabel || '').trim();
    await DeviceToken.findOneAndUpdate(
      { token },
      {
        token,
        platform,
        deviceLabel,
        isActive: true,
        lastSeenAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await syncDeviceTokenToSupabase({
      token,
      platform,
      deviceLabel,
      isActive: true,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Could not register device token.' });
  }
});

app.post('/api/device-tokens/unregister', async (req, res) => {
  try {
    await ensureDbReady();
    const token = String(req.body.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Device token is required.' });
    }
    await DeviceToken.deleteOne({ token });
    await deactivateSupabaseDeviceToken(token);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Could not unregister device token.' });
  }
});

app.get('/admin/reports/export.xls', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    const { where } = buildReportDateRangeFilter(req.query.from, req.query.to);
    const reports = await Report.find(where).sort({ timestamp: -1 }).lean({ virtuals: true });
    const html = buildExcelHtml(reports);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reports-${stamp}.xls"`);
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not export Excel');
  }
});

app.get('/admin/reports/export.pdf', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    const { from, to, where } = buildReportDateRangeFilter(req.query.from, req.query.to);
    const reports = await Report.find(where).sort({ timestamp: -1 }).lean({ virtuals: true });
    const lines = [];
    lines.push('MDRRMO REPORT EXPORT');
    lines.push(`Date range: ${from || 'All'} to ${to || 'All'}`);
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    lines.push('');
    reports.forEach((r, i) => {
      const line = [
        `${i + 1}.`,
        r.reportId || String(r._id || ''),
        r.emergencyType || '',
        r.status || '',
        r.claimedByUsername || r.claimedByName || '-',
        r.assignedToUsername || r.assignedToName || '-',
        `passes:${Math.max(0, Number(r.passCount) || 0)}`,
        r.barangay || '',
        r.landmark || '',
        new Date(r.timestamp).toLocaleString(),
      ].join(' | ');
      lines.push(line.slice(0, 160));
    });
    const pdf = buildSimplePdf(lines);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="reports-${stamp}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not export PDF');
  }
});

app.post('/admin/reports/clear', requireRolesPage(['admin'], '/login'), async (req, res) => {
  try {
    const beforeCount = await Report.countDocuments({});
    await Report.deleteMany({});
    await Counter.deleteMany({});
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORTS_CLEAR_ALL',
      targetType: 'REPORT',
      targetId: '*',
      details: `Cleared ${beforeCount} reports via admin console`,
    });
    await emitRealtime('reports-cleared', {});
    return res.redirect('/admin?ok=All%20reports%20have%20been%20deleted&tab=reports');
  } catch (err) {
    console.error(err);
    return res.redirect('/admin?err=Could%20not%20delete%20all%20reports&tab=reports');
  }
});

// Simple health checks
app.get('/api/ping', (_req, res) => res.json({ ok: true, now: Date.now() }));
app.get('/api/health', async (_req, res) => {
  try {
    await ensureDbReady();
    return res.json({ ok: true, db: 'connected' });
  } catch (e) {
    return res.status(503).json({ ok: false, error: e && e.message ? e.message : 'unavailable' });
  }
});

// ── API: submit a normal report ──────────────────────────────────────────────
app.all('/api/report', (req, res, next) => {
  if (req.method === 'POST') return next();
  return res.status(405).json({ error: 'Method not allowed' });
});
app.post('/api/report', async (req, res) => {
  try {
    const clean = sanitizeNormalReportInput(req.body || {});
    const seq      = await Counter.nextSeq('report');
    const reportId = `RPT-${String(seq).padStart(4, '0')}`;

    const report = await Report.create({
      ...clean,
      reportId,
      status:      'new',
      timestamp:   new Date(),
      credibility: computeCredibility(clean),
      isPanic:     false,
    });

    const payload = ensureReportHasId(report.toJSON());
    await emitRealtime('new-report', payload);
    res.json({ success: true, id: reportId });
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : 'Could not save report';
    if (/missing required|invalid|too large|required/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'Could not save report' });
  }
});

// ── API: Panic SOS ──────────────────────────────────────────────────────────
app.all('/api/panic', (req, res, next) => {
  if (req.method === 'POST') return next();
  return res.status(405).json({ error: 'Method not allowed' });
});
app.post('/api/panic', async (req, res) => {
  try {
    const panicInput = sanitizePanicInput(req.body || {});
    const seq      = await Counter.nextSeq('panic');
    const reportId = `SOS-${String(seq).padStart(4, '0')}`;
    const gps = panicInput.gps;
    let barangay = panicInput.barangay;
    let landmark = panicInput.landmark;
    let street = panicInput.street;

    const coords = parseGpsCoords(gps);
    if (coords && (!barangay || !landmark || !street)) {
      const primary = await reverseViaNominatim(coords.lat, coords.lng);
      let fallback = { barangay: '', landmark: '', street: '' };
      if (!primary.barangay && !primary.landmark && !primary.street) {
        fallback = await reverseViaBigDataCloud(coords.lat, coords.lng);
      }
      barangay = barangay || primary.barangay || fallback.barangay || '';
      landmark = landmark || primary.landmark || fallback.landmark || '';
      street = street || primary.street || fallback.street || '';
    }

    const locationText = pickFirst([
      [street, landmark, barangay].filter(Boolean).join(', '),
      [landmark, barangay].filter(Boolean).join(', '),
      barangay,
      landmark,
      'Location unavailable',
    ]);

    const report = await Report.create({
      reportId,
      name:          'PANIC ALERT',
      contact:       panicInput.contact,
      emergencyType: 'PANIC SOS',
      severity:      'High',
      barangay:      barangay || 'Unknown location',
      landmark:      landmark || 'Location unavailable',
      street:        street,
      description:   `INSTANT PANIC ALERT - Caller needs immediate callback. Location: ${locationText}`,
      gps:           gps,
      photo:         null,
      status:        'new',
      credibility:   'high',
      isPanic:       true,
      timestamp:     new Date(),
    });

    const payload = ensureReportHasId(report.toJSON());
    await emitRealtime('new-report', payload);
    res.json({ success: true, id: reportId });
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : 'Could not save panic report';
    if (/invalid|required/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'Could not save panic report' });
  }
});

// ── API: update status ───────────────────────────────────────────────────────
app.patch('/api/report/:id/status', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const nextStatus = String(req.body.status || '').trim().toLowerCase();
    if (!VALID_REPORT_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const where = reportLookupQuery(req.params.id);
    const updates = { status: nextStatus };
    if (req.auth && req.auth.role === 'dispatcher') {
      updates.dispatcherId = String(req.auth.userId || '');
      updates.dispatcherName = String(req.auth.fullName || req.auth.username || '').trim();
    }
    const report = await Report.findOneAndUpdate(
      where,
      updates,
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORT_STATUS_UPDATE',
      targetType: 'REPORT',
      targetId: report.reportId || String(report._id),
      details: `Set status to ${report.status}`,
    });
    await emitRealtime('report-updated', {
      id: report.reportId || String(report._id),
      status: report.status,
      assignedToId: report.assignedToId || '',
      assignedToUsername: report.assignedToUsername || '',
      assignedToName: report.assignedToName || '',
      assignedAt: report.assignedAt || null,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not update report' });
  }
});

// API: update reporter details
app.patch('/api/report/:id/details', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const allowedFields = ['name', 'contact', 'emergencyType', 'severity', 'barangay', 'landmark', 'street', 'description', 'gps'];
    const updates = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = cleanInputText(req.body[field], 2000);
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'emergencyType') && updates.emergencyType) {
      updates.emergencyType = normalizeEmergencyType(updates.emergencyType);
      if (!VALID_EMERGENCY_TYPES.has(updates.emergencyType)) {
        return res.status(400).json({ error: 'Invalid emergency type' });
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'severity') && updates.severity) {
      updates.severity = normalizeSeverity(updates.severity);
      if (!VALID_SEVERITIES.has(updates.severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'gps') && updates.gps && !parseGpsCoords(updates.gps)) {
      return res.status(400).json({ error: 'Invalid GPS format' });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'contact') && updates.contact) {
      const digits = updates.contact.replace(/[\s-]/g, '');
      if (!/^(?:\+63|0)9\d{9}$/.test(digits)) {
        return res.status(400).json({ error: 'Invalid contact number' });
      }
    }

    const where = reportLookupQuery(req.params.id);
    const current = await Report.findOne(where);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const assignment = await resolveDispatcherAssignmentPatch(req, current);
    if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });

    const merged = {
      name: current.name,
      contact: current.contact,
      landmark: current.landmark,
      description: current.description,
      photo: current.photo,
      gps: current.gps,
      ...updates,
    };
    updates.credibility = computeCredibility(merged);

    const report = await Report.findOneAndUpdate(
      where,
      { ...updates, ...assignment.patch },
      { new: true }
    );
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORT_DETAILS_UPDATE',
      targetType: 'REPORT',
      targetId: report.reportId || String(report._id),
      details: `Updated fields: ${Object.keys(updates).join(', ')}`,
    });

    const payload = report.toJSON();
    payload.id = payload.id || payload.reportId || String(report._id || '');
    await emitRealtime('report-details-updated', payload);
    res.json({ success: true, report: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update report details' });
  }
});

// WebRTC signaling for browser-to-browser calls between dispatchers.
app.get('/api/call/:id/signal', requireRolesApi(['dispatcher', 'admin']), (req, res) => {
  const slot = getWebCallSlot(req.params.id);
  if (!slot) return res.json({});
  return res.json({
    offer: slot.offer,
    answer: slot.answer,
    offerCandidates: slot.offerCandidates,
    answerCandidates: slot.answerCandidates,
    updatedAt: slot.updatedAt,
  });
});

app.post('/api/call/:id/offer', requireRolesApi(['dispatcher', 'admin']), (req, res) => {
  const sdp = req.body && req.body.sdp;
  const type = req.body && req.body.type;
  if (!sdp) return res.status(400).json({ error: 'Missing offer SDP' });
  const slot = touchWebCallSlot(req.params.id);
  slot.offer = {
    sdp,
    type: type || 'offer',
    fromId: String(req.auth.userId || ''),
    fromName: String(req.auth.fullName || req.auth.username || 'Dispatcher'),
  };
  slot.answer = slot.answer || null;
  slot.offerCandidates = [];
  slot.answerCandidates = [];
  return res.json({ success: true });
});

app.post('/api/call/:id/answer', requireRolesApi(['dispatcher', 'admin']), (req, res) => {
  const sdp = req.body && req.body.sdp;
  const type = req.body && req.body.type;
  if (!sdp) return res.status(400).json({ error: 'Missing answer SDP' });
  const slot = touchWebCallSlot(req.params.id);
  slot.answer = {
    sdp,
    type: type || 'answer',
    fromId: String(req.auth.userId || ''),
    fromName: String(req.auth.fullName || req.auth.username || 'Dispatcher'),
  };
  slot.answerCandidates = slot.answerCandidates || [];
  return res.json({ success: true });
});

app.post('/api/call/:id/candidate', requireRolesApi(['dispatcher', 'admin']), (req, res) => {
  const role = req.body && req.body.role === 'answer' ? 'answer' : 'offer';
  const candidate = req.body && req.body.candidate;
  if (!candidate || typeof candidate !== 'object' || !candidate.candidate) {
    return res.status(400).json({ error: 'Invalid ICE candidate' });
  }
  const slot = touchWebCallSlot(req.params.id);
  const listKey = role === 'answer' ? 'answerCandidates' : 'offerCandidates';
  if (!Array.isArray(slot[listKey])) slot[listKey] = [];
  slot[listKey].push(candidate);
  return res.json({ success: true });
});

app.delete('/api/call/:id', requireRolesApi(['dispatcher', 'admin']), (_req, res) => {
  clearWebCallSlot(_req.params.id);
  return res.json({ success: true });
});
// ── API: delete all reports ──────────────────────────────────────────────────
app.delete('/api/reports', requireRolesApi(['dispatcher', 'admin']), async (_req, res) => {
  try {
    const beforeCount = await Report.countDocuments({});
    await Report.deleteMany({});
    await Counter.deleteMany({});   // reset RPT/SOS counters to 0
    await logAudit({
      actorRole: _req.auth.role,
      actorId: _req.auth.userId,
      actorName: _req.auth.fullName || _req.auth.username || '',
      action: 'REPORTS_CLEAR_ALL',
      targetType: 'REPORT',
      targetId: '*',
      details: `Cleared ${beforeCount} reports`,
    });
    await emitRealtime('reports-cleared', {});
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not clear reports' });
  }
});

// ── API: list all reports (JSON) ─────────────────────────────────────────────
app.get('/api/reports', requireRolesApi(['dispatcher', 'admin']), async (_req, res) => {
  try {
    const query = buildReportVisibilityQuery(_req.auth);
    const reports = await Report.find(query).sort({ timestamp: -1 }).lean({ virtuals: true });
    // Ensure every report has an id field
    const reportsWithId = reports.map(ensureReportHasId);
    res.json(reportsWithId);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

app.get('/api/dispatchers/active', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const dispatchers = await Dispatcher.find({ isActive: true }).sort({ fullName: 1, username: 1 }).lean();
    const payload = dispatchers.map(d => ({
      id: String(d._id),
      username: d.username || '',
      fullName: d.fullName || d.username || '',
      isSelf: String(d._id) === String(req.auth.userId || ''),
    }));
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch active dispatchers' });
  }
});

app.post('/api/report/:id/claim', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const where = reportLookupQuery(req.params.id);
    const current = await Report.findOne(where);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const existingOwner = String(current.assignedToId || '').trim();
    const requesterId = String(req.auth.userId || '').trim();
    if (existingOwner && existingOwner !== requesterId) {
      return res.status(409).json({ error: 'This report was already claimed by another dispatcher' });
    }

    const assignment = await resolveDispatcherAssignmentPatch(req, current, { requireClaimWhenUnassigned: true });
    if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });

    const claimWhere = req.auth.role === 'dispatcher'
      ? {
        $and: [
          where,
          {
            $or: [
              { assignedToId: { $exists: false } },
              { assignedToId: null },
              { assignedToId: '' },
              { assignedToId: String(req.auth.userId || '') },
            ],
          },
        ],
      }
      : where;
    const report = await Report.findOneAndUpdate(claimWhere, { ...assignment.patch }, { new: true });
    if (!report) return res.status(409).json({ error: 'This report was already claimed by another dispatcher' });
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORT_CLAIM',
      targetType: 'REPORT',
      targetId: report.reportId || String(report._id),
      details: `Claimed report by ${report.assignedToName || req.auth.username}`,
    });
    const payload = report.toJSON();
    payload.id = payload.id || payload.reportId || String(report._id || '');
    await emitRealtime('report-assignment-updated', payload);
    return res.json({ success: true, report: payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not claim report' });
  }
});

app.post('/api/report/:id/pass', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const targetDispatcherId = String(req.body.targetDispatcherId || '').trim();
    if (!targetDispatcherId || !mongoose.Types.ObjectId.isValid(targetDispatcherId)) {
      return res.status(400).json({ error: 'Invalid target dispatcher' });
    }
    const target = await Dispatcher.findOne({ _id: targetDispatcherId, isActive: true }).lean();
    if (!target) return res.status(404).json({ error: 'Target dispatcher not active' });

    const where = reportLookupQuery(req.params.id);
    const current = await Report.findOne(where);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const isClosed = ['resolved', 'false-report'].includes(String(current.status || '').toLowerCase());
    if (isClosed) return res.status(400).json({ error: 'Closed reports cannot be passed' });

    const assignment = await resolveDispatcherAssignmentPatch(req, current, { requireClaimWhenUnassigned: false });
    if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });
    if (String(current.assignedToId || '').trim() === String(target._id)) {
      return res.status(400).json({ error: 'Report is already assigned to that dispatcher' });
    }

    const nextAssignedName = String(target.fullName || target.username || '').trim();
    const actorName = String(req.auth.fullName || req.auth.username || '').trim();
    const actorUsername = String(req.auth.username || '').trim();
    const nextPassCount = Math.max(0, Number(current.passCount) || 0) + 1;
    const assignedToIdStr = String(target._id || '').trim();
    
    const report = await Report.findOneAndUpdate(
      where,
      {
        assignedToId: assignedToIdStr,
        assignedToUsername: String(target.username || '').trim(),
        assignedToName: nextAssignedName,
        assignedAt: new Date(),
        passCount: nextPassCount,
        lastPassedById: String(req.auth.userId || '').trim(),
        lastPassedByUsername: actorUsername,
        lastPassedByName: actorName,
        lastPassedAt: new Date(),
      },
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORT_PASS',
      targetType: 'REPORT',
      targetId: report.reportId || String(report._id),
      details: `Passed report to ${nextAssignedName}`,
    });
    const payload = report.toJSON();
    payload.id = payload.id || payload.reportId || String(report._id || '');
    await emitRealtime('report-assignment-updated', payload);
    return res.json({ success: true, report: payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not pass report' });
  }
});

// ── API: reverse geocode GPS to location labels ──────────────────────────────
app.get('/api/reverse-geocode', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const primary = await reverseViaNominatim(lat, lng);
    if (primary.barangay || primary.landmark || primary.street) return res.json(primary);

    const fallback = await reverseViaBigDataCloud(lat, lng);
    return res.json(fallback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reverse geocode' });
  }
});

// ── Helper: credibility score ─────────────────────────────────────────────────
function computeCredibility({ name, contact, landmark, description, photo, gps }) {
  let score = 0;
  if (name        && name.trim().split(' ').length >= 2) score += 25;
  if (contact     && contact.length >= 11)               score += 20;
  if (landmark    && landmark.length > 5)                score += 20;
  if (description && description.length > 30)            score += 20;
  if (photo)                                             score += 10;
  if (gps)                                               score +=  5;
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function pickFirst(parts) {
  for (const p of parts) {
    if (p && String(p).trim()) return String(p).trim();
  }
  return '';
}

function extractBarangayFromText(text) {
  const s = String(text || '');
  const m = s.match(/(?:\bbrgy\.?\b|\bbarangay\b)\s*([a-z0-9][a-z0-9\s\-]*)/i);
  if (!m || !m[1]) return '';
  return `Barangay ${m[1].trim()}`.replace(/\s+/g, ' ');
}

function normalizeBarangayLabel(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  if (/^brgy\.?/i.test(s)) return s.replace(/^brgy\.?/i, 'Barangay').replace(/\s+/g, ' ').trim();
  return s;
}

function ensureReportHasId(report) {
  if (!report || typeof report !== 'object') return report;
  return {
    ...report,
    id: report.id || report.reportId || String(report._id || '')
  };
}

function reportLookupQuery(id) {
  const raw = String(id || '').trim();
  if (!raw) return { reportId: '' };
  if (mongoose.Types.ObjectId.isValid(raw)) {
    return { $or: [{ reportId: raw }, { _id: raw }] };
  }
  return { reportId: raw };
}

function parseGpsCoords(gps) {
  const s = String(gps || '');
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

async function reverseViaNominatim(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&addressdetails=1&zoom=18`;
  try {
    const data = await httpsGetJson(url, {
      'Accept-Language': 'en',
      'User-Agent': 'Franzolutions/1.0 (Emergency Reporting App)',
    });
    const a = (data && data.address) || {};
    const barangay = normalizeBarangayLabel(
      pickFirst([
        a.barangay,
        extractBarangayFromText(data.display_name),
        extractBarangayFromText(data.name),
        a.suburb,
        a.neighbourhood,
        a.neighborhood,
        a.quarter,
        a.village,
        a.hamlet,
        a.city_district,
      ])
    );
    const landmark = pickFirst([data.name, a.amenity, a.building, a.shop, a.tourism, a.leisure, a.road, a.pedestrian, a.footway]);
    const street = pickFirst([a.road, a.pedestrian, a.footway, a.path, a.cycleway, a.neighbourhood, a.neighborhood]);
    return { barangay, landmark, street };
  } catch (_e) {
    return { barangay: '', landmark: '', street: '' };
  }
}

async function reverseViaBigDataCloud(lat, lng) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=en`;
  try {
    const data = await httpsGetJson(url, {
      'User-Agent': 'Franzolutions/1.0 (Emergency Reporting App)',
    });
    const admins = (data.localityInfo && Array.isArray(data.localityInfo.administrative)) ? data.localityInfo.administrative : [];
    const brgy = admins.find(x => /barangay/i.test(String(x.name || '')));
    const barangay = normalizeBarangayLabel(
      pickFirst([
        brgy && brgy.name,
        extractBarangayFromText(data.locality),
        extractBarangayFromText(data.city),
        data.locality,
        data.city,
        data.principalSubdivision,
      ])
    );
    const landmark = pickFirst([data.locality, data.city, data.principalSubdivision]);
    const street = pickFirst([data.locality, data.city, data.principalSubdivision]);
    return { barangay, landmark, street };
  } catch (_e) {
    return { barangay: '', landmark: '', street: '' };
  }
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Request timeout')));
  });
}

function getCookie(req, name) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  if (!raw) return '';
  const parts = raw.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(rest.join('=') || '');
      } catch (_e) {
        return rest.join('=') || '';
      }
    }
  }
  return '';
}

async function createSession(req, res, payload, opts = {}) {
  const role = payload.role;
  const cookieName = cookieNameForRole(role);
  const currentToken = req.authToken || getCookie(req, cookieName);
  if (currentToken) await Session.deleteOne({ token: currentToken });
  const secureCookie = shouldUseSecureCookie(req);
  const token = crypto.randomBytes(24).toString('hex');
  const remember = !!opts.remember;
  const ttlMs = Number(opts.ttlMs) > 0
    ? Number(opts.ttlMs)
    : (remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS);
  await Session.create({
    token,
    role: payload.role,
    userId: payload.userId,
    username: payload.username,
    fullName: payload.fullName,
    remember,
    ttlMs,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  res.cookie(cookieName, token, {
    maxAge: ttlMs,
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie,
    path: '/',
  });

  // Clean up legacy cookie after successful role-based login.
  clearSessionCookie(res, null, COOKIE_NAME_LEGACY, req);
}

function clearSessionCookie(res, role = null, explicitCookieName = '', req = null) {
  const cookieName = explicitCookieName || (role ? cookieNameForRole(role) : COOKIE_NAME_LEGACY);
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookie(req),
    path: '/',
  });
}

async function destroySession(req, res, role = '') {
  const effectiveRole = role || (req.auth && req.auth.role) || '';
  const cookieName = effectiveRole ? cookieNameForRole(effectiveRole) : (req.authCookieName || COOKIE_NAME_LEGACY);
  const token = role ? getCookie(req, cookieName) : (req.authToken || getCookie(req, cookieName));
  if (token) await Session.deleteOne({ token });
  if (effectiveRole) {
    clearSessionCookie(res, effectiveRole, '', req);
  } else {
    clearSessionCookie(res, null, cookieName, req);
    clearSessionCookie(res, null, COOKIE_NAME_LEGACY, req);
  }
}

async function destroyAllSessions(req, res) {
  for (const role of Object.keys(ROLE_COOKIE_NAMES)) {
    const cookieName = cookieNameForRole(role);
    const token = getCookie(req, cookieName);
    if (token) await Session.deleteOne({ token });
    clearSessionCookie(res, role, '', req);
  }
  const legacyToken = getCookie(req, COOKIE_NAME_LEGACY);
  if (legacyToken) await Session.deleteOne({ token: legacyToken });
  clearSessionCookie(res, null, COOKIE_NAME_LEGACY, req);
}

function cookieNameForRole(role) {
  return ROLE_COOKIE_NAMES[role] || COOKIE_NAME_LEGACY;
}

function preferredRolesForPath(pathname) {
  const p = String(pathname || '');
  if (p === '/admin' || p.startsWith('/admin/')) return ['admin'];
  if (p === '/dashboard' || p === '/dispatcher' || p.startsWith('/dispatcher/')) return ['dispatcher'];
  if (p.startsWith('/api/')) return ['dispatcher', 'admin'];
  return ['admin', 'dispatcher'];
}

function shouldUseSecureCookie(req) {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  const forcedSecure = String(process.env.COOKIE_SECURE || '').toLowerCase();
  if (forcedSecure === 'true' || forcedSecure === '1') return true;
  if (forcedSecure === 'false' || forcedSecure === '0') return false;
  if (req && req.secure) return true;
  const xfProto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase();
  if (xfProto.includes('https')) return true;
  return nodeEnv === 'production';
}

function getSessionSecret() {
  const explicit = String(process.env.SESSION_SECRET || '').trim();
  if (explicit) return explicit;
  const fallback = `${process.env.MONGODB_URI || ''}|${process.env.ADMIN_PASSWORD || ''}|svs-session`;
  return crypto.createHash('sha256').update(fallback).digest('hex');
}

function createSignedSessionToken(payload) {
  try {
    const data = {
      role: String(payload.role || ''),
      userId: String(payload.userId || ''),
      username: String(payload.username || ''),
      fullName: String(payload.fullName || ''),
      expiresAt: Number(payload.expiresAt) || (Date.now() + SESSION_TTL_MS),
    };
    const body = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
    return `${SIGNED_SESSION_PREFIX}${body}.${sig}`;
  } catch (_err) {
    return '';
  }
}

function verifySignedSessionToken(token) {
  const raw = String(token || '').trim();
  if (!raw || !raw.startsWith(SIGNED_SESSION_PREFIX)) return null;
  const bodyAndSig = raw.slice(SIGNED_SESSION_PREFIX.length);
  const dot = bodyAndSig.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = bodyAndSig.slice(0, dot);
  const sig = bodyAndSig.slice(dot + 1);
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  if (sig !== expected) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const expiresAt = Number(parsed.expiresAt) || 0;
    if (!expiresAt || expiresAt < Date.now()) return null;
    const role = String(parsed.role || '').trim();
    const userId = String(parsed.userId || '').trim();
    if (!role || !userId) return null;
    return {
      role,
      userId,
      username: String(parsed.username || ''),
      fullName: String(parsed.fullName || ''),
      expiresAt,
    };
  } catch (_err) {
    return null;
  }
}

function requireRolesPage(roles, loginPath = '/dispatcher/login') {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.redirect(loginPath);
    next();
  };
}

function requireRolesApi(roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function cleanupStaleWebCalls() {
  const now = Date.now();
  for (const [key, entry] of webCallSignals.entries()) {
    if (!entry || entry.expiresAt < now) webCallSignals.delete(key);
  }
}
setInterval(cleanupStaleWebCalls, 60 * 1000).unref();

function touchWebCallSlot(reportId) {
  const id = String(reportId || '').trim();
  if (!id) return null;
  const now = Date.now();
  const slot = webCallSignals.get(id) || {
    offer: null,
    answer: null,
    offerCandidates: [],
    answerCandidates: [],
    updatedAt: now,
    expiresAt: now + WEB_CALL_TTL_MS,
  };
  slot.updatedAt = now;
  slot.expiresAt = now + WEB_CALL_TTL_MS;
  webCallSignals.set(id, slot);
  return slot;
}

function getWebCallSlot(reportId) {
  const id = String(reportId || '').trim();
  if (!id) return null;
  const slot = webCallSignals.get(id);
  if (!slot) return null;
  if (slot.expiresAt < Date.now()) {
    webCallSignals.delete(id);
    return null;
  }
  return slot;
}

function clearWebCallSlot(reportId) {
  const id = String(reportId || '').trim();
  if (id) webCallSignals.delete(id);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, oldHash] = String(stored || '').split(':');
  if (!salt || !oldHash) return false;
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(oldHash, 'hex'));
  } catch (_e) {
    return false;
  }
}

async function ensureDefaultAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim();
  const password = String(process.env.ADMIN_PASSWORD || 'admin123');
  const fullName = String(process.env.ADMIN_FULLNAME || 'System Administrator').trim();
  const adminCount = await Admin.countDocuments({});

  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const usingFallbackUsername = !String(process.env.ADMIN_USERNAME || '').trim() || username === 'admin';
  const usingFallbackPassword = !String(process.env.ADMIN_PASSWORD || '').trim() || password === 'admin123';
  if (adminCount === 0 && isProduction && (usingFallbackUsername || usingFallbackPassword || password.length < 10)) {
    throw new Error('Production bootstrap requires explicit ADMIN_USERNAME and strong ADMIN_PASSWORD (10+ chars).');
  }

  if (adminCount === 0) {
    await Admin.create({ username, fullName, passwordHash: hashPassword(password) });
    console.log(`  ✔  Default admin created (${username})`);
  }

  const secondaryAdmin = await Admin.findOne({ username: 'admin1' }).lean();
  if (!secondaryAdmin) {
    await Admin.create({
      username: 'admin1',
      fullName: 'Admin One',
      passwordHash: hashPassword('123456'),
    });
    console.log('  ✔  Secondary admin created (admin1)');
  }
}

function buildReportDateRangeFilter(fromRaw, toRaw) {
  const from = String(fromRaw || '').trim();
  const to = String(toRaw || '').trim();
  const where = {};
  const ts = {};

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const d = new Date(`${from}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) ts.$gte = d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const d = new Date(`${to}T23:59:59.999Z`);
    if (!Number.isNaN(d.getTime())) ts.$lte = d;
  }
  if (Object.keys(ts).length) where.timestamp = ts;
  return { from, to, where };
}

function parsePage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function parsePerPage(value, fallback = 20) {
  const allowed = [10, 20, 40, 80, 100, 200];
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (!allowed.includes(v)) return fallback;
  return v;
}

function buildPagerMeta(page, limit, total) {
  const totalCount = Number(total) > 0 ? Number(total) : 0;
  const safeLimit = Number(limit) > 0 ? Number(limit) : 20;
  const totalPages = Math.max(1, Math.ceil(totalCount / safeLimit));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const skip = (currentPage - 1) * safeLimit;
  return {
    totalCount,
    totalPages,
    currentPage,
    limit: safeLimit,
    skip,
  };
}

function buildPagerView(baseQuery, tab, pageKey, meta) {
  const q = { ...(baseQuery || {}) };
  const makeUrl = (n) => {
    const params = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => {
      if (v == null || v === '') return;
      params.set(k, String(v));
    });
    params.set(pageKey, String(n));
    params.set('tab', tab);
    return `/admin?${params.toString()}`;
  };
  return {
    tab,
    pageKey,
    currentPage: meta.currentPage,
    totalPages: meta.totalPages,
    totalCount: meta.totalCount,
    limit: meta.limit,
    hasPrev: meta.currentPage > 1,
    hasNext: meta.currentPage < meta.totalPages,
    prevUrl: makeUrl(Math.max(1, meta.currentPage - 1)),
    nextUrl: makeUrl(Math.min(meta.totalPages, meta.currentPage + 1)),
    pages: Array.from({ length: meta.totalPages }, (_x, i) => {
      const n = i + 1;
      return { n, isCurrent: n === meta.currentPage, url: makeUrl(n) };
    }),
  };
}

function buildReportVisibilityQuery(auth) {
  if (!auth) return { _id: null };
  if (auth.role === 'admin') return {};
  const userId = String(auth.userId || '').trim();
  // Dispatchers can see unassigned reports and reports assigned to them
  // Use explicit string comparison to handle both ObjectId and string formats
  return {
    $or: [
      { assignedToId: { $exists: false } },
      { assignedToId: null },
      { assignedToId: '' },
      { assignedToId: userId },
    ],
  };
}

async function resolveDispatcherAssignmentPatch(req, currentReport, opts = {}) {
  if (!req || !req.auth || req.auth.role !== 'dispatcher') {
    return { ok: true, patch: {} };
  }

  const dispatcher = await Dispatcher.findOne({ _id: req.auth.userId, isActive: true }).lean();
  if (!dispatcher) {
    return { ok: false, status: 403, error: 'Dispatcher account is inactive' };
  }

  const me = String(req.auth.userId || '').trim();
  const assignedTo = String((currentReport && currentReport.assignedToId) || '').trim();
  if (assignedTo && assignedTo !== me) {
    return { ok: false, status: 403, error: 'This report is assigned to another dispatcher' };
  }

  const shouldClaim = !assignedTo && (opts.requireClaimWhenUnassigned !== false);
  if (!shouldClaim) return { ok: true, patch: {} };
  const claimedById = String((currentReport && currentReport.claimedById) || '').trim();
  const claimedByUsername = String((dispatcher && dispatcher.username) || '').trim();
  const claimedByName = String(dispatcher.fullName || dispatcher.username || '').trim();
  return {
    ok: true,
    patch: {
      claimedById: claimedById || me,
      claimedByUsername: claimedById ? String((currentReport && currentReport.claimedByUsername) || '').trim() : claimedByUsername,
      claimedByName: claimedById ? String((currentReport && currentReport.claimedByName) || '').trim() : claimedByName,
      claimedAt: claimedById ? (currentReport && currentReport.claimedAt) || new Date() : new Date(),
      assignedToId: me,
      assignedToUsername: claimedByUsername,
      assignedToName: claimedByName,
      assignedAt: new Date(),
    },
  };
}

function cleanInputText(value, maxLen = 180) {
  const collapsed = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLen <= 0) return '';
  return collapsed.slice(0, maxLen);
}

function normalizeEmergencyType(value) {
  const raw = cleanInputText(value, 30);
  const map = {
    fire: 'Fire',
    flood: 'Flood',
    medical: 'Medical',
    accident: 'Accident',
    landslide: 'Landslide',
    other: 'Other',
    'panic sos': 'PANIC SOS',
  };
  return map[raw.toLowerCase()] || raw;
}

function normalizeSeverity(value) {
  const raw = cleanInputText(value, 10).toLowerCase();
  if (raw === 'high') return 'High';
  if (raw === 'medium') return 'Medium';
  if (raw === 'low') return 'Low';
  return cleanInputText(value, 10);
}

function sanitizeDataImage(photoRaw) {
  const photo = String(photoRaw || '').trim();
  if (!photo) return '';
  const isDataUri = /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(photo);
  if (isDataUri) {
    if (photo.length > 15 * 1024 * 1024) {
      throw new Error('Photo is too large');
    }
    return photo;
  }
  try {
    const u = new URL(photo);
    if (!/^https?:$/i.test(u.protocol)) throw new Error('Invalid photo URL');
    // Allow supabase/public object urls only to avoid arbitrary fetches
    if (!/supabase\.co\/storage\/v1\/object/i.test(u.href)) {
      throw new Error('Photo URL must be a Supabase storage link');
    }
    if (photo.length > 2048) throw new Error('Photo URL too long');
    return photo;
  } catch (e) {
    throw new Error('Invalid photo format');
  }
}

function sanitizePhotoList(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const clean = [];
  for (const item of list) {
    if (clean.length >= 10) break;
    const normalized = sanitizeDataImage(item);
    if (normalized) clean.push(normalized);
  }
  return clean;
}

function sanitizeNormalReportInput(body) {
  const clean = {
    name: cleanInputText(body.name, 120),
    contact: cleanInputText(body.contact, 32),
    emergencyType: normalizeEmergencyType(body.emergencyType),
    severity: normalizeSeverity(body.severity),
    barangay: cleanInputText(body.barangay, 120),
    landmark: cleanInputText(body.landmark, 180),
    street: cleanInputText(body.street, 180),
    description: cleanInputText(body.description, 1200),
    gps: cleanInputText(body.gps, 64),
    photos: sanitizePhotoList(body.photos || body.photo),
    photo: '', // filled below for compatibility
    tags: Array.isArray(body.tags)
      ? Array.from(new Set(body.tags.map(t => String(t || '').trim().toLowerCase()))).filter(t => VALID_REPORT_TAGS.includes(t)).slice(0, 6)
      : [],
  };
  clean.photo = clean.photos[0] || sanitizeDataImage(body.photo);

  if (!clean.name || !clean.contact || !clean.emergencyType || !clean.severity || !clean.barangay || !clean.landmark || !clean.street) {
    throw new Error('Missing required report fields');
  }
  if (!VALID_EMERGENCY_TYPES.has(clean.emergencyType)) {
    throw new Error('Invalid emergency type');
  }
  if (!VALID_SEVERITIES.has(clean.severity)) {
    throw new Error('Invalid severity');
  }
  if (!/^(?:\+63|0)9\d{9}$/.test(clean.contact.replace(/[\s-]/g, ''))) {
    throw new Error('Invalid contact number');
  }
  if (!parseGpsCoords(clean.gps)) {
    throw new Error('Invalid GPS coordinates');
  }
  return clean;
}

function sanitizePanicInput(body) {
  const clean = {
    contact: cleanInputText(body.contact, 32),
    gps: cleanInputText(body.gps, 64),
    barangay: cleanInputText(body.barangay, 120),
    landmark: cleanInputText(body.landmark, 180),
    street: cleanInputText(body.street, 180),
  };
  if (!clean.contact) {
    throw new Error('Contact number is required');
  }
  if (!/^(?:\+63|0)9\d{9}$/.test(clean.contact.replace(/[\s-]/g, ''))) {
    throw new Error('Invalid contact number');
  }
  if (clean.gps && clean.gps.toLowerCase() !== 'unavailable' && !parseGpsCoords(clean.gps)) {
    throw new Error('Invalid GPS coordinates');
  }
  if (clean.gps.toLowerCase() === 'unavailable') clean.gps = '';
  return clean;
}

async function renderAdminPage(req, res, options = {}, statusCode = 200) {
  const data = await getAdminViewData(req);
  return res.status(statusCode).render('admin', {
    dispatchers: data.dispatchers,
    reports: data.reports,
    auditLogs: data.auditLogs,
    stats: data.stats,
    reportPagination: data.reportPagination,
    auditPagination: data.auditPagination,
    reportPager: {
      currentPage: data.reportPagination.page,
      totalPages: data.reportPagination.totalPages,
      totalCount: data.reportPagination.totalCount,
      hasPrev: data.reportPagination.hasPrev,
      hasNext: data.reportPagination.hasNext,
    },
    auditPager: {
      currentPage: data.auditPagination.page,
      totalPages: data.auditPagination.totalPages,
      totalCount: data.auditPagination.totalCount,
      hasPrev: data.auditPagination.hasPrev,
      hasNext: data.auditPagination.hasNext,
    },
    reportLimit: data.reportLimit,
    auditLimit: data.auditLimit,
    from: data.from,
    to: data.to,
    tab: data.tab,
    latestAlert: data.latestAlert,
    currentUser: req.auth,
    error: options.error || '',
    success: options.success || '',
  });
}

async function getAdminViewData(req) {
  const source = {
    ...(req.query || {}),
    ...(req.body || {}),
  };
  const { from, to, where } = buildReportDateRangeFilter(source.from, source.to);
  const reportPage = parsePositiveInt(source.reportPage, 1);
  const auditPage = parsePositiveInt(source.auditPage, 1);
  const dispatchers = await Dispatcher.find().sort({ createdAt: -1 }).lean();
  const latestAlert = await Alert.findOne({ active: true }).sort({ timestamp: -1 }).lean();
  const reportTotal = await Report.countDocuments(where);
  const reportTotalPages = Math.max(1, Math.ceil(reportTotal / ADMIN_REPORTS_PAGE_SIZE));
  const safeReportPage = Math.min(reportPage, reportTotalPages);
  const reports = await Report.find(where)
    .sort({ timestamp: -1 })
    .skip((safeReportPage - 1) * ADMIN_REPORTS_PAGE_SIZE)
    .limit(ADMIN_REPORTS_PAGE_SIZE)
    .lean({ virtuals: true });

  const auditWhere = { actorRole: 'dispatcher' };
  const auditTotal = await AuditLog.countDocuments(auditWhere);
  const auditTotalPages = Math.max(1, Math.ceil(auditTotal / ADMIN_AUDIT_PAGE_SIZE));
  const safeAuditPage = Math.min(auditPage, auditTotalPages);
  const auditLogs = await AuditLog.find(auditWhere)
    .sort({ timestamp: -1 })
    .skip((safeAuditPage - 1) * ADMIN_AUDIT_PAGE_SIZE)
    .limit(ADMIN_AUDIT_PAGE_SIZE)
    .lean();
  const reportPagination = buildPaginationMeta(safeReportPage, reportTotal, ADMIN_REPORTS_PAGE_SIZE);
  const auditPagination = buildPaginationMeta(safeAuditPage, auditTotal, ADMIN_AUDIT_PAGE_SIZE);

  return {
    dispatchers,
    reports,
    auditLogs,
    stats: {
      totalReports: reportTotal,
      activeDispatchers: dispatchers.filter(d => d.isActive).length,
      totalDispatchers: dispatchers.length,
      auditCount: auditTotal,
    },
    reportPagination,
    auditPagination,
    reportLimit: ADMIN_REPORTS_PAGE_SIZE,
    auditLimit: ADMIN_AUDIT_PAGE_SIZE,
    from,
    to,
    tab: pickAdminTab(source.tab),
    latestAlert,
  };
}

function pickAdminTab(tabRaw) {
  const tab = String(tabRaw || '').trim();
  return ['dashboard', 'reports', 'dispatchers', 'audit'].includes(tab) ? tab : 'dashboard';
}

function adminRedirectUrl(req, flash = {}) {
  const params = new URLSearchParams();
  const tab = pickAdminTab(req.body.tab || req.query.tab);
  if (tab !== 'dashboard') params.set('tab', tab);
  const reportPage = parsePositiveInt(req.body.reportPage || req.query.reportPage, 0);
  const auditPage = parsePositiveInt(req.body.auditPage || req.query.auditPage, 0);
  if (reportPage > 0) params.set('reportPage', String(reportPage));
  if (auditPage > 0) params.set('auditPage', String(auditPage));
  if (flash.ok) params.set('ok', String(flash.ok));
  if (flash.err) params.set('err', String(flash.err));
  const q = params.toString();
  return q ? `/admin?${q}` : '/admin';
}

function formatAlertPayload(alert) {
  if (!alert) return null;
  return {
    id: String(alert._id || alert.id || ''),
    title: String(alert.title || 'Emergency alert'),
    message: String(alert.message || ''),
    disasterType: String(alert.disasterType || 'General'),
    severity: String(alert.severity || 'High'),
    active: alert.active !== false,
    sentBy: String(alert.sentBy || ''),
    createdAt: alert.timestamp || alert.createdAt || null,
    updatedAt: alert.updatedAt || alert.timestamp || null,
  };
}

function getFirebaseServiceAccount() {
  const inlineJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      if (parsed && parsed.private_key) {
        parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
      }
      return parsed;
    } catch (err) {
      console.error('[push] invalid FIREBASE_SERVICE_ACCOUNT_JSON:', err && err.message ? err.message : err);
      return null;
    }
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[push] Firebase service account env vars are missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.');
    return null;
  }
  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
  };
}

function getFirebaseAdminApp() {
  if (firebaseAdminApp !== undefined) {
    return firebaseAdminApp || null;
  }
  if (!firebaseAdmin) {
    firebaseAdminApp = null;
    return null;
  }
  const serviceAccount = getFirebaseServiceAccount();
  if (!serviceAccount) {
    firebaseAdminApp = null;
    return null;
  }
  try {
    firebaseAdminApp = firebaseAdmin.apps && firebaseAdmin.apps.length
      ? firebaseAdmin.app()
      : firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
      });
    return firebaseAdminApp;
  } catch (err) {
    console.error('[push] firebase-admin init failed:', err && err.message ? err.message : err);
    firebaseAdminApp = null;
    return null;
  }
}

async function sendPushAlertToDevices(alertPayload) {
  try {
    const app = getFirebaseAdminApp();
    if (!alertPayload) return;
    if (!app) {
      console.warn('[push] Push skipped because Firebase Admin is not configured.');
      return;
    }

    const [mongoDevices, supabaseTokens] = await Promise.all([
      DeviceToken.find({ isActive: true }).select('token').lean(),
      getSupabaseDeviceTokens(),
    ]);
    const tokens = Array.from(new Set([
      ...mongoDevices.map(device => String(device.token || '').trim()),
      ...supabaseTokens.map(token => String(token || '').trim()),
    ].filter(Boolean)));
    if (!tokens.length) {
      console.warn('[push] Push skipped because there are no registered device tokens.');
      return;
    }

    const body = String(alertPayload.message || '').trim()
      || `${alertPayload.disasterType || 'General'} alert`;

    const response = await firebaseAdmin.messaging(app).sendEachForMulticast({
      tokens,
      notification: {
        title: String(alertPayload.title || 'Emergency alert'),
        body,
      },
      data: {
        kind: 'admin_alert',
        id: String(alertPayload.id || ''),
        title: String(alertPayload.title || 'Emergency alert'),
        message: body,
        disasterType: String(alertPayload.disasterType || 'General'),
        severity: String(alertPayload.severity || 'High'),
        active: String(alertPayload.active !== false),
        createdAt: String(alertPayload.createdAt || ''),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'svs_alerts',
          sound: 'default',
          priority: 'max',
          defaultVibrateTimings: true,
          visibility: 'public',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
    console.log(`[push] Alert fanout complete. success=${response.successCount} failure=${response.failureCount} tokens=${tokens.length}`);

    const invalidTokens = [];
    response.responses.forEach((result, index) => {
      if (result.success) return;
      const code = String(result.error && result.error.code || '');
      console.warn(`[push] Token send failed (${code || 'unknown-error'}) for token index ${index}.`);
      if (code.includes('registration-token-not-registered') ||
          code.includes('invalid-argument') ||
          code.includes('invalid-registration-token')) {
        invalidTokens.push(tokens[index]);
      }
    });
    if (invalidTokens.length) {
      await DeviceToken.deleteMany({ token: { $in: invalidTokens } });
      await Promise.all(invalidTokens.map((token) => deactivateSupabaseDeviceToken(token)));
      console.warn(`[push] Removed ${invalidTokens.length} invalid device token(s).`);
    }
  } catch (err) {
    console.error('[push] failed to send alert notification:', err && err.message ? err.message : err);
  }
}

function parsePositiveInt(value, fallback = 1) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildPaginationMeta(page, totalCount, pageSize) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    page: safePage,
    pageSize,
    totalCount,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildExcelHtml(reports) {
  const rows = reports.map(r => {
    return `<tr>
      <td>${escHtml(r.reportId || r._id)}</td>
      <td>${escHtml(r.emergencyType)}</td>
      <td>${escHtml(r.status)}</td>
      <td>${escHtml(r.claimedByUsername || r.claimedByName || '-')}</td>
      <td>${escHtml(r.assignedToUsername || r.assignedToName || '-')}</td>
      <td>${escHtml(String(Math.max(0, Number(r.passCount) || 0)))}</td>
      <td>${escHtml(r.severity)}</td>
      <td>${escHtml(r.name)}</td>
      <td>${escHtml(r.contact)}</td>
      <td>${escHtml(r.barangay)}</td>
      <td>${escHtml(r.landmark)}</td>
      <td>${escHtml(r.street)}</td>
      <td>${escHtml(new Date(r.timestamp).toLocaleString())}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <table border="1">
    <thead>
      <tr><th>ID</th><th>Type</th><th>Status</th><th>Claimed By</th><th>Current Dispatcher</th><th>Pass Count</th><th>Severity</th><th>Name</th><th>Contact</th><th>Barangay</th><th>Landmark</th><th>Street</th><th>Timestamp</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`;
}

function pdfEscapeText(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildSimplePdf(lines) {
  const safeLines = (Array.isArray(lines) ? lines : []).slice(0, 500);
  const contentLines = ['BT', '/F1 10 Tf', '40 800 Td', '12 TL'];
  safeLines.forEach((line, idx) => {
    const txt = pdfEscapeText(line).slice(0, 220);
    contentLines.push(`(${txt}) Tj`);
    if (idx !== safeLines.length - 1) contentLines.push('T*');
  });
  contentLines.push('ET');
  const stream = contentLines.join('\n');
  const streamLen = Buffer.byteLength(stream, 'utf8');

  const objs = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objs.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  objs.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objs.push(`5 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}\nendstream\nendobj\n`);

  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += o;
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objs.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'utf8');
}

async function emitRealtime(eventName, payload) {
  if (!pusher) return;
  try {
    await pusher.trigger(REALTIME_CHANNEL, eventName, payload);
  } catch (e) {
    console.error('[realtime] failed to publish:', e && e.message ? e.message : e);
  }
}

async function logAudit(entry) {
  try {
    if (!entry) return;
    const saved = await AuditLog.create({
      actorRole: String(entry.actorRole || ''),
      actorId: String(entry.actorId || ''),
      actorName: String(entry.actorName || ''),
      action: String(entry.action || ''),
      targetType: String(entry.targetType || ''),
      targetId: String(entry.targetId || ''),
      details: String(entry.details || ''),
      timestamp: new Date(),
    });
    await emitRealtime('audit-log-created', saved.toJSON());
  } catch (e) {
    console.error('[audit] failed to write log:', e && e.message ? e.message : e);
  }
}

function isApiRequest(req) {
  return String((req && req.path) || '').startsWith('/api/');
}

// Final 404 handler.
app.use((req, res) => {
  if (isApiRequest(req)) return res.status(404).json({ error: 'Not found' });
  return res.status(404).send('Page not found');
});

// Final Express error handler.
app.use((err, req, res, _next) => {
  const msg = err && err.message ? err.message : String(err || 'Unknown error');
  console.error('[http] unhandled error:', msg);
  if (res.headersSent) return;
  if (isApiRequest(req)) return res.status(500).json({ error: 'Internal server error' });
  return res.status(500).send('Internal server error');
});

process.on('unhandledRejection', reason => {
  const msg = reason && reason.message ? reason.message : String(reason || 'Unknown rejection');
  console.error('[process] unhandledRejection:', msg);
});

process.on('uncaughtException', err => {
  const msg = err && err.message ? err.message : String(err || 'Unknown exception');
  console.error('[process] uncaughtException:', msg);
});

// ── Realtime (Pusher) ────────────────────────────────────────────────────────

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  MDRRMO running on http://localhost:${PORT}`);
    console.log(`  Reporter        -> http://localhost:${PORT}/report`);
    console.log(`  Dispatcher      -> http://localhost:${PORT}/dispatcher/login`);
    console.log(`  Admin           -> http://localhost:${PORT}/login`);
    console.log(`  Dispatcher UI   -> http://localhost:${PORT}/dashboard`);
    console.log(`  Admin Console   -> http://localhost:${PORT}/admin\n`);
  });
}

module.exports = app;
