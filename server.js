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
  (!BOT_TOKEN ||
    !ADMIN_PASSWORD ||
    SESSION_SECRET.length < 32)
) {
  console.warn(
    "WARNING: Set BOT_TOKEN, ADMIN_PASSWORD, and SESSION_SECRET (32+ chars) in production environment variables."
  );
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(
  rateLimit({
    windowMs: 60000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"]
  })
);

/* =========================
   DATABASE
========================= */

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

/* Database migration */

const userCols = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map(c => c.name);

if (!userCols.includes("photo_url")) {
  db.exec(
    "ALTER TABLE users ADD COLUMN photo_url TEXT DEFAULT ''"
  );
}

if (!userCols.includes("spins_available")) {
  db.exec(
    "ALTER TABLE users ADD COLUMN spins_available INTEGER NOT NULL DEFAULT 0"
  );
}

/* =========================
   SETTINGS
========================= */

const now = () => Date.now();

const defaultSettings = {
  appName: "CoinNova",
  tagline: "Tap • Mine • Earn",
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
      enabled: true,
      logo: "https://cdn.simpleicons.org/bkash/E2136E"
    },
    {
      id: "nagad",
      name: "Nagad",
      type: "mobile",
      enabled: true,
      logo: "https://cdn.simpleicons.org/nagad/F6921E"
    },
    {
      id: "rocket",
      name: "Rocket",
      type: "mobile",
      enabled: true,
      logo: "https://cdn.simpleicons.org/dutchbanglabank/8B1E8B"
    },
    {
      id: "usdt_trc20",
      name: "USDT · TRC20",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B"
    },
    {
      id: "usdt_bep20",
      name: "USDT · BEP20",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B"
    },
    {
      id: "binance",
      name: "Binance Pay / Wallet",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/binance/F0B90B"
    },
    {
      id: "trustwallet",
      name: "Trust Wallet",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/trustwallet/3375BB"
    },
    {
      id: "bitget",
      name: "Bitget Wallet",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/bitget/00F0FF"
    }
  ],

  updatedAt: now()
};

const getSetting = db.prepare(
  "SELECT value FROM settings WHERE key=?"
);

const setSetting = db.prepare(`
INSERT INTO settings(key, value)
VALUES(?, ?)
ON CONFLICT(key)
DO UPDATE SET value=excluded.value
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

/* Default tasks */

const taskCount = db
  .prepare("SELECT COUNT(*) n FROM tasks")
  .get().n;

if (!taskCount) {
  const insertTask = db.prepare(`
    INSERT INTO tasks
    (title, platform, url, reward, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
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

/* =========================
   AUTHENTICATION HELPERS
========================= */

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));

  const signature = crypto
    .createHmac(
      "sha256",
      SESSION_SECRET || "dev-secret-change-me"
    )
    .update(body)
    .digest("base64url");

  return body + "." + signature;
}

function verify(token) {
  try {
    const [body, signature] = String(token || "").split(".");

    if (!body || !signature) return null;

    const expected = crypto
      .createHmac(
        "sha256",
        SESSION_SECRET || "dev-secret-change-me"
      )
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

    if (payload.exp < Date.now()) return null;

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

function parseCookie(value) {
  return Object.fromEntries(
    value
      .split(";")
      .map(item => item.trim().split(/=(.*)/s).slice(0, 2))
      .filter(item => item.length === 2)
      .map(([key, val]) => [key, decodeURIComponent(val)])
  );
}

function auth(req, res, next) {
  const payload = verify(
    req.cookies?.cn_auth ||
    parseCookie(req.headers.cookie || "").cn_auth
  );

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
    const received = Buffer.from(hash, "hex");
    const calculated = Buffer.from(expected, "hex");

    if (
      received.length !== calculated.length ||
      !crypto.timingSafeEqual(received, calculated)
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const authDate = Number(params.get("auth_date") || 0);

  if (
    !authDate ||
    Date.now() / 1000 - authDate > 86400
  ) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "{}");
  } catch {
    return null;
  }
}

/* =========================
   USER HELPERS
========================= */

function getUserById(id) {
  return db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(id);
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

function refreshEnergy(user) {
  const settings = getSettings();

  const elapsed = Math.max(
    0,
    Math.floor(
      (now() - (user.last_energy_at || now())) / 1000
    )
  );

  const energy = Math.min(
    settings.maxEnergy,
    user.energy + elapsed * settings.energyPerSecond
  );

  if (energy !== user.energy) {
    db.prepare(`
      UPDATE users
      SET energy=?, last_energy_at=?
      WHERE id=?
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
    SELECT COUNT(*) n
    FROM referrals
    WHERE inviter_id=? AND qualified=1
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

/* =========================
   BANGLADESH TIME HELPERS
========================= */

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

/* =========================
   REFERRAL TEAM / COMMISSION
========================= */

function levelAncestors(userId, max = 6) {
  const ancestors = [];
  let current = userId;

  for (let level = 1; level <= max; level++) {
    const row = db.prepare(`
      SELECT inviter_id
      FROM referrals
      WHERE invited_user_id=? AND qualified=1
    `).get(current);

    if (!row) break;

    ancestors.push({
      userId: row.inviter_id,
      level
    });

    current = row.inviter_id;
  }

  return ancestors;
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
        WHERE qualified=1
        AND inviter_id IN (${placeholders})
      )
    `).all(...frontier);

    const ids = rows.map(row => row.id);

    let todayCoins = 0;
    let commissionToday = 0;

    if (ids.length) {
      const idPlaceholders = ids.map(() => "?").join(",");

      todayCoins = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) n
        FROM earnings
        WHERE user_id IN (${idPlaceholders})
        AND created_at>=?
        AND created_at<?
      `).get(
        ...ids,
        dayStartBd(),
        dayStartBd() + 86400000
      ).n;

      commissionToday = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) n
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

/*
 * Daily commission:
 * Previous day's recorded earnings are used as the base.
 * Payout processing starts after 1:00 AM Bangladesh time.
 * Unique database keys prevent the same source/day/level
 * commission from being credited more than once.
 */
function payDailyCommissions() {
  const settings = getSettings();

  if (!settings.commissionEnabled) return;

  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const time = Object.fromEntries(
    timeParts.map(part => [part.type, part.value])
  );

  if (Number(time.hour) < 1) return;

  const day = bdDate(Date.now() - 86400000);
  const start = dayStartBd() - 86400000;
  const end = start + 86400000;

  const earners = db.prepare(`
    SELECT DISTINCT user_id
    FROM earnings
    WHERE created_at>=? AND created_at<?
  `).all(start, end);

  const transaction = db.transaction(() => {
    for (const earner of earners) {
      const earned = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) n
        FROM earnings
        WHERE user_id=?
        AND created_at>=?
        AND created_at<?
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
            beneficiary_id,
            source_user_id,
            day,
            level,
            base_amount,
            rate,
            amount,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ancestor.userId,
          earner.user_id,
          day,
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
    console.error(
      "Daily commission payout failed:",
      error.message
    );
  }
}

setInterval(payDailyCommissions, 60 * 1000);
setTimeout(payDailyCommissions, 5000);

/* =========================
   BASIC ROUTES
========================= */

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

/* =========================
   TELEGRAM LOGIN
========================= */

app.post(
  "/api/auth/telegram",
  rateLimit({ windowMs: 60000, limit: 30 }),
  (req, res) => {
    const telegramUser = verifyTelegramInitData(
      String(req.body?.initData || "")
    );

    if (!telegramUser || !telegramUser.id) {
      return res.status(401).json({
        error:
          "Telegram verification failed. Open this app from your Telegram bot."
      });
    }

    const tgId = String(telegramUser.id);

    const name = cleanText(
      [
        telegramUser.first_name,
        telegramUser.last_name
      ].filter(Boolean).join(" ") || "Miner",
      80
    );

    const username = cleanText(
      telegramUser.username || "",
      64
    );

    const startParam = cleanText(
      req.body?.startParam || "",
      80
    );

    const transaction = db.transaction(() => {
      let user = db.prepare(`
        SELECT * FROM users WHERE tg_id=?
      `).get(tgId);

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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          tgId,
          name,
          username,
          validUrl(telegramUser.photo_url || "")
            ? telegramUser.photo_url
            : "",
          0,
          settings.maxEnergy,
          now(),
          startParam.startsWith("ref_")
            ? startParam.slice(4)
            : "",
          now()
        );

        user = db.prepare(`
          SELECT * FROM users WHERE tg_id=?
        `).get(tgId);

        if (startParam.startsWith("ref_")) {
          const inviter = db.prepare(`
            SELECT * FROM users WHERE tg_id=?
          `).get(startParam.slice(4));

          if (inviter && inviter.id !== user.id) {
            db.prepare(`
              INSERT OR IGNORE INTO referrals
              (inviter_id, invited_user_id, qualified, created_at)
              VALUES (?, ?, 0, ?)
            `).run(inviter.id, user.id, now());
          }
        }
      } else {
        db.prepare(`
          UPDATE users
          SET name=?, username=?, photo_url=?
          WHERE id=?
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
        SELECT * FROM users WHERE id=?
      `).get(user.id);
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
      tasks: listTasksForUser(user.id),
      referralUrl: BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?startapp=ref_${user.tg_id}`
        : ""
    });
  }
);

/* Optional demo login for development only */

app.post("/api/auth/demo", (req, res) => {
  if (!ALLOW_DEMO_LOGIN) {
    return res.status(403).json({
      error:
        "Demo login is disabled. Open this app inside Telegram."
    });
  }

  const suffix = cleanText(
    req.body?.name || "Miner",
    30
  ).replace(/\W/g, "").toLowerCase();

  const tgId = "demo-" + suffix;

  let user = db.prepare(`
    SELECT * FROM users WHERE tg_id=?
  `).get(tgId);

  if (!user) {
    db.prepare(`
      INSERT INTO users
      (
        tg_id,
        name,
        username,
        balance,
        energy,
        last_energy_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tgId,
      "Demo Miner",
      "",
      0,
      getSettings().maxEnergy,
      now(),
      now()
    );

    user = db.prepare(`
      SELECT * FROM users WHERE tg_id=?
    `).get(tgId);
  }

  setAuthCookie(res, {
    role: "user",
    uid: user.id,
    tgId: user.tg_id
  });

  res.json({
    user: publicUser(refreshEnergy(user)),
    settings: getSettings(),
    tasks: listTasksForUser(user.id),
    referralUrl: ""
  });
});

/* Admin login */

app.post(
  "/api/auth/admin",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 8 }),
  (req, res) => {
    const password = String(req.body?.password || "");

    const submittedHash = crypto
      .createHash("sha256")
      .update(password)
      .digest();

    const configuredHash = crypto
      .createHash("sha256")
      .update(ADMIN_PASSWORD)
      .digest();

    if (
      !ADMIN_PASSWORD ||
      password.length > 300 ||
      !crypto.timingSafeEqual(
        submittedHash,
        configuredHash
      )
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

/* =========================
   USER TASKS
========================= */

function listTasksForUser(userId) {
  return db.prepare(`
    SELECT
      t.*,
      CASE
        WHEN c.user_id IS NULL THEN 0
        ELSE 1
      END claimed
    FROM tasks t
    LEFT JOIN task_claims c
      ON c.task_id=t.id AND c.user_id=?
    WHERE t.enabled=1
    ORDER BY t.id
  `).all(userId).map(task => ({
    id: task.id,
    title: task.title,
    platform: task.platform,
    url: task.url,
    reward: task.reward,
    claimed: !!task.claimed
  }));
}

/* =========================
   USER PROFILE
========================= */

app.get("/api/me", auth, requireUser, (req, res) => {
  const userId = req.user.id;

  res.json({
    user: publicUser(req.user),
    settings: getSettings(),
    tasks: listTasksForUser(userId),

    referralUrl: BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?startapp=ref_${req.user.tg_id}`
      : "",

    referrals: countQualifiedReferrals(userId),

    spinHistory: db.prepare(`
      SELECT
        reward,
        created_at createdAt
      FROM spin_history
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 10
    `).all(userId),

    commissionLevels: teamStats(userId),

    commissionToday: db.prepare(`
      SELECT COALESCE(SUM(amount), 0) n
      FROM commission_payouts
      WHERE beneficiary_id=? AND day=?
    `).get(userId, bdDate()).n,

    withdrawals: db.prepare(`
      SELECT
        id,
        method,
        address,
        amount,
        status,
        txid,
        note,
        created_at createdAt
      FROM withdrawals
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 20
    `).all(userId)
  });
});

/* =========================
   TAP / MINING
========================= */

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
      balance=balance+?,
      energy=energy-?,
      total_taps=total_taps+?,
      last_energy_at=?
    WHERE id=?
  `).run(
    reward,
    taps,
    taps,
    now(),
    user.id
  );

  recordEarning(user.id, reward, "tap");

  /*
   * A referral qualifies after the invitee has made
   * at least 10 taps.
   */
  if (user.total_taps + taps >= 10) {
    const referral = db.prepare(`
      SELECT *
      FROM referrals
      WHERE invited_user_id=? AND qualified=0
    `).get(user.id);

    if (referral) {
      db.prepare(`
        UPDATE referrals SET qualified=1 WHERE id=?
      `).run(referral.id);

      const currentSettings = getSettings();
      const referralBonus = currentSettings.referralBonus;

      db.prepare(`
        UPDATE users
        SET balance=balance+?
        WHERE id=?
      `).run(referralBonus, referral.inviter_id);

      recordEarning(
        referral.inviter_id,
        referralBonus,
        "referral_bonus"
      );

      const perSpin = Math.max(
        1,
        Number(currentSettings.referralsPerSpin) || 1
      );

      const qualified = countQualifiedReferrals(
        referral.inviter_id
      );

      const grantRow = db.prepare(`
        SELECT total_granted
        FROM spin_grants
        WHERE inviter_id=?
      `).get(referral.inviter_id);

      const granted = grantRow?.total_granted || 0;
      const shouldHave = Math.floor(qualified / perSpin);

      if (
        currentSettings.spinEnabled &&
        shouldHave > granted
      ) {
        const newSpins = shouldHave - granted;

        db.prepare(`
          UPDATE users
          SET spins_available=spins_available+?
          WHERE id=?
        `).run(newSpins, referral.inviter_id);

        db.prepare(`
          INSERT INTO spin_grants(inviter_id, total_granted)
          VALUES(?, ?)
          ON CONFLICT(inviter_id)
          DO UPDATE SET total_granted=excluded.total_granted
        `).run(referral.inviter_id, shouldHave);
      }
    }
  }

  const updatedUser = refreshEnergy(
    getUserById(user.id)
  );

  res.json({
    user: publicUser(updatedUser),
    reward
  });
});

/* =========================
   DAILY BONUS
========================= */

app.post("/api/bonus/daily", auth, requireUser, (req, res) => {
  const key = "daily_" + req.user.id;
  const last = getSetting.get(key);
  const today = new Date().toISOString().slice(0, 10);

  if (last && last.value === today) {
    return res.status(400).json({
      error: "Daily bonus already claimed today."
    });
  }

  const settings = getSettings();

  setSetting.run(key, today);

  db.prepare(`
    UPDATE users SET balance=balance+? WHERE id=?
  `).run(settings.dailyBonus, req.user.id);

  recordEarning(
    req.user.id,
    settings.dailyBonus,
    "daily_bonus"
  );

  res.json({
    reward: settings.dailyBonus,
    user: publicUser(getUserById(req.user.id))
  });
});

/* =========================
   TASK CLAIM
========================= */

app.post(
  "/api/tasks/:id/claim",
  auth,
  requireUser,
  (req, res) => {
    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE id=? AND enabled=1
    `).get(Number(req.params.id));

    if (!task) {
      return res.status(404).json({
        error: "Task not found."
      });
    }

    /*
     * This prototype records the claim after the client
     * visits the URL. Actual social-task verification
     * requires the platform's verification APIs.
     */
    try {
      db.prepare(`
        INSERT INTO task_claims
        (user_id, task_id, claimed_at)
        VALUES (?, ?, ?)
      `).run(req.user.id, task.id, now());
    } catch {
      return res.status(409).json({
        error: "Task already claimed."
      });
    }

    db.prepare(`
      UPDATE users SET balance=balance+? WHERE id=?
    `).run(task.reward, req.user.id);

    recordEarning(req.user.id, task.reward, "task");

    res.json({
      reward: task.reward,
      user: publicUser(getUserById(req.user.id))
    });
  }
);

/* =========================
   LUCKY SPIN
========================= */

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
      error:
        "No spins available. Invite qualified friends to earn spins."
    });
  }

  const rewards = (settings.spinRewards || [])
    .map(Number)
    .filter(value =>
      Number.isSafeInteger(value) && value >= 0
    );

  if (!rewards.length) {
    return res.status(503).json({
      error: "Spin rewards are not configured."
    });
  }

  const reward = rewards[
    crypto.randomInt(rewards.length)
  ];

  const transaction = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE users
      SET
        spins_available=spins_available-1,
        balance=balance+?
      WHERE id=? AND spins_available>0
    `).run(reward, user.id);

    if (!changed.changes) {
      throw new Error("No spins available.");
    }

    db.prepare(`
      INSERT INTO spin_history(user_id, reward, created_at)
      VALUES (?, ?, ?)
    `).run(user.id, reward, now());

    recordEarning(user.id, reward, "spin");
  });

  try {
    transaction();

    res.json({
      reward,
      user: publicUser(getUserById(user.id))
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

/* =========================
   COMMISSION API
========================= */

app.get(
  "/api/commissions",
  auth,
  requireUser,
  (req, res) => {
    const userId = req.user.id;

    const todayTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) n
      FROM commission_payouts
      WHERE beneficiary_id=?
      AND created_at>=?
      AND created_at<?
    `).get(
      userId,
      dayStartBd(),
      dayStartBd() + 86400000
    ).n;

    const history = db.prepare(`
      SELECT
        day,
        level,
        amount,
        base_amount baseAmount,
        rate,
        created_at createdAt
      FROM commission_payouts
      WHERE beneficiary_id=?
      ORDER BY id DESC
      LIMIT 50
    `).all(userId);

    const settings = getSettings();

    res.json({
      today: bdDate(),
      total: todayTotal,
      levels: teamStats(userId),
      history,
      rates: settings.commissionRates || [
        10, 5, 3, 2, 1, 1
      ],
      enabled: !!settings.commissionEnabled
    });
  }
);

/* =========================
   WALLET OPTIONS
========================= */

app.get(
  "/api/wallet/options",
  auth,
  requireUser,
  (req, res) => {
    const settings = getSettings();

    res.json({
      methods: settings.paymentMethods.filter(
        method => method.enabled
      ),
      minWithdraw: settings.minWithdraw,
      referralRequired: settings.referralRequired
    });
  }
);

/* =========================
   WITHDRAWAL REQUEST
========================= */

app.post("/api/withdraw", auth, requireUser, (req, res) => {
  const settings = getSettings();

  const methodId = cleanText(req.body?.method, 40);
  const address = cleanText(req.body?.address, 180);
  const amount = Math.floor(Number(req.body?.amount));

  const method = settings.paymentMethods.find(
    item => item.id === methodId && item.enabled
  );

  if (!method) {
    return res.status(400).json({
      error: "Choose an available withdrawal method."
    });
  }

  if (
    !Number.isSafeInteger(amount) ||
    amount < settings.minWithdraw
  ) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${settings.minWithdraw} coins.`
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

  const qualified = countQualifiedReferrals(req.user.id);

  if (qualified < settings.referralRequired) {
    return res.status(400).json({
      error:
        `You need ${settings.referralRequired} qualified referral(s). Current: ${qualified}.`
    });
  }

  const transaction = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE users
      SET balance=balance-?
      WHERE id=? AND balance>=?
    `).run(amount, req.user.id, amount);

    if (!changed.changes) {
      throw new Error("Insufficient balance.");
    }

    return db.prepare(`
      INSERT INTO withdrawals
      (
        user_id,
        method,
        address,
        amount,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      req.user.id,
      methodId,
      address,
      amount,
      now(),
      now()
    ).lastInsertRowid;
  });

  try {
    const id = transaction();

    res.json({
      ok: true,
      id,
      message:
        "Request sent for admin review. Payment is not automatic.",
      user: publicUser(getUserById(req.user.id))
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

/* =========================
   ADMIN API
========================= */

app.post("/api/admin/login-check", adminAuth, (req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/overview", adminAuth, (req, res) => {
  const counts = {
    users: db.prepare(`
      SELECT COUNT(*) n FROM users
    `).get().n,

    banned: db.prepare(`
      SELECT COUNT(*) n
      FROM users
      WHERE is_banned=1
    `).get().n,

    withdrawPending: db.prepare(`
      SELECT COUNT(*) n
      FROM withdrawals
      WHERE status='pending'
    `).get().n,

    withdrawTotal: db.prepare(`
      SELECT COALESCE(SUM(amount), 0) n
      FROM withdrawals
    `).get().n,

    coins: db.prepare(`
      SELECT COALESCE(SUM(balance), 0) n
      FROM users
    `).get().n,

    taps: db.prepare(`
      SELECT COALESCE(SUM(total_taps), 0) n
      FROM users
    `).get().n
  };

  const withdrawals = db.prepare(`
    SELECT
      w.*,
      u.name userName,
      u.tg_id tgId
    FROM withdrawals w
    JOIN users u ON u.id=w.user_id
    ORDER BY w.id DESC
    LIMIT 100
  `).all();

  const users = db.prepare(`
    SELECT
      id,
      tg_id,
      name,
      username,
      balance,
      energy,
      created_at,
      is_banned,
      total_taps
    FROM users
    ORDER BY id DESC
    LIMIT 200
  `).all();

  counts.spinAvailable = db.prepare(`
    SELECT COALESCE(SUM(spins_available), 0) n
    FROM users
  `).get().n;

  counts.commissionToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) n
    FROM commission_payouts
    WHERE created_at>=? AND created_at<?
  `).get(
    dayStartBd(),
    dayStartBd() + 86400000
  ).n;

  res.json({
    counts,
    settings: getSettings(),
    tasks: db.prepare(`
      SELECT * FROM tasks ORDER BY id DESC
    `).all(),
    withdrawals,
    users
  });
});

/* Update app and spin/commission settings */

app.put(
  "/api/admin/settings",
  adminAuth,
  (req, res) => {
    const oldSettings = getSettings();
    const incoming = req.body || {};
    const next = { ...oldSettings };

    for (const key of ["appName", "tagline"]) {
      if (typeof incoming[key] === "string") {
        next[key] = cleanText(incoming[key], 80);
      }
    }

    const numericKeys = [
      "tapReward",
      "maxEnergy",
      "energyPerSecond",
      "dailyBonus",
      "minWithdraw",
      "referralRequired",
      "referralBonus",
      "referralsPerSpin"
    ];

    for (const key of numericKeys) {
      if (Number.isFinite(Number(incoming[key]))) {
        next[key] = Math.max(
          0,
          Math.min(
            100000000,
            Math.floor(Number(incoming[key]))
          )
        );
      }
    }

    if (typeof incoming.spinEnabled === "boolean") {
      next.spinEnabled = incoming.spinEnabled;
    }

    if (typeof incoming.commissionEnabled === "boolean") {
      next.commissionEnabled = incoming.commissionEnabled;
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

      if (rewards.length) {
        next.spinRewards = rewards;
      }
    }

    if (Array.isArray(incoming.commissionRates)) {
      next.commissionRates = Array.from(
        { length: 6 },
        (_, index) => Math.max(
          0,
          Math.min(
            100,
            Number(incoming.commissionRates[index]) || 0
          )
        )
      );
    }

    if (typeof incoming.maintenance === "boolean") {
      next.maintenance = incoming.maintenance;
    }

    if (typeof incoming.sound === "boolean") {
      next.sound = incoming.sound;
    }

    if (Array.isArray(incoming.paymentMethods)) {
      next.paymentMethods = incoming.paymentMethods
        .slice(0, 30)
        .map(method => ({
          id: cleanText(method.id, 40).replace(
            /[^a-zA-Z0-9_-]/g,
            ""
          ),
          name: cleanText(method.name, 60),
          type: method.type === "crypto"
            ? "crypto"
            : "mobile",
          enabled: !!method.enabled,
          logo: validUrl(method.logo)
            ? method.logo
            : ""
        }))
        .filter(method => method.id && method.name);
    }

    saveSettings(next);

    res.json({ settings: next });
  }
);

/* =========================
   ADMIN TASK MANAGEMENT
========================= */

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
      error:
        "Provide a title, platform, valid http(s) URL and reward."
    });
  }

  const id = db.prepare(`
    INSERT INTO tasks
    (title, platform, url, reward, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    title,
    platform,
    url,
    reward,
    now()
  ).lastInsertRowid;

  res.json({ id });
});

app.patch(
  "/api/admin/tasks/:id",
  adminAuth,
  (req, res) => {
    const task = db.prepare(`
      SELECT * FROM tasks WHERE id=?
    `).get(Number(req.params.id));

    if (!task) {
      return res.status(404).json({
        error: "Task not found."
      });
    }

    const title = cleanText(
      req.body?.title ?? task.title,
      100
    );

    const platform = cleanText(
      req.body?.platform ?? task.platform,
      40
    );

    const url = cleanText(
      req.body?.url ?? task.url,
      500
    );

    const reward = Math.floor(
      Number(req.body?.reward ?? task.reward)
    );

    const enabled =
      req.body?.enabled === undefined
        ? task.enabled
        : (req.body.enabled ? 1 : 0);

    if (
      !title ||
      !platform ||
      !validUrl(url) ||
      !Number.isSafeInteger(reward) ||
      reward < 0
    ) {
      return res.status(400).json({
        error: "Invalid task data."
      });
    }

    db.prepare(`
      UPDATE tasks
      SET title=?, platform=?, url=?, reward=?, enabled=?
      WHERE id=?
    `).run(
      title,
      platform,
      url,
      reward,
      enabled,
      task.id
    );

    res.json({ ok: true });
  }
);

app.delete(
  "/api/admin/tasks/:id",
  adminAuth,
  (req, res) => {
    const taskId = Number(req.params.id);

    db.prepare(`
      DELETE FROM task_claims WHERE task_id=?
    `).run(taskId);

    db.prepare(`
      DELETE FROM tasks WHERE id=?
    `).run(taskId);

    res.json({ ok: true });
  }
);

/* =========================
   ADMIN WITHDRAWAL MANAGEMENT
========================= */

app.patch(
  "/api/admin/withdrawals/:id",
  adminAuth,
  (req, res) => {
    const status = String(req.body?.status || "");

    if (
      !["pending", "approved", "paid", "rejected"]
        .includes(status)
    ) {
      return res.status(400).json({
        error: "Invalid status."
      });
    }

    const txid = cleanText(req.body?.txid, 160);
    const note = cleanText(req.body?.note, 250);

    const withdrawal = db.prepare(`
      SELECT * FROM withdrawals WHERE id=?
    `).get(Number(req.params.id));

    if (!withdrawal) {
      return res.status(404).json({
        error: "Request not found."
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
        `).run(
          withdrawal.amount,
          withdrawal.user_id
        );
      }

      db.prepare(`
        UPDATE withdrawals
        SET
          status=?,
          txid=?,
          note=?,
          updated_at=?
        WHERE id=?
      `).run(
        status,
        txid,
        note,
        now(),
        withdrawal.id
      );
    });

    transaction();

    res.json({ ok: true });
  }
);

/* =========================
   ADMIN USER MANAGEMENT
========================= */

app.patch(
  "/api/admin/users/:id",
  adminAuth,
  (req, res) => {
    const user = getUserById(
      Number(req.params.id)
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    const balance =
      req.body?.balance === undefined
        ? user.balance
        : Math.floor(Number(req.body.balance));

    if (
      !Number.isSafeInteger(balance) ||
      balance < 0 ||
      balance > 1e12
    ) {
      return res.status(400).json({
        error: "Invalid balance."
      });
    }

    const banned =
      req.body?.banned === undefined
        ? user.is_banned
        : (req.body.banned ? 1 : 0);

    db.prepare(`
      UPDATE users
      SET balance=?, is_banned=?
      WHERE id=?
    `).run(balance, banned, user.id);

    res.json({ ok: true });
  }
);

/* =========================
   FALLBACK / START SERVER
========================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log(`CoinNova server listening on ${PORT}`);
});
