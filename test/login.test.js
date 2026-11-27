'use strict';

// 登入：全站鎖定與信任裝置、換密碼、Session 到期、代理信任設定，以及 /api/login 對請求格式的檢查與操作紀錄。
// panel.test.js 已測過的（密碼對錯、Cookie 屬性、單一來源鎖定、登出失效）這裡不重複。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-panel-login-'));
delete process.env.ALERT_WEBHOOK_URL; // 鎖定時的告警不要真的送出
delete process.env.ADMIN_TRUSTED_PROXIES;
Object.assign(process.env, {
  ADMIN_SESSION_SECRET: 's'.repeat(40),
  ADMIN_AUDIT_FILE: path.join(TMP, 'audit.json'),
  ADMIN_REVOKED_FILE: path.join(TMP, 'revoked.json'),
  PANEL_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
});

const { startServer } = require('../server');
const { createAuth, describeSource, _resolveClient, _parseTrustedProxies } = require('../lib/auth');
const audit = require('../lib/audit');

const PASSWORD = 'unit-test-password';
const newAuth = (opts = {}) => createAuth({ password: PASSWORD, secretFile: path.join(TMP, 'secret'), sessionHours: 1, ...opts });
// 直接連線（公開 IP）的假請求：限流以 ip 為單位
const req = (ip, cookie) => ({ socket: { remoteAddress: ip }, headers: cookie ? { cookie } : {} });
const cookieOf = (result, name) => result.headers['Set-Cookie'].map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));

test('login：全站 50 次失敗後所有新來源都被擋；登入過的裝置不受影響，但偽造的裝置 Cookie 沒用', () => {
  const auth = newAuth();
  const ok = auth.login(req('198.51.100.1'), { password: PASSWORD });
  assert.equal(ok.status, 200);
  const device = cookieOf(ok, 'mb_admin_dev');
  assert.match(ok.headers['Set-Cookie'].find((c) => c.startsWith('mb_admin_dev=')), new RegExp(`Max-Age=${90 * 86400}`));

  // 50 個不同來源各錯一次：每個來源都沒到自己的上限
  for (let i = 0; i < 50; i++) assert.equal(auth.login(req(`203.0.113.${i}`), { password: 'nope' }).status, 401);

  const blocked = auth.login(req('192.0.2.10'), { password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);

  assert.equal(auth.login(req('192.0.2.11', device), { password: PASSWORD }).status, 200);
  const [exp, mac] = device.slice('mb_admin_dev='.length).split('.');
  assert.equal(auth.login(req('192.0.2.12', `mb_admin_dev=${Number(exp) + 1}.${mac}`), { password: PASSWORD }).status, 429);
  // 用 Session Cookie 冒充裝置 Cookie 也不行（簽章內容不同）
  const session = cookieOf(ok, 'mb_admin').slice('mb_admin='.length);
  assert.equal(auth.login(req('192.0.2.13', `mb_admin_dev=${session}`), { password: PASSWORD }).status, 429);
});

test('login：信任裝置仍受自己來源的 10 次上限限制', () => {
  const auth = newAuth();
  const device = cookieOf(auth.login(req('198.51.100.2'), { password: PASSWORD }), 'mb_admin_dev');
  for (let i = 0; i < 10; i++) auth.login(req('198.51.100.3', device), { password: 'nope' });
  assert.equal(auth.login(req('198.51.100.3', device), { password: PASSWORD }).status, 429);
});

test('login：密碼不是字串或沒給 → 401，也算一次失敗', () => {
  const auth = newAuth();
  for (const body of [undefined, {}, { password: 12345678901234 }, { password: '' }, { password: [PASSWORD] }]) {
    assert.equal(auth.login(req('198.51.100.4'), body).status, 401);
  }
  for (let i = 0; i < 5; i++) auth.login(req('198.51.100.4'), { password: 'nope' });
  assert.equal(auth.login(req('198.51.100.4'), { password: PASSWORD }).status, 429);
});

test('login：成功登入會清掉該來源的失敗次數', () => {
  const auth = newAuth();
  for (let i = 0; i < 9; i++) auth.login(req('198.51.100.5'), { password: 'nope' });
  assert.equal(auth.login(req('198.51.100.5'), { password: PASSWORD }).status, 200);
  for (let i = 0; i < 9; i++) auth.login(req('198.51.100.5'), { password: 'nope' });
  assert.equal(auth.login(req('198.51.100.5'), { password: PASSWORD }).status, 200);
});

test('login：換密碼後舊的 Cookie 全部失效', () => {
  const cookie = cookieOf(newAuth().login(req('198.51.100.6'), { password: PASSWORD }), 'mb_admin');
  assert.equal(newAuth().isAuthenticated(req('198.51.100.6', cookie)), true);
  const changed = createAuth({ password: 'another-password-123', secretFile: path.join(TMP, 'secret'), sessionHours: 1 });
  assert.equal(changed.isAuthenticated(req('198.51.100.6', cookie)), false);
});

test('login：Session 到期後失效', async () => {
  const auth = newAuth({ sessionHours: 0.02 / 3600 }); // 20 毫秒
  const cookie = cookieOf(auth.login(req('198.51.100.7'), { password: PASSWORD }), 'mb_admin');
  assert.equal(auth.isAuthenticated(req('198.51.100.7', cookie)), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(auth.isAuthenticated(req('198.51.100.7', cookie)), false);
});

test('login：沒有登入就登出 → 不算撤銷，仍清掉 Cookie', () => {
  const out = newAuth().logout(req('198.51.100.8'));
  assert.equal(out.revoked, false);
  assert.match(out.headers['Set-Cookie'], /^mb_admin=; .*Max-Age=0/);
});

test('ADMIN_TRUSTED_PROXIES：只採信指定網段的 X-Forwarded-For；none 完全不讀；格式錯誤的略過', () => {
  const r = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });

  const only = _parseTrustedProxies('172.18.0.0/16, 不是IP, 10.0.0.0/99, 2001:db8::1');
  assert.deepEqual(_resolveClient(r('::ffff:172.18.0.5', '203.0.113.9'), only), { key: '203.0.113.9', peer: '172.18.0.5', forwarded: true });
  assert.equal(_resolveClient(r('10.0.0.1', '203.0.113.9'), only).key, '10.0.0.1'); // 10/99 不合法，沒有加入
  assert.equal(_resolveClient(r('2001:db8::1', '203.0.113.9'), only).key, '203.0.113.9'); // 單一 IP（沒寫 /）

  for (const none of ['none', '', '  ']) {
    assert.equal(_resolveClient(r('127.0.0.1', '203.0.113.9'), _parseTrustedProxies(none)).key, '127.0.0.1');
  }

  // X-Forwarded-For 全是垃圾 → 用連線位址，不算經由代理
  assert.deepEqual(_resolveClient(r('10.1.2.3', 'garbage, , unknown')), { key: '10.1.2.3', peer: '10.1.2.3', forwarded: false });
  assert.equal(_resolveClient({ socket: {}, headers: {} }).key, 'unknown');
});

test('describeSource：經由代理時附上連線位址，直接連線時只有來源', () => {
  assert.equal(describeSource({ socket: { remoteAddress: '10.0.0.2' }, headers: { 'x-forwarded-for': '203.0.113.1' } }), '203.0.113.1，經由 10.0.0.2');
  assert.equal(describeSource({ socket: { remoteAddress: '203.0.113.1' }, headers: { 'x-forwarded-for': '1.1.1.1' } }), '203.0.113.1');
});

// ── HTTP 層：/api/login 的請求格式與操作紀錄 ───────────────────────
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let xff = 0;
const post = (p, body, { contentType = 'application/json', cookie, csrf = true } = {}) => fetch(BASE + p, {
  method: 'POST',
  headers: {
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(csrf ? { 'x-mousebot-admin': '1' } : {}),
    ...(cookie ? { cookie } : {}),
    'x-forwarded-for': `10.9.0.${++xff}`,
  },
  body,
});

test.before(async () => {
  server = startServer({ env: { ADMIN_PASSWORD: PASSWORD, ADMIN_PORT: String(PORT), ADMIN_HOST: '127.0.0.1', PANEL_BOTS: '' } });
  await new Promise((resolve) => server.once('listening', resolve));
});
test.after(() => {
  server.close();
  setTimeout(() => process.exit(), 300).unref();
});

test('/api/login：格式不對的請求——太大 413、不是 JSON 415、JSON 壞掉或不是物件 400、GET 405', async () => {
  const big = await post('/api/login', JSON.stringify({ password: 'x'.repeat(3000) }));
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('connection'), 'close');
  assert.equal((await post('/api/login', 'password=x', { contentType: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('/api/login', 'password=x', { contentType: null })).status, 415);
  assert.equal((await post('/api/login', '{oops')).status, 400);
  assert.equal((await post('/api/login', '[1]')).status, 400);
  assert.equal((await post('/api/login', 'null')).status, 400);
  assert.equal((await fetch(`${BASE}/api/login`)).status, 405);
  // 空的 body 當成沒給密碼
  assert.equal((await post('/api/login', '')).status, 401);
});

test('/api/login：成功、失敗寫進操作紀錄；沒登入就登出不寫', async () => {
  const before = audit.list({ limit: 2000 }).length;
  assert.equal((await post('/api/login', JSON.stringify({ password: 'wrong-password' }))).status, 401);
  const ok = await post('/api/login', JSON.stringify({ password: PASSWORD }));
  assert.equal(ok.status, 200);
  assert.equal((await post('/api/logout', '{}')).status, 200);

  const added = audit.list({ limit: 2000 }).slice(0, audit.list({ limit: 2000 }).length - before);
  assert.deepEqual(added.map((e) => e.action).sort(), ['登入失敗（密碼錯誤）', '登入成功']);
  assert.equal(added.find((e) => e.action.startsWith('登入失敗')).unauth, true);

  const cookie = ok.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('mb_admin='));
  assert.equal((await post('/api/logout', '{}', { cookie })).status, 200);
  assert.equal(audit.list({ limit: 1 })[0].action, '登出');
});

test('/api/logout：沒帶 CSRF header → 403，Cookie 仍然有效', async () => {
  const ok = await post('/api/login', JSON.stringify({ password: PASSWORD }));
  const cookie = ok.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('mb_admin='));
  assert.equal((await post('/api/logout', '{}', { cookie, csrf: false })).status, 403);
  assert.equal((await fetch(`${BASE}/api/audit`, { headers: { cookie } })).status, 200);
});
