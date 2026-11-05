'use strict';
// server.js
// ─────────────────────────────────────────────────────────────
// Bot 管理面板：一個網頁管理多隻 Discord Bot（Mousebot、mousebot-lite…）。
//
// 面板負責網頁、登入與操作紀錄；實際的設定與操作由各 Bot 程序內的管理 API 執行
// （Bot 端的 admin/agent.js：各模組的設定快取在 Bot 的記憶體裡，只有 Bot 自己改才會一致）。
// 瀏覽器只跟面板說話，面板帶著金鑰轉發到 Bot；Bot 的管理 API 不對外公開。
//
// 環境變數：
//   ADMIN_PASSWORD        登入密碼（必填，至少 12 個字元）
//   PANEL_BOTS            要管理的 Bot（見 lib/config.js），例如 mousebot=http://mousebot:3940,lite=http://mousebot-lite:3940
//   PANEL_TOKEN_<代號>    各 Bot 的管理 API 金鑰（= 那隻 Bot 的 ADMIN_AGENT_TOKEN）；全部相同時可只設 PANEL_TOKEN
//   ADMIN_PORT            監聽埠（預設 3940）
//   ADMIN_HOST            監聽位址（預設 127.0.0.1）。容器裡設 0.0.0.0，並經由 HTTPS 反向代理存取
//   ADMIN_SESSION_HOURS   登入有效時數（預設 168＝7 天）
//   ADMIN_SESSION_SECRET  簽 Cookie 用的金鑰（選填；未設定時自動產生並存在 data/admin-session-secret）
//   ADMIN_TRUSTED_PROXIES 信任哪些反向代理帶來的 X-Forwarded-For（見 lib/auth.js）
//   PANEL_DATA_DIR        資料目錄（預設 ./data）：Session 金鑰、登出清單、操作紀錄
//
// 路由：
//   GET  /、/css/*、/js/*        網頁（public/）
//   GET  /healthz                健康檢查（不需登入）
//   POST /api/login、/api/logout
//   GET  /api/bots               各 Bot 的狀態與支援的功能
//   GET  /api/audit              操作紀錄（?bot=代號 只看那隻 Bot）
//   *    /api/bots/<代號>/<路徑> 轉發到那隻 Bot 的 /api/<路徑>

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./lib/logger');
const audit = require('./lib/audit');
const { createAuth, describeSource } = require('./lib/auth');
const { DATA_DIR, parseBots } = require('./lib/config');
const { callAgent, fetchInfo, AgentError } = require('./lib/agentClient');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET_FILE = path.join(DATA_DIR, 'admin-session-secret');
// 已登出的 Cookie（ADMIN_REVOKED_FILE：改放到別的位置，給測試用）
const REVOKED_FILE = process.env.ADMIN_REVOKED_FILE || path.join(DATA_DIR, 'admin-revoked.json');
const MIN_PASSWORD_LENGTH = 12;
// 還原設定備份時整份備份檔會放在 body 裡（含統計資料、多個人格檔時可能到幾 MB）
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOGIN_BODY_BYTES = 2 * 1024;
// 所有寫入請求都要帶這個 header（CSRF 防護，見 lib/auth.js）
const CSRF_HEADER = 'x-mousebot-admin';
const BOT_PATH_RE = /^\/api\/bots\/([a-z0-9-]+)(\/.*)$/;

// 網頁版本：public/ 所有檔案內容的雜湊（啟動時算一次）。網頁定期從 /api/bots 拿到它，
// 和自己載入時的不同＝面板部署了新版：換頁時自動重新載入，不會繼續跑記憶體裡的舊版頁面
function computePanelVersion(dir = PUBLIC_DIR) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const file = path.join(d, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else hash.update(path.relative(dir, file)).update('\0').update(fs.readFileSync(file)).update('\0');
    }
  };
  try { walk(dir); } catch { return 'unknown'; }
  return hash.digest('hex').slice(0, 12);
}
const PANEL_VERSION = computePanelVersion();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// 網頁只載入自己的檔案；圖片放行 https（Discord 頭像、限免遊戲封面）
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  }, JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 不再讀取；回應時帶 Connection: close，送完就關閉連線
        req.off('data', onData);
        req.pause();
        reject(new HttpError(413, '資料太大'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, limit) {
  const raw = (await readBody(req, limit)).toString('utf8');
  if (!raw) return {};
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, '只接受 JSON');
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, 'JSON 格式錯誤');
  }
}

// ════════════════════════════════════════════════════════
//  靜態檔案
// ════════════════════════════════════════════════════════
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { Allow: 'GET, HEAD' });
    return;
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    send(res, 400, {});
    return;
  }
  // path.resolve 會把 .. 正規化掉；結果不在 public 目錄裡就當作不存在
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  const type = MIME[path.extname(file).toLowerCase()];
  if (rel.includes('\0') || !file.startsWith(PUBLIC_DIR + path.sep) || !type) {
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      return;
    }
    // 每次都向伺服器確認有沒有更新（部署後不會卡在舊版），沒變就回 304
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      send(res, 304, headers);
      return;
    }
    if (req.method === 'HEAD') {
      send(res, 200, { ...headers, 'Content-Length': stat.size });
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

// ════════════════════════════════════════════════════════
//  API
// ════════════════════════════════════════════════════════

// 轉發到 Bot：路徑 /api/bots/<代號>/<rest> → Bot 的 /api/<rest>
async function proxyToBot(req, res, url, bot, rest, source) {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  const body = mutating ? await readBody(req, MAX_BODY_BYTES) : null;
  const result = await callAgent(bot, {
    method: req.method,
    path: `/api${rest}`,
    search: url.search,
    body,
    contentType: req.headers['content-type'],
    source,
  });
  for (const action of result.audit) audit.record(action, { source, bot: bot.id });

  const headers = {
    'Content-Type': result.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  const disposition = result.headers.get('content-disposition');
  if (disposition) headers['Content-Disposition'] = disposition;
  send(res, result.status, { ...headers, 'Content-Length': result.body.length }, result.body);
}

async function handleApi(req, res, url, { auth, bots }) {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && req.headers[CSRF_HEADER] !== '1') {
    throw new HttpError(403, '請從管理面板網頁操作');
  }

  // 稽核紀錄的來源：經由反向代理時一併記下 TCP 連線位址（見 auth.describeSource）
  const source = describeSource(req);

  if (url.pathname === '/api/login' || url.pathname === '/api/logout') {
    if (req.method !== 'POST') throw new HttpError(405, '不支援的方法');
    const isLogin = url.pathname === '/api/login';
    const result = isLogin ? auth.login(req, await parseJsonBody(req, LOGIN_BODY_BYTES)) : auth.logout(req);
    // 🔒 只有真的登出了一個有效的 session 才記錄：沒登入的請求也寫一筆「登出」的話，
    // 送 1000 次就能把操作紀錄裡真正的管理操作全部擠掉
    if (!isLogin) { if (result.revoked) audit.record('登出', { source }); }
    else if (result.status === 200) audit.record('登入成功', { source });
    // 🔒 登入失敗不需要登入就能觸發：標成 unauth，在操作紀錄裡另有上限，擠不掉真正的管理操作（見 lib/audit.js）
    else if (result.status === 401) audit.record('登入失敗（密碼錯誤）', { source, level: 'warn', unauth: true });
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // 先驗證登入才讀取 body：未登入的請求不必等它上傳完
  if (!auth.isAuthenticated(req)) throw new HttpError(401, '請先登入');

  const botMatch = BOT_PATH_RE.exec(url.pathname);
  if (botMatch) {
    const bot = bots.find((b) => b.id === botMatch[1]);
    if (!bot) throw new HttpError(404, `面板沒有設定「${botMatch[1]}」這隻 Bot`);
    await proxyToBot(req, res, url, bot, botMatch[2], source);
    return;
  }

  if (url.pathname === '/api/bots') {
    if (req.method !== 'GET') throw new HttpError(405, '不支援的方法');
    sendJson(res, 200, { bots: await Promise.all(bots.map(fetchInfo)), panelVersion: PANEL_VERSION });
    return;
  }

  if (url.pathname === '/api/audit') {
    if (req.method !== 'GET') throw new HttpError(405, '不支援的方法');
    const before = Number.parseInt(url.searchParams.get('before') ?? '', 10);
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
    const bot = url.searchParams.get('bot') || null;
    sendJson(res, 200, { entries: audit.list({ before: Number.isFinite(before) ? before : Infinity, limit, bot }) });
    return;
  }

  throw new HttpError(404, '找不到這個 API');
}

function createHandler(deps) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://admin.local');
    } catch {
      send(res, 400, {});
      return;
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, bots: deps.bots.length });
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res, url.pathname);
      return;
    }

    try {
      await handleApi(req, res, url, deps);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError || err instanceof AgentError) {
        sendJson(res, err.status, { error: err.message }, err.status === 413 ? { Connection: 'close' } : {});
        return;
      }
      logger.error('Admin', `${req.method} ${url.pathname} 失敗：`, err);
      sendJson(res, 500, { error: `伺服器錯誤：${err.message}` });
    }
  };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {http.Server}
 */
function startServer({ env = process.env } = {}) {
  const password = env.ADMIN_PASSWORD || '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD 未設定或少於 ${MIN_PASSWORD_LENGTH} 個字元`);
  }

  const { bots, errors } = parseBots(env.PANEL_BOTS, env);
  for (const message of errors) logger.warn('Panel', `PANEL_BOTS：${message}`);
  if (!bots.length) logger.warn('Panel', '沒有設定任何 Bot（PANEL_BOTS），面板只能登入、看操作紀錄');

  const port = Number.parseInt(env.ADMIN_PORT ?? '3940', 10);
  const host = env.ADMIN_HOST || '127.0.0.1';
  const sessionHours = Math.max(1, Number.parseFloat(env.ADMIN_SESSION_HOURS || '168') || 168);
  const auth = createAuth({ password, secretFile: SECRET_FILE, sessionHours, revokedFile: REVOKED_FILE });

  const server = http.createServer(createHandler({ auth, bots }));
  server.requestTimeout = 90 * 1000;
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    logger.success('Panel', `管理面板：http://${shown}:${port}/（${bots.length} 隻 Bot：${bots.map((b) => b.id).join('、') || '無'}）`);
  });
  return server;
}

if (require.main === module) {
  let server;
  try {
    server = startServer();
  } catch (err) {
    logger.error('Panel', `無法啟動：${err.message}`);
    process.exit(1);
  }
  server.on('error', (err) => {
    logger.error('Panel', `無法監聽：${err.message}`);
    process.exit(1);
  });
  // 結束時（容器停止）讓 process 'exit' 事件觸發，操作紀錄裡還沒寫出的部分會寫進檔案
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }
}

module.exports = { startServer };
