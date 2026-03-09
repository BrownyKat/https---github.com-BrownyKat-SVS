require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const crypto     = require('crypto');
const Pusher     = require('pusher');
const path       = require('path');
const mongoose   = require('mongoose');

const Report      = require('./models/Report');
const Counter     = require('./models/Counter');
const Admin       = require('./models/Admin');
const Dispatcher  = require('./models/Dispatcher');
const AuditLog    = require('./models/AuditLog');
const Session     = require('./models/Session');

const app    = express();
const server = http.createServer(app);
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
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
const VALID_SEVERITIES = new Set(['High', 'Medium', 'Low']);
const SIGNED_SESSION_PREFIX = 'v1.';
let dbInitPromise = null;
const pusher = process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER
  ? new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true,
  })
  : null;

// â”€â”€ Database connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      const connectOptions = {};
      if (mongoDb) connectOptions.dbName = mongoDb;
      await mongoose.connect(mongoUri, connectOptions);
      console.log(`  âœ”  MongoDB connected${mongoDb ? ` (db: ${mongoDb})` : ''}`);
      await ensureDefaultAdmin();
    } catch (err) {
      console.error('  âœ˜  MongoDB connection error:', err.message);
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

// â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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

      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await Session.updateOne({ token: candidate.token }, { $set: { expiresAt } });
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
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Prevent cached protected pages from showing after logout (back button issue).
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// â”€â”€ Pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/', (req, res) => {
  if (!req.auth) return res.redirect('/report');
  if (req.auth.role === 'admin') return res.redirect('/admin');
  return res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  if (String(req.query.force || '') !== '1') {
    if (req.auth?.role === 'admin') return res.redirect('/admin');
  }
  res.render('login', { error: '' });
});

app.post('/login', async (req, res) => {
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
    console.error('[login] admin login failed:', err && err.message ? err.message : err);
    return res.status(500).render('login', { error: 'Login failed. Please try again.' });
  }
});

app.get('/dispatcher/login', (req, res) => {
  if (String(req.query.force || '') !== '1') {
    if (req.auth?.role === 'dispatcher') return res.redirect('/dashboard');
  }
  res.render('dispatcher-login', { error: '' });
});

app.post('/dispatcher/login', async (req, res) => {
  try {
    await ensureDbReady();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).render('dispatcher-login', { error: 'Invalid login details.' });
    }

    const dispatcher = await Dispatcher.findOne({ username });
    if (!dispatcher || !dispatcher.isActive || !verifyPassword(password, dispatcher.passwordHash)) {
      return res.status(401).render('dispatcher-login', { error: 'Invalid dispatcher credentials.' });
    }

    await createSession(req, res, {
      role: 'dispatcher',
      userId: String(dispatcher._id),
      username: dispatcher.username,
      fullName: dispatcher.fullName || dispatcher.username,
    });
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
  res.redirect('/login');
});

app.get('/report', (_req, res) => res.render('report'));

app.get('/dashboard', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
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
    console.error(err);
    res.status(500).send('Database error loading dashboard');
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

app.get('/admin', requireRolesPage(['admin'], '/login'), async (req, res) => {
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

// â”€â”€ API: submit a normal report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    const payload = report.toJSON();
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

// â”€â”€ API: Panic SOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    const payload = report.toJSON();
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

// â”€â”€ API: update status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.patch('/api/report/:id/status', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const nextStatus = String(req.body.status || '').trim().toLowerCase();
    if (!VALID_REPORT_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const where = reportLookupQuery(req.params.id);
    const updates = { status: req.body.status };
    if (req.auth && req.auth.role === 'dispatcher') {
      updates.dispatcherId = String(req.auth.userId || '');
      updates.dispatcherName = String(req.auth.fullName || req.auth.username || '').trim();
    }
    const report = await Report.findOneAndUpdate(
      where,
      updates,
      { new: true }
    );
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
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update report' });
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
    await emitRealtime('report-details-updated', payload);
    res.json({ success: true, report: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update report details' });
  }
});

// â”€â”€ API: delete all reports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ API: list all reports (JSON) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reports', requireRolesApi(['dispatcher', 'admin']), async (_req, res) => {
  try {
    const reports = await Report.find(buildReportVisibilityQuery(_req.auth)).sort({ timestamp: -1 }).lean({ virtuals: true });
    res.json(reports);
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

    const assignment = await resolveDispatcherAssignmentPatch(req, current, { requireClaimWhenUnassigned: false });
    if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });
    if (String(current.assignedToId || '').trim() === String(target._id)) {
      return res.status(400).json({ error: 'Report is already assigned to that dispatcher' });
    }

    const nextAssignedName = String(target.fullName || target.username || '').trim();
    const actorName = String(req.auth.fullName || req.auth.username || '').trim();
    const actorUsername = String(req.auth.username || '').trim();
    const nextPassCount = Math.max(0, Number(current.passCount) || 0) + 1;
    const report = await Report.findOneAndUpdate(
      where,
      {
        assignedToId: String(target._id),
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
    await emitRealtime('report-assignment-updated', payload);
    return res.json({ success: true, report: payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not pass report' });
  }
});

// â”€â”€ API: reverse geocode GPS to location labels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Helper: credibility score â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

async function createSession(req, res, payload) {
  const role = payload.role;
  const cookieName = cookieNameForRole(role);
  const currentToken = req.authToken || getCookie(req, cookieName);
  if (currentToken) await Session.deleteOne({ token: currentToken });
  const secureCookie = shouldUseSecureCookie(req);
  const token = crypto.randomBytes(24).toString('hex');
  await Session.create({
    token,
    role: payload.role,
    userId: payload.userId,
    username: payload.username,
    fullName: payload.fullName,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  res.cookie(cookieName, token, {
    maxAge: SESSION_TTL_MS,
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
    console.log(`  âœ”  Default admin created (${username})`);
  }

  const secondaryAdmin = await Admin.findOne({ username: 'admin1' }).lean();
  if (!secondaryAdmin) {
    await Admin.create({
      username: 'admin1',
      fullName: 'Admin One',
      passwordHash: hashPassword('123456'),
    });
    console.log('  âœ”  Secondary admin created (admin1)');
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
  if (!/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(photo)) {
    throw new Error('Invalid photo format');
  }
  if (photo.length > 10 * 1024 * 1024) {
    throw new Error('Photo is too large');
  }
  return photo;
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
    photo: sanitizeDataImage(body.photo),
  };

  if (!clean.name || !clean.contact || !clean.emergencyType || !clean.severity || !clean.barangay || !clean.landmark || !clean.street || !clean.description) {
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

// â”€â”€ Realtime (Pusher) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

