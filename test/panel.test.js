'use strict';

// 面板的 HTTP 層：登入、Cookie、CSRF、限流、靜態檔案，以及轉發到 Bot 的管理 API 與操作紀錄。
// 用一個假的 Bot 管理 API（本機的小 HTTP 伺服器）代替真正的 Bot。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 40000 + Math.floor(Math.random() * 10000);
const AGENT_PORT = PORT + 1;
const DEAD_PORT = PORT + 2;
const TOKEN = 'a'.repeat(40);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-panel-'));
Object.assign(process.env, {
  ADMIN_SESSION_SECRET: 's'.repeat(40), // 不產生 data/admin-session-secret
  ADMIN_AUDIT_FILE: path.join(TMP, 'audit.json'),
  ADMIN_REVOKED_FILE: path.join(TMP, 'revoked.json'),
  PANEL_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
});

const { startServer } = require('../server');
const { _ipv6Prefix64, _clientKey, createAuth } = require('../lib/auth');
const { parseBots } = require('../lib/config');
const audit = require('../lib/audit');

const ENV = {
  ADMIN_PASSWORD: 'unit-test-password',
  ADMIN_PORT: String(PORT),
  ADMIN_HOST: '127.0.0.1',
  PANEL_BOTS: `main=http://127.0.0.1:${AGENT_PORT},dead=http://127.0.0.1:${DEAD_PORT},wrong-key=http://127.0.0.1:${AGENT_PORT}`,
  PANEL_TOKEN_MAIN: TOKEN,
  PANEL_TOKEN_DEAD: TOKEN,
  PANEL_TOKEN_WRONG_KEY: 'b'.repeat(40),
};

const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { 'x-mousebot-admin': '1', 'content-type': 'application/json' };
let server;
let agent;
let xff = 0;
const agentRequests = [];

// 假的 Bot 管理 API：金鑰不對回 401；PUT /api/things 回報一筆操作；/api/backup 回傳檔案
function startFakeAgent() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      agentRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"bad token"}');
        return;
      }
      if (req.url === '/api/me') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ protocol: 1, app: 'fake', features: ['voice'], ready: true, ping: 42, bot: { name: 'Fake' } }));
      } else if (req.url.startsWith('/api/things') && req.method === 'PUT') {
        const audit = Buffer.from(JSON.stringify([`改了 ${JSON.parse(body).value}`])).toString('base64url');
        res.writeHead(200, { 'content-type': 'application/json', 'x-admin-audit': audit, 'set-cookie': 'evil=1' });
        res.end('{"ok":true}');
      } else if (req.url === '/api/backup') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="b.json"' });
        res.end('{"files":{}}');
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"找不到這個 API"}');
      }
    });
  }).listen(AGENT_PORT, '127.0.0.1');
}

// 每個測試用不同的 X-Forwarded-For（連線來自本機＝私有網段，會採信它），登入限流彼此不干擾
function call(method, p, { body, cookie, headers = ADMIN, source } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...(source ? { 'x-forwarded-for': source } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function login(password = 'unit-test-password', source = `10.0.0.${++xff}`) {
  const res = await call('POST', '/api/login', { body: { password }, source });
  return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test.before(async () => {
  agent = startFakeAgent();
  server = startServer({ env: ENV });
  await Promise.all([
    new Promise((resolve) => server.once('listening', resolve)),
    new Promise((resolve) => agent.once('listening', resolve)),
  ]);
});
test.after(() => {
  server.close();
  agent.close();
  setTimeout(() => process.exit(), 300).unref();
});

test('panel：未登入讀 API → 401；寫入沒帶 CSRF header → 403；/healthz 不需登入', async () => {
  assert.equal((await call('GET', '/api/bots')).status, 401);
  assert.equal((await call('GET', '/api/bots/main/voice')).status, 401);
  const res = await call('POST', '/api/login', { body: { password: 'x' }, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 403);
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200);
  assert.equal(agentRequests.length, 0); // 未登入的請求不會轉發給 Bot
});

test('panel：密碼正確才發 Cookie（HttpOnly、SameSite=Strict）', async () => {
  assert.equal((await login('wrong-password')).res.status, 401);
  const { res } = await login();
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^mb_admin=\d+\.[\w-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Secure/);
});

test('panel：HTTPS 代理後面發的 Cookie 帶 Secure', async () => {
  const res = await call('POST', '/api/login', {
    body: { password: 'unit-test-password' },
    headers: { ...ADMIN, 'x-forwarded-proto': 'https' },
  });
  assert.match(res.headers.get('set-cookie'), /; Secure$/);
});

test('panel：竄改或過期的 Cookie 一律 401；登出後原本的 Cookie 失效', async () => {
  const { cookie } = await login();
  const [exp, mac] = cookie.slice('mb_admin='.length).split('.');
  assert.equal((await call('GET', '/api/bots', { cookie: `mb_admin=${Number(exp) + 1}.${mac}` })).status, 401);
  assert.equal((await call('GET', '/api/bots', { cookie: `mb_admin=1.${mac}` })).status, 401);
  assert.equal((await call('GET', '/api/bots', { cookie: 'mb_admin=garbage' })).status, 401);

  assert.equal((await call('POST', '/api/logout', { cookie, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/bots', { cookie })).status, 401);
});

test('panel：同一來源連續失敗 10 次後被擋（429），其他來源不受影響', async () => {
  const source = '203.0.113.7';
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/login', { body: { password: 'nope' }, source })).status, 401);
  }
  const blocked = await call('POST', '/api/login', { body: { password: 'unit-test-password' }, source });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await login()).res.status, 200);
});

test('panel：/api/bots 列出每隻 Bot 的狀態；連不上、金鑰不對的標成離線並說明原因', async () => {
  const { cookie } = await login();
  const res = await call('GET', '/api/bots', { cookie });
  assert.equal(res.status, 200);
  const { bots } = await res.json();
  assert.deepEqual(bots.map((b) => b.id), ['main', 'dead', 'wrong-key']);
  assert.deepEqual(bots[0], { id: 'main', online: true, app: 'fake', features: ['voice'], ready: true, ping: 42, bot: { name: 'Fake' } });
  assert.equal(bots[1].online, false);
  assert.match(bots[1].error, /無法連線/);
  assert.equal(bots[2].online, false);
  assert.match(bots[2].error, /ADMIN_AGENT_TOKEN/);
});

test('panel：轉發到 Bot——帶金鑰與來源、原樣傳 body 與查詢字串，操作寫進紀錄，Bot 的 Set-Cookie 不外流', async () => {
  const { cookie } = await login('unit-test-password', '198.51.100.77');
  agentRequests.length = 0;
  const res = await call('PUT', '/api/bots/main/things/1?x=1', { cookie, body: { value: 5 }, source: '198.51.100.77' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('x-admin-audit'), null);

  const [req] = agentRequests;
  assert.equal(req.url, '/api/things/1?x=1');
  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  // 經由代理（本機連線）時來源含中文「，經由 127.0.0.1」：標頭裡是 URL 編碼
  assert.equal(decodeURIComponent(req.headers['x-admin-source']), '198.51.100.77，經由 127.0.0.1');
  assert.equal(req.headers.cookie, undefined); // 面板的登入 Cookie 不會送給 Bot
  assert.deepEqual(JSON.parse(req.body), { value: 5 });

  const entry = audit.list({ limit: 1, bot: 'main' })[0];
  assert.equal(entry.action, '改了 5');
  assert.equal(entry.bot, 'main');
  assert.equal(entry.source, '198.51.100.77，經由 127.0.0.1');

  const listed = await (await call('GET', '/api/audit?bot=main', { cookie })).json();
  assert.ok(listed.entries.every((e) => e.bot === 'main'));
  assert.ok(listed.entries.some((e) => e.action === '改了 5'));
});

test('panel：轉發的錯誤——Bot 的錯誤原樣傳回；連不上 502；金鑰不對 502（不是 401，網頁才不會被登出）', async () => {
  const { cookie } = await login();
  const notFound = await call('GET', '/api/bots/main/nope', { cookie });
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).error, '找不到這個 API');

  assert.equal((await call('GET', '/api/bots/dead/voice', { cookie })).status, 502);
  const wrongKey = await call('GET', '/api/bots/wrong-key/voice', { cookie });
  assert.equal(wrongKey.status, 502);
  assert.match((await wrongKey.json()).error, /ADMIN_AGENT_TOKEN/);

  assert.equal((await call('GET', '/api/bots/unknown/voice', { cookie })).status, 404);
  assert.equal((await call('GET', '/api/nope', { cookie })).status, 404);
});

test('panel：檔案下載保留 Content-Disposition', async () => {
  const { cookie } = await login();
  const res = await call('GET', '/api/bots/main/backup', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="b.json"');
  assert.equal(await res.text(), '{"files":{}}');
});

test('panel：靜態檔案帶安全標頭、擋路徑穿越、只提供已知類型', async () => {
  const index = await fetch(`${BASE}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');

  const js = await fetch(`${BASE}/js/app.js`);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  const etag = js.headers.get('etag');
  assert.equal((await fetch(`${BASE}/js/app.js`, { headers: { 'if-none-match': etag } })).status, 304);

  for (const p of ['/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/js/', '/nope.txt']) {
    assert.equal((await fetch(BASE + p)).status, 404, p);
  }
});

test('panel：PANEL_BOTS 解析——格式錯誤、重複、沒有金鑰的會被略過並說明', () => {
  const env = { PANEL_TOKEN_A: TOKEN, PANEL_TOKEN: 'c'.repeat(40), PANEL_TOKEN_MY_BOT: 'd'.repeat(40) };
  const { bots, errors } = parseBots('a=http://a:1/, my-bot=https://b.example/x/,a=http://dup:1,Bad!=http://x,c=ftp://x,d=http://d:2', env);
  assert.deepEqual(bots, [
    { id: 'a', url: 'http://a:1', token: TOKEN },
    { id: 'my-bot', url: 'https://b.example/x', token: 'd'.repeat(40) },
    { id: 'd', url: 'http://d:2', token: 'c'.repeat(40) }, // 沒有專屬金鑰時用 PANEL_TOKEN
  ]);
  assert.equal(errors.length, 3);
  assert.match(parseBots('x=http://x:1', {}).errors[0], /PANEL_TOKEN_X/);
});

test('panel：限流來源——IPv6 以 /64 為單位；私有網段連線才採信 X-Forwarded-For', () => {
  assert.equal(_ipv6Prefix64('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(_ipv6Prefix64('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(_ipv6Prefix64('::1'), '0:0:0:0::/64');

  const req = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  assert.equal(_clientKey(req('::ffff:10.42.0.1', '198.51.100.9, 203.0.113.5')), '203.0.113.5');
  assert.equal(_clientKey(req('198.51.100.20', '203.0.113.5')), '198.51.100.20');
  assert.equal(_clientKey(req('2001:db8:aa:bb:1:2:3:4')), '2001:db8:aa:bb::/64');
});

test('panel：登出清單存檔，重新啟動後已登出的 Cookie 仍然無效', () => {
  const opts = { password: 'unit-test-password', secretFile: path.join(TMP, 'secret'), sessionHours: 1, revokedFile: path.join(TMP, 'revoked-restart.json') };
  const req = (cookie) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: cookie ? { cookie } : {} });
  const before = createAuth(opts);
  const issue = () => before.login(req(), { password: 'unit-test-password' }).headers['Set-Cookie'][0].split(';')[0];
  const out = issue();
  let kept;
  do kept = issue(); while (kept === out); // 同一毫秒發的 Cookie 會一模一樣
  assert.equal(before.logout(req(out)).revoked, true);

  const after = createAuth(opts); // 模擬重新啟動：記憶體清空、金鑰不變
  assert.equal(after.isAuthenticated(req(out)), false);
  assert.equal(after.isAuthenticated(req(kept)), true);
});

test('panel：登入失敗在操作紀錄裡另有上限，擠不掉管理操作；同一來源連續失敗合併成一筆', () => {
  audit.record('測試用管理操作', { bot: 'main' });
  for (let i = 0; i < 300; i++) audit.record('登入失敗（密碼錯誤）', { source: `198.51.100.${i}`, level: 'warn', unauth: true });
  audit.record('登入失敗（密碼錯誤）', { source: '198.51.100.299', level: 'warn', unauth: true });
  const all = audit.list({ limit: 3000 });
  assert.ok(all.some((e) => e.action === '測試用管理操作'));
  assert.ok(all.filter((e) => e.unauth).length <= 200);
  assert.equal(all.find((e) => e.source === '198.51.100.299').count, 2);
});

test('panel：沒有密碼或太短時拒絕啟動', () => {
  assert.throws(() => startServer({ env: { ...ENV, ADMIN_PASSWORD: '' } }), /ADMIN_PASSWORD/);
  assert.throws(() => startServer({ env: { ...ENV, ADMIN_PASSWORD: 'short' } }), /ADMIN_PASSWORD/);
});
