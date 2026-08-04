require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("baileys");

const app = express();

// ------------ Config ------------
const PORT = Number(process.env.PORT || 4001);
const API_KEY = process.env.API_KEY || "";
const SESSION_LABEL = process.env.WWS_SESSION_LABEL || "tirtabening";
const AUTH_DIR = path.join(__dirname, `auth_info_${SESSION_LABEL}`);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ------------ Logs Ring Buffer ------------
const LOG_MAX = Number(process.env.LOG_MAX || 500);
const logs = []; // { ts: number, level: 'info'|'warn'|'error'|'debug', msg: string, meta?: any }

function addLog(level, msg, meta) {
  logs.push({ ts: Date.now(), level, msg, meta });
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
  // tetap kirim ke console untuk debugging server
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  if (level === "error") console.error(line, meta || "");
  else if (level === "warn") console.warn(line, meta || "");
  else console.log(line, meta || "");
}

// ------------ Middleware ------------
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.length === 0) return cb(null, true);
      return allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error("Not allowed by CORS"));
    },
  }),
);

// Simple API key auth
app.use((req, res, next) => {
  if (!API_KEY) return next(); // kalau tidak di-set, nonaktif (dev only)
  const key = req.header("x-api-key");
  if (key && key === API_KEY) return next();
  return res.status(401).json({ ok: false, message: "Unauthorized" });
});

// Tambahkan limiter spesifik utk endpoint "write"
const writeLimiter = rateLimit({ windowMs: 60_000, max: 120 }); // 120/mnt

// ------------ WA Socket ------------
let sock = null;
let lastQRData = null; // simpan QR terakhir (data url)
let ready = false;
let state = "INIT";
let me = null;

const logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });

async function isSocketHealthy() {
  try {
    if (!sock) return false;
    if (!ready) return false;
    if (!sock.user) return false;
    // ws.readyState 1 === OPEN
    if (sock.ws && typeof sock.ws.readyState === "number" && sock.ws.readyState !== 1) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

let reinitLock = false;

function wipeAuthDir() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    addLog("info", "Auth dir wiped", { dir: AUTH_DIR });
  } catch (e) {
    addLog("error", "Gagal wipe auth dir", { error: e?.message });
  }
}

async function safeReinitialize(reason = "unknown", { wipeSession = false } = {}) {
  if (reinitLock) return;
  reinitLock = true;

  addLog("warn", "Reinitializing WA socket", { reason, wipeSession });

  ready = false;
  state = "REINITIALIZING";
  me = null;

  try {
    sock?.end?.(undefined);
  } catch {}

  if (wipeSession) wipeAuthDir();

  setTimeout(async () => {
    try {
      await startSocket();
      addLog("info", "startSocket() called");
    } catch (e) {
      addLog("error", "Reinitialize failed", { error: e?.message });
    } finally {
      reinitLock = false;
    }
  }, 1500);
}

function buildMe(sockRef) {
  const u = sockRef?.user;
  if (!u) return null;
  const [numberPart] = String(u.id || "").split(":");
  return {
    wid: u.id || null,
    user: numberPart || null,
    pushname: u.name || u.notify || null,
    platform: "baileys",
  };
}

async function startSocket() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: authState,
    version,
    logger,
    browser: ["TirtaBening", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state = "QR";
      ready = false;
      me = null;
      lastQRData = await QRCode.toDataURL(qr, { margin: 1 });
      qrcodeTerminal.generate(qr, { small: true });
      console.log("[WA] QR siap discan.");
      addLog("info", "QR siap discan");
    }

    if (connection === "open") {
      state = "READY";
      ready = true;
      me = buildMe(sock);
      lastQRData = null;
      addLog("info", "WhatsApp Ready", { me });
      console.log("[WA] Ready.");
    }

    if (connection === "close") {
      ready = false;
      me = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      state = loggedOut ? "LOGOUT" : "DISCONNECTED";
      addLog(loggedOut ? "warn" : "warn", "Connection closed", {
        statusCode,
        loggedOut,
      });

      await safeReinitialize(
        loggedOut ? "logged_out" : "disconnected",
        { wipeSession: loggedOut },
      );
    }
  });
}

startSocket().catch((e) => {
  addLog("error", "Initial startSocket failed", { error: e?.message });
});

// Health monitor tiap 30 detik
setInterval(async () => {
  if (!ready) return;

  const healthy = await isSocketHealthy();
  if (!healthy) {
    addLog("warn", "Health check failed");
    await safeReinitialize("health monitor");
  }
}, 30000);

// ------------ Helpers ------------
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // Normalisasi ke format Indonesia: 62xxxxxxxx
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.startsWith("8")) return "62" + digits;
  // jika sudah +62 (dihilangkan plus), atau negara lain, gunakan apa adanya
  return digits;
}

// Normalisasi nomor
function normNumber(raw) {
  return String(raw || "")
    .replace(/\D/g, "")
    .replace(/^0/, "62");
}

function toJid(msisdn) {
  return `${msisdn}@s.whatsapp.net`;
}

async function ensureReady(res) {
  if (!ready) {
    res.status(503).json({
      ok: false,
      message: "WhatsApp belum siap. Scan QR / tunggu READY.",
    });
    return true;
  }
  return false;
}

// ------------ Routes ------------
app.get("/health", (req, res) => {
  res.json({ ok: true, state, ready, me });
});

app.get("/status", (req, res) => {
  res.json({ ok: true, state, ready, me: ready ? me : null });
});

// Ambil QR terakhir (untuk dashboard)
app.get("/qr", (req, res) => {
  if (ready || !lastQRData) return res.status(204).end(); // tidak ada QR bila sudah ready
  res.json({ ok: true, dataUrl: lastQRData });
});

// Kirim pesan tunggal
// body: { to: string, text: string }
app.post("/send", writeLimiter, async (req, res) => {
  try {
    if (await ensureReady(res)) return;

    const healthy = await isSocketHealthy();
    if (!healthy) {
      await safeReinitialize("unhealthy before send");
      return res.status(503).json({
        ok: false,
        message: "WA session tidak sehat. Coba lagi beberapa detik.",
      });
    }

    const { to, text } = req.body || {};
    if (!to || !text) {
      return res
        .status(400)
        .json({ ok: false, message: "`to` dan `text` wajib" });
    }

    const msisdn = normalizePhone(to);
    if (!msisdn)
      return res.status(400).json({ ok: false, message: "Nomor tidak valid" });

    const jid = toJid(msisdn);
    const sent = await sock.sendMessage(jid, { text });

    addLog("info", "Send text OK", { to: msisdn, id: sent?.key?.id || null });

    return res.json({
      ok: true,
      id: sent?.key?.id || null,
      to: msisdn,
    });
  } catch (e) {
    addLog("error", "Send text FAIL", { error: e?.message });
    console.error("[/send] error:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || "Gagal kirim WA",
    });
  }
});

// Kirim dokumen (PDF)
app.post("/send-document", writeLimiter, async (req, res) => {
  try {
    const { to, url, base64, filename, caption, mimeType } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, message: "to wajib" });
    if (!url && !base64) {
      return res
        .status(400)
        .json({ ok: false, message: "url atau base64 wajib" });
    }

    const jid = toJid(normNumber(to));

    let buffer,
      mime = mimeType || "application/pdf",
      name = filename || "invoice.pdf";
    if (url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Gagal fetch PDF: ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
    } else {
      buffer = Buffer.from(base64, "base64");
    }

    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mime,
      fileName: name,
      caption: caption || "",
    });

    addLog("info", "Send document OK", { to, filename: name });
    return res.json({ ok: true });
  } catch (e) {
    addLog("error", "Send document FAIL", {
      to: req.body?.to,
      error: e?.message,
    });
    console.error("[send-document] error:", e);
    return res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// Kirim gambar (JPG/PNG)
// body: { to: string, url?: string, base64?: string, caption?: string, mimeType?: string, filename?: string }
app.post("/send-image", writeLimiter, async (req, res) => {
  try {
    if (await ensureReady(res)) return;
    const { to, url, base64, caption, mimeType, filename } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, message: "`to` wajib" });
    if (!url && !base64)
      return res
        .status(400)
        .json({ ok: false, message: "`url` atau `base64` wajib" });

    const jid = toJid(normNumber(to));

    // deteksi mime default
    const mime = mimeType || "image/jpeg";
    const name = filename || (mime.includes("png") ? "image.png" : "image.jpg");

    let buffer;
    if (url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Gagal fetch image: ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
    } else {
      buffer = Buffer.from(base64, "base64");
    }

    const sent = await sock.sendMessage(jid, {
      image: buffer,
      mimetype: mime,
      caption: caption || "",
    });
    void name;

    addLog("info", "Send image OK", {
      to,
      id: sent?.key?.id || null,
      filename: name,
    });
    return res.json({
      ok: true,
      id: sent?.key?.id || null,
    });
  } catch (e) {
    addLog("error", "Send image FAIL", { to: req.body?.to, error: e?.message });
    console.error("[/send-image] error:", e);
    return res
      .status(500)
      .json({ ok: false, message: String(e?.message || e) });
  }
});

// Bulk kirim (opsional)
// body: { items: [{to, text}, ...], delayMs?: number }
app.post("/bulk", writeLimiter, async (req, res) => {
  try {
    if (await ensureReady(res)) return;
    const { items, delayMs = 800 } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ ok: false, message: "`items` wajib array" });
    }

    const results = [];
    for (const it of items) {
      try {
        const msisdn = normalizePhone(it.to);
        if (!msisdn) throw new Error("Nomor tidak valid");
        const jid = toJid(msisdn);
        const sent = await sock.sendMessage(jid, { text: it.text });
        results.push({
          to: msisdn,
          ok: true,
          id: sent?.key?.id || null,
        });
        addLog("info", "Bulk send OK", { to: msisdn });
      } catch (err) {
        results.push({
          to: it.to,
          ok: false,
          message: err?.message || "error",
        });
        addLog("warn", "Bulk send FAIL", { to: it.to, error: err?.message });
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }

    res.json({ ok: true, results });
  } catch (e) {
    addLog("error", "Bulk endpoint FAIL", { error: e?.message });
    console.error("[/bulk] error:", e);
    res.status(500).json({ ok: false, message: e?.message || "Bulk gagal" });
  }
});

// Logout & hapus session (perlu scan ulang)
app.post("/logout", writeLimiter, async (req, res) => {
  try {
    ready = false;
    state = "LOGOUT";
    me = null;
    await sock?.logout?.();
    addLog("info", "Logout session OK");
    res.json({ ok: true });
  } catch (e) {
    addLog("error", "Logout FAIL", { error: e?.message });
    res.status(500).json({ ok: false, message: e?.message || "Gagal logout" });
  }
});

// Re-init: paksa inisialisasi ulang supaya QR baru muncul
app.post("/reinit", async (req, res) => {
  try {
    if (reinitLock) {
      return res.json({ ok: true, message: "Already reinitializing" });
    }

    addLog("info", "Manual re-init requested");
    await safeReinitialize("manual reinit", { wipeSession: true });

    res.json({ ok: true });
  } catch (e) {
    addLog("error", "Manual re-init FAIL", { error: e?.message });
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// get logs
app.get("/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), LOG_MAX);
  const slice = logs.slice(-limit).reverse();
  res.json({ ok: true, items: slice });
});

app.listen(PORT, () => {
  console.log(`[WA-SENDER] listening on :${PORT}`);
});
