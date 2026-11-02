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
const DB_PATH = process.env.DB_PATH || './coinnova.sqlite';

if (process.env.NODE_ENV === 'production') {
  if (ADMIN_PASSWORD.length < 12) {
    throw new Error('Set ADMIN_PASSWORD to at least 12 characters.');
  }

  if (SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }
}

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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

  if (!columns.some(columnInfo => columnInfo.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('users', 'photo_url', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'last_daily', 'TEXT');

addColumnIfMissing('withdrawals', 'network', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('withdrawals', 'fee', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('withdrawals', 'net_amount', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('withdrawals', 'asset', "TEXT NOT NULL DEFAULT 'POINTS'");
addColumnIfMissing('withdrawals', 'admin_note', "TEXT NOT NULL DEFAULT ''");

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
  maintenanceMode: 'false',

  walletConfig: JSON.stringify({
    USDT: {
      enabled: true,
      name: 'Binance USDT',
      logo: 'https://cryptologos.cc/logos/tether-usdt-logo.png',
      description: 'Withdraw crypto to your external wallet.',
      feePercent: 10,
      minimum: 10,
      networks: [
        {
          id: 'TRX',
          name: 'TRX (TRC20)',
          description: 'TRON network',
          enabled: true,
          feePercent: 10,
          minimum: 10
        },
        {
          id: 'TON',
          name: 'TON',
          description: 'TON network',
          enabled: true,
          feePercent: 10,
          minimum: 3
        }
      ]
    },

    bKash: {
      enabled: true,
      name: 'bKash',
      logo: '',
      description: 'Enter your bKash account number.',
      feePercent: 0,
      minimum: 100,
      networks: []
    },

    Nagad: {
      enabled: true,
      name: 'Nagad',
      logo: '',
      description: 'Enter your Nagad account number.',
      feePercent: 0,
      minimum: 100,
      networks: []
    },

    Rocket: {
      enabled: true,
      name: 'Rocket',
      logo: '',
      description: 'Enter your Rocket account number.',
      feePercent: 0,
      minimum: 100,
      networks: []
    }
  })
};

const getSettingStmt = db.prepare(
  'SELECT value FROM settings WHERE key = ?'
);

const setSettingStmt = db.prepare(`
  INSERT INTO settings(key, value)
  VALUES (?, ?)
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
  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

function decimal(value, fallback = 0, min = 0, max = 1000000000) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

function cleanText(value, max = 200) {
  return String(value == null ? '' : value)
    .trim()
    .slice(0, max);
}

function validHttpUrl(value) {
  if (!value) return '';

  try {
    const url = new URL(String(value));

    if (!['https:', 'http:'].includes(url.protocol)) {
      return '';
    }

    return url.href;
  } catch {
    return '';
  }
}

function parseWalletConfig() {
  try {
    const parsed = JSON.parse(setting('walletConfig'));

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signCookie(token) {
  return crypto
    .createHmac('sha256', SESSION_SECRET || 'development-only-secret')
    .update(token)
    .digest('hex');
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
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

  if (!safeEqual(signature, signCookie(token))) {
    return null;
  }

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

  return db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(hashToken(token), Date.now()) || null;
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
    return res.status(401).json({
      ok: false,
      error: 'Admin login required.'
    });
  }

  const session = db.prepare(`
    SELECT token_hash FROM admin_sessions
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: 'Admin session expired.'
    });
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

function publicWalletConfig() {
  const config = parseWalletConfig();
  const result = {};

  for (const [key, wallet] of Object.entries(config)) {
    result[key] = {
      enabled: wallet.enabled === true,
      name: cleanText(wallet.name, 80),
      logo: validHttpUrl(wallet.logo || ''),
      description: cleanText(wallet.description, 500),
      feePercent: decimal(wallet.feePercent, 0, 0, 100),
      minimum: decimal(wallet.minimum, 0, 0, 1000000000),
      networks: Array.isArray(wallet.networks)
        ? wallet.networks.map(network => ({
            id: cleanText(network.id, 30),
            name: cleanText(network.name, 80),
            description: cleanText(network.description, 200),
            enabled: network.enabled === true,
            feePercent: decimal(
              network.feePercent,
              wallet.feePercent || 0,
              0,
              100
            ),
            minimum: decimal(
              network.minimum,
              wallet.minimum || 0,
              0,
              1000000000
            )
          }))
        : []
    };
  }

  return result;
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
    maintenanceMode: setting('maintenanceMode') === 'true',
    walletConfig: publicWalletConfig()
  };
}

/* =========================
   HEALTH AND PUBLIC SETTINGS
========================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: setting('appName'),
    time: new Date().toISOString()
  });
});

app.get('/api/settings', (req, res) => {
  res.json({
    ok: true,
    settings: publicSettings()
  });
});

/* =========================
   TELEGRAM AUTHENTICATION
========================= */

app.post('/api/auth/telegram', authLimiter, (req, res) => {
  if (setting('registrationEnabled') !== 'true') {
    return res.status(403).json({
      ok: false,
      error: 'Registration is disabled.'
    });
  }

  const telegramUser = telegramInitDataValid(
    req.body && req.body.initData
  );

  if (!telegramUser) {
    return res.status(401).json({
      ok: false,
      error: 'Telegram verification failed. Open this app from your Telegram bot.'
    });
  }

  const existing = db.prepare(
    'SELECT * FROM users WHERE tg_id = ?'
  ).get(telegramUser.id);

  if (!existing && setting('maintenanceMode') === 'true') {
    return res.status(503).json({
      ok: false,
      error: 'App is under maintenance.'
    });
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
    `).run(
      telegramUser.first_name,
      telegramUser.last_name,
      telegramUser.username,
      telegramUser.photo_url,
      telegramUser.id
    );
  } else {
    db.prepare(`
      INSERT INTO users
        (tg_id, first_name, last_name, username, photo_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      telegramUser.id,
      telegramUser.first_name,
      telegramUser.last_name,
      telegramUser.username,
      telegramUser.photo_url
    );
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE tg_id = ?'
  ).get(telegramUser.id);

  const token = newToken();

  db.prepare(`
    INSERT INTO sessions(token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(
    hashToken(token),
    user.id,
    Date.now() + 30 * 24 * 60 * 60 * 1000
  );

  sendSessionCookie(
    res,
    'cn_session',
    token,
    30 * 24 * 60 * 60 * 1000
  );

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
    db.prepare(
      'DELETE FROM sessions WHERE token_hash = ?'
    ).run(hashToken(token));
  }

  res.clearCookie('cn_session', { path: '/' });
  res.json({ ok: true });
});

/* =========================
   MINING AND DAILY REWARDS
========================= */

app.post('/api/mine', requireUser, (req, res) => {
  if (
    setting('maintenanceMode') === 'true' ||
    setting('miningEnabled') !== 'true'
  ) {
    return res.status(403).json({
      ok: false,
      error: 'Mining is currently disabled.'
    });
  }

  const taps = integer(req.body && req.body.taps, 1, 1, 10);
  const reward = integer(setting('miningReward'), 1, 0, 1000000);
  const amount = taps * reward;

  db.prepare(`
    UPDATE users
    SET balance = balance + ?,
        total_mined = total_mined + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(amount, amount, req.user.id);

  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({
    ok: true,
    added: amount,
    user: publicUser(user)
  });
});

app.post('/api/daily', requireUser, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const claim = db.transaction(() => {
    const user = db.prepare(
      'SELECT last_daily FROM users WHERE id = ?'
    ).get(req.user.id);

    if (user.last_daily === today) {
      return false;
    }

    const reward = integer(setting('dailyReward'), 100, 0, 100000000);

    db.prepare(`
      UPDATE users
      SET balance = balance + ?,
          last_daily = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reward, today, req.user.id);

    return reward;
  });

  const result = claim();

  if (result === false) {
    return res.status(409).json({
      ok: false,
      error: 'Daily reward already claimed.'
    });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({
    ok: true,
    added: result,
    user: publicUser(user)
  });
});

/* =========================
   TASKS
========================= */

app.get('/api/tasks', requireUser, (req, res) => {
  const tasks = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.description,
      t.url,
      t.reward,
      CASE WHEN ut.user_id IS NULL THEN 0 ELSE 1 END AS claimed
    FROM tasks t
    LEFT JOIN user_tasks ut
      ON ut.task_id = t.id AND ut.user_id = ?
    WHERE t.active = 1
    ORDER BY t.id DESC
  `).all(req.user.id);

  res.json({ ok: true, tasks });
});

app.post('/api/tasks/:id/claim', requireUser, (req, res) => {
  const taskId = integer(req.params.id, 0, 1, 2147483647);

  const task = db.prepare(
    'SELECT * FROM tasks WHERE id = ? AND active = 1'
  ).get(taskId);

  if (!task) {
    return res.status(404).json({
      ok: false,
      error: 'Task not found.'
    });
  }

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO user_tasks(user_id, task_id)
        VALUES (?, ?)
      `).run(req.user.id, task.id);

      db.prepare(`
        UPDATE users
        SET balance = balance + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(task.reward, req.user.id);
    })();
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({
        ok: false,
        error: 'Task already claimed.'
      });
    }

    throw error;
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({
    ok: true,
    added: task.reward,
    user: publicUser(user)
  });
});

/* =========================
   REFERRALS
========================= */

app.get('/api/referrals', requireUser, (req, res) => {
  const count = db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE referred_by = ?
  `).get(req.user.tg_id).total;

  res.json({
    ok: true,
    referrals: count,
    referralLink: BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(req.user.tg_id)}`
      : ''
  });
});

/* =========================
   USER WITHDRAWALS
========================= */

app.get('/api/withdrawals', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      method,
      wallet,
      amount,
      network,
      fee,
      net_amount AS netAmount,
      asset,
      status,
      admin_note AS adminNote,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM withdrawals
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(req.user.id);

  res.json({
    ok: true,
    withdrawals: rows
  });
});

app.post('/api/withdrawals', requireUser, (req, res) => {
  if (setting('maintenanceMode') === 'true') {
    return res.status(503).json({
      ok: false,
      error: 'App is under maintenance.'
    });
  }

  if (setting('withdrawalEnabled') !== 'true') {
    return res.status(403).json({
      ok: false,
      error: 'Withdrawals are disabled.'
    });
  }

  const method = cleanText(req.body && req.body.method, 40);
  const walletAddress = cleanText(
    req.body && (req.body.wallet || req.body.address),
    200
  );
  const networkId = cleanText(req.body && req.body.network, 30);
  const amount = integer(req.body && req.body.amount, 0, 1, 1000000000);

  if (!method || walletAddress.length < 4) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a valid withdrawal method and wallet/account.'
    });
  }

  const config = parseWalletConfig();
  const walletConfig = config[method];

  if (!walletConfig || walletConfig.enabled !== true) {
    return res.status(400).json({
      ok: false,
      error: 'This withdrawal method is unavailable.'
    });
  }

  let minimum = decimal(walletConfig.minimum, 0, 0, 1000000000);
  let feePercent = decimal(walletConfig.feePercent, 0, 0, 100);
  let networkName = '';

  if (Array.isArray(walletConfig.networks) && walletConfig.networks.length) {
    const network = walletConfig.networks.find(item =>
      item.id === networkId && item.enabled === true
    );

    if (!network) {
      return res.status(400).json({
        ok: false,
        error: 'Select an available withdrawal network.'
      });
    }

    minimum = decimal(network.minimum, minimum, 0, 1000000000);
    feePercent = decimal(network.feePercent, feePercent, 0, 100);
    networkName = cleanText(network.name || network.id, 80);
  }

  if (amount < minimum) {
    return res.status(400).json({
      ok: false,
      error: `Minimum withdrawal for ${method} is ${minimum}.`,
      minimum
    });
  }

  const referrals = db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE referred_by = ?
  `).get(req.user.tg_id).total;

  const requiredReferrals = integer(
    setting('referralRequirement'),
    1,
    0,
    100
  );

  if (referrals < requiredReferrals) {
    return res.status(403).json({
      ok: false,
      error: `You need ${requiredReferrals} referral(s) before withdrawal.`,
      referrals,
      required: requiredReferrals
    });
  }

  /*
   * IMPORTANT:
   * The current CoinNova balance is integer app points.
   * It is not a real USDT balance.
   *
   * The fee is calculated for display/request records only.
   * Automatic blockchain or mobile-money payments are not performed here.
   */
  const fee = Math.round(amount * feePercent) / 100;
  const netAmount = Math.max(0, amount - fee);

  try {
    const withdrawalId = db.transaction(() => {
      const user = db.prepare(
        'SELECT balance FROM users WHERE id = ?'
      ).get(req.user.id);

      if (!user || user.balance < amount) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      db.prepare(`
        UPDATE users
        SET balance = balance - ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(amount, req.user.id);

      return db.prepare(`
        INSERT INTO withdrawals
          (user_id, method, wallet, amount, network, fee, net_amount, asset)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        method,
        walletAddress,
        amount,
        networkName,
        fee,
        netAmount,
        'POINTS'
      ).lastInsertRowid;
    })();

    res.json({
      ok: true,
      withdrawalId,
      amount,
      fee,
      netAmount,
      message: 'Withdrawal request submitted for admin review.'
    });
  } catch (error) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({
        ok: false,
        error: 'Insufficient balance.'
      });
    }

    throw error;
  }
});

/* =========================
   ADMIN LOGIN AND LOGOUT
========================= */

app.post('/api/admin/login', adminLimiter, (req, res) => {
  const password = String(req.body && req.body.password || '');

  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({
      ok: false,
      error: 'Incorrect admin password.'
    });
  }

  const token = newToken();

  db.prepare(`
    INSERT INTO admin_sessions(token_hash, expires_at)
    VALUES (?, ?)
  `).run(
    hashToken(token),
    Date.now() + 8 * 60 * 60 * 1000
  );

  sendSessionCookie(
    res,
    'cn_admin',
    token,
    8 * 60 * 60 * 1000
  );

  res.json({
    ok: true,
    message: 'Admin login successful.'
  });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = readSignedCookie(req, 'cn_admin');

  if (token) {
    db.prepare(
      'DELETE FROM admin_sessions WHERE token_hash = ?'
    ).run(hashToken(token));
  }

  res.clearCookie('cn_admin', { path: '/' });
  res.json({ ok: true });
});

/* =========================
   ADMIN OVERVIEW AND USERS
========================= */

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT COUNT(*) AS total FROM users'
  ).get().total;

  const pendingWithdrawals = db.prepare(`
    SELECT COUNT(*) AS total
    FROM withdrawals
    WHERE status = 'pending'
  `).get().total;

  const totalUserBalance = db.prepare(`
    SELECT COALESCE(SUM(balance), 0) AS total
    FROM users
  `).get().total;

  res.json({
    ok: true,
    stats: {
      users,
      pendingWithdrawals,
      totalUserBalance
    },
    settings: publicSettings()
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const page = integer(req.query.page, 1, 1, 100000);
  const limit = integer(req.query.limit, 50, 1, 100);

  const users = db.prepare(`
    SELECT
      id,
      tg_id AS telegramId,
      first_name AS firstName,
      last_name AS lastName,
      username,
      photo_url AS photoUrl,
      balance,
      total_mined AS totalMined,
      referrals,
      created_at AS createdAt
    FROM users
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(limit, (page - 1) * limit);

  res.json({ ok: true, page, limit, users });
});

/* =========================
   ADMIN WITHDRAWAL REQUESTS
========================= */

app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  const status = cleanText(req.query.status, 20);

  const allowedStatuses = ['pending', 'approved', 'paid', 'rejected'];

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid withdrawal status filter.'
    });
  }

  const query = `
    SELECT
      w.*,
      u.tg_id AS telegramId,
      u.username,
      u.first_name AS firstName,
      u.last_name AS lastName
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ${status ? 'WHERE w.status = ?' : ''}
    ORDER BY w.id DESC
    LIMIT 200
  `;

  const withdrawals = status
    ? db.prepare(query).all(status)
    : db.prepare(query).all();

  res.json({
    ok: true,
    withdrawals
  });
});

app.post('/api/admin/withdrawals/:id/status', requireAdmin, (req, res) => {
  const id = integer(req.params.id, 0, 1, 2147483647);
  const status = cleanText(req.body && req.body.status, 20);
  const adminNote = cleanText(req.body && req.body.adminNote, 500);

  const allowedStatuses = ['pending', 'approved', 'paid', 'rejected'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid withdrawal status.'
    });
  }

  const existing = db.prepare(
    'SELECT * FROM withdrawals WHERE id = ?'
  ).get(id);

  if (!existing) {
    return res.status(404).json({
      ok: false,
      error: 'Withdrawal request not found.'
    });
  }

  if (existing.status === 'paid' && status !== 'paid') {
    return res.status(400).json({
      ok: false,
      error: 'A paid withdrawal cannot be changed.'
    });
  }

  if (existing.status === 'rejected' && status !== 'rejected') {
    return res.status(400).json({
      ok: false,
      error: 'A rejected withdrawal cannot be reopened.'
    });
  }

  db.transaction(() => {
    if (status === 'rejected' && existing.status !== 'rejected') {
      db.prepare(`
        UPDATE users
        SET balance = balance + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(existing.amount, existing.user_id);
    }

    db.prepare(`
      UPDATE withdrawals
      SET status = ?,
          admin_note = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, adminNote, id);
  })();

  res.json({
    ok: true,
    message: 'Withdrawal status updated.'
  });
});

/* =========================
   ADMIN APP SETTINGS
========================= */

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const input = req.body && req.body.settings;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({
      ok: false,
      error: 'A settings object is required.'
    });
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
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

    const max = key === 'referralRequirement'
      ? 100
      : 1000000000;

    setSetting(
      key,
      String(integer(input[key], 0, 0, max))
    );
  }

  for (const key of booleanKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

    const value = input[key] === true || input[key] === 'true';

    setSetting(key, value ? 'true' : 'false');
  }

  for (const key of textKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

    setSetting(
      key,
      cleanText(input[key], key === 'welcomeText' ? 2000 : 100)
    );
  }

  for (const key of urlKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

    setSetting(key, validHttpUrl(input[key]));
  }

  res.json({
    ok: true,
    settings: publicSettings()
  });
});

/* =========================
   ADMIN WALLET MANAGEMENT
========================= */

/*
 * GET /api/admin/wallets
 * Returns wallet configuration for the Admin Panel.
 */
app.get('/api/admin/wallets', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    wallets: publicWalletConfig()
  });
});

/*
 * PUT /api/admin/wallets
 *
 * Example request body:
 * {
 *   "wallets": {
 *     "USDT": {
 *       "enabled": true,
 *       "name": "Binance USDT",
 *       "logo": "https://example.com/logo.png",
 *       "description": "Withdraw crypto",
 *       "feePercent": 10,
 *       "minimum": 10,
 *       "networks": [
 *         {
 *           "id": "TRX",
 *           "name": "TRX (TRC20)",
 *           "enabled": true,
 *           "feePercent": 10,
 *           "minimum": 10
 *         }
 *       ]
 *     }
 *   }
 * }
 */
app.put('/api/admin/wallets', requireAdmin, (req, res) => {
  const input = req.body && req.body.wallets;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({
      ok: false,
      error: 'A wallets object is required.'
    });
  }

  const allowedWallets = ['USDT', 'bKash', 'Nagad', 'Rocket'];
  const current = parseWalletConfig();

  for (const method of allowedWallets) {
    if (!Object.prototype.hasOwnProperty.call(input, method)) continue;

    const item = input[method];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid wallet configuration: ${method}`
      });
    }

    const networks = [];

    if (Array.isArray(item.networks)) {
      if (item.networks.length > 30) {
        return res.status(400).json({
          ok: false,
          error: 'Too many networks.'
        });
      }

      const networkIds = new Set();

      for (const network of item.networks) {
        const id = cleanText(network && network.id, 30);
        const name = cleanText(network && network.name, 80);

        if (!id || !name) {
          return res.status(400).json({
            ok: false,
            error: `Each ${method} network needs an ID and name.`
          });
        }

        if (networkIds.has(id)) {
          return res.status(400).json({
            ok: false,
            error: `Duplicate network ID: ${id}`
          });
        }

        networkIds.add(id);

        networks.push({
          id,
          name,
          description: cleanText(network.description, 200),
          enabled: network.enabled === true,
          feePercent: decimal(network.feePercent, 0, 0, 100),
          minimum: decimal(network.minimum, 0, 0, 1000000000)
        });
      }
    }

    current[method] = {
      enabled: item.enabled === true,
      name: cleanText(item.name, 80) || method,
      logo: validHttpUrl(item.logo || ''),
      description: cleanText(item.description, 500),
      feePercent: decimal(item.feePercent, 0, 0, 100),
      minimum: decimal(item.minimum, 0, 0, 1000000000),
      networks
    };
  }

  setSetting('walletConfig', JSON.stringify(current));

  res.json({
    ok: true,
    wallets: publicWalletConfig(),
    message: 'Wallet settings saved.'
  });
});

/* =========================
   ADMIN TASK MANAGEMENT
========================= */

app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  const tasks = db.prepare(
    'SELECT * FROM tasks ORDER BY id DESC'
  ).all();

  res.json({ ok: true, tasks });
});

app.post('/api/admin/tasks', requireAdmin, (req, res) => {
  const title = cleanText(req.body && req.body.title, 120);
  const description = cleanText(req.body && req.body.description, 500);
  const url = validHttpUrl(req.body && req.body.url);
  const reward = integer(req.body && req.body.reward, 0, 0, 100000000);
  const active = req.body && req.body.active === false ? 0 : 1;

  if (!title) {
    return res.status(400).json({
      ok: false,
      error: 'Task title is required.'
    });
  }

  const result = db.prepare(`
    INSERT INTO tasks(title, description, url, reward, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, description, url, reward, active);

  res.json({
    ok: true,
    task: db.prepare(
      'SELECT * FROM tasks WHERE id = ?'
    ).get(result.lastInsertRowid)
  });
});

app.put('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const id = integer(req.params.id, 0, 1, 2147483647);

  const existing = db.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ).get(id);

  if (!existing) {
    return res.status(404).json({
      ok: false,
      error: 'Task not found.'
    });
  }

  const input = req.body || {};

  const title = Object.prototype.hasOwnProperty.call(input, 'title')
    ? cleanText(input.title, 120)
    : existing.title;

  const description = Object.prototype.hasOwnProperty.call(input, 'description')
    ? cleanText(input.description, 500)
    : existing.description;

  const url = Object.prototype.hasOwnProperty.call(input, 'url')
    ? validHttpUrl(input.url)
    : existing.url;

  const reward = Object.prototype.hasOwnProperty.call(input, 'reward')
    ? integer(input.reward, existing.reward, 0, 100000000)
    : existing.reward;

  const active = Object.prototype.hasOwnProperty.call(input, 'active')
    ? (input.active === true || input.active === 'true' ? 1 : 0)
    : existing.active;

  if (!title) {
    return res.status(400).json({
      ok: false,
      error: 'Task title is required.'
    });
  }

  db.prepare(`
    UPDATE tasks
    SET title = ?,
        description = ?,
        url = ?,
        reward = ?,
        active = ?
    WHERE id = ?
  `).run(title, description, url, reward, active, id);

  res.json({ ok: true });
});

app.delete('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const id = integer(req.params.id, 0, 1, 2147483647);

  const result = db.prepare(
    'DELETE FROM tasks WHERE id = ?'
  ).run(id);

  if (!result.changes) {
    return res.status(404).json({
      ok: false,
      error: 'Task not found.'
    });
  }

  res.json({ ok: true });
});

/* =========================
   STATIC FILES
========================= */

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
    error: 'Not found. Ensure index.html and Admin.html are inside the public folder.'
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error('Request failed:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: 'Internal server error.'
  });
});

/* =========================
   START SERVER
========================= */

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`CoinNova server listening on port ${PORT}`);
});

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } catch {}

    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
