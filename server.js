'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || './coinnova.sqlite';

if (process.env.NODE_ENV === 'production') {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('Set a strong ADMIN_PASSWORD in Render Environment.');
  }

  if (SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }

  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN is not configured. Telegram login will not work.');
  }
}

const dbDirectory = path.dirname(path.resolve(DB_PATH));
fs.mkdirSync(dbDirectory, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0,
  total_mined INTEGER NOT NULL DEFAULT 0,
  referrals INTEGER NOT NULL DEFAULT 0,
  referred_by TEXT,
  last_daily TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  reward INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_tasks (
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, task_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('users', 'photo_url', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'last_daily', 'TEXT');

const DEFAULT_SETTINGS = {
  appName: 'CoinNova',
  miningReward: '1',
  dailyReward: '100',
  referralReward: '250',
  minimumWithdrawal: '1000',
  referralRequirement: '1',
  miningEnabled: 'true',
  registrationEnabled: 'true',
  withdrawalEnabled: 'true',
  welcomeText: 'Welcome to CoinNova!',
  supportUrl: '',
  telegramUrl: '',
  maintenanceMode: 'false'
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`
  INSERT INTO settings(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  if (!getSettingStmt.get(key)) {
    setSettingStmt.run(key, value);
  }
}

function setting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

function integer(value, fallback = 0, min = 0, max = 1000000000) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validHttpUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signCookie(value) {
  return crypto
    .createHmac('sha256', SESSION_SECRET || 'development-only-secret')
    .update(value)
    .digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendSessionCookie(res, name, token, maxAge) {
  res.cookie(name, `${token}.${signCookie(token)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/'
  });
}

function readSignedCookie(req, name) {
  const raw = req.cookies && req.cookies[name];
  if (!raw || typeof raw !== 'string') return null;

  const index = raw.lastIndexOf('.');
  if (index <= 0) return null;

  const token = raw.slice(0, index);
  const signature = raw.slice(index + 1);

  if (!safeEqual(signature, signCookie(token))) return null;
  return token;
}

function telegramInitDataValid(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') {
    return null;
  }

  if (initData.length > 10000) return null;

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));

  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) {
    return null;
  }

  if (!Number.isFinite(authDate)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > 86400) {
    return null;
  }

  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (!safeEqual(calculatedHash, suppliedHash.toLowerCase())) {
    return null;
  }

  try {
    const user = JSON.parse(params.get('user') || '{}');

    if (!user.id || !Number.isSafeInteger(Number(user.id))) {
      return null;
    }

    return {
      id: String(user.id),
      first_name: cleanText(user.first_name, 100),
      last_name: cleanText(user.last_name, 100),
      username: cleanText(user.username, 100),
      photo_url: validHttpUrl(user.photo_url || '')
    };
  } catch {
    return null;
  }
}

function currentUser(req) {
  const token = readSignedCookie(req, 'cn_session');
  if (!token) return null;

  const row = db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(hashToken(token), Date.now());

  return row || null;
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Please open the app in Telegram and log in.'
    });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const token = readSignedCookie(req, 'cn_admin');
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Admin login required.' });
  }

  const session = db.prepare(`
    SELECT token_hash FROM admin_sessions
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());

  if (!session) {
    return res.status(401).json({ ok: false, error: 'Admin session expired.' });
  }

  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

function publicUser(user) {
  return {
    id: user.id,
    telegramId: user.tg_id,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
    photoUrl: user.photo_url,
    balance: user.balance,
    totalMined: user.total_mined,
    referrals: user.referrals,
    lastDaily: user.last_daily,
    createdAt: user.created_at
  };
}

function publicSettings() {
  return {
    appName: setting('appName'),
    miningReward: integer(setting('miningReward'), 1),
    dailyReward: integer(setting('dailyReward'), 100),
    referralReward: integer(setting('referralReward'), 250),
    minimumWithdrawal: integer(setting('minimumWithdrawal'), 1000),
    referralRequirement: integer(setting('referralRequirement'), 1, 0, 100),
    miningEnabled: setting('miningEnabled') === 'true',
    registrationEnabled: setting('registrationEnabled') === 'true',
    withdrawalEnabled: setting('withdrawalEnabled') === 'true',
    welcomeText: setting('welcomeText'),
    supportUrl: setting('supportUrl'),
    telegramUrl: setting('telegramUrl'),
    maintenanceMode: setting('maintenanceMode') === 'true'
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: setting('appName'),
    time: new Date().toISOString()
  });
});

app.get('/api/settings', (req, res) => {
  res.json({ ok: true, settings: publicSettings() });
});

/*
 * Telegram Mini App authentication.
 * Frontend must POST { initData: Telegram.WebApp.initData }.
 * Do not authenticate from initDataUnsafe.
 */
app.post('/api/auth/telegram', authLimiter, (req, res) => {
  if (setting('registrationEnabled') !== 'true') {
    return res.status(403).json({ ok: false, error: 'Registration is disabled.' });
  }

  const tg = telegramInitDataValid(req.body && req.body.initData);

  if (!tg) {
    return res.status(401).json({
      ok: false,
      error: 'Telegram verification failed. Open this app from your Telegram bot.'
    });
  }

  const existing = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tg.id);

  if (!existing && setting('maintenanceMode') === 'true') {
    return res.status(503).json({ ok: false, error: 'App is under maintenance.' });
  }

  if (existing) {
    db.prepare(`
      UPDATE users SET
        first_name = ?,
        last_name = ?,
        username = ?,
        photo_url = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE tg_id = ?
    `).run(tg.first_name, tg.last_name, tg.username, tg.photo_url, tg.id);
  } else {
    db.prepare(`
      INSERT INTO users (tg_id, first_name, last_name, username, photo_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(tg.id, tg.first_name, tg.last_name, tg.username, tg.photo_url);
  }

  const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tg.id);
  const token = newToken();

  db.prepare(`
    INSERT INTO sessions(token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(hashToken(token), user.id, Date.now() + 30 * 24 * 60 * 60 * 1000);

  sendSessionCookie(res, 'cn_session', token, 30 * 24 * 60 * 60 * 1000);

  res.json({
    ok: true,
    user: publicUser(user),
    settings: publicSettings()
  });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({
    ok: true,
    user: publicUser(req.user),
    settings: publicSettings()
  });
});

app.post('/api/logout', (req, res) => {
  const token = readSignedCookie(req, 'cn_session');
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  res.clearCookie('cn_session', { path: '/' });
  res.json({ ok: true });
});

/*
 * Mining endpoint:
 * each accepted tap adds the configured points.
 * This is an in-app points system, not real cryptocurrency.
 */
app.post('/api/mine', requireUser, (req, res) => {
  if (setting('maintenanceMode') === 'true' ||
      setting('miningEnabled') !== 'true') {
    return res.status(403).json({ ok: false, error: 'Mining is currently disabled.' });
  }

  const requested = integer(req.body && req.body.taps, 1, 1, 10);
  const reward = integer(setting('miningReward'), 1, 0, 1000000);
  const amount = requested * reward;

  const result = db.prepare(`
    UPDATE users
    SET balance = balance + ?,
        total_mined = total_mined + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(amount, amount, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  res.json({
    ok: true,
    added: amount,
    user: publicUser(user)
  });
});

app.post('/api/daily', requireUser, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  if (req.user.last_daily === today) {
    return res.status(409).json({ ok: false, error: 'Daily reward already claimed.' });
  }

  const reward = integer(setting('dailyReward'), 100, 0, 100000000);

  const claim = db.transaction(() => {
    const fresh = db.prepare('SELECT last_daily FROM users WHERE id = ?')
      .get(req.user.id);

    if (fresh.last_daily === today) return false;

    db.prepare(`
      UPDATE users SET
        balance = balance + ?,
        last_daily = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reward, today, req.user.id);

    return true;
  });

  if (!claim()) {
    return res.status(409).json({ ok: false, error: 'Daily reward already claimed.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, added: reward, user: publicUser(user) });
});

app.get('/api/tasks', requireUser, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.description, t.url, t.reward,
      CASE WHEN ut.user_id IS NULL THEN 0 ELSE 1 END AS claimed
    FROM tasks t
    LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = ?
    WHERE t.active = 1
    ORDER BY t.id DESC
  `).all(req.user.id);

  res.json({ ok: true, tasks });
});

/*
 * Claiming a task only awards app points.
 * It does not verify completion on an external website.
 */
app.post('/api/tasks/:id/claim', requireUser, (req, res) => {
  const taskId = integer(req.params.id, 0, 1, 2147483647);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND active = 1')
    .get(taskId);

  if (!task) {
    return res.status(404).json({ ok: false, error: 'Task not found.' });
  }

  try {
    const claim = db.transaction(() => {
      db.prepare('INSERT INTO user_tasks(user_id, task_id) VALUES (?, ?)')
        .run(req.user.id, task.id);

      db.prepare(`
        UPDATE users SET balance = balance + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(task.reward, req.user.id);
    });

    claim();
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ ok: false, error: 'Task already claimed.' });
    }
    throw error;
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, added: task.reward, user: publicUser(user) });
});

app.get('/api/referrals', requireUser, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS total FROM users WHERE referred_by = ?')
    .get(req.user.tg_id).total;

  res.json({
    ok: true,
    referrals: count,
    referralLink: BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(req.user.tg_id)}`
      : ''
  });
});

app.get('/api/withdrawals', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT id, method, wallet, amount, status, created_at AS createdAt
    FROM withdrawals WHERE user_id = ?
    ORDER BY id DESC LIMIT 50
  `).all(req.user.id);

  res.json({ ok: true, withdrawals: rows });
});

app.post('/api/withdrawals', requireUser, (req, res) => {
  if (setting('withdrawalEnabled') !== 'true') {
    return res.status(403).json({ ok: false, error: 'Withdrawals are disabled.' });
  }

  const method = cleanText(req.body && req.body.method, 30);
  const wallet = cleanText(req.body && req.body.wallet, 200);
  const amount = integer(req.body && req.body.amount, 0, 1, 1000000000);

  const allowedMethods = ['bKash', 'Nagad', 'Rocket', 'USDT', 'Binance', 'Trust Wallet', 'Bitget'];

  if (!allowedMethods.includes(method)) {
    return res.status(400).json({ ok: false, error: 'Unsupported withdrawal method.' });
  }

  if (wallet.length < 4) {
    return res.status(400).json({ ok: false, error: 'Enter a valid wallet or account.' });
  }

  if (amount < integer(setting('minimumWithdrawal'), 1000)) {
    return res.status(400).json({ ok: false, error: 'Amount is below minimum withdrawal.' });
  }

  const needed = integer(setting('referralRequirement'), 1, 0, 100);
  const referrals = db.prepare('SELECT COUNT(*) AS total FROM users WHERE referred_by = ?')
    .get(req.user.tg_id).total;

  if (referrals < needed) {
    return res.status(403).json({
      ok: false,
      error: `You need ${needed} referral(s) before withdrawal.`,
      referrals,
      required: needed
    });
  }

  const create = db.transaction(() => {
    const user = db.prepare('SELECT balance FROM users WHERE id = ?')
      .get(req.user.id);

    if (!user || user.balance < amount) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
      .run(amount, req.user.id);

    return db.prepare(`
      INSERT INTO withdrawals(user_id, method, wallet, amount)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, method, wallet, amount).lastInsertRowid;
  });

  try {
    const id = create();
    res.json({
      ok: true,
      withdrawalId: id,
      message: 'Withdrawal request submitted for admin review.'
    });
  } catch (error) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ ok: false, error: 'Insufficient balance.' });
    }
    throw error;
  }
});

/* Admin login */
app.post('/api/admin/login', adminLimiter, (req, res) => {
  const password = String(req.body && req.body.password || '');

  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'Incorrect admin password.' });
  }

  const token = newToken();

  db.prepare(`
    INSERT INTO admin_sessions(token_hash, expires_at)
    VALUES (?, ?)
  `).run(hashToken(token), Date.now() + 8 * 60 * 60 * 1000);

  sendSessionCookie(res, 'cn_admin', token, 8 * 60 * 60 * 1000);
  res.json({ ok: true, message: 'Admin login successful.' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = readSignedCookie(req, 'cn_admin');
  if (token) {
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  res.clearCookie('cn_admin', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  const pending = db.prepare(`
    SELECT COUNT(*) AS total FROM withdrawals WHERE status = 'pending'
  `).get().total;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) AS total FROM users')
    .get().total;

  res.json({
    ok: true,
    stats: { users, pendingWithdrawals: pending, totalUserBalance: totalBalance },
    settings: publicSettings()
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const page = integer(req.query.page, 1, 1, 100000);
  const limit = integer(req.query.limit, 50, 1, 100);
  const users = db.prepare(`
    SELECT id, tg_id AS telegramId, first_name AS firstName,
      last_name AS lastName, username, photo_url AS photoUrl,
      balance, total_mined AS totalMined, referrals,
      created_at AS createdAt
    FROM users ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(limit, (page - 1) * limit);

  res.json({ ok: true, page, limit, users });
});

app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  const status = cleanText(req.query.status, 20);
  const rows = status
    ? db.prepare(`
        SELECT w.*, u.tg_id AS telegramId, u.username
        FROM withdrawals w JOIN users u ON u.id = w.user_id
        WHERE w.status = ? ORDER BY w.id DESC LIMIT 200
      `).all(status)
    : db.prepare(`
        SELECT w.*, u.tg_id AS telegramId, u.username
        FROM withdrawals w JOIN users u ON u.id = w.user_id
        ORDER BY w.id DESC LIMIT 200
      `).all();

  res.json({ ok: true, withdrawals: rows });
});

app.post('/api/admin/withdrawals/:id/status', requireAdmin, (req, res) => {
  const id = integer(req.params.id, 0, 1, 2147483647);
  const status = cleanText(req.body && req.body.status, 20);
  const allowed = ['pending', 'approved', 'paid', 'rejected'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid status.' });
  }

  const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'Request not found.' });

  const update = db.transaction(() => {
    if (status === 'rejected' && row.status !== 'rejected' && row.status !== 'paid') {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
        .run(row.amount, row.user_id);
    }

    db.prepare(`
      UPDATE withdrawals SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
  });

  update();
  res.json({ ok: true });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const input = req.body && req.body.settings;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ ok: false, error: 'settings object required.' });
  }

  const numericKeys = [
    'miningReward',
    'dailyReward',
    'referralReward',
    'minimumWithdrawal',
    'referralRequirement'
  ];

  const booleanKeys = [
    'miningEnabled',
    'registrationEnabled',
    'withdrawalEnabled',
    'maintenanceMode'
  ];

  const textKeys = ['appName', 'welcomeText'];
  const urlKeys = ['supportUrl', 'telegramUrl'];

  for (const key of numericKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const max = key === 'referralRequirement' ? 100 : 1000000000;
      setSetting(key, String(integer(input[key], 0, 0, max)));
    }
  }

  for (const key of booleanKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      setSetting(key, input[key] === true || input[key] === 'true' ? 'true' : 'false');
    }
  }

  for (const key of textKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      setSetting(key, cleanText(input[key], key === 'welcomeText' ? 2000 : 100));
    }
  }

  for (const key of urlKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      setSetting(key, validHttpUrl(input[key]));
    }
  }

  res.json({ ok: true, settings: publicSettings() });
});

app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
  res.json({ ok: true, tasks });
});

app.post('/api/admin/tasks', requireAdmin, (req, res) => {
  const title = cleanText(req.body && req.body.title, 120);
  const description = cleanText(req.body && req.body.description, 500);
  const url = validHttpUrl(req.body && req.body.url);
  const reward = integer(req.body && req.body.reward, 0, 0, 100000000);

  if (!title) {
    return res.status(400).json({ ok: false, error: 'Task title is required.' });
  }

  const result = db.prepare(`
    INSERT INTO tasks(title, description, url, reward, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, description, url, reward, req.body && req.body.active === false ? 0 : 1);

  res.json({
    ok: true,
    task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid)
  });
});

app.put('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const id = integer(req.params.id, 0, 1, 2147483647);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Task not found.' });
  }

  const title = cleanText(req.body && req.body.title, 120) || existing.title;
  const description = Object.prototype.hasOwnProperty.call(req.body || {}, 'description')
    ? cleanText(req.body.description, 500) : existing.description;
  const url = Object.prototype.hasOwnProperty.call(req.body || {}, 'url')
    ? validHttpUrl(req.body.url) : existing.url;
  const reward = Object.prototype.hasOwnProperty.call(req.body || {}, 'reward')
    ? integer(req.body.reward, existing.reward, 0, 100000000) : existing.reward;
  const active = Object.prototype.hasOwnProperty.call(req.body || {}, 'active')
    ? (req.body.active === true || req.body.active === 'true' ? 1 : 0)
    : existing.active;

  db.prepare(`
    UPDATE tasks SET title = ?, description = ?, url = ?, reward = ?, active = ?
    WHERE id = ?
  `).run(title, description, url, reward, active, id);

  res.json({ ok: true });
});

app.delete('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const id = integer(req.params.id, 0, 1, 2147483647);
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'Task not found.' });
  }

  res.json({ ok: true });
});

/* Static pages */
const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir, {
  index: 'index.html',
  extensions: ['html']
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'Admin.html'));
});

app.get('/admin/', (req, res) => {
  res.sendFile(path.join(publicDir, 'Admin.html'));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not found. Ensure your User Panel and Admin Panel are inside the public folder.'
  });
});

app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);

  if (res.headersSent) return next(err);

  res.status(500).json({
    ok: false,
    error: 'Internal server error.'
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`CoinNova server listening on port ${PORT}`);
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
