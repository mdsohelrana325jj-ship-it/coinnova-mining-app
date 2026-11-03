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
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

if (PROD && (!BOT_TOKEN || !ADMIN_PASSWORD || SESSION_SECRET.length < 32)) {
  console.error(
    "Configuration error: set BOT_TOKEN, ADMIN_PASSWORD and SESSION_SECRET (32+ characters)."
  );
  process.exit(1);
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { extensions: ["html"] }));

/* ---------------- DATABASE ---------------- */

const dbPath =
  process.env.DB_PATH ||
  path.join(__dirname, "data", "coinnova.sqlite");

try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
} catch (error) {
  console.error("Cannot create database directory:", error.message);
  console.error("Check DB_PATH and your Render Persistent Disk mount.");
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

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

/* Migrate older databases safely. */
const userColumns = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map(column => column.name);

if (!userColumns.includes("photo_url")) {
  db.exec("ALTER TABLE users ADD COLUMN photo_url TEXT DEFAULT ''");
}

if (!userColumns.includes("spins_available")) {
  db.exec(
    "ALTER TABLE users ADD COLUMN spins_available INTEGER NOT NULL DEFAULT 0"
  );
}

/* ---------------- DEFAULT SETTINGS ---------------- */

const now = () => Date.now();

const defaultSettings = {
  appName: "CoinNova",
  tagline: "Tap • Mine • Earn",

  logoUrl: "",
  loadingImage: "",
  loadingEnabled: true,

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

  walletCategoryName: "E-Wallet",
  walletCategoryLogo: "",
  networkCategoryName: "Select Network",
  networkCategoryLogo: "",
  binanceButtonName: "Binance",
  binanceButtonLogo: "https://cdn.simpleicons.org/binance/F0B90B",

  withdrawalTitle: "Withdraw",
  withdrawalNotice:
    "Select a withdrawal category first. Verify the destination before submitting.",
  withdrawalFeeText: "Secure payout",

  paymentMethods: [
    {
      id: "bkash",
      name: "bKash",
      type: "mobile",
      enabled: true,
      logo: "https://cdn.simpleicons.org/bkash/E2136E",
      color: "#E2136E",
      animation: "pulse",
      fee: 0,
      minimum: 100
    },
    {
      id: "nagad",
      name: "Nagad",
      type: "mobile",
      enabled: true,
      logo: "https://cdn.simpleicons.org/nagad/F6921E",
      color: "#F6921E",
      animation: "pulse",
      fee: 0,
      minimum: 100
    },
    {
      id: "rocket",
      name: "Rocket",
      type: "mobile",
      enabled: true,
      logo: "https://cdn.simpleicons.org/dutchbanglabank/8B1E8B",
      color: "#8B1E8B",
      animation: "pulse",
      fee: 0,
      minimum: 100
    },
    {
      id: "usdt_trc20",
      name: "USDT TRC20",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B",
      color: "#26A17B",
      animation: "pulse",
      fee: 0,
      minimum: 100
    },
    {
      id: "usdt_bep20",
      name: "USDT BEP20",
      type: "crypto",
      enabled: true,
      logo: "https://cdn.simpleicons.org/tether/26A17B",
      color: "#F0B90B",
      animation: "pulse",
      fee: 0,
      minimum: 100
    }
  ],

  updatedAt: now()
};

const getSettingStmt = db.prepare(
  "SELECT value FROM settings WHERE key = ?"
);

const setSettingStmt = db.prepare(`
  INSERT INTO settings(key, value)
  VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSettings() {
  const row = getSettingStmt.get("main");

  if (!row) {
    setSettingStmt.run("main", JSON.stringify(defaultSettings));
    return { ...defaultSettings };
  }

  try {
    return {
      ...defaultSettings,
      ...JSON.parse(row.value)
    };
  } catch (error) {
    console.error("Settings parse error:", error.message);
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  settings.updatedAt = now();
  setSettingStmt.run("main", JSON.stringify(settings));
  return settings;
}

if (!getSettingStmt.get("main")) {
  saveSettings({ ...defaultSettings });
}

if (db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n === 0) {
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

/* ---------------- UTILITIES / AUTH ---------------- */

function cleanText(value, max = 100) {
  return String(value ?? "").trim().slice(0, max);
}

function validUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  const body = base64url(JSON.stringify(payload));
  const secret = SESSION_SECRET || "dev-secret-change-me";
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

function verify(token) {
  try {
    const [body, signature] = String(token || "").split(".");
    if (!body || !signature) return null;

    const secret = SESSION_SECRET || "dev-secret-change-me";
    const expected = crypto
      .createHmac("sha256", secret)
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
      Buffer.from(body, "base64url").toString("utf8")
    );

    if (!payload.exp || payload.exp < Date.now()) return null;
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

function auth(req, res, next) {
  const payload = verify(req.cookies?.cn_auth);

  if (!payload) {
    return res.status(401).json({ error: "Please sign in again." });
  }

  req.auth = payload;
  next();
}

function adminAuth(req, res, next) {
  return auth(req, res, () => {
    if (req.auth.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }
    next();
  });
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const a = Buffer.from(receivedHash, "hex");
    const b = Buffer.from(calculatedHash, "hex");

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const authDate = Number(params.get("auth_date") || 0);
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;

    if (!authDate || ageSeconds < -60 || ageSeconds > 86400) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "{}");
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function publicUser(user) {
  if (!user) return null;

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
    db.prepare(
      "UPDATE users SET energy = ?, last_energy_at = ? WHERE id = ?"
    ).run(energy, now(), user.id);
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
    return res.status(403).json({ error: "User unavailable or blocked." });
  }

  req.user = user;
  next();
}

function countQualifiedReferrals(userId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM referrals WHERE inviter_id = ? AND qualified = 1"
    )
    .get(userId).n;
}

function recordEarning(userId, amount, kind) {
  const value = Math.floor(Number(amount));
  if (!Number.isSafeInteger(value) || value <= 0) return;

  db.prepare(
    "INSERT INTO earnings(user_id, amount, kind, created_at) VALUES(?, ?, ?, ?)"
  ).run(userId, value, kind, now());
}

/* ---------------- BANGLADESH TIME / COMMISSION ---------------- */

function bdDate(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayStartBd(timestamp = Date.now()) {
  const date = bdDate(timestamp);
  return Date.parse(`${date}T00:00:00+06:00`);
}

function levelAncestors(userId, maxLevels = 6) {
  const result = [];
  let currentId = userId;

  for (let level = 1; level <= maxLevels; level++) {
    const relation = db
      .prepare(
        "SELECT inviter_id FROM referrals WHERE invited_user_id = ? AND qualified = 1"
      )
      .get(currentId);

    if (!relation) break;

    result.push({ userId: relation.inviter_id, level });
    currentId = relation.inviter_id;
  }

  return result;
}

function teamStats(userId) {
  const result = [];
  let frontier = [userId];
  const start = dayStartBd();
  const end = start + 86400000;

  for (let level = 1; level <= 6; level++) {
    if (!frontier.length) {
      result.push({
        level,
        members: 0,
        todayMembers: 0,
        todayCoins: 0,
        commissionToday: 0
      });
      continue;
    }

    const placeholders = frontier.map(() => "?").join(",");

    const members = db
      .prepare(`
        SELECT id, created_at
        FROM users
        WHERE id IN (
          SELECT invited_user_id
          FROM referrals
          WHERE qualified = 1
            AND inviter_id IN (${placeholders})
        )
      `)
      .all(...frontier);

    const ids = members.map(member => member.id);
    let todayCoins = 0;

    if (ids.length) {
      const userPlaceholders = ids.map(() => "?").join(",");

      todayCoins = db
        .prepare(`
          SELECT COALESCE(SUM(amount), 0) AS n
          FROM earnings
          WHERE user_id IN (${userPlaceholders})
            AND created_at >= ?
            AND created_at < ?
        `)
        .get(...ids, start, end).n;
    }

    const commissionToday = db
      .prepare(`
        SELECT COALESCE(SUM(amount), 0) AS n
        FROM commission_payouts
        WHERE beneficiary_id = ?
          AND level = ?
          AND created_at >= ?
          AND created_at < ?
      `)
      .get(userId, level, start, end).n;

    result.push({
      level,
      members: ids.length,
      todayMembers: members.filter(member => bdDate(member.created_at) === bdDate()).length,
      todayCoins,
      commissionToday
    });

    frontier = ids;
  }

  return result;
}

function payDailyCommissions() {
  const settings = getSettings();
  if (!settings.commissionEnabled) return;

  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const time = Object.fromEntries(timeParts.map(part => [part.type, part.value]));

  // Payout starts after 01:00 Bangladesh time.
  if (Number(time.hour) < 1) return;

  const day = bdDate(Date.now() - 86400000);
  const start = dayStartBd(Date.now() - 86400000);
  const end = start + 86400000;

  const earners = db
    .prepare(`
      SELECT DISTINCT user_id
      FROM earnings
      WHERE created_at >= ? AND created_at < ?
    `)
    .all(start, end);

  const transaction = db.transaction(() => {
    for (const earner of earners) {
      const earned = db
        .prepare(`
          SELECT COALESCE(SUM(amount), 0) AS n
          FROM earnings
          WHERE user_id = ? AND created_at >= ? AND created_at < ?
        `)
        .get(earner.user_id, start, end).n;

      if (earned <= 0) continue;

      for (const ancestor of levelAncestors(earner.user_id, 6)) {
        const rate = Number(settings.commissionRates?.[ancestor.level - 1] || 0);
        const amount = Math.floor((earned * rate) / 100);

        if (rate <= 0 || amount <= 0) continue;

        const inserted = db
          .prepare(`
            INSERT OR IGNORE INTO commission_payouts
            (beneficiary_id, source_user_id, day, level, base_amount, rate, amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
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
          db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
            .run(amount, ancestor.userId);
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
setTimeout(payDailyCommissions, 5000);

/* ---------------- PAGES / HEALTH ---------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "Admin.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "CoinNova", time: now() });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "CoinNova", time: now() });
});

/* ---------------- TELEGRAM LOGIN ---------------- */

const telegramLoginLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.post("/api/auth/telegram", telegramLoginLimit, (req, res) => {
  try {
    const telegramUser = verifyTelegramInitData(
      String(req.body?.initData || "")
    );

    if (!telegramUser) {
      return res.status(401).json({
        error: "Telegram authentication failed. Reopen the app from Telegram."
      });
    }

    const tgId = String(telegramUser.id);
    const name = cleanText(
      [telegramUser.first_name, telegramUser.last_name]
        .filter(Boolean)
        .join(" ") || "Miner",
      80
    );
    const username = cleanText(telegramUser.username || "", 64);
    const photoUrl = validUrl(telegramUser.photo_url)
      ? telegramUser.photo_url
      : "";

    const startParam = cleanText(req.body?.startParam || "", 80);

    const transaction = db.transaction(() => {
      let user = db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId);

      if (!user) {
        const settings = getSettings();

        db.prepare(`
          INSERT INTO users
          (tg_id, name, username, photo_url, balance, energy,
           last_energy_at, invited_by, created_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
          tgId,
          name,
          username,
          photoUrl,
          settings.maxEnergy,
          now(),
          startParam.startsWith("ref_") ? startParam.slice(4) : "",
          now()
        );

        user = db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId);

        if (startParam.startsWith("ref_")) {
          const inviterTgId = startParam.slice(4);
          const inviter = db
            .prepare("SELECT * FROM users WHERE tg_id = ?")
            .get(inviterTgId);

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
          SET name = ?, username = ?, photo_url = ?
          WHERE id = ?
        `).run(name, username, photoUrl || user.photo_url || "", user.id);
      }

      return db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId);
    });

    const user = transaction();

    if (!user || user.is_banned) {
      return res.status(403).json({ error: "This account is blocked." });
    }

    setAuthCookie(res, {
      role: "user",
      uid: user.id,
      tgId: user.tg_id
    });

    res.json({
      ok: true,
      user: publicUser(refreshEnergy(user)),
      settings: getSettings(),
      tasks: listTasksForUser(user.id),
      referralUrl: BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?startapp=ref_${user.tg_id}`
        : ""
    });
  } catch (error) {
    console.error("Telegram authentication error:", error);
    res.status(500).json({ error: "Authentication server error." });
  }
});

/* ---------------- ADMIN AUTH ---------------- */

app.post(
  "/api/auth/admin",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false
  }),
  (req, res) => {
    const password = String(req.body?.password || "");

    if (!ADMIN_PASSWORD || password.length > 300) {
      return res.status(401).json({ error: "Incorrect admin password." });
    }

    const submittedHash = crypto
      .createHash("sha256")
      .update(password)
      .digest();

    const expectedHash = crypto
      .createHash("sha256")
      .update(ADMIN_PASSWORD)
      .digest();

    if (!crypto.timingSafeEqual(submittedHash, expectedHash)) {
      return res.status(401).json({ error: "Incorrect admin password." });
    }

    setAuthCookie(res, { role: "admin" });
    res.json({ ok: true });
  }
);

app.post("/api/admin/login-check", adminAuth, (req, res) => {
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/* ---------------- USER PROFILE / TASKS ---------------- */

function listTasksForUser(userId) {
  return db
    .prepare(`
      SELECT t.*,
        CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS claimed
      FROM tasks t
      LEFT JOIN task_claims c
        ON c.task_id = t.id AND c.user_id = ?
      WHERE t.enabled = 1
      ORDER BY t.id
    `)
    .all(userId)
    .map(task => ({
      id: task.id,
      title: task.title,
      platform: task.platform,
      url: task.url,
      reward: task.reward,
      claimed: Boolean(task.claimed)
    }));
}

app.get("/api/me", auth, requireUser, (req, res) => {
  const user = getUserById(req.user.id);
  const start = dayStartBd();
  const end = start + 86400000;

  res.json({
    user: publicUser(req.user),
    settings: getSettings(),
    tasks: listTasksForUser(req.user.id),
    referralUrl: BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?startapp=ref_${user.tg_id}`
      : "",
    referrals: countQualifiedReferrals(user.id),
    spinHistory: db
      .prepare(`
        SELECT reward, created_at AS createdAt
        FROM spin_history
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 10
      `)
      .all(user.id),
    commissionLevels: teamStats(user.id),
    commissionToday: db
      .prepare(`
        SELECT COALESCE(SUM(amount), 0) AS n
        FROM commission_payouts
        WHERE beneficiary_id = ? AND created_at >= ? AND created_at < ?
      `)
      .get(user.id, start, end).n,
    withdrawals: db
      .prepare(`
        SELECT id, method, address, amount, status, txid, note,
               created_at AS createdAt
        FROM withdrawals
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 20
      `)
      .all(user.id)
  });
});

/* ---------------- MINING ---------------- */

app.post("/api/tap", auth, requireUser, (req, res) => {
  const settings = getSettings();

  if (settings.maintenance) {
    return res.status(503).json({ error: "App is under maintenance." });
  }

  const user = refreshEnergy(req.user);
  const count = Math.max(1, Math.min(20, Math.floor(Number(req.body?.count) || 1)));

  if (user.energy < count) {
    return res.status(400).json({ error: "Not enough energy." });
  }

  const reward = count * settings.tapReward;

  const transaction = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE users
      SET balance = balance + ?,
          energy = energy - ?,
          total_taps = total_taps + ?,
          last_energy_at = ?
      WHERE id = ? AND energy >= ?
    `).run(reward, count, count, now(), user.id, count);

    if (!updated.changes) throw new Error("Not enough energy.");

    recordEarning(user.id, reward, "tap");

    const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);

    if (updatedUser.total_taps >= 10) {
      const referral = db.prepare(`
        SELECT * FROM referrals
        WHERE invited_user_id = ? AND qualified = 0
      `).get(user.id);

      if (referral) {
        db.prepare("UPDATE referrals SET qualified = 1 WHERE id = ?")
          .run(referral.id);

        const freshSettings = getSettings();

        db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
          .run(freshSettings.referralBonus, referral.inviter_id);

        recordEarning(
          referral.inviter_id,
          freshSettings.referralBonus,
          "referral_bonus"
        );

        const qualifiedCount = countQualifiedReferrals(referral.inviter_id);
        const perSpin = Math.max(1, Number(freshSettings.referralsPerSpin) || 1);
        const grantRow = db.prepare(`
          SELECT total_granted FROM spin_grants WHERE inviter_id = ?
        `).get(referral.inviter_id);

        const previouslyGranted = grantRow?.total_granted || 0;
        const shouldHave = Math.floor(qualifiedCount / perSpin);

        if (freshSettings.spinEnabled && shouldHave > previouslyGranted) {
          db.prepare(`
            UPDATE users
            SET spins_available = spins_available + ?
            WHERE id = ?
          `).run(shouldHave - previouslyGranted, referral.inviter_id);

          db.prepare(`
            INSERT INTO spin_grants(inviter_id, total_granted)
            VALUES(?, ?)
            ON CONFLICT(inviter_id)
            DO UPDATE SET total_granted = excluded.total_granted
          `).run(referral.inviter_id, shouldHave);
        }
      }
    }
  });

  try {
    transaction();
    res.json({
      user: publicUser(refreshEnergy(getUserById(user.id))),
      reward
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Mining failed." });
  }
});

/* ---------------- DAILY BONUS ---------------- */

app.post("/api/bonus/daily", auth, requireUser, (req, res) => {
  const today = bdDate();
  const key = `daily_${req.user.id}`;
  const previous = getSettingStmt.get(key);

  if (previous && previous.value === today) {
    return res.status(400).json({ error: "Daily bonus already claimed today." });
  }

  const settings = getSettings();

  const transaction = db.transaction(() => {
    setSettingStmt.run(key, today);

    db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
      .run(settings.dailyBonus, req.user.id);

    recordEarning(req.user.id, settings.dailyBonus, "daily_bonus");
  });

  transaction();

  res.json({
    reward: settings.dailyBonus,
    user: publicUser(getUserById(req.user.id))
  });
});

/* ---------------- TASKS ---------------- */

app.post("/api/tasks/:id/claim", auth, requireUser, (req, res) => {
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND enabled = 1
  `).get(Number(req.params.id));

  if (!task) {
    return res.status(404).json({ error: "Task not found." });
  }

  try {
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO task_claims(user_id, task_id, claimed_at)
        VALUES(?, ?, ?)
      `).run(req.user.id, task.id, now());

      db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
        .run(task.reward, req.user.id);

      recordEarning(req.user.id, task.reward, "task");
    });

    transaction();
  } catch {
    return res.status(409).json({ error: "Task already claimed." });
  }

  res.json({
    reward: task.reward,
    user: publicUser(getUserById(req.user.id))
  });
});

/* ---------------- LUCKY SPIN ---------------- */

app.post("/api/spin", auth, requireUser, (req, res) => {
  const settings = getSettings();

  if (!settings.spinEnabled) {
    return res.status(403).json({ error: "Lucky Spin is disabled." });
  }

  const user = getUserById(req.user.id);

  if ((user.spins_available || 0) < 1) {
    return res.status(400).json({
      error: "No spins available. Invite qualified friends to earn spins."
    });
  }

  const rewards = (settings.spinRewards || [])
    .map(Number)
    .filter(value => Number.isSafeInteger(value) && value >= 0);

  if (!rewards.length) {
    return res.status(503).json({ error: "Spin rewards are not configured." });
  }

  const reward = rewards[crypto.randomInt(rewards.length)];

  const transaction = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE users
      SET spins_available = spins_available - 1,
          balance = balance + ?
      WHERE id = ? AND spins_available > 0
    `).run(reward, user.id);

    if (!changed.changes) throw new Error("No spins available.");

    db.prepare(`
      INSERT INTO spin_history(user_id, reward, created_at)
      VALUES(?, ?, ?)
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
    res.status(400).json({ error: error.message });
  }
});

/* ---------------- COMMISSIONS ---------------- */

app.get("/api/commissions", auth, requireUser, (req, res) => {
  const start = dayStartBd();
  const end = start + 86400000;

  res.json({
    today: bdDate(),
    total: db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS n
      FROM commission_payouts
      WHERE beneficiary_id = ? AND created_at >= ? AND created_at < ?
    `).get(req.user.id, start, end).n,
    levels: teamStats(req.user.id),
    history: db.prepare(`
      SELECT day, level, amount, base_amount AS baseAmount,
             rate, created_at AS createdAt
      FROM commission_payouts
      WHERE beneficiary_id = ?
      ORDER BY id DESC LIMIT 50
    `).all(req.user.id),
    rates: getSettings().commissionRates,
    enabled: Boolean(getSettings().commissionEnabled)
  });
});

/* ---------------- WALLET / WITHDRAWALS ---------------- */

app.get("/api/wallet/options", auth, requireUser, (req, res) => {
  const settings = getSettings();

  res.json({
    methods: settings.paymentMethods.filter(method => method.enabled),
    minWithdraw: settings.minWithdraw,
    referralRequired: settings.referralRequired,
    walletCategoryName: settings.walletCategoryName,
    walletCategoryLogo: settings.walletCategoryLogo,
    networkCategoryName: settings.networkCategoryName,
    networkCategoryLogo: settings.networkCategoryLogo,
    binanceButtonName: settings.binanceButtonName,
    binanceButtonLogo: settings.binanceButtonLogo,
    withdrawalTitle: settings.withdrawalTitle,
    withdrawalNotice: settings.withdrawalNotice,
    withdrawalFeeText: settings.withdrawalFeeText
  });
});

app.post("/api/withdraw", auth, requireUser, (req, res) => {
  const settings = getSettings();
  const methodId = cleanText(req.body?.method, 40);
  const address = cleanText(req.body?.address, 180);
  const amount = Math.floor(Number(req.body?.amount));

  const method = settings.paymentMethods.find(
    item => item.id === methodId && item.enabled
  );

  if (!method) {
    return res.status(400).json({ error: "Choose an available withdrawal method." });
  }

  const minimum = Math.max(
    Number(settings.minWithdraw) || 0,
    Number(method.minimum) || 0
  );

  if (!Number.isSafeInteger(amount) || amount < minimum) {
    return res.status(400).json({ error: `Minimum withdrawal is ${minimum} coins.` });
  }

  if (address.length < 5) {
    return res.status(400).json({ error: "Enter a valid destination number or wallet address." });
  }

  if (req.user.balance < amount) {
    return res.status(400).json({ error: "Insufficient balance." });
  }

  const qualified = countQualifiedReferrals(req.user.id);

  if (qualified < settings.referralRequired) {
    return res.status(400).json({
      error: `You need ${settings.referralRequired} qualified referral(s). Current: ${qualified}.`
    });
  }

  const feePercent = Math.max(0, Math.min(100, Number(method.fee) || 0));
  const fee = Math.floor((amount * feePercent) / 100);
  const netAmount = amount - fee;

  try {
    const transaction = db.transaction(() => {
      const changed = db.prepare(`
        UPDATE users
        SET balance = balance - ?
        WHERE id = ? AND balance >= ?
      `).run(amount, req.user.id, amount);

      if (!changed.changes) throw new Error("Insufficient balance.");

      return db.prepare(`
        INSERT INTO withdrawals
        (user_id, method, address, amount, status, txid, note, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'pending', '', ?, ?, ?)
      `).run(
        req.user.id,
        methodId,
        address,
        amount,
        `fee=${feePercent}%;feeAmount=${fee};netAmount=${netAmount}`,
        now(),
        now()
      ).lastInsertRowid;
    });

    const id = transaction();

    res.json({
      ok: true,
      id,
      fee,
      netAmount,
      message: "Withdrawal request submitted for admin review.",
      user: publicUser(getUserById(req.user.id))
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Withdrawal failed." });
  }
});

/* ---------------- ADMIN OVERVIEW ---------------- */

app.get("/api/admin/overview", adminAuth, (req, res) => {
  const counts = {
    users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    banned: db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_banned = 1").get().n,
    withdrawPending: db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'").get().n,
    withdrawTotal: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM withdrawals").get().n,
    coins: db.prepare("SELECT COALESCE(SUM(balance), 0) AS n FROM users").get().n,
    taps: db.prepare("SELECT COALESCE(SUM(total_taps), 0) AS n FROM users").get().n,
    spinAvailable: db.prepare("SELECT COALESCE(SUM(spins_available), 0) AS n FROM users").get().n
  };

  const start = dayStartBd();
  const end = start + 86400000;

  counts.commissionToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS n
    FROM commission_payouts
    WHERE created_at >= ? AND created_at < ?
  `).get(start, end).n;

  const withdrawals = db.prepare(`
    SELECT w.*, u.name AS userName, u.tg_id AS tgId
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ORDER BY w.id DESC LIMIT 100
  `).all();

  const users = db.prepare(`
    SELECT id, tg_id, name, username, balance, energy,
           created_at, is_banned, total_taps, spins_available
    FROM users
    ORDER BY id DESC LIMIT 200
  `).all();

  res.json({
    counts,
    settings: getSettings(),
    tasks: db.prepare("SELECT * FROM tasks ORDER BY id DESC").all(),
    withdrawals,
    users
  });
});

/* ---------------- ADMIN SETTINGS ---------------- */

app.put("/api/admin/settings", adminAuth, (req, res) => {
  const incoming = req.body || {};
  const current = getSettings();
  const next = { ...current };

  // Allow known and custom UI settings to be saved.
  // This includes headings, labels, logos, loading images, messages and category names.
  const textFields = [
    "appName",
    "tagline",
    "logoUrl",
    "loadingImage",
    "walletCategoryName",
    "walletCategoryLogo",
    "networkCategoryName",
    "networkCategoryLogo",
    "binanceButtonName",
    "binanceButtonLogo",
    "withdrawalTitle",
    "withdrawalNotice",
    "withdrawalFeeText"
  ];

  for (const key of textFields) {
    if (typeof incoming[key] === "string") {
      const max = key.toLowerCase().includes("notice") ? 1000 : 500;
      if (
        key.toLowerCase().includes("url") ||
        key.toLowerCase().includes("logo") ||
        key === "loadingImage"
      ) {
        if (incoming[key] === "" || validUrl(incoming[key])) {
          next[key] = incoming[key].slice(0, max);
        }
      } else {
        next[key] = cleanText(incoming[key], max);
      }
    }
  }

  for (const key of [
    "tapReward",
    "maxEnergy",
    "energyPerSecond",
    "dailyBonus",
    "minWithdraw",
    "referralRequired",
    "referralBonus",
    "referralsPerSpin"
  ]) {
    if (incoming[key] !== undefined && Number.isFinite(Number(incoming[key]))) {
      next[key] = Math.max(
        0,
        Math.min(100000000, Math.floor(Number(incoming[key])))
      );
    }
  }

  for (const key of [
    "spinEnabled",
    "commissionEnabled",
    "maintenance",
    "sound",
    "loadingEnabled"
  ]) {
    if (typeof incoming[key] === "boolean") next[key] = incoming[key];
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
    next.commissionRates = Array.from({ length: 6 }, (_, index) => {
      const rate = Number(incoming.commissionRates[index]) || 0;
      return Math.max(0, Math.min(100, rate));
    });
  }

  if (Array.isArray(incoming.paymentMethods)) {
    next.paymentMethods = incoming.paymentMethods
      .slice(0, 50)
      .map((method, index) => {
        const id = cleanText(method.id || `method_${index + 1}`, 40)
          .replace(/[^a-zA-Z0-9_-]/g, "");

        const name = cleanText(method.name, 60);
        const type = method.type === "crypto" ? "crypto" : "mobile";

        return {
          id,
          name,
          type,
          enabled: method.enabled !== false,
          logo: method.logo && validUrl(method.logo)
            ? method.logo.slice(0, 500)
            : "",
          color: /^#[0-9a-f]{6}$/i.test(method.color || "")
            ? method.color
            : "#F0B90B",
          animation: cleanText(method.animation || "pulse", 30),
          fee: Math.max(0, Math.min(100, Number(method.fee) || 0)),
          minimum: Math.max(0, Math.floor(Number(method.minimum) || 0))
        };
      })
      .filter(method => method.id && method.name);
  }

  // Save other simple custom settings too, for future UI controls.
  const protectedKeys = new Set([
    "paymentMethods",
    "spinRewards",
    "commissionRates"
  ]);

  for (const [key, value] of Object.entries(incoming)) {
    if (
      /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key) &&
      !protectedKeys.has(key) &&
      !["__proto__", "constructor", "prototype"].includes(key) &&
      (typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)))
    ) {
      if (typeof value === "string") {
        next[key] = value.slice(0, 2000);
      } else {
        next[key] = value;
      }
    }
  }

  saveSettings(next);
  res.json({ ok: true, settings: next });
});

/* ---------------- ADMIN TASKS ---------------- */

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

  const id = db.prepare(`
    INSERT INTO tasks(title, platform, url, reward, enabled, created_at)
    VALUES(?, ?, ?, ?, 1, ?)
  `).run(title, platform, url, reward, now()).lastInsertRowid;

  res.json({ id });
});

app.patch("/api/admin/tasks/:id", adminAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?")
    .get(Number(req.params.id));

  if (!task) return res.status(404).json({ error: "Task not found." });

  const title = cleanText(req.body?.title ?? task.title, 100);
  const platform = cleanText(req.body?.platform ?? task.platform, 40);
  const url = cleanText(req.body?.url ?? task.url, 500);
  const reward = Math.floor(Number(req.body?.reward ?? task.reward));
  const enabled = req.body?.enabled === undefined
    ? task.enabled
    : (req.body.enabled ? 1 : 0);

  if (!title || !platform || !validUrl(url) || !Number.isSafeInteger(reward) || reward < 0) {
    return res.status(400).json({ error: "Invalid task data." });
  }

  db.prepare(`
    UPDATE tasks
    SET title = ?, platform = ?, url = ?, reward = ?, enabled = ?
    WHERE id = ?
  `).run(title, platform, url, reward, enabled, task.id);

  res.json({ ok: true });
});

app.delete("/api/admin/tasks/:id", adminAuth, (req, res) => {
  const id = Number(req.params.id);

  db.prepare("DELETE FROM task_claims WHERE task_id = ?").run(id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);

  res.json({ ok: true });
});

/* ---------------- ADMIN WITHDRAWALS ---------------- */

app.patch("/api/admin/withdrawals/:id", adminAuth, (req, res) => {
  const status = String(req.body?.status || "");

  if (!["pending", "approved", "paid", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid withdrawal status." });
  }

  const txid = cleanText(req.body?.txid, 160);
  const note = cleanText(req.body?.note, 250);
  const withdrawal = db.prepare("SELECT * FROM withdrawals WHERE id = ?")
    .get(Number(req.params.id));

  if (!withdrawal) {
    return res.status(404).json({ error: "Withdrawal request not found." });
  }

  const transaction = db.transaction(() => {
    if (
      status === "rejected" &&
      withdrawal.status !== "rejected" &&
      withdrawal.status !== "paid"
    ) {
      db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
        .run(withdrawal.amount, withdrawal.user_id);
    }

    db.prepare(`
      UPDATE withdrawals
      SET status = ?, txid = ?, note = ?, updated_at = ?
      WHERE id = ?
    `).run(status, txid, note, now(), withdrawal.id);
  });

  transaction();
  res.json({ ok: true });
});

/* ---------------- ADMIN USERS ---------------- */

app.patch("/api/admin/users/:id", adminAuth, (req, res) => {
  const user = getUserById(Number(req.params.id));

  if (!user) return res.status(404).json({ error: "User not found." });

  const balance = req.body?.balance === undefined
    ? user.balance
    : Math.floor(Number(req.body.balance));

  if (!Number.isSafeInteger(balance) || balance < 0 || balance > 1e12) {
    return res.status(400).json({ error: "Invalid balance." });
  }

  const banned = req.body?.banned === undefined
    ? user.is_banned
    : (req.body.banned ? 1 : 0);

  db.prepare(`
    UPDATE users
    SET balance = ?, is_banned = ?
    WHERE id = ?
  `).run(balance, banned, user.id);

  res.json({ ok: true });
});

/* ---------------- ERROR HANDLING ---------------- */

app.use((req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`CoinNova server listening on port ${PORT}`);
  console.log(`Database: ${dbPath}`);
});
