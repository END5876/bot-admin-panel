'use strict';

// 轉發到 Bot：上傳／回應大小上限、逾時、Bot 出錯時不寫操作紀錄、不跟著 Bot 轉址、路徑穿越、
// 各種方法與 body 的轉發，以及 Bot 狀態（/api/me）的各種異常。
// panel.test.js 已測過的（金鑰、來源、Set-Cookie 不外流、404／502、Content-Disposition）這裡不重複。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-panel-forward-'));
Object.assign(process.env, {
  ADMIN_SESSION_SECRET: 's'.repeat(40),
  ADMIN_AUDIT_FILE: path.join(TMP, 'audit.json'),
  ADMIN_REVOKED_FILE: path.join(TMP, 'revoked.json'),
  PANEL_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
});

const { startServer } = require('../server');
const { callAgent, fetchInfo, decodeAudit, AgentError } = require('../lib/agentClient');
const audit = require('../lib/audit');

const PORT = 40000 + Math.floor(Math.random() * 10000);
const AGENT_PORT = PORT + 1;
const TOKEN = 'a'.repeat(40);
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = `http://127.0.0.1:${AGENT_PORT}`;
const PASSWORD = 'unit-test-password';
const NINE_MB = 9 * 1024 * 1024;
const enc = (list) => Buffer.from(JSON.stringify(list)).toString('base64url');

let server;
let agent;
let meReply = { protocol: 1, app: 'fake', ready: true };
const agentRequests = [];
const hanging = new Set();

// 假的 Bot 管理 API
function startFakeAgent() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      agentRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, data, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof data === 'string' ? data : JSON.stringify(data));
      };
      const route = req.url.split('?')[0];
      if (route === '/api/me') {
        if (typeof meReply === 'string') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(meReply); }
        else json(meReply.status || 200, meReply);
      } else if (route === '/api/echo') {
        json(200, { method: req.method, contentType: req.headers['content-type'] ?? null, length: body.length, query: req.url.split('?')[1] ?? null });
      } else if (route === '/api/fail') {
        json(500, { error: 'Bot 這邊壞了' }, { 'x-admin-audit': enc(['不該被記錄']) });
      } else if (route === '/api/audit-ok') {
        json(200, { ok: true }, { 'x-admin-audit': enc(['第一件', '第二件']) });
      } else if (route === '/api/redirect') {
        res.writeHead(302, { location: `${AGENT}/api/echo` });
        res.end();
      } else if (route === '/api/big-length') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': NINE_MB });
        res.end(Buffer.alloc(NINE_MB));
      } else if (route === '/api/big-chunked') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); // 沒有 Content-Length
        for (let i = 0; i < 9; i++) res.write(Buffer.alloc(1024 * 1024));
        res.end();
      } else if (route === '/api/hang') {
        hanging.add(res); // 不回應
      } else {
        json(404, { error: '找不到這個 API' });
      }
    });
  }).listen(AGENT_PORT, '127.0.0.1');
}

let cookie;
let xff = 0;
function call(method, p, { body, headers = {}, withCookie = true } = {}) {
  return fetch(BASE + p, {
    method,
    headers: {
      'x-mousebot-admin': '1',
      'x-forwarded-for': `10.8.0.${++xff % 250}`,
      ...(withCookie && cookie ? { cookie } : {}),
      ...headers,
    },
    body,
  });
}

// 不經過 fetch 的 URL 正規化，原樣送出路徑
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: rawPath, headers: { cookie } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test.before(async () => {
  agent = startFakeAgent();
  server = startServer({
    env: {
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_PORT: String(PORT),
      ADMIN_HOST: '127.0.0.1',
      PANEL_BOTS: `main=${AGENT}`,
      PANEL_TOKEN: TOKEN,
    },
  });
  await Promise.all([
    new Promise((resolve) => server.once('listening', resolve)),
    new Promise((resolve) => agent.once('listening', resolve)),
  ]);
  const res = await call('POST', '/api/login', { body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' }, withCookie: false });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('mb_admin='));
});
test.after(() => {
  for (const res of hanging) res.destroy();
  server.close();
  agent.close();
  setTimeout(() => process.exit(), 300).unref();
});

test('forward：各種方法——GET 不帶 body；POST／PUT／PATCH／DELETE 原樣帶 body 與 Content-Type；查詢字串保留', async () => {
  agentRequests.length = 0;
  const get = await (await call('GET', '/api/bots/main/echo?a=1&b=%E4%B8%AD')).json();
  assert.deepEqual(get, { method: 'GET', contentType: null, length: 0, query: 'a=1&b=%E4%B8%AD' });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call(method, '/api/bots/main/echo', { body: 'hello', headers: { 'content-type': 'text/plain; charset=utf-8' } });
    assert.deepEqual(await res.json(), { method, contentType: 'text/plain; charset=utf-8', length: 5, query: null }, method);
  }
  // 沒有 body 的寫入：不送 Content-Type
  assert.equal((await (await call('POST', '/api/bots/main/echo')).json()).contentType, null);
  // 沒給 Content-Type 但有 body：當成 JSON
  const noType = await call('POST', '/api/bots/main/echo', { body: '{}', headers: { 'content-type': '' } });
  assert.equal((await noType.json()).contentType, 'application/json');
});

test('forward：未登入的寫入在讀 body 前就擋下，不會轉發', async () => {
  agentRequests.length = 0;
  const res = await call('POST', '/api/bots/main/echo', { body: 'x'.repeat(1024 * 1024), withCookie: false });
  assert.equal(res.status, 401);
  assert.equal(agentRequests.length, 0);
});

test('forward：上傳超過 8 MB → 413 並關閉連線，Bot 收不到', async () => {
  agentRequests.length = 0;
  let status;
  try {
    status = (await call('POST', '/api/bots/main/echo', { body: Buffer.alloc(NINE_MB), headers: { 'content-type': 'application/json' } })).status;
  } catch {
    status = 'closed'; // 伺服器提早關閉連線時，fetch 可能還在上傳就斷了：同樣代表被拒絕
  }
  assert.ok(status === 413 || status === 'closed', `status=${status}`);
  assert.equal(agentRequests.length, 0);
  // 之後的請求照常
  assert.equal((await call('GET', '/api/bots/main/echo')).status, 200);
});

test('forward：Bot 回應超過 8 MB → 502（有沒有 Content-Length 都一樣）', async () => {
  for (const p of ['big-length', 'big-chunked']) {
    const res = await call('GET', `/api/bots/main/${p}`);
    assert.equal(res.status, 502, p);
    assert.match((await res.json()).error, /太大/);
  }
});

test('forward：Bot 出錯時原樣回傳狀態，但不寫操作紀錄；成功時每一件都記下', async () => {
  const before = audit.list({ limit: 2000 }).length;
  const fail = await call('POST', '/api/bots/main/fail', { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(fail.status, 500);
  assert.equal((await fail.json()).error, 'Bot 這邊壞了');
  assert.equal(fail.headers.get('x-admin-audit'), null);
  assert.equal(audit.list({ limit: 2000 }).length, before);

  assert.equal((await call('POST', '/api/bots/main/audit-ok')).status, 200);
  assert.deepEqual(audit.list({ limit: 2, bot: 'main' }).map((e) => e.action), ['第二件', '第一件']);
});

test('forward：Bot 回 302 時不跟著轉址，也不把 Location 交給瀏覽器', async () => {
  agentRequests.length = 0;
  const res = await call('GET', '/api/bots/main/redirect', { headers: {} });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), null);
  assert.deepEqual(agentRequests.map((r) => r.url), ['/api/redirect']);
});

test('forward：路徑穿越與大小寫——正規化後不是 Bot 路徑就 404，不轉發', async () => {
  agentRequests.length = 0;
  for (const p of ['/api/bots/main/%2e%2e/%2e%2e/me', '/api/bots/main/../../me', '/api/bots/MAIN/me', '/api/bots/main']) {
    assert.equal(await rawGet(p), 404, p);
  }
  assert.equal(agentRequests.length, 0);
});

test('callAgent：逾時 → 504，連不上 → 502，都是 AgentError', async () => {
  const bot = { id: 'main', url: AGENT, token: TOKEN };
  await assert.rejects(callAgent(bot, { path: '/api/hang', timeoutMs: 200 }), (err) => err instanceof AgentError && err.status === 504);
  await assert.rejects(
    callAgent({ ...bot, url: 'http://127.0.0.1:1' }, { path: '/api/me' }),
    (err) => err instanceof AgentError && err.status === 502 && /連不上/.test(err.message),
  );
});

test('fetchInfo：Bot 回錯誤、版本不相容、不是 JSON 時標成離線並說明', async () => {
  const bot = { id: 'main', url: AGENT, token: TOKEN };
  meReply = { status: 503, error: 'Bot 還在啟動' };
  assert.deepEqual(await fetchInfo(bot), { id: 'main', online: false, error: 'Bot 還在啟動' });
  meReply = { protocol: 2 };
  assert.match((await fetchInfo(bot)).error, /版本不相容/);
  meReply = '<html>';
  assert.match((await fetchInfo(bot)).error, /回應格式錯誤/);
  meReply = { protocol: 1 };
  assert.deepEqual(await fetchInfo(bot), { id: 'main', online: true, app: null, features: [], ready: false, ping: -1, bot: null });
});

test('decodeAudit：格式錯誤回空陣列；只留非空字串，每筆最多 500 字', () => {
  assert.deepEqual(decodeAudit(null), []);
  assert.deepEqual(decodeAudit('!!!'), []);
  assert.deepEqual(decodeAudit(enc({ a: 1 })), []);
  assert.deepEqual(decodeAudit(enc(['好', '', 3, null, 'x'.repeat(600)])), ['好', 'x'.repeat(500)]);
});
