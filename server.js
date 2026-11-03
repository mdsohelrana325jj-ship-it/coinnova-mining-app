require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === "production";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

const dbPath =
  process.env.DB_PATH ||
  path.join(__dirname, "data", "coinnova.sqlite");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

if (
  PROD &&
  (!BOT_TOKEN ||
    ADMIN_PASSWORD.length < 12 ||
    SESSION_SECRET.length < 32)
) {
  console.warn(
    "WARNING: Set BOT_TOKEN, ADMIN_PASSWORD (12+ chars), and SESSION_SECRET (32+ chars) in Render environment variables."
  );
}

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "50kb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

const now = () => Date.now();

function cleanText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function validUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bdDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function dayStartBd(timestamp = Date.now()) {
  const date = bdDate(timestamp);
  const [year, month, day] = date.split("-").map(Number);

  return Date.UTC(year, month - 1, day) -
    6 * 60 * 60 * 1000;
}

/* =========================================================
   DATABASE
========================================================= */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  username TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 1000,
  total_taps INTEGER NOT NULL DEFAULT 0,
  spins_available INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  reward INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, task_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL,
  invited_user_id INTEGER NOT NULL UNIQUE,
  qualified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(inviter_id) REFERENCES users(id),
  FOREIGN KEY(invited_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  address TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  txid TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spin_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS spin_grants (
  inviter_id INTEGER PRIMARY KEY,
  total_granted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(inviter_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS commission_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beneficiary_id INTEGER NOT NULL,
  source_user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  level INTEGER NOT NULL,
  base_amount INTEGER NOT NULL,
  rate REAL NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(beneficiary_id, source_user_id, day, level),
  FOREIGN KEY(beneficiary_id) REFERENCES users(id),
  FOREIGN KEY(source_user_id) REFERENCES users(id)
);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("users", "username", "TEXT DEFAULT ''");
addColumnIfMissing("users", "photo_url", "TEXT DEFAULT ''");
addColumnIfMissing("users", "balance", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "energy", "INTEGER NOT NULL DEFAULT 1000");
addColumnIfMissing("users", "total_taps", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "spins_available", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "is_banned", "INTEGER NOT NULL DEFAULT 0");

/* =========================================================
   CENTRAL SETTINGS
   All User Panel text, logos, categories and visual controls
   are stored here and delivered through /api/settings.
========================================================= */

const defaultSettings = {
  appName: "CoinNova",
  tagline: "Tap • Mine • Earn",

  appLogo: "",
  loadingImage: "",
  loadingEnabled: true,
  loadingTitle: "CoinNova",
  loadingMessage: "Preparing your mining dashboard...",
  loadingDuration: 1200,

  theme: {
    background: "#080c17",
    card: "#121c30",
    accent: "#ffcc55",
    text: "#f4f6ff",
    muted: "#9ba9c3",
    border: "#263957",
    buttonAnimation: "pulse"
  },

  messages: {
    homeTitle: "CoinNova",
    homeSubtitle: "Tap • Mine • Earn",
    walletTitle: "Wallet",
    withdrawTitle: "Withdraw",
    withdrawSubtitle: "Secure payout",
    withdrawNotice:
      "Select a withdrawal category first. E-Wallet and Binance use separate selection screens. Verify the destination carefully before submitting.",
    backToWithdraw: "← Back to Withdraw",
    eWalletTitle: "E-Wallet",
    binanceTitle: "Binance",
    selectNetworkTitle: "Select Network",
    selectNetworkDescription:
      "Choose a network before entering your wallet address.",
    amountLabel: "Withdrawal Amount",
    addressLabel: "Wallet Address / Account Number",
    submitWithdraw: "Submit Withdrawal",
    withdrawHistory: "Withdrawal History",
    noWithdrawals: "No withdrawal requests yet.",
    available: "available",
    mobileMoney: "Mobile money",
    securePayout: "Secure payout",
    minimumLabel: "Minimum",
    feeLabel: "Fee",
    loading: "Loading...",
    errorTitle: "Something went wrong",
    successTitle: "Success",
    insufficientBalance: "Insufficient balance.",
    chooseMethod: "Choose a withdrawal method.",
    enterAmount: "Enter a valid withdrawal amount.",
    enterAddress: "Enter your wallet address or account number.",
    withdrawSubmitted: "Withdrawal request submitted.",
    noTasks: "No tasks available right now.",
    tasksTitle: "Tasks",
    spinTitle: "Lucky Spin",
    friendsTitle: "Friends",
    homeTab: "Home",
    tasksTab: "Tasks",
    spinTab: "Spin",
    friendsTab: "Friends",
    walletTab: "Wallet",
    referralTitle: "Invite Friends",
    referralDescription: "Invite friends and earn rewards.",
    copyReferral: "Copy Referral Link",
    copied: "Copied!",
    spinButton: "SPIN NOW",
    noSpins: "No spins available. Invite friends to earn spins.",
    spinReward: "You won",
    dailyReward: "Daily Reward",
    claimReward: "Claim Reward",
    maintenance: "The app is currently under maintenance."
  },

  withdrawalCategories: [
    {
      id: "ewallet",
      name: "E-Wallet",
      logo: "",
      description: "Mobile money",
      enabled: true,
      color: "#ffcc55",
      animation: "pulse"
    },
    {
      id: "binance",
      name: "Binance",
      logo: "https://cdn.simpleicons.org/binance/F0B90B",
      description: "Crypto wallet and network",
      enabled: true,
      color: "#ffcc55",
      animation: "pulse"
    }
  ],

  tapReward: 1,
  maxEnergy: 1000,
  energyPerSecond: 3,
  dailyBonus: 50,
  minWithdraw: 1000,
  referralRequired: 1,
  referralBonus: 100,
  maintenance: false,
  sound: true,

  referralsPerSpin: 1,
  spinEnabled: true,
  spinRewards: [10, 20, 30, 50, 100, 200],

  commissionEnabled: true,
  commissionRates: [10, 5, 3, 2, 1, 1],

  paymentMethods: [
    {
      id: "bkash",
      name: "bKash",
      type: "mobile",
      category: "ewallet",
      description: "Mobile money",
      enabled: true,
      logo: "https://cdn.simpleicons.org/bkash/E2136E",
      color: "#E2136E",
      animation: "pulse",
      feePercent: 0,
      minimum: 100
    },
    {
      id: "nagad",
      name: "Nagad",
      type: "mobile",
      category: "ewallet",
      description: "Mobile money",
      enabled: true,
      logo: "",
      color: "#F6921E",
      animation: "pulse",
      feePercent: 0,
      minimum: 100
    },
    {
      id: "rocket",
      name: "Rocket",
      type: "mobile",
      category: "ewallet",
      description: "Mobile money",
      enabled: true,
      logo: "",
      color: "#8B1E8B",
      animation: "pulse",
      feePercent: 0,
      minimum: 100
    },
    {
      id: "usdt_trc20",
      name: "USDT TRC20",
      type: "crypto",
      category: "binance",
      network: "TRC20",
      description: "TRON Network",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B",
      color: "#26A17B",
      animation: "pulse",
      feePercent: 0,
      minimum: 1000
    },
    {
      id: "usdt_bep20",
      name: "USDT BEP20",
      type: "crypto",
      category: "binance",
      network: "BEP20",
      description: "BNB Smart Chain",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B",
      color: "#F0B90B",
      animation: "pulse",
      feePercent: 0,
      minimum: 1000
    },
    {
      id: "binance_pay",
      name: "Binance Pay",
      type: "crypto",
      category: "binance",
      description: "Binance Pay ID",
      enabled: true,
      logo: "https://cdn.simpleicons.org/binance/F0B90B",
      color: "#F0B90B",
      animation: "pulse",
      feePercent: 0,
      minimum: 1000
    }
  ],

  updatedAt: now()
};

const getSettingRow = db.prepare(
  "SELECT value FROM settings WHERE key=?"
);

const setSettingRow = db.prepare(`
  INSERT INTO settings(key,value)
  VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

function getSettings() {
  const row = getSettingRow.get("main");

  if (!row) {
    saveSettings(defaultSettings);
    return JSON.parse(JSON.stringify(defaultSettings));
  }

  const saved = safeJson(row.value, {});
  return {
    ...JSON.parse(JSON.stringify(defaultSettings)),
    ...saved,
    theme: {
      ...defaultSettings.theme,
      ...(saved.theme || {})
    },
    messages: {
      ...defaultSettings.messages,
      ...(saved.messages || {})
    },
    withdrawalCategories: Array.isArray(saved.withdrawalCategories)
      ? saved.withdrawalCategories
      : defaultSettings.withdrawalCategories,
    paymentMethods: Array.isArray(saved.paymentMethods)
      ? saved.paymentMethods
      : defaultSettings.paymentMethods
  };
}

function saveSettings(settings) {
  settings.updatedAt = now();
  setSettingRow.run("main", JSON.stringify(settings));
  return settings;
}

if (!getSettingRow.get("main")) {
  saveSettings(defaultSettings);
}

/* =========================================================
   TASK SEED DATA
========================================================= */

if (db.prepare("SELECT COUNT(*) n FROM tasks").get().n === 0) {
  const insertTask = db.prepare(`
    INSERT INTO tasks(title,platform,url,reward,enabled,created_at)
    VALUES(?,?,?,?,1,?)
  `);

  [
    ["Join our Telegram", "Telegram", "https://telegram.org", 100],
    ["Watch on YouTube", "YouTube", "https://youtube.com", 100],
    ["Follow on TikTok", "TikTok", "https://tiktok.com", 100],
    ["Follow on Facebook", "Facebook", "https://facebook.com", 100],
    ["Follow on Instagram", "Instagram", "https://instagram.com", 100],
    ["Follow on X", "X", "https://x.com", 100]
  ].forEach(task => insertTask.run(...task, now()));
}

/* =========================================================
   AUTHENTICATION HELPERS
========================================================= */

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function setAuthCookie(res, name, token, maxAge) {
  res.cookie(name, token, {
    httpOnly: true,
    secure: PROD,
    sameSite: "lax",
    path: "/",
    maxAge
  });
}

function clearAuthCookie(res, name) {
  res.clearCookie(name, {
    httpOnly: true,
    secure: PROD,
    sameSite: "lax",
    path: "/"
  });
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username || "",
    photoUrl: user.photo_url || "",
    balance: user.balance,
    energy: user.energy,
    maxEnergy: getSettings().maxEnergy,
    totalTaps: user.total_taps,
    spinsAvailable: user.spins_available || 0,
    createdAt: user.created_at,
    referralCode: user.tg_id
  };
}

function auth(req, res, next) {
  const token = req.cookies.cn_session;

  if (!token) {
    return res.status(401).json({ error: "Please sign in." });
  }

  const session = db.prepare(`
    SELECT user_id
    FROM sessions
    WHERE token_hash=? AND expires_at>?
  `).get(hashToken(token), now());

  if (!session) {
    clearAuthCookie(res, "cn_session");
    return res.status(401).json({ error: "Session expired." });
  }

  req.user = getUserById(session.user_id);

  if (!req.user) {
    return res.status(401).json({ error: "User not found." });
  }

  next();
}

function requireUser(req, res, next) {
  if (req.user.is_banned) {
    return res.status(403).json({ error: "This account is disabled." });
  }

  next();
}

function adminAuth(req, res, next) {
  const token = req.cookies.cn_admin;

  if (!token) {
    return res.status(401).json({ error: "Admin login required." });
  }

  const session = db.prepare(`
    SELECT id
    FROM admin_sessions
    WHERE token_hash=? AND expires_at>?
  `).get(hashToken(token), now());

  if (!session) {
    clearAuthCookie(res, "cn_admin");
    return res.status(401).json({ error: "Admin session expired." });
  }

  next();
}

function recordEarning(userId, amount, source) {
  const value = Math.floor(Number(amount));

  if (!Number.isSafeInteger(value) || value <= 0) return;

  db.prepare(`
    INSERT INTO earnings(user_id,amount,source,created_at)
    VALUES(?,?,?,?)
  `).run(userId, value, source, now());
}

function countQualifiedReferrals(userId) {
  return db.prepare(`
    SELECT COUNT(*) n
    FROM referrals
    WHERE inviter_id=? AND qualified=1
  `).get(userId).n;
}

function levelAncestors(userId, maxLevel = 6) {
  const result = [];
  let current = userId;

  for (let level = 1; level <= maxLevel; level++) {
    const row = db.prepare(`
      SELECT inviter_id
      FROM referrals
      WHERE invited_user_id=? AND qualified=1
    `).get(current);

    if (!row) break;

    result.push({
      userId: row.inviter_id,
      level
    });

    current = row.inviter_id;
  }

  return result;
}

function teamStats(userId) {
  const levels = [];
  let frontier = [userId];

  for (let level = 1; level <= 6; level++) {
    if (!frontier.length) {
      levels.push({
        level,
        members: 0,
        todayMembers: 0,
        todayCoins: 0,
        commissionToday: 0
      });
      continue;
    }

    const placeholders = frontier.map(() => "?").join(",");

    const rows = db.prepare(`
      SELECT id,created_at
      FROM users
      WHERE id IN (
        SELECT invited_user_id
        FROM referrals
        WHERE qualified=1
          AND inviter_id IN (${placeholders})
      )
    `).all(...frontier);

    const ids = rows.map(row => row.id);
    let todayCoins = 0;
    let commissionToday = 0;

    if (ids.length) {
      const qs = ids.map(() => "?").join(",");

      todayCoins = db.prepare(`
        SELECT COALESCE(SUM(amount),0) n
        FROM earnings
        WHERE user_id IN (${qs})
          AND created_at>=?
          AND created_at<?
      `).get(
        ...ids,
        dayStartBd(),
        dayStartBd() + 86400000
      ).n;

      commissionToday = db.prepare(`
        SELECT COALESCE(SUM(amount),0) n
        FROM commission_payouts
        WHERE beneficiary_id=?
          AND level=?
          AND created_at>=?
          AND created_at<?
      `).get(
        userId,
        level,
        dayStartBd(),
        dayStartBd() + 86400000
      ).n;
    }

    levels.push({
      level,
      members: ids.length,
      todayMembers: rows.filter(
        row => bdDate(row.created_at) === bdDate()
      ).length,
      todayCoins,
      commissionToday
    });

    frontier = ids;
  }

  return levels;
}

/* =========================================================
   DAILY COMMISSION PROCESSOR
   Uses Asia/Dhaka timezone. Idempotency is enforced by the
   UNIQUE key in commission_payouts.
========================================================= */

function payDailyCommissions() {
  const settings = getSettings();

  if (!settings.commissionEnabled) return;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const time = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  if (Number(time.hour) < 1) return;

  const yesterday = bdDate(Date.now() - 86400000);
  const end = dayStartBd();
  const start = end - 86400000;

  const earners = db.prepare(`
    SELECT DISTINCT user_id
    FROM earnings
    WHERE created_at>=? AND created_at<?
  `).all(start, end);

  const transaction = db.transaction(() => {
    for (const earner of earners) {
      const earned = db.prepare(`
        SELECT COALESCE(SUM(amount),0) n
        FROM earnings
        WHERE user_id=? AND created_at>=? AND created_at<?
      `).get(earner.user_id, start, end).n;

      if (earned <= 0) continue;

      for (const ancestor of levelAncestors(earner.user_id, 6)) {
        const rate = Number(
          (settings.commissionRates || [])[ancestor.level - 1] || 0
        );

        const amount = Math.floor(earned * rate / 100);

        if (rate <= 0 || amount <= 0) continue;

        const inserted = db.prepare(`
          INSERT OR IGNORE INTO commission_payouts
          (
            beneficiary_id,source_user_id,day,level,
            base_amount,rate,amount,created_at
          )
          VALUES(?,?,?,?,?,?,?,?)
        `).run(
          ancestor.userId,
          earner.user_id,
          yesterday,
          ancestor.level,
          earned,
          rate,
          amount,
          now()
        );

        if (inserted.changes) {
          db.prepare(`
            UPDATE users
            SET balance=balance+?
            WHERE id=?
          `).run(amount, ancestor.userId);
        }
      }
    }
  });

  try {
    transaction();
  } catch (error) {
    console.error("Daily commission payout failed:", error.message);
  }
}

setInterval(payDailyCommissions, 60 * 1000);

/* =========================================================
   HEALTH AND PUBLIC SETTINGS
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "CoinNova",
    timestamp: now()
  });
});

app.get("/api/settings", (req, res) => {
  const settings = getSettings();

  res.json({
    ...settings,
    paymentMethods: settings.paymentMethods.filter(method => method.enabled),
    withdrawalCategories: settings.withdrawalCategories.filter(
      category => category.enabled
    )
  });
});

/* =========================================================
   TELEGRAM WEB APP AUTHENTICATION
========================================================= */

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const entries = [...params.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const dataCheckString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  const provided = Buffer.from(hash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");

  if (
    provided.length !== calculated.length ||
    !crypto.timingSafeEqual(provided, calculated)
  ) {
    return null;
  }

  const authDate = Number(params.get("auth_date") || 0);

  if (
    !Number.isFinite(authDate) ||
    Math.floor(Date.now() / 1000) - authDate > 86400
  ) {
    return null;
  }

  const user = safeJson(params.get("user") || "{}", null);

  if (!user || !user.id) return null;

  return user;
}

app.post(
  "/api/auth/telegram",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 30
  }),
  (req, res) => {
    const telegramUser = verifyTelegramInitData(
      req.body?.initData
    );

    if (!telegramUser) {
      return res.status(401).json({
        error: "Telegram verification failed. Open this app inside Telegram."
      });
    }

    const telegramId = String(telegramUser.id);

    const firstName = cleanText(telegramUser.first_name, 80);
    const lastName = cleanText(telegramUser.last_name, 80);

    const name = `${firstName} ${lastName}`.trim() || "CoinNova User";
    const username = cleanText(telegramUser.username, 80);
    const photoUrl = validUrl(telegramUser.photo_url)
      ? telegramUser.photo_url
      : "";

    let user = db.prepare(`
      SELECT * FROM users WHERE tg_id=?
    `).get(telegramId);

    if (!user) {
      const result = db.prepare(`
        INSERT INTO users
        (
          tg_id,name,username,photo_url,
          balance,energy,created_at
        )
        VALUES(?,?,?,?,0,?,?,?)
      `);

      /*
       * Explicit insertion below avoids accepting any client-supplied
       * balance or reward values.
       */
      const created = db.prepare(`
        INSERT INTO users
        (
          tg_id,name,username,photo_url,
          balance,energy,created_at
        )
        VALUES(?,?,?,?,0,?,?)
      `).run(
        telegramId,
        name,
        username,
        photoUrl,
        getSettings().maxEnergy,
        now()
      );

      user = getUserById(created.lastInsertRowid);

      const startParam = cleanText(req.body?.startParam, 100);
      const referralMatch = startParam.match(/^ref_(\d+)$/);

      if (referralMatch && referralMatch[1] !== telegramId) {
        const inviter = db.prepare(`
          SELECT id FROM users WHERE tg_id=?
        `).get(referralMatch[1]);

        if (inviter && inviter.id !== user.id) {
          db.prepare(`
            INSERT OR IGNORE INTO referrals
            (inviter_id,invited_user_id,qualified,created_at)
            VALUES(?,?,0,?)
          `).run(inviter.id, user.id, now());
        }
      }
    } else {
      db.prepare(`
        UPDATE users
        SET name=?,username=?,photo_url=?
        WHERE id=?
      `).run(name, username, photoUrl, user.id);

      user = getUserById(user.id);
    }

    const token = makeToken();

    db.prepare(`
      INSERT INTO sessions(user_id,token_hash,expires_at,created_at)
      VALUES(?,?,?,?)
    `).run(
      user.id,
      hashToken(token),
      now() + 30 * 86400000,
      now()
    );

    setAuthCookie(res, "cn_session", token, 30 * 86400000);

    res.json({
      ok: true,
      user: publicUser(user),
      settings: getSettings()
    });
  }
);

app.get("/api/me", auth, requireUser, (req, res) => {
  const settings = getSettings();

  res.json({
    user: publicUser(req.user),
    settings,
    tasks: db.prepare(`
      SELECT
        t.id,t.title,t.platform,t.url,t.reward,t.enabled,
        ut.status
      FROM tasks t
      LEFT JOIN user_tasks ut
        ON ut.task_id=t.id AND ut.user_id=?
      WHERE t.enabled=1
      ORDER BY t.id DESC
    `).all(req.user.id),
    referralUrl: BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?startapp=ref_${req.user.tg_id}`
      : "",
    referrals: countQualifiedReferrals(req.user.id),
    spinHistory: db.prepare(`
      SELECT reward,created_at AS createdAt
      FROM spin_history
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 10
    `).all(req.user.id),
    commissionLevels: teamStats(req.user.id),
    commissionToday: db.prepare(`
      SELECT COALESCE(SUM(amount),0) n
      FROM commission_payouts
      WHERE beneficiary_id=? AND day=?
    `).get(req.user.id, bdDate()).n,
    withdrawals: db.prepare(`
      SELECT
        id,method,address,amount,status,txid,note,
        created_at AS createdAt
      FROM withdrawals
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 20
    `).all(req.user.id)
  });
});

/* =========================================================
   LOGOUT
========================================================= */

app.post("/api/logout", (req, res) => {
  const token = req.cookies.cn_session;
  const adminToken = req.cookies.cn_admin;

  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(hashToken(token));
  }

  if (adminToken) {
    db.prepare("DELETE FROM admin_sessions WHERE token_hash=?")
      .run(hashToken(adminToken));
  }

  clearAuthCookie(res, "cn_session");
  clearAuthCookie(res, "cn_admin");

  res.json({ ok: true });
});

/* =========================================================
   MINING / TAP
========================================================= */

app.post("/api/tap", auth, requireUser, (req, res) => {
  const settings = getSettings();
  const user = getUserById(req.user.id);

  if (settings.maintenance) {
    return res.status(503).json({
      error: settings.messages.maintenance
    });
  }

  if (user.energy < 1) {
    return res.status(400).json({ error: "Not enough energy." });
  }

  const reward = Math.max(
    0,
    Math.floor(Number(settings.tapReward) || 0)
  );

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET energy=energy-1,
          balance=balance+?,
          total_taps=total_taps+1
      WHERE id=?
    `).run(reward, user.id);

    recordEarning(user.id, reward, "tap");
  });

  tx();

  res.json({
    user: publicUser(getUserById(user.id)),
    reward
  });
});

/* =========================================================
   DAILY BONUS
========================================================= */

app.post("/api/daily", auth, requireUser, (req, res) => {
  const settings = getSettings();

  const row = db.prepare(`
    SELECT created_at
    FROM earnings
    WHERE user_id=? AND source='daily_bonus'
    ORDER BY id DESC LIMIT 1
  `).get(req.user.id);

  if (row && bdDate(row.created_at) === bdDate()) {
    return res.status(400).json({
      error: "Daily reward already claimed."
    });
  }

  const reward = Math.max(0, Math.floor(settings.dailyBonus));

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE users SET balance=balance+? WHERE id=?
    `).run(reward, req.user.id);

    recordEarning(req.user.id, reward, "daily_bonus");
  });

  tx();

  res.json({
    reward,
    user: publicUser(getUserById(req.user.id))
  });
});

/* =========================================================
   TASKS
========================================================= */

app.post("/api/tasks/:id/claim", auth, requireUser, (req, res) => {
  const task = db.prepare(`
    SELECT * FROM tasks
    WHERE id=? AND enabled=1
  `).get(Number(req.params.id));

  if (!task) {
    return res.status(404).json({ error: "Task not found." });
  }

  const already = db.prepare(`
    SELECT id FROM user_tasks
    WHERE user_id=? AND task_id=?
  `).get(req.user.id, task.id);

  if (already) {
    return res.status(400).json({
      error: "This task has already been claimed."
    });
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO user_tasks(user_id,task_id,status,created_at)
      VALUES(?,?,?,?)
    `).run(req.user.id, task.id, "completed", now());

    db.prepare(`
      UPDATE users SET balance=balance+? WHERE id=?
    `).run(task.reward, req.user.id);

    recordEarning(req.user.id, task.reward, "task");
  });

  tx();

  res.json({
    reward: task.reward,
    user: publicUser(getUserById(req.user.id))
  });
});

/* =========================================================
   LUCKY SPIN
========================================================= */

app.post("/api/spin", auth, requireUser, (req, res) => {
  const settings = getSettings();

  if (!settings.spinEnabled) {
    return res.status(403).json({
      error: "Lucky Spin is currently disabled."
    });
  }

  const user = getUserById(req.user.id);

  if ((user.spins_available || 0) < 1) {
    return res.status(400).json({
      error: settings.messages.noSpins
    });
  }

  const rewards = (settings.spinRewards || [])
    .map(Number)
    .filter(value =>
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 100000000
    );

  if (!rewards.length) {
    return res.status(503).json({
      error: "Spin rewards are not configured."
    });
  }

  const reward = rewards[crypto.randomInt(rewards.length)];

  const tx = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE users
      SET spins_available=spins_available-1,
          balance=balance+?
      WHERE id=? AND spins_available>0
    `).run(reward, user.id);

    if (!changed.changes) {
      throw new Error("No spins available.");
    }

    db.prepare(`
      INSERT INTO spin_history(user_id,reward,created_at)
      VALUES(?,?,?)
    `).run(user.id, reward, now());

    recordEarning(user.id, reward, "spin");
  });

  try {
    tx();

    res.json({
      reward,
      user: publicUser(getUserById(user.id))
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* =========================================================
   REFERRAL COMMISSIONS
========================================================= */

app.get("/api/commissions", auth, requireUser, (req, res) => {
  const userId = req.user.id;

  const totalToday = db.prepare(`
    SELECT COALESCE(SUM(amount),0) n
    FROM commission_payouts
    WHERE beneficiary_id=? AND created_at>=? AND created_at<?
  `).get(
    userId,
    dayStartBd(),
    dayStartBd() + 86400000
  ).n;

  const history = db.prepare(`
    SELECT
      day,level,amount,
      base_amount AS baseAmount,
      rate,
      created_at AS createdAt
    FROM commission_payouts
    WHERE beneficiary_id=?
    ORDER BY id DESC
    LIMIT 50
  `).all(userId);

  res.json({
    today: bdDate(),
    total: totalToday,
    levels: teamStats(userId),
    history,
    rates: getSettings().commissionRates,
    enabled: !!getSettings().commissionEnabled
  });
});

/* =========================================================
   WITHDRAWALS
========================================================= */

app.post("/api/withdraw", auth, requireUser, (req, res) => {
  const settings = getSettings();

  if (!settings.withdrawalEnabled && settings.withdrawalEnabled !== undefined) {
    return res.status(403).json({
      error: "Withdrawals are currently disabled."
    });
  }

  const methodId = cleanText(req.body?.method, 60);
  const address = cleanText(req.body?.address, 300);
  const amount = Math.floor(Number(req.body?.amount));

  const method = settings.paymentMethods.find(
    item => item.id === methodId && item.enabled
  );

  if (!method) {
    return res.status(400).json({
      error: settings.messages.chooseMethod
    });
  }

  if (!address) {
    return res.status(400).json({
      error: settings.messages.enterAddress
    });
  }

  if (
    !Number.isSafeInteger(amount) ||
    amount < Math.max(
      Number(settings.minWithdraw) || 0,
      Number(method.minimum) || 0
    )
  ) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${Math.max(
        Number(settings.minWithdraw) || 0,
        Number(method.minimum) || 0
      )} coins.`
    });
  }

  const user = getUserById(req.user.id);

  if (user.balance < amount) {
    return res.status(400).json({
      error: settings.messages.insufficientBalance
    });
  }

  const tx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE users
      SET balance=balance-?
      WHERE id=? AND balance>=?
    `).run(amount, user.id, amount);

    if (!result.changes) {
      throw new Error("Insufficient balance.");
    }

    return db.prepare(`
      INSERT INTO withdrawals
      (
        user_id,method,address,amount,status,
        created_at,updated_at
      )
      VALUES(?,?,?,?,'pending',?,?)
    `).run(
      user.id,
      methodId,
      address,
      amount,
      now(),
      now()
    ).lastInsertRowid;
  });

  try {
    const withdrawalId = tx();

    res.json({
      ok: true,
      id: withdrawalId,
      message: settings.messages.withdrawSubmitted,
      user: publicUser(getUserById(user.id))
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/auth/admin",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10
  }),
  async (req, res) => {
    const password = String(req.body?.password || "");

    if (!ADMIN_PASSWORD) {
      return res.status(503).json({
        error: "Set ADMIN_PASSWORD in the Render environment."
      });
    }

    const matches = crypto.timingSafeEqual(
      Buffer.from(
        crypto.createHash("sha256").update(password).digest("hex")
      ),
      Buffer.from(
        crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex")
      )
    );

    if (!matches) {
      return res.status(401).json({
        error: "Incorrect admin password."
      });
    }

    const token = makeToken();

    db.prepare(`
      INSERT INTO admin_sessions(token_hash,expires_at,created_at)
      VALUES(?,?,?)
    `).run(
      hashToken(token),
      now() + 12 * 60 * 60 * 1000,
      now()
    );

    setAuthCookie(res, "cn_admin", token, 12 * 60 * 60 * 1000);

    res.json({ ok: true });
  }
);

app.post("/api/admin/login-check", adminAuth, (req, res) => {
  res.json({ ok: true });
});

/* =========================================================
   ADMIN OVERVIEW
========================================================= */

app.get("/api/admin/overview", adminAuth, (req, res) => {
  const counts = {
    users: db.prepare(
      "SELECT COUNT(*) n FROM users"
    ).get().n,

    banned: db.prepare(
      "SELECT COUNT(*) n FROM users WHERE is_banned=1"
    ).get().n,

    withdrawPending: db.prepare(
      "SELECT COUNT(*) n FROM withdrawals WHERE status='pending'"
    ).get().n,

    withdrawTotal: db.prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM withdrawals"
    ).get().n,

    coins: db.prepare(
      "SELECT COALESCE(SUM(balance),0) n FROM users"
    ).get().n,

    taps: db.prepare(
      "SELECT COALESCE(SUM(total_taps),0) n FROM users"
    ).get().n,

    spinAvailable: db.prepare(
      "SELECT COALESCE(SUM(spins_available),0) n FROM users"
    ).get().n,

    commissionToday: db.prepare(`
      SELECT COALESCE(SUM(amount),0) n
      FROM commission_payouts
      WHERE created_at>=? AND created_at<?
    `).get(dayStartBd(), dayStartBd() + 86400000).n
  };

  const withdrawals = db.prepare(`
    SELECT
      w.*,
      u.name AS userName,
      u.tg_id AS tgId
    FROM withdrawals w
    JOIN users u ON u.id=w.user_id
    ORDER BY w.id DESC
    LIMIT 100
  `).all();

  const users = db.prepare(`
    SELECT
      id,tg_id,name,username,balance,energy,
      created_at,is_banned,total_taps,spins_available
    FROM users
    ORDER BY id DESC
    LIMIT 200
  `).all();

  res.json({
    counts,
    settings: getSettings(),
    tasks: db.prepare(
      "SELECT * FROM tasks ORDER BY id DESC"
    ).all(),
    withdrawals,
    users
  });
});

/* =========================================================
   ADMIN SETTINGS
   Unknown keys are preserved so new UI settings can be added
   without overwriting settings belonging to other features.
========================================================= */

app.put("/api/admin/settings", adminAuth, (req, res) => {
  const oldSettings = getSettings();
  const incoming = req.body || {};

  const next = {
    ...oldSettings,
    ...incoming,
    theme: {
      ...oldSettings.theme,
      ...(incoming.theme || {})
    },
    messages: {
      ...oldSettings.messages,
      ...(incoming.messages || {})
    }
  };

  for (const key of ["appName", "tagline", "appLogo", "loadingImage", "loadingTitle", "loadingMessage"]) {
    if (typeof incoming[key] === "string") {
      if (["appLogo", "loadingImage"].includes(key)) {
        next[key] = incoming[key] === "" || validUrl(incoming[key])
          ? incoming[key]
          : oldSettings[key] || "";
      } else {
        next[key] = cleanText(incoming[key], 300);
      }
    }
  }

  const numberKeys = [
    "tapReward",
    "maxEnergy",
    "energyPerSecond",
    "dailyBonus",
    "minWithdraw",
    "referralRequired",
    "referralBonus",
    "referralsPerSpin",
    "loadingDuration"
  ];

  for (const key of numberKeys) {
    if (incoming[key] !== undefined && Number.isFinite(Number(incoming[key]))) {
      next[key] = Math.max(
        0,
        Math.min(100000000, Math.floor(Number(incoming[key])))
      );
    }
  }

  for (const key of [
    "maintenance",
    "sound",
    "spinEnabled",
    "commissionEnabled",
    "loadingEnabled",
    "withdrawalEnabled",
    "miningEnabled",
    "registrationEnabled"
  ]) {
    if (typeof incoming[key] === "boolean") {
      next[key] = incoming[key];
    }
  }

  if (Array.isArray(incoming.spinRewards)) {
    const rewards = incoming.spinRewards
      .map(Number)
      .filter(value =>
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 100000000
      )
      .slice(0, 20);

    if (rewards.length) next.spinRewards = rewards;
  }

  if (Array.isArray(incoming.commissionRates)) {
    next.commissionRates = Array.from(
      { length: 6 },
      (_, index) => Math.max(
        0,
        Math.min(100, Number(incoming.commissionRates[index]) || 0)
      )
    );
  }

  if (incoming.theme && typeof incoming.theme === "object") {
    for (const key of Object.keys(oldSettings.theme)) {
      if (typeof incoming.theme[key] === "string") {
        next.theme[key] = cleanText(incoming.theme[key], 100);
      }
    }
  }

  if (incoming.messages && typeof incoming.messages === "object") {
    for (const [key, value] of Object.entries(incoming.messages)) {
      if (typeof value === "string") {
        next.messages[key] = cleanText(value, 1000);
      }
    }
  }

  if (Array.isArray(incoming.withdrawalCategories)) {
    next.withdrawalCategories = incoming.withdrawalCategories
      .slice(0, 10)
      .map((category, index) => ({
        id: cleanText(category.id || `category_${index + 1}`, 40)
          .replace(/[^a-zA-Z0-9_-]/g, ""),
        name: cleanText(category.name, 60),
        logo: category.logo && validUrl(category.logo)
          ? category.logo
          : "",
        description: cleanText(category.description, 250),
        enabled: category.enabled !== false,
        color: /^#[0-9a-fA-F]{6}$/.test(category.color || "")
          ? category.color
          : "#ffcc55",
        animation: cleanText(category.animation || "pulse", 30)
      }))
      .filter(category => category.id && category.name);
  }

  if (Array.isArray(incoming.paymentMethods)) {
    next.paymentMethods = incoming.paymentMethods
      .slice(0, 50)
      .map((method, index) => ({
        id: cleanText(method.id || `method_${index + 1}`, 60)
          .replace(/[^a-zA-Z0-9_-]/g, ""),
        name: cleanText(method.name, 80),
        type: method.type === "crypto" ? "crypto" : "mobile",
        category: cleanText(
          method.category || (method.type === "crypto" ? "binance" : "ewallet"),
          40
        ),
        network: cleanText(method.network || "", 80),
        description: cleanText(method.description || "", 200),
        enabled: method.enabled !== false,
        logo: method.logo && validUrl(method.logo)
          ? method.logo
          : "",
        color: /^#[0-9a-fA-F]{6}$/.test(method.color || "")
          ? method.color
          : "#ffcc55",
        animation: cleanText(method.animation || "pulse", 30),
        feePercent: Math.max(
          0,
          Math.min(100, Number(method.feePercent) || 0)
        ),
        minimum: Math.max(
          0,
          Math.min(100000000, Math.floor(Number(method.minimum) || 0))
        )
      }))
      .filter(method => method.id && method.name);
  }

  saveSettings(next);

  res.json({
    ok: true,
    settings: next
  });
});

/* =========================================================
   ADMIN TASK MANAGEMENT
========================================================= */

app.post("/api/admin/tasks", adminAuth, (req, res) => {
  const title = cleanText(req.body?.title, 100);
  const platform = cleanText(req.body?.platform, 40);
  const url = cleanText(req.body?.url, 500);
  const reward = Math.floor(Number(req.body?.reward));

  if (
    !title ||
    !platform ||
    !validUrl(url) ||
    !Number.isSafeInteger(reward) ||
    reward < 0 ||
    reward > 10000000
  ) {
    return res.status(400).json({
      error: "Provide a title, platform, valid URL and reward."
    });
  }

  const result = db.prepare(`
    INSERT INTO tasks(title,platform,url,reward,enabled,created_at)
    VALUES(?,?,?,?,1,?)
  `).run(title, platform, url, reward, now());

  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch("/api/admin/tasks/:id", adminAuth, (req, res) => {
  const task = db.prepare(
    "SELECT * FROM tasks WHERE id=?"
  ).get(Number(req.params.id));

  if (!task) {
    return res.status(404).json({ error: "Task not found." });
  }

  const title = cleanText(req.body?.title ?? task.title, 100);
  const platform = cleanText(req.body?.platform ?? task.platform, 40);
  const url = cleanText(req.body?.url ?? task.url, 500);
  const reward = Math.floor(Number(req.body?.reward ?? task.reward));
  const enabled = req.body?.enabled === undefined
    ? task.enabled
    : req.body.enabled ? 1 : 0;

  if (
    !title ||
    !platform ||
    !validUrl(url) ||
    !Number.isSafeInteger(reward) ||
    reward < 0
  ) {
    return res.status(400).json({ error: "Invalid task data." });
  }

  db.prepare(`
    UPDATE tasks
    SET title=?,platform=?,url=?,reward=?,enabled=?
    WHERE id=?
  `).run(title, platform, url, reward, enabled, task.id);

  res.json({ ok: true });
});

app.delete("/api/admin/tasks/:id", adminAuth, (req, res) => {
  db.prepare(
    "DELETE FROM user_tasks WHERE task_id=?"
  ).run(Number(req.params.id));

  db.prepare(
    "DELETE FROM tasks WHERE id=?"
  ).run(Number(req.params.id));

  res.json({ ok: true });
});

/* =========================================================
   ADMIN WITHDRAWAL MANAGEMENT
========================================================= */

app.patch("/api/admin/withdrawals/:id", adminAuth, (req, res) => {
  const status = String(req.body?.status || "");

  if (!["pending", "approved", "paid", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const txid = cleanText(req.body?.txid, 160);
  const note = cleanText(req.body?.note, 250);

  const withdrawal = db.prepare(
    "SELECT * FROM withdrawals WHERE id=?"
  ).get(Number(req.params.id));

  if (!withdrawal) {
    return res.status(404).json({
      error: "Withdrawal request not found."
    });
  }

  const transaction = db.transaction(() => {
    if (
      status === "rejected" &&
      withdrawal.status !== "rejected" &&
      withdrawal.status !== "paid"
    ) {
      db.prepare(`
        UPDATE users
        SET balance=balance+?
        WHERE id=?
      `).run(withdrawal.amount, withdrawal.user_id);
    }

    db.prepare(`
      UPDATE withdrawals
      SET status=?,txid=?,note=?,updated_at=?
      WHERE id=?
    `).run(status, txid, note, now(), withdrawal.id);
  });

  transaction();

  res.json({ ok: true });
});

/* =========================================================
   ADMIN USER MANAGEMENT
========================================================= */

app.patch("/api/admin/users/:id", adminAuth, (req, res) => {
  const user = getUserById(Number(req.params.id));

  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const balance = req.body?.balance === undefined
    ? user.balance
    : Math.floor(Number(req.body.balance));

  if (
    !Number.isSafeInteger(balance) ||
    balance < 0 ||
    balance > 1000000000000
  ) {
    return res.status(400).json({ error: "Invalid balance." });
  }

  const banned = req.body?.banned === undefined
    ? user.is_banned
    : req.body.banned ? 1 : 0;

  db.prepare(`
    UPDATE users
    SET balance=?,is_banned=?
    WHERE id=?
  `).run(balance, banned, user.id);

  res.json({ ok: true });
});

/* =========================================================
   FALLBACK
========================================================= */

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(`CoinNova server listening on port ${PORT}`);
});
