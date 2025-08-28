// index.js — MatchM8 server (final, prod-hardened)

const path = require('path');
const fs = require('fs');

// ------------- Load & sanitize environment -------------
const envPath = path.join(__dirname, '.env');
require('dotenv').config({ path: envPath, override: true });

function cleanToken(s = '') {
  return String(s)
    .replace(/\r/g, '')
    .replace(/\s+#.*$/, '')
    .replace(/^\s*['"]|['"]\s*$/g, '')
    .trim();
}
if (process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = cleanToken(process.env.ADMIN_TOKEN);
}
if (process.env.LICENSE_PUBKEY_B64) {
  process.env.LICENSE_PUBKEY_B64 = cleanToken(process.env.LICENSE_PUBKEY_B64);
}
const APP_MODE = process.env.APP_MODE || 'demo';
// demo guard: allow running without license when explicitly set
const SKIP_LICENSE = String(process.env.DEMO_SKIP_LICENSE || '').toLowerCase() === 'true';

// ------------- App bootstrap -------------
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { DATA_DIR } = require('./lib/paths');     // <- central data dir (env DATA_DIR or ./data)

const app = express();
app.set('trust proxy', 1);                        // ✅ for Render/Railway/any proxy
const PORT = process.env.PORT || 3000;            // ✅ use platform port if provided

const joinRepo = (...p) => path.join(__dirname, ...p);
const joinData = (...p) => path.join(DATA_DIR, ...p);
const CONFIG_PATH = joinData('config.json');

// --- config defaults used if data/config.json is missing ---
const DEFAULT_CONFIG = {
  season: 2025,
  total_weeks: 38,
  current_week: 1,
  lock_minutes_before_kickoff: 10,
  deadline_mode: 'first_kickoff',
  timezone: 'Australia/Melbourne',
};

// helpers to read/write config.json safely
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...obj };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function writeConfig(cfg) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// timing-safe admin-token guard (used only where needed)
function timingSafeEqual(a = '', b = '') {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}
function requireAdminToken(req, res, next) {
  const token = cleanToken(req.headers['x-admin-token'] || '');
  const expected = process.env.ADMIN_TOKEN || '';
  if (!token || !expected || !timingSafeEqual(token, expected)) {
    return res.status(401).json({ ok: false, error: 'invalid admin token' });
  }
  next();
}

// --- License wiring ---
const license = require('./lib/license');
// only log license status if we're not skipping in demo
license.loadAndValidate().then(s => { if (!SKIP_LICENSE) console.log('License:', s.reason); });

// Expose license status for UI
app.get('/api/license/status', (_req, res) => res.json(license.getStatus()));

// PUBLIC admin-auth endpoints (allowed even if license invalid)
const ADMIN_PUBLIC = new Set(['/login', '/bootstrap', '/state', '/health']);

if (SKIP_LICENSE) {
  console.log('DEMO_SKIP_LICENSE=true — bypassing license checks for /api/admin and /api/scores');
}

// Gate /api/admin by license (NOT by admin token here; token is enforced inside the admin routers)
app.use('/api/admin', (req, res, next) => {
  // allow public admin endpoints through this gate
  if (ADMIN_PUBLIC.has(req.path)) return next();
  // demo bypass: skip license check entirely
  if (SKIP_LICENSE) return next();
  // otherwise license must be valid
  const s = license.getStatus();
  if (!s.ok) return res.status(403).json({ error: 'License invalid: ' + s.reason });
  next();
});

// Require license for scores (unless demo bypass)
app.use('/api/scores', (req, res, next) => {
  if (SKIP_LICENSE) return next();
  const s = license.getStatus();
  if (!s.ok) return res.status(403).json({ error: 'License invalid: ' + s.reason });
  next();
});

/* -------------------- Global middleware -------------------- */
// CORS allowlist via env: CORS_ORIGIN="http://localhost:3000,https://your.site"
const ALLOW = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (ALLOW.length) {
  app.use(cors({
    origin: (origin, cb) => (!origin || ALLOW.includes(origin)) ? cb(null, origin) : cb(new Error('Not allowed by CORS')),
    credentials: false
  }));
} else {
  app.use(cors());
}

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Health (Render/Railway)
app.get('/health', (_req, res) => res.json({ ok: true, mode: APP_MODE, ts: Date.now() }));
app.get('/healthz', (_req, res) => res.status(200).send('ok')); // legacy/simple

// Static assets (SAFE): expose only read-only scores + fixtures
app.use('/data/scores', express.static(joinData('scores')));
app.use('/data/fixtures', express.static(joinData('fixtures')));
app.use(express.static(joinRepo('public')));
app.use('/ui', express.static(joinRepo('ui')));

// Fix old encoded URLs (legacy)
app.use((req, res, next) => {
  if (req.url.includes('%3F') || req.url.includes('%26')) {
    const fixed = req.url.replace(/%3F/gi, '?').replace(/%26/gi, '&');
    return res.redirect(fixed);
  }
  next();
});

/* -------------------- /api/config -------------------- */
// Public GET: players & UI read season info
app.get('/api/config', (_req, res) => res.json(readConfig()));

// Admin POST: save season settings etc.
app.post('/api/config', requireAdminToken, (req, res) => {
  const prev = readConfig();
  const next = { ...prev, ...req.body };

  // coercions/sanity
  if ('total_weeks' in req.body) next.total_weeks = Math.max(1, parseInt(req.body.total_weeks, 10) || prev.total_weeks);
  if ('current_week' in req.body) next.current_week = Math.max(1, parseInt(req.body.current_week, 10) || prev.current_week);
  if ('lock_minutes_before_kickoff' in req.body) next.lock_minutes_before_kickoff = Math.max(0, parseInt(req.body.lock_minutes_before_kickoff, 10) || 0);
  if ('season' in req.body) next.season = parseInt(req.body.season, 10) || prev.season;
  if ('deadline_mode' in req.body) next.deadline_mode = (req.body.deadline_mode === 'per_match') ? 'per_match' : 'first_kickoff';
  if ('timezone' in req.body) next.timezone = String(req.body.timezone || prev.timezone);

  writeConfig(next);
  res.json({ ok: true, config: next });
});

/* -------------------- Safe require + mount -------------------- */
function safeRequire(label, p) {
  try {
    const mod = require(p);
    console.log(`[boot] mounted ${label} at runtime path ${p}`);
    return { ok: true, mod };
  } catch (e) {
    console.warn(`[boot] Skipping ${label}: ${e.message}`);
    return { ok: false, mod: null, reason: e.message };
  }
}
function mount(label, route, mod) {
  app.use(route, mod);
  mounted.push({ label, route });
}
const mounted = [];

// Fixtures (try user route first)
const fixtures = safeRequire('./routes/fixtures.js', './routes/fixtures');
if (fixtures.ok) {
  mount('./routes/fixtures.js', '/api/fixtures', fixtures.mod);
  mount('./routes/fixtures.js', '/fixtures', fixtures.mod);
} else {
  // Fallback public fixtures: returns plain array for week
  app.get('/api/fixtures', (req, res) => {
    const cfg = readConfig();
    const week = Math.max(1, parseInt(req.query.week, 10) || 1);
    const season = cfg.season || 2025;
    const fpath = path.join(DATA_DIR, 'fixtures', `season-${season}`, `week-${week}.json`);
    try {
      const txt = fs.readFileSync(fpath, 'utf8');
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) return res.json(arr);
      if (arr && Array.isArray(arr.fixtures)) return res.json(arr.fixtures);
      return res.json([]);
    } catch {
      return res.json([]);
    }
  });
  mounted.push({ label: '(inline)/api/fixtures', route: '/api/fixtures' });
}

// Predictions
const predictions = safeRequire('./routes/predictions.js', './routes/predictions');
if (predictions.ok) {
  mount('./routes/predictions.js', '/api/predictions', predictions.mod);
  mount('./routes/predictions.js', '/predictions', predictions.mod);
}

// Scores
const scores = safeRequire('./routes/scores.js', './routes/scores');
if (scores.ok) {
  mount('./routes/scores.js', '/api/scores', scores.mod);
  mount('./routes/scores.js', '/scores', scores.mod);
}

// Auth
const auth = safeRequire('./routes/auth.js', './routes/auth');
if (auth.ok) {
  mount('./routes/auth.js', '/api/auth', auth.mod);
  mount('./routes/auth.js', '/auth', auth.mod);
}

// Players (optional)
const players = safeRequire('./routes/players.js', './routes/players');
if (players.ok) {
  mount('./routes/players.js', '/api/players', players.mod);
  mount('./routes/players.js', '/players', players.mod);
}

// ---- Admin auth (mounted BEFORE other /api/admin routes; allowed by ADMIN_PUBLIC whitelist) ----
const adminAuth = require('./routes/admin_auth');
app.use('/api/admin', adminAuth);
mounted.push({ label: './routes/admin_auth.js', route: '/api/admin' });

// ---- Admin routes (guarded; token checks inside route impl) ----
const admin = safeRequire('./routes/admin.js', './routes/admin');
if (admin.ok) {
  mount('./routes/admin.js', '/api/admin', admin.mod);
}

// ---- Locks route (license-gated unless demo bypass) ----
{
  const locksRt = safeRequire('./routes/locks.js', './routes/locks');
  if (locksRt.ok) {
    const locksGate = (req, res, next) => {
      if (SKIP_LICENSE) return next();
      const s = license.getStatus();
      if (!s.ok) return res.status(403).json({ error: 'License invalid: ' + s.reason });
      next();
    };
    app.use('/api/locks', locksGate, locksRt.mod);
    mounted.push({ label: './routes/locks.js', route: '/api/locks' });
  } else {
    console.warn('Skipping ./routes/locks.js:', locksRt.reason || 'failed to load');
  }
}

// ---- Admin reminders (under /api/admin; router also checks x-admin-token) ----
{
  const remindersRt = safeRequire('./routes/admin-reminders.js', './routes/admin-reminders');
  if (remindersRt.ok) {
    app.use('/api/admin/reminders', remindersRt.mod);
    mounted.push({ label: './routes/admin-reminders.js', route: '/api/admin/reminders' });
  } else {
    console.warn('Skipping ./routes/admin-reminders.js:', remindersRt.reason || 'failed to load');
  }
}

/* -------------------- Diagnostics -------------------- */
app.get('/api/__health', (_req, res) => res.json({ ok: true, mounted, mode: APP_MODE, dataDir: DATA_DIR }));
app.get('/api/__routes', (_req, res) => res.json(mounted));

/* -------------------- Map UI pages -------------------- */
[
  'Part_A_PIN.html',
  'Part_B_Predictions.html',
  'Part_D_Scoring.html',
  'Part_E_Season.html',
  'Part_E_Matrix.html',           // ⬅️ new matrix page
].forEach(page => {
  app.get('/' + page, (_req, res) => res.sendFile(joinRepo('public', page)));
});

/* -------------------- Root -------------------- */
// Root (new) — return 200 so platform healthcheck passes
app.get('/', (_req, res) => res.sendFile(joinRepo('public', 'Part_A_PIN.html')));

/* -------------------- Listen -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MatchM8 listening on port ${PORT} (mode=${APP_MODE})`);
  console.log(`DATA_DIR = ${DATA_DIR}`);
});
