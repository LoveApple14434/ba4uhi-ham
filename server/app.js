"use strict";

/*
  BA4UHI QSL admin
  - Single-user password login (server-side)
  - Session cookie + CSRF protection
  - CRUD for the QSL records stored in assets/data.js
  - Atomic writes with automatic backups

  Run: node app.js
  See README.md for deployment on a VPS / 宝塔.
*/

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { URL } = require("node:url");

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");
const ENV_FILE = path.join(APP_DIR, ".env");

loadEnv(ENV_FILE);

const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_PATH = normalizeBase(process.env.BASE_PATH || "/admin");
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(APP_DIR, "..", "assets", "data.js"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(APP_DIR, "backups"));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const SITE_URL = process.env.SITE_URL || "/";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = (process.env.GITHUB_REPO || "").trim();
const GITHUB_BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const GITHUB_DATA_PATH = (process.env.GITHUB_DATA_PATH || "assets/data.js")
  .trim()
  .replace(/^\/+|\/+$/g, "");
const GITHUB_API_BASE = (process.env.GITHUB_API_BASE || "https://api.github.com")
  .replace(/\/+$/, "");
const GITHUB_SYNC_ENABLED =
  process.env.GITHUB_SYNC !== "0" && Boolean(GITHUB_TOKEN && GITHUB_REPO);
const GITHUB_SYNC_FORCE = process.env.GITHUB_SYNC_FORCE === "1";
const GITHUB_STATE_FILE = path.resolve(
  process.env.GITHUB_STATE_FILE || path.join(BACKUP_DIR, "github-sync.json")
);

const COOKIE_NAME = "ba4uhi_admin_sid";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_BLOCK = 15 * 60 * 1000;
const BACKUP_LIMIT = 30;

if (BASE_PATH === "/") {
  fail("BASE_PATH cannot be '/'; use a path such as /admin");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fail("PORT must be a valid TCP port");
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  fail("ADMIN_PASSWORD must be set and at least 12 characters long");
}
if (!fs.existsSync(DATA_FILE)) {
  fail(`DATA_FILE does not exist: ${DATA_FILE}`);
}
if (GITHUB_REPO && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GITHUB_REPO)) {
  fail("GITHUB_REPO must look like owner/repository");
}
if (!GITHUB_DATA_PATH || GITHUB_DATA_PATH.split("/").includes("..")) {
  fail("GITHUB_DATA_PATH must be a repository-relative path");
}
if (GITHUB_SYNC_ENABLED && !GITHUB_BRANCH) {
  fail("GITHUB_BRANCH cannot be empty");
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const sessions = new Map();
const loginAttempts = new Map();
let writeQueue = Promise.resolve();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(message) {
  console.error(`[qsl-admin] ${message}`);
  process.exit(1);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equal = trimmed.indexOf("=");
    if (equal < 1) continue;
    const key = trimmed.slice(0, equal).trim();
    let value = trimmed.slice(equal + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeBase(value) {
  let base = String(value || "/admin").trim();
  if (!base.startsWith("/")) base = `/${base}`;
  base = base.replace(/\/+$/, "");
  return base || "/admin";
}

function nowIso() {
  return new Date().toISOString();
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function sessionCookie(value, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${BASE_PATH}/`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function getSession(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  session.expires = Date.now() + SESSION_TTL;
  return { sid, session };
}

function createSession(req) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const session = {
    csrf: crypto.randomBytes(32).toString("base64url"),
    expires: Date.now() + SESSION_TTL,
    ip: clientIp(req),
  };
  sessions.set(sid, session);
  return { sid, session };
}

function loginAllowed(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return true;
  if (attempt.blockedUntil && attempt.blockedUntil > Date.now()) return false;
  if (Date.now() - attempt.firstAt > LOGIN_WINDOW) {
    loginAttempts.delete(key);
    return true;
  }
  return true;
}

function recordLoginFailure(key) {
  const now = Date.now();
  let attempt = loginAttempts.get(key);
  if (!attempt || now - attempt.firstAt > LOGIN_WINDOW) {
    attempt = { count: 0, firstAt: now };
  }
  attempt.count += 1;
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    attempt.blockedUntil = now + LOGIN_BLOCK;
  }
  loginAttempts.set(key, attempt);
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function sameOrigin(req) {
  if (!PUBLIC_ORIGIN) return true;
  const origin = req.headers.origin;
  return !origin || origin === PUBLIC_ORIGIN;
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
      "form-action 'self'; img-src 'self' data:; style-src 'self'; " +
      "script-src 'self'; connect-src 'self'"
  );
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function redirect(res, location) {
  res.writeHead(301, { Location: location });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, "请求体必须是 JSON 对象"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, maxLength = 160) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanRst(value) {
  const text = cleanText(value, 3);
  if (!text) return "";
  if (!/^\d{1,3}$/.test(text)) {
    throw new HttpError(400, "RST 必须是 1 到 3 位数字");
  }
  return Number(text);
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "日期格式必须是 YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "日期无效");
  }
  return value;
}

function validateTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, "时间格式必须是 HH:MM（24 小时制）");
  }
  return value;
}

function validateCallsign(value) {
  const callsign = cleanText(value, 20).toUpperCase();
  if (!/^[A-Z0-9/-]{2,20}$/.test(callsign)) {
    throw new HttpError(400, "呼号格式无效");
  }
  return callsign;
}

function buildRecord(body, existing) {
  const old = existing || {};
  const record = {
    date: validateDate(cleanText(body.date, 10)),
    time: validateTime(cleanText(body.time, 5)),
    callsign: validateCallsign(body.callsign),
    freq_rx: cleanText(body.freq_rx, 20),
    freq_tx: cleanText(body.freq_tx, 20),
    mode: cleanText(body.mode, 12),
    rst_sent: cleanRst(body.rst_sent),
    rst_rcvd: cleanRst(body.rst_rcvd),
    qth: cleanText(body.qth, 80),
    rig: cleanText(body.rig, 80),
    ant: cleanText(body.ant, 80),
    pwr: cleanText(body.pwr, 20),
    my_rig: cleanText(body.my_rig, 40),
    my_ant: cleanText(body.my_ant, 80),
    my_pwr: cleanText(body.my_pwr, 20),
    remarks: cleanText(body.remarks, 500),
    grid: cleanText(body.grid, 12),
    name: cleanText(body.name, 80),
    timestamp: nowIso(),
  };

  // Keep the older single-report field when it existed and no split RST was entered.
  if (!record.rst_sent && !record.rst_rcvd) {
    if (old.report !== undefined && old.report !== null && cleanText(old.report)) {
      record.report = old.report;
    }
  }

  return record;
}

function parseDataText(source, filename = DATA_FILE) {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename, timeout: 1000 });
  const data = sandbox.window.HAM_DATA;
  if (!data || !Array.isArray(data.records)) {
    throw new Error("data.js does not contain window.HAM_DATA.records");
  }
  return data;
}

function readData() {
  return parseDataText(fs.readFileSync(DATA_FILE, "utf8"));
}

function renderData(data) {
  return (
    "/* QSL log data — generated from BA4UHI QSL log. Managed by server admin. */\n" +
    `window.HAM_DATA = ${JSON.stringify(data, null, 2)};\n`
  );
}

function recordKey(record) {
  return `${record.date || ""}|${record.time || ""}|${record.callsign || ""}`;
}

function readSyncState() {
  try {
    const state = JSON.parse(fs.readFileSync(GITHUB_STATE_FILE, "utf8"));
    return state && typeof state.contentSha === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeSyncState(contentSha) {
  const state = { contentSha, syncedAt: nowIso() };
  fs.mkdirSync(path.dirname(GITHUB_STATE_FILE), { recursive: true });
  const tempFile = `${GITHUB_STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, GITHUB_STATE_FILE);
}

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function githubRequest(method, endpoint, body) {
  const response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ba4uhi-qsl-admin",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload && payload.message ? payload.message : `HTTP ${response.status}`;
    throw new GitHubError(response.status, detail);
  }
  return payload;
}

async function syncDataToGitHub(content, data) {
  if (!GITHUB_SYNC_ENABLED) return { status: "disabled" };

  const encodedPath = GITHUB_DATA_PATH.split("/").map(encodeURIComponent).join("/");
  const endpoint = `/repos/${GITHUB_REPO}/contents/${encodedPath}`;
  let remote = null;
  try {
    remote = await githubRequest(
      "GET",
      `${endpoint}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }

  const remoteSha = remote && typeof remote.sha === "string" ? remote.sha : null;
  const lastSync = readSyncState();
  const unchangedSinceLastSync =
    Boolean(lastSync && remoteSha && lastSync.contentSha === remoteSha);

  if (remote && remote.content && !unchangedSinceLastSync && !GITHUB_SYNC_FORCE) {
    let remoteData;
    try {
      remoteData = parseDataText(
        Buffer.from(remote.content, "base64").toString("utf8"),
        "GitHub:" + GITHUB_DATA_PATH
      );
    } catch (error) {
      throw new Error(`无法解析 GitHub 上的数据文件：${error.message}`);
    }
    const localKeys = new Set(data.records.map(recordKey));
    const remoteOnly = remoteData.records.filter(
      (record) => !localKeys.has(recordKey(record))
    );
    if (remoteOnly.length > 0) {
      return {
        status: "blocked",
        message:
          `GitHub 上有 ${remoteOnly.length} 条记录在线上数据中不存在，` +
          "为避免覆盖已停止同步；请先核对或使用 GITHUB_SYNC_FORCE=1 强制覆盖。",
      };
    }
  }

  const message = `data: sync QSL log from admin ${new Date()
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")} UTC [skip ci]`;
  const result = await githubRequest("PUT", endpoint, {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: GITHUB_BRANCH,
    ...(remoteSha ? { sha: remoteSha } : {}),
  });

  const newSha = result && result.content && result.content.sha;
  if (newSha) writeSyncState(newSha);
  return {
    status: "ok",
    repo: GITHUB_REPO,
    branch: GITHUB_BRANCH,
    commitUrl: (result && result.commit && result.commit.html_url) || null,
  };
}

function githubSyncInfo() {
  return {
    enabled: GITHUB_SYNC_ENABLED,
    repo: GITHUB_REPO || null,
    branch: GITHUB_BRANCH,
  };
}


function pruneBackups() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^data-\d{8}-\d{6}\.js$/.test(name))
    .sort();
  for (const name of files.slice(0, Math.max(0, files.length - BACKUP_LIMIT))) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, name));
    } catch {
      // A failed cleanup must not block saving the new record.
    }
  }
}

function writeData(data) {
  const records = data.records;
  const unique = new Set(
    records.map((record) => cleanText(record.callsign, 20)).filter(Boolean)
  ).size;
  const now = nowIso();

  data.sourceStats = {
    ...(data.sourceStats || {}),
    total_qsos: records.length,
    unique_callsigns: unique,
    last_updated: now,
  };
  data.sourceMeta = {
    ...(data.sourceMeta || {}),
    generated_at: now,
  };

  const content = renderData(data);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15);
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `data-${stamp}.js`));
    pruneBackups();
  }

  const tempFile = path.join(
    path.dirname(DATA_FILE),
    `.${path.basename(DATA_FILE)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tempFile, content, "utf8");
  fs.renameSync(tempFile, DATA_FILE);
  return content;
}

function listResponse(data) {
  const records = data.records
    .map((record, index) => ({ ...record, id: index }))
    .sort((a, b) => {
      const aKey = `${a.date || ""}T${a.time || "00:00"}:00`;
      const bKey = `${b.date || ""}T${b.time || "00:00"}:00`;
      return bKey.localeCompare(aKey) || b.id - a.id;
    });
  return {
    records,
    total: records.length,
    unique: new Set(records.map((record) => cleanText(record.callsign, 20)).filter(Boolean))
      .size,
    latest: records[0] ? `${records[0].date || ""} ${records[0].time || ""}`.trim() : "",
  };
}

function mutateData(mutator) {
  const run = writeQueue.then(async () => {
    const data = readData();
    const result = mutator(data);
    const content = writeData(data);
    let sync = { status: "disabled" };
    try {
      sync = await syncDataToGitHub(content, data);
    } catch (error) {
      console.error("[qsl-admin] GitHub sync failed:", error);
      sync = { status: "error", message: error.message || "GitHub 同步失败" };
    }
    return { ...result, sync };
  });
  writeQueue = run.catch(() => {});
  return run;
}

function requireAuth(req) {
  const found = getSession(req);
  if (!found) throw new HttpError(401, "请先登录");
  return found;
}

function requireCsrf(req, session) {
  const token = req.headers["x-csrf-token"];
  if (typeof token !== "string" || token !== session.csrf) {
    throw new HttpError(403, "CSRF 校验失败，请刷新页面重试");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

function serveAdminFile(req, res, localPath) {
  const files = {
    "/": "index.html",
    "/index.html": "index.html",
    "/admin.css": "admin.css",
    "/admin.js": "admin.js",
    "/favicon.svg": "favicon.svg",
  };
  const name = files[localPath];
  if (!name) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const filePath = path.join(PUBLIC_DIR, name);
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Admin page file is missing");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(content);
}

async function handleApi(req, res, apiPath) {
  if (apiPath === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, service: "ba4uhi-qsl-admin" });
    return;
  }

  if (apiPath === "/api/session" && req.method === "GET") {
    const found = getSession(req);
    if (!found) {
      sendJson(res, 200, { authenticated: false, siteUrl: SITE_URL });
      return;
    }
    sendJson(res, 200, {
      authenticated: true,
      csrfToken: found.session.csrf,
      siteUrl: SITE_URL,
      githubSync: githubSyncInfo(),
    });
    return;
  }

  if (apiPath === "/api/login" && req.method === "POST") {
    if (!sameOrigin(req)) throw new HttpError(403, "Origin 校验失败");
    const ip = clientIp(req);
    if (!loginAllowed(ip)) {
      throw new HttpError(429, "登录尝试过多，请 15 分钟后再试");
    }
    const body = await readJsonBody(req);
    const password = typeof body.password === "string" ? body.password : "";
    const supplied = Buffer.from(password);
    const expected = Buffer.from(ADMIN_PASSWORD);
    const valid =
      supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

    if (!valid) {
      recordLoginFailure(ip);
      throw new HttpError(401, "密码不正确");
    }

    clearLoginFailures(ip);
    const previous = getSession(req);
    if (previous) sessions.delete(previous.sid);
    const { sid, session } = createSession(req);
    res.setHeader("Set-Cookie", sessionCookie(sid, SESSION_TTL / 1000));
    sendJson(res, 200, {
      ok: true,
      csrfToken: session.csrf,
      siteUrl: SITE_URL,
      githubSync: githubSyncInfo(),
    });
    return;
  }

  if (apiPath === "/api/logout" && req.method === "POST") {
    const found = getSession(req);
    if (found) {
      requireCsrf(req, found.session);
      sessions.delete(found.sid);
    }
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (apiPath === "/api/sync" && req.method === "POST") {
    if (!sameOrigin(req)) throw new HttpError(403, "Origin 校验失败");
    const found = requireAuth(req);
    requireCsrf(req, found.session);
    const run = writeQueue.then(async () => {
      const data = readData();
      try {
        return await syncDataToGitHub(renderData(data), data);
      } catch (error) {
        console.error("[qsl-admin] GitHub sync failed:", error);
        return { status: "error", message: error.message || "GitHub 同步失败" };
      }
    });
    writeQueue = run.catch(() => {});
    const sync = await run;
    sendJson(res, 200, { ok: sync.status === "ok", sync });
    return;
  }

  if (apiPath === "/api/records" && req.method === "GET") {
    requireAuth(req);
    const data = readData();
    sendJson(res, 200, listResponse(data));
    return;
  }

  if (apiPath === "/api/records" && req.method === "POST") {
    if (!sameOrigin(req)) throw new HttpError(403, "Origin 校验失败");
    const found = requireAuth(req);
    requireCsrf(req, found.session);
    const body = await readJsonBody(req);
    const result = await mutateData((data) => {
      data.records.push(buildRecord(body, null));
      return listResponse(data);
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  const match = apiPath.match(/^\/api\/records\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "记录编号无效");
    if (req.method !== "PUT" && req.method !== "DELETE") {
      throw new HttpError(405, "Method not allowed");
    }
    if (!sameOrigin(req)) throw new HttpError(403, "Origin 校验失败");
    const found = requireAuth(req);
    requireCsrf(req, found.session);

    if (req.method === "DELETE") {
      const result = await mutateData((data) => {
        if (id >= data.records.length) throw new HttpError(404, "记录不存在");
        data.records.splice(id, 1);
        return listResponse(data);
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    const body = await readJsonBody(req);
    const result = await mutateData((data) => {
      if (id >= data.records.length) throw new HttpError(404, "记录不存在");
      data.records[id] = buildRecord(body, data.records[id]);
      return listResponse(data);
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  throw new HttpError(404, "API not found");
}

async function handle(req, res) {
  setSecurityHeaders(res);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(res, 400, "路径无效");
    return;
  }

  if (pathname === BASE_PATH) {
    redirect(res, `${BASE_PATH}/`);
    return;
  }

  if (!pathname.startsWith(`${BASE_PATH}/`)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const localPath = pathname.slice(BASE_PATH.length) || "/";

  if (localPath.startsWith("/api/")) {
    try {
      await handleApi(req, res, localPath);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error("[qsl-admin]", error);
      if (!res.headersSent) {
        sendError(res, status, error instanceof HttpError ? error.message : "服务器内部错误");
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  serveAdminFile(req, res, localPath);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("[qsl-admin]", error);
    if (!res.headersSent) {
      sendError(res, 500, "服务器内部错误");
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[qsl-admin] listening on http://${HOST}:${PORT}${BASE_PATH}/`);
  console.log(`[qsl-admin] data file: ${DATA_FILE}`);
  console.log(`[qsl-admin] backups:  ${BACKUP_DIR}`);
  console.log(
    `[qsl-admin] github sync: ${
      GITHUB_SYNC_ENABLED ? `enabled (${GITHUB_REPO}@${GITHUB_BRANCH})` : "disabled"
    }`
  );
});

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (session.expires < now) sessions.delete(sid);
  }
}, 10 * 60 * 1000).unref();
