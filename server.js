require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === "production";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");

const ALLOW_DEMO_LOGIN =
  process.env.ALLOW_DEMO_LOGIN === "true" && !PROD;

const dbPath =
  process.env.DB_PATH ||
  path.join(__dirname, "data", "coinnova.sqlite");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

if (
  PROD &&
  (!BOT_TOKEN || !ADMIN_PASSWORD || SESSION_SECRET.length < 32)
) {
  console.warn(
    "WARNING: Set BOT_TOKEN, ADMIN_PASSWORD, and SESSION_SECRET (32+ characters) in production environment variables."
  );
}

app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

// ======================================================
// DATABASE
// ======================================================

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  username TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 1000,
  last_energy_at INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  is_banned INTEGER NOT NULL DEFAULT 0,
  total_taps INTEGER NOT NULL DEFAULT 0,
  spins_available INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS task_claims (
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, task_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
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
  fee_percent REAL NOT NULL DEFAULT 0,
  fee_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
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
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_earnings_user_time
ON earnings(user_id, created_at);

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

// ======================================================
// DATABASE MIGRATION
// ======================================================

function getColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

let userCols = getColumns("users");

if (!userCols.includes("photo_url")) {
  db.exec("ALTER TABLE users ADD COLUMN photo_url TEXT DEFAULT ''");
}

if (!userCols.includes("spins_available")) {
  db.exec(
    "ALTER TABLE users ADD COLUMN spins_available INTEGER NOT NULL DEFAULT 0"
  );
}

let withdrawalCols = getColumns("withdrawals");

if (!withdrawalCols.includes("fee_percent")) {
  db.exec(
    "ALTER TABLE withdrawals ADD COLUMN fee_percent REAL NOT NULL DEFAULT 0"
  );
}

if (!withdrawalCols.includes("fee_amount")) {
  db.exec(
    "ALTER TABLE withdrawals ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0"
  );
}

if (!withdrawalCols.includes("net_amount")) {
  db.exec(
    "ALTER TABLE withdrawals ADD COLUMN net_amount INTEGER NOT NULL DEFAULT 0"
  );
}

db.exec(`
UPDATE withdrawals
SET net_amount = amount
WHERE net_amount = 0 AND amount > 0
`);

// ======================================================
// DEFAULT SETTINGS
// ======================================================

const now = () => Date.now();

const defaultSettings = {
  appName: "CoinNova",
  tagline: "Tap • Mine • Earn",

  appLogo: "",
  loadingImage: "",
  loadingTitle: "Preparing your CoinNova account…",
  loadingText: "VERIFYING TELEGRAM ACCOUNT",

  // Custom text messages
  txtHomeNotice: "Keep your Telegram account secure. Never share your wallet seed phrase or password.",
  txtReferralRule: "Your friend qualifies after completing 10 taps. Withdrawals require referral requirement.",
  txtWithdrawSub: "Select a withdrawal category first. E-Wallet and Crypto Network use separate selection screens.",
  txtWalletFormNotice: "Enter valid destination details.",
  txtTaskSub: "Earn CNV",
  txtSpinRules: "Invite qualified friends to unlock spins.",

  // Category Titles & Logos
  catEwalletName: "E-Wallet",
  catEwalletLogo: "",
  catNetworkName: "Select Network",
  catNetworkLogo: "",

  tapReward: 1,
  maxEnergy: 1000,
  energyPerSecond: 3,
  dailyBonus: 50,

  minWithdraw: 1000,
  referralRequired: 1,
  referralBonus: 100,
  withdrawalFeePercent: 0,

  maintenance: false,
  sound: true,

  spinEnabled: true,
  referralsPerSpin: 1,
  spinRewards: [10, 20, 30, 50, 100, 200],

  commissionEnabled: true,
  commissionRates: [10, 5, 3, 2, 1, 1],

  buttons: [],

  paymentMethods: [
    {
      id: "bkash",
      name: "bKash",
      type: "mobile",
      category: "ewallet",
      color: "#E2136E",
      animation: "pulse",
      url: "",
      enabled: true,
      logo: "https://cdn.simpleicons.org/bkash/E2136E",
      minWithdrawal: 1000,
      feePercent: 0
    },
    {
      id: "nagad",
      name: "Nagad",
      type: "mobile",
      category: "ewallet",
      color: "#F6921E",
      animation: "pulse",
      url: "",
      enabled: true,
      logo: "https://cdn.simpleicons.org/nagad/F6921E",
      minWithdrawal: 1000,
      feePercent: 0
    },
    {
      id: "rocket",
      name: "Rocket",
      type: "mobile",
      category: "ewallet",
      color: "#8B1E8B",
      animation: "pulse",
      url: "",
      enabled: true,
      logo: "https://cdn.simpleicons.org/dutchbanglabank/8B1E8B",
      minWithdrawal: 1000,
      feePercent: 0
    },
    {
      id: "binance",
      name: "Binance Pay / Wallet",
      type: "crypto",
      category: "network",
      color: "#F0B90B",
      animation: "pulse",
      url: "",
      enabled: true,
      logo: "https://cdn.simpleicons.org/binance/F0B90B",
      minWithdrawal: 1000,
      feePercent: 0
    },
    {
      id: "usdt_trc20",
      name: "USDT · TRC20",
      type: "crypto",
      category: "network",
      color: "#26A17B",
      animation: "pulse",
      url: "",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B",
      minWithdrawal: 1000,
      feePercent: 0
    }
  ],

  updatedAt: now()
};

const getSetting = db.prepare(
  "SELECT value FROM settings WHERE key = ?"
);

const setSetting = db.prepare(`
INSERT INTO settings(key, value)
VALUES(?, ?)
ON CONFLICT(key)
DO UPDATE SET value = excluded.value
`);

function getSettings() {
  const row = getSetting.get("main");

  if (!row) {
    setSetting.run("main", JSON.stringify(defaultSettings));
    return { ...defaultSettings };
  }

  try {
    return {
      ...defaultSettings,
      ...JSON.parse(row.value)
    };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  settings.updatedAt = now();
  setSetting.run("main", JSON.stringify(settings));
  return settings;
}

if (!getSetting.get("main")) {
  saveSettings(defaultSettings);
}

// ======================================================
// DEFAULT TASKS
// ======================================================

const taskCount = db.prepare(
  "SELECT COUNT(*) AS n FROM tasks"
).get().n;

if (!taskCount) {
  const insertTask = db.prepare(`
    INSERT INTO tasks(title, platform, url, reward, enabled, created_at)
    VALUES(?, ?, ?, ?, 1, ?)
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

// ======================================================
// AUTHENTICATION HELPERS
// ======================================================

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET || "dev-secret-change-me")
    .update(body)
    .digest("base64url");

  return body + "." + signature;
}

function verify(token) {
  try {
    const [body, signature] = String(token || "").split(".");

    if (!body || !signature) return null;

    const expected = crypto
      .createHmac("sha256", SESSION_SECRET || "dev-secret-change-me")
      .update(body)
      .digest();

    const actual = Buffer.from(signature, "base64url");

    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString()
    );

    if (!payload.exp || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function setAuthCookie(res, payload) {
  res.cookie(
    "cn_auth",
    sign({
      ...payload,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    }),
    {
      httpOnly: true,
      secure: PROD,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/"
    }
  );
}

function clearAuthCookie(res) {
  res.clearCookie("cn_auth", { path: "/" });
}

function parseCookie(cookieString) {
  return Object.fromEntries(
    cookieString
      .split(";")
      .map(item => item.trim().split(/=(.*)/s).slice(0, 2))
      .filter(item => item.length === 2)
      .map(([key, value]) => {
        try {
          return [key, decodeURIComponent(value)];
        } catch {
          return [key, value];
        }
      })
  );
}

function auth(req, res, next) {
  const cookies = parseCookie(req.headers.cookie || "");
  const payload = verify(cookies.cn_auth);

  if (!payload) {
    return res.status(401).json({
      error: "Please sign in again."
    });
  }

  req.auth = payload;
  next();
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.auth.role !== "admin") {
      return res.status(403).json({
        error: "Admin access required."
      });
    }

    next();
  });
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const expected = crypto
    .createHmac("sha256", secret)
    .update(dataCheck)
    .digest("hex");

  try {
    const actualBuffer = Buffer.from(hash, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const authDate = Number(params.get("auth_date") || 0);

  if (
    !authDate ||
    Date.now() / 1000 - authDate > 86400 ||
    authDate > Date.now() / 1000 + 60
  ) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "{}");
  } catch {
    return null;
  }
}

// ======================================================
// USER HELPERS
// ======================================================

function cleanText(value, max = 100) {
  return String(value || "").trim().slice(0, max);
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function getUserById(id) {
  return db.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).get(id);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
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

function refreshEnergy(user) {
  const settings = getSettings();

  const elapsed = Math.max(
    0,
    Math.floor((now() - (user.last_energy_at || now())) / 1000)
  );

  const energy = Math.min(
    settings.maxEnergy,
    user.energy + elapsed * settings.energyPerSecond
  );

  if (energy !== user.energy) {
    db.prepare(`
      UPDATE users
      SET energy = ?, last_energy_at = ?
      WHERE id = ?
    `).run(energy, now(), user.id);
  }

  return { ...user, energy };
}

function currentUser(req) {
  if (req.auth.role !== "user") return null;

  const user = getUserById(req.auth.uid);

  if (!user || user.is_banned) return null;

  return refreshEnergy(user);
}

function requireUser(req, res, next) {
  const user = currentUser(req);

  if (!user) {
    return res.status(403).json({
      error: "User unavailable or blocked."
    });
  }

  req.user = user;
  next();
}

function countQualifiedReferrals(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM referrals
    WHERE inviter_id = ? AND qualified = 1
  `).get(userId).n;
}

function recordEarning(userId, amount, kind) {
  if (Number(amount) > 0) {
    db.prepare(`
      INSERT INTO earnings(user_id, amount, kind, created_at)
      VALUES(?, ?, ?, ?)
    `).run(userId, Math.floor(amount), kind, now());
  }
}

// ======================================================
// BANGLADESH DATE AND COMMISSION HELPERS
// ======================================================

function bdDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function dayStartBd() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return Date.parse(
    `${values.year}-${values.month}-${values.day}T00:00:00+06:00`
  );
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
      SELECT id, created_at
      FROM users
      WHERE id IN (
        SELECT invited_user_id
        FROM referrals
        WHERE qualified = 1
          AND inviter_id IN (${placeholders})
      )
    `).all(...frontier);

    const ids = rows.map(row => row.id);

    levels.push({
      level,
      members: ids.length,
      todayMembers: rows.filter(
        row => bdDate(row.created_at) === bdDate()
      ).length,
      todayCoins: 0,
      commissionToday: 0
    });

    frontier = ids;
  }

  return levels;
}

// ======================================================
// PAGE ROUTES
// ======================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Admin.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "CoinNova",
    time: now()
  });
});

// ======================================================
// TELEGRAM AUTHENTICATION
// ======================================================

app.post(
  "/api/auth/telegram",
  rateLimit({ windowMs: 60000, limit: 30 }),
  (req, res) => {
    const telegramUser = verifyTelegramInitData(
      String(req.body?.initData || "")
    );

    if (!telegramUser || !telegramUser.id) {
      return res.status(401).json({
        error: "Telegram verification failed. Open this app from your Telegram bot."
      });
    }

    const telegramId = String(telegramUser.id);

    const name = cleanText(
      [
        telegramUser.first_name,
        telegramUser.last_name
      ].filter(Boolean).join(" ") || "Miner",
      80
    );

    const username = cleanText(telegramUser.username || "", 64);
    const startParam = cleanText(req.body?.startParam || "", 80);

    const transaction = db.transaction(() => {
      let user = db.prepare(`
        SELECT * FROM users WHERE tg_id = ?
      `).get(telegramId);

      if (!user) {
        const settings = getSettings();

        db.prepare(`
          INSERT INTO users
          (
            tg_id,
            name,
            username,
            photo_url,
            balance,
            energy,
            last_energy_at,
            invited_by,
            created_at
          )
          VALUES(?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
          telegramId,
          name,
          username,
          validUrl(telegramUser.photo_url || "")
            ? telegramUser.photo_url
            : "",
          settings.maxEnergy,
          now(),
          startParam.startsWith("ref_")
            ? startParam.slice(4)
            : "",
          now()
        );

        user = db.prepare(`
          SELECT * FROM users WHERE tg_id = ?
        `).get(telegramId);

        if (startParam.startsWith("ref_")) {
          const inviter = db.prepare(`
            SELECT * FROM users WHERE tg_id = ?
          `).get(startParam.slice(4));

          if (inviter && inviter.id !== user.id) {
            db.prepare(`
              INSERT OR IGNORE INTO referrals
              (inviter_id, invited_user_id, qualified, created_at)
              VALUES(?, ?, 0, ?)
            `).run(inviter.id, user.id, now());
          }
        }
      } else {
        db.prepare(`
          UPDATE users
          SET name = ?, username = ?, photo_url = ?
          WHERE id = ?
        `).run(
          name,
          username,
          validUrl(telegramUser.photo_url || "")
            ? telegramUser.photo_url
            : (user.photo_url || ""),
          user.id
        );
      }

      return db.prepare(`
        SELECT * FROM users WHERE tg_id = ?
      `).get(telegramId);
    });

    const user = transaction();

    if (user.is_banned) {
      return res.status(403).json({
        error: "This account is blocked."
      });
    }

    setAuthCookie(res, {
      role: "user",
      uid: user.id,
      tgId: user.tg_id
    });

    res.json({
      user: publicUser(refreshEnergy(user)),
      settings: getSettings(),
      tasks: db.prepare("SELECT * FROM tasks WHERE enabled = 1").all(),
      referralUrl: BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?startapp=ref_${user.tg_id}`
        : ""
    });
  }
);

// ======================================================
// ADMIN LOGIN AND LOGOUT
// ======================================================

app.post(
  "/api/auth/admin",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 8 }),
  (req, res) => {
    const password = String(req.body?.password || "");

    if (
      !ADMIN_PASSWORD ||
      password !== ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        error: "Incorrect admin password."
      });
    }

    setAuthCookie(res, { role: "admin" });

    res.json({ ok: true });
  }
);

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ======================================================
// CURRENT USER DATA
// ======================================================

app.get("/api/me", auth, requireUser, (req, res) => {
  const user = req.user;

  res.json({
    user: publicUser(user),
    settings: getSettings(),
    tasks: db.prepare(`
      SELECT
        t.*,
        CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS claimed
      FROM tasks t
      LEFT JOIN task_claims c
        ON c.task_id = t.id AND c.user_id = ?
      WHERE t.enabled = 1
      ORDER BY t.id
    `).all(user.id),

    referralUrl: BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?startapp=ref_${user.tg_id}`
      : "",

    referrals: countQualifiedReferrals(user.id),

    spinHistory: db.prepare(`
      SELECT reward, created_at AS createdAt
      FROM spin_history
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(user.id),

    commissionLevels: teamStats(user.id),

    withdrawals: db.prepare(`
      SELECT
        id,
        method,
        address,
        amount,
        fee_percent AS feePercent,
        fee_amount AS feeAmount,
        net_amount AS netAmount,
        status,
        txid,
        note,
        created_at AS createdAt
      FROM withdrawals
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(user.id)
  });
});

// ======================================================
// MINING / TAP
// ======================================================

app.post("/api/tap", auth, requireUser, (req, res) => {
  const user = refreshEnergy(req.user);
  const settings = getSettings();

  if (settings.maintenance) {
    return res.status(503).json({
      error: "App is under maintenance."
    });
  }

  const taps = Math.max(
    1,
    Math.min(20, Number(req.body?.count) || 1)
  );

  if (user.energy < taps) {
    return res.status(400).json({
      error: "Not enough energy."
    });
  }

  const reward = taps * settings.tapReward;

  db.prepare(`
    UPDATE users
    SET
      balance = balance + ?,
      energy = energy - ?,
      total_taps = total_taps + ?,
      last_energy_at = ?
    WHERE id = ?
  `).run(reward, taps, taps, now(), user.id);

  recordEarning(user.id, reward, "tap");

  if (user.total_taps + taps >= 10) {
    const referral = db.prepare(`
      SELECT * FROM referrals
      WHERE invited_user_id = ? AND qualified = 0
    `).get(user.id);

    if (referral) {
      db.prepare(`
        UPDATE referrals SET qualified = 1 WHERE id = ?
      `).run(referral.id);

      const bonus = getSettings().referralBonus;

      db.prepare(`
        UPDATE users SET balance = balance + ? WHERE id = ?
      `).run(bonus, referral.inviter_id);

      recordEarning(referral.inviter_id, bonus, "referral_bonus");
    }
  }

  res.json({
    user: publicUser(refreshEnergy(getUserById(user.id))),
    reward
  });
});

// ======================================================
// DAILY BONUS
// ======================================================

app.post("/api/bonus/daily", auth, requireUser, (req, res) => {
  const key = "daily_" + req.user.id;
  const last = getSetting.get(key);
  const today = bdDate();

  if (last && last.value === today) {
    return res.status(400).json({
      error: "Daily bonus already claimed today."
    });
  }

  const reward = getSettings().dailyBonus;

  setSetting.run(key, today);

  db.prepare(`
    UPDATE users SET balance = balance + ? WHERE id = ?
  `).run(reward, req.user.id);

  recordEarning(req.user.id, reward, "daily_bonus");

  res.json({
    reward,
    user: publicUser(getUserById(req.user.id))
  });
});

// ======================================================
// TASK CLAIM
// ======================================================

app.post("/api/tasks/:id/claim", auth, requireUser, (req, res) => {
  const task = db.prepare(`
    SELECT * FROM tasks
    WHERE id = ? AND enabled = 1
  `).get(Number(req.params.id));

  if (!task) {
    return res.status(404).json({
      error: "Task not found."
    });
  }

  try {
    db.prepare(`
      INSERT INTO task_claims(user_id, task_id, claimed_at)
      VALUES(?, ?, ?)
    `).run(req.user.id, task.id, now());
  } catch {
    return res.status(409).json({
      error: "Task already claimed."
    });
  }

  db.prepare(`
    UPDATE users SET balance = balance + ? WHERE id = ?
  `).run(task.reward, req.user.id);

  recordEarning(req.user.id, task.reward, "task");

  res.json({
    reward: task.reward,
    user: publicUser(getUserById(req.user.id))
  });
});

// ======================================================
// LUCKY SPIN
// ======================================================

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
      error: "No spins available."
    });
  }

  const rewards = (settings.spinRewards || [10, 20]).map(Number);
  const reward = rewards[crypto.randomInt(rewards.length)];

  db.prepare(`
    UPDATE users
    SET spins_available = spins_available - 1,
        balance = balance + ?
    WHERE id = ?
  `).run(reward, user.id);

  db.prepare(`
    INSERT INTO spin_history(user_id, reward, created_at)
    VALUES(?, ?, ?)
  `).run(user.id, reward, now());

  recordEarning(user.id, reward, "spin");

  res.json({
    reward,
    user: publicUser(getUserById(user.id))
  });
});

// ======================================================
// WITHDRAW REQUEST
// ======================================================

app.post("/api/withdraw", auth, requireUser, (req, res) => {
  const settings = getSettings();

  const methodId = cleanText(req.body?.method, 40);
  const address = cleanText(req.body?.address, 180);
  const amount = Math.floor(Number(req.body?.amount));

  const method = settings.paymentMethods.find(item =>
    item.id === methodId && item.enabled
  );

  if (!method) {
    return res.status(400).json({
      error: "Choose an available withdrawal method."
    });
  }

  const minW = method.minWithdrawal || settings.minWithdraw;

  if (!Number.isSafeInteger(amount) || amount < minW) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${minW} coins.`
    });
  }

  if (address.length < 5) {
    return res.status(400).json({
      error: "Enter a valid destination number or wallet address."
    });
  }

  if (req.user.balance < amount) {
    return res.status(400).json({
      error: "Insufficient balance."
    });
  }

  const feePercent = Math.max(
    0,
    Math.min(100, Number(method.feePercent ?? settings.withdrawalFeePercent) || 0)
  );

  const feeAmount = Math.min(
    amount,
    Math.floor(amount * feePercent / 100)
  );

  const netAmount = amount - feeAmount;

  db.prepare(`
    UPDATE users
    SET balance = balance - ?
    WHERE id = ?
  `).run(amount, req.user.id);

  const id = db.prepare(`
    INSERT INTO withdrawals
    (
      user_id,
      method,
      address,
      amount,
      fee_percent,
      fee_amount,
      net_amount,
      status,
      created_at,
      updated_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    req.user.id,
    methodId,
    address,
    amount,
    feePercent,
    feeAmount,
    netAmount,
    now(),
    now()
  ).lastInsertRowid;

  res.json({
    ok: true,
    id,
    amount,
    feePercent,
    feeAmount,
    netAmount,
    user: publicUser(getUserById(req.user.id))
  });
});

// ======================================================
// ADMIN OVERVIEW & SETTINGS
// ======================================================

app.get("/api/admin/overview", adminAuth, (req, res) => {
  res.json({
    counts: {
      users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      withdrawPending: db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'").get().n,
      withdrawTotal: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM withdrawals").get().n,
      coins: db.prepare("SELECT COALESCE(SUM(balance), 0) AS n FROM users").get().n
    },
    settings: getSettings(),
    tasks: db.prepare("SELECT * FROM tasks ORDER BY id DESC").all(),
    withdrawals: db.prepare("SELECT w.*, u.name AS userName FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.id DESC LIMIT 100").all(),
    users: db.prepare("SELECT id, tg_id, name, username, balance, energy, created_at, is_banned, total_taps FROM users ORDER BY id DESC LIMIT 200").all()
  });
});

app.put("/api/admin/settings", adminAuth, (req, res) => {
  const oldSettings = getSettings();
  const incoming = req.body || {};
  const next = { ...oldSettings, ...incoming };
  saveSettings(next);
  res.json({ settings: next });
});

app.post("/api/admin/tasks", adminAuth, (req, res) => {
  const { title, platform, url, reward } = req.body;
  const id = db.prepare(`
    INSERT INTO tasks(title, platform, url, reward, enabled, created_at)
    VALUES(?, ?, ?, ?, 1, ?)
  `).run(title, platform, url, Number(reward), now()).lastInsertRowid;

  res.json({ id });
});

app.patch("/api/admin/tasks/:id", adminAuth, (req, res) => {
  const { title, platform, url, reward, enabled } = req.body;
  db.prepare(`
    UPDATE tasks
    SET title = ?, platform = ?, url = ?, reward = ?, enabled = ?
    WHERE id = ?
  `).run(title, platform, url, Number(reward), enabled ? 1 : 0, Number(req.params.id));

  res.json({ ok: true });
});

app.delete("/api/admin/tasks/:id", adminAuth, (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.patch("/api/admin/withdrawals/:id", adminAuth, (req, res) => {
  const { status, note } = req.body;
  const withdrawal = db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(Number(req.params.id));

  if (status === "rejected" && withdrawal.status !== "rejected") {
    db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(withdrawal.amount, withdrawal.user_id);
  }

  db.prepare(`
    UPDATE withdrawals
    SET status = ?, note = ?, updated_at = ?
    WHERE id = ?
  `).run(status, note || "", now(), withdrawal.id);

  res.json({ ok: true });
});

app.patch("/api/admin/users/:id", adminAuth, (req, res) => {
  const { balance, blocked } = req.body;
  db.prepare(`
    UPDATE users
    SET balance = ?, is_banned = ?
    WHERE id = ?
  `).run(Number(balance), blocked ? 1 : 0, Number(req.params.id));

  res.json({ ok: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`CoinNova server listening on ${PORT}`);
});
