// 管理面板進入點：登入畫面、側邊欄（Bot 切換＋頁面選單）、網址 hash 路由（#/<Bot 代號>/<頁面>）、各頁面的生命週期
//
// 每隻 Bot 回報自己支援的功能（features，見 Bot 端 admin/api/index.js），選單只顯示那隻 Bot 有的頁面。
// 「操作紀錄」是面板自己的頁面（panel: true），不屬於某隻 Bot。

import { fill, h, icon, logo } from './dom.js';
import { api, setCurrentBot, setUnauthorizedHandler } from './api.js';
import { avatar, confirmDialog, toastError } from './ui.js';
import overview from './pages/overview.js';
import responses from './pages/responses.js';
import prompts from './pages/prompts.js';
import aiSettings from './pages/aiSettings.js';
import usage from './pages/usage.js';
import voice from './pages/voice.js';
import tts from './pages/tts.js';
import notify from './pages/notify.js';
import status from './pages/status.js';
import maintenance from './pages/maintenance.js';
import auditLog from './pages/audit.js';
import logs from './pages/logs.js';

const THEME_KEY = 'mousebot-admin-theme';
const BOT_KEY = 'mousebot-admin-bot';
const PANEL_TITLE = 'Bot 管理面板';
const THEME_COLORS = { light: '#F3F4F7', dark: '#1E1F22' };

const NAV = [
  { items: [{ id: 'overview', title: '總覽', sub: 'Bot 狀態一覽', icon: 'home', mount: overview }] },
  {
    label: '對話',
    items: [
      { id: 'responses', title: '自訂回應', sub: '關鍵字自動回覆', icon: 'message', mount: responses },
      { id: 'prompts', title: 'AI 人格', sub: '各模式的 system prompt', icon: 'sparkle', mount: prompts },
      { id: 'ai', title: 'AI 設定', sub: '使用者模式、隨機插話', icon: 'sliders', mount: aiSettings },
      { id: 'usage', title: 'AI 用量', sub: 'Gemini token 統計', icon: 'chart', mount: usage },
    ],
  },
  {
    label: '語音與通知',
    items: [
      { id: 'voice', title: '語音與音樂', sub: '加入頻道、點歌、播放控制', icon: 'headphones', mount: voice },
      { id: 'tts', title: 'TTS 語音', sub: '模型、聲音、AI 朗讀', icon: 'mic', mount: tts },
      { id: 'notify', title: '通知與報時', sub: '限免通知、整點報時', icon: 'bell', mount: notify },
    ],
  },
  {
    label: '系統',
    items: [
      { id: 'status', title: '狀態與訊息', sub: 'Bot 狀態文字、以 Bot 身分發訊息', icon: 'send', mount: status },
      { id: 'maintenance', title: '維護', sub: '指令同步、快取、備份、重新啟動', icon: 'tool', mount: maintenance },
      { id: 'audit', title: '操作紀錄', sub: '管理面板上做過的變更（所有 Bot）', icon: 'history', mount: auditLog, panel: true },
      { id: 'logs', title: '日誌', sub: '最近的執行紀錄', icon: 'terminal', mount: logs },
    ],
  },
];
const PAGES = new Map(NAV.flatMap((g) => g.items).map((p) => [p.id, p]));
// 手機底部分頁列：最常用的四頁，其餘從「更多」打開完整選單
const TABS = [['overview', '總覽'], ['voice', '語音'], ['responses', '回應'], ['prompts', '人格']];

const root = document.getElementById('app');
let shell = null;      // { app, nav, tabbar, moreBtn, title, sub, actions, content, switcher, topBot }
let current = null;    // { key, id, bot, ctx }
let suppressHash = false;
let bots = [];         // GET /api/bots：[{ id, online, features, ready, ping, bot, error }]
let currentBot = null; // 代號

// ════════════════════════════════════════════════════════
//  Bot 與功能
// ════════════════════════════════════════════════════════
const botById = (id) => bots.find((b) => b.id === id) ?? null;
const botName = (b) => b?.bot?.name || b?.id || 'Bot';

// 連不上的 Bot 不知道支援哪些功能：只留總覽（會顯示連線錯誤）
function botFeatures(b) {
  if (!b) return new Set();
  return new Set(b.online ? ['overview', ...b.features] : ['overview']);
}

function pageAvailable(page, botId = currentBot) {
  if (page.panel) return true;
  return botFeatures(botById(botId)).has(page.id);
}

function savedBot() {
  try { return localStorage.getItem(BOT_KEY); } catch { return null; }
}

function rememberBot(id) {
  try { localStorage.setItem(BOT_KEY, id); } catch {}
}

const pageHash = (pageId, botId) => (PAGES.get(pageId)?.panel || !botId ? `#/${pageId}` : `#/${botId}/${pageId}`);

// ════════════════════════════════════════════════════════
//  主題
// ════════════════════════════════════════════════════════
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  document.dispatchEvent(new CustomEvent('themechange'));
}

function themeButton() {
  const btn = h('button', { type: 'button', class: 'btn btn-sm' });
  const paint = () => {
    const dark = currentTheme() === 'dark';
    btn.replaceChildren(icon(dark ? 'sun' : 'moon', 'ic-sm'), dark ? '淺色' : '深色');
    btn.setAttribute('aria-label', dark ? '切換成淺色主題' : '切換成深色主題');
  };
  btn.addEventListener('click', () => { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); paint(); });
  paint();
  return btn;
}

// ════════════════════════════════════════════════════════
//  登入
// ════════════════════════════════════════════════════════
function showLogin(message = '') {
  disposePage();
  shell = null;
  const input = h('input', {
    class: 'input', type: 'password', id: 'password', autocomplete: 'current-password', required: true,
    placeholder: 'ADMIN_PASSWORD',
  });
  const error = h('div', { class: 'login-error', role: 'alert' }, message);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '登入');

  const form = h('form', { class: 'card login-card', novalidate: true },
    h('div', { class: 'login-brand' },
      h('div', { class: 'brand-mark' }, logo()),
      h('h1', null, PANEL_TITLE),
      h('p', { class: 'hint' }, '請輸入在面板的 .env 設定的 ADMIN_PASSWORD'),
    ),
    h('div', { class: 'field' }, h('label', { for: 'password' }, '密碼'), input),
    error,
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) { error.textContent = '請輸入密碼'; input.focus(); return; }
    submit.disabled = true;
    error.textContent = '';
    try {
      await api.post('/api/login', { password: input.value });
      await startApp();
    } catch (err) {
      error.textContent = err.message;
      input.select();
    } finally {
      submit.disabled = false;
    }
  });

  root.className = '';
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('main', { class: 'login-wrap' }, form));
  input.focus();
}

async function logout() {
  if (current?.ctx.isDirty() && !await confirmDialog({ title: '還有未儲存的變更', message: '登出後這些變更會遺失，確定要登出嗎？', confirmText: '登出' })) return;
  try { await api.post('/api/logout'); } catch {}
  showLogin('已登出');
}

// ════════════════════════════════════════════════════════
//  外框
// ════════════════════════════════════════════════════════
function buildShell() {
  const navEl = h('nav', { class: 'nav', 'aria-label': '主選單' });
  for (const group of NAV) {
    if (group.label) navEl.append(h('div', { class: 'nav-label' }, group.label));
    for (const page of group.items) {
      navEl.append(h('a', { href: `#/${page.id}`, dataset: { page: page.id } }, icon(page.icon), page.title));
    }
  }

  const switcher = h('nav', { class: 'bot-switch', 'aria-label': '選擇 Bot' });
  const topBot = h('button', { type: 'button', class: 'topbar-bot', 'aria-label': '切換 Bot' });
  const title = h('h1');
  const sub = h('div', { class: 'topbar-sub' });
  const actions = h('div', { class: 'topbar-actions' });
  const content = h('div', { class: 'content', id: 'content' });
  const app = h('div', { class: 'app' });

  const closeNav = () => app.classList.remove('nav-open');
  navEl.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
  switcher.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
  topBot.addEventListener('click', () => app.classList.add('nav-open'));

  const moreBtn = h('button', { type: 'button', 'aria-label': '更多頁面', onclick: () => app.classList.add('nav-open') }, icon('menu'), '更多');
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': '常用頁面' },
    TABS.map(([id, label]) => h('a', { href: `#/${id}`, dataset: { page: id } }, icon(PAGES.get(id).icon), label)),
    moreBtn,
  );

  app.append(
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark' }, logo()),
        h('div', null, h('div', { class: 'brand-name' }, '管理面板'), h('div', { class: 'brand-sub' }, 'Discord Bot')),
      ),
      switcher,
      navEl,
      h('div', { class: 'sidebar-foot' },
        h('div', { class: 'sidebar-actions' },
          themeButton(),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: logout }, icon('logout', 'ic-sm'), '登出'),
        ),
      ),
    ),
    h('div', { class: 'nav-scrim', onclick: closeNav }),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-icon menu-btn', 'aria-label': '開啟選單',
          onclick: () => app.classList.add('nav-open'),
        }, icon('menu')),
        h('div', { class: 'row-main' }, title, sub),
        topBot,
        actions,
      ),
      h('main', { class: 'content-wrap' }, content),
    ),
    tabbar,
  );

  root.className = '';
  root.removeAttribute('aria-busy');
  root.replaceChildren(app);
  return { app, nav: navEl, tabbar, moreBtn, title, sub, actions, content, switcher, topBot };
}

function botStatus(b) {
  if (!b?.online) return ['bad', '無法連線'];
  if (!b.ready) return ['warn', '連線 Discord 中…'];
  return ['good', `線上 · ${b.ping >= 0 ? `${b.ping} ms` : '—'}`];
}

// 側邊欄的 Bot 清單、頂端目前的 Bot，以及選單裡這隻 Bot 有的頁面
function paintBots() {
  if (!shell) return;
  const pageId = current?.id ?? 'overview';
  fill(shell.switcher, bots.length
    ? bots.map((b) => {
      const [kind, text] = botStatus(b);
      const target = PAGES.get(pageId);
      // 換 Bot 時留在同一頁；那隻 Bot 沒有這一頁就回總覽
      const page = target && !target.panel && pageAvailable(target, b.id) ? pageId : 'overview';
      return h('a', {
        class: 'bot-chip', href: `#/${b.id}/${page}`, title: b.error || null,
        'aria-current': b.id === currentBot ? 'true' : null,
      },
      avatar({ url: b.bot?.avatarUrl, name: botName(b) }),
      h('div', { class: 'row-main' },
        h('div', { class: 'bot-chip-name' }, botName(b)),
        h('div', { class: 'bot-chip-status' }, h('span', { class: ['dot', `dot-${kind}`] }), text),
      ));
    })
    : h('div', { class: 'hint bot-switch-empty' }, '還沒有設定任何 Bot（面板的 PANEL_BOTS）'));

  const cur = botById(currentBot);
  shell.topBot.hidden = !cur;
  if (cur) {
    const [kind] = botStatus(cur);
    fill(shell.topBot, avatar({ url: cur.bot?.avatarUrl, name: botName(cur), size: 'sm' }),
      h('span', { class: 'truncate' }, botName(cur)), h('span', { class: ['dot', `dot-${kind}`] }));
  }

  for (const a of [...shell.nav.querySelectorAll('a'), ...shell.tabbar.querySelectorAll('a')]) {
    const page = PAGES.get(a.dataset.page);
    a.hidden = !pageAvailable(page);
    a.setAttribute('href', pageHash(page.id, currentBot));
  }
  // 分組裡的頁面全部隱藏時，標題也一起藏起來
  for (const label of shell.nav.querySelectorAll('.nav-label')) {
    let el = label.nextElementSibling;
    let any = false;
    while (el && !el.classList.contains('nav-label')) { if (!el.hidden) any = true; el = el.nextElementSibling; }
    label.hidden = !any;
  }
}

async function loadBots() {
  bots = (await api.get('/api/bots')).bots;
}

async function refreshBots() {
  try {
    await loadBots();
    paintBots();
  } catch {}
}

// ════════════════════════════════════════════════════════
//  頁面生命週期
// ════════════════════════════════════════════════════════
function createCtx() {
  const cleanups = new Set();
  let dirty = false;
  let disposed = false;

  return {
    /** 定期執行 fn（分頁在背景時暫停）；回傳停止函式。頁面切換時自動停止 */
    poll(fn, ms) {
      let timer = null;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        if (!document.hidden) {
          try { await fn(); } catch {}
        }
        if (!stopped) timer = setTimeout(tick, ms);
      };
      timer = setTimeout(tick, ms);
      const stop = () => { stopped = true; clearTimeout(timer); };
      cleanups.add(stop);
      return stop;
    },
    onCleanup(fn) { cleanups.add(fn); },
    setDirty(v) { dirty = !!v; },
    isDirty: () => dirty,
    get disposed() { return disposed; },
    setActions(...nodes) { if (shell) fill(shell.actions, nodes); },
    /** 這一頁屬於哪一隻 Bot（PANEL_BOTS 的代號） */
    bot: currentBot,
    /** 目前的 Bot 是否支援某個功能（例如 voice:join） */
    has: (feature) => botFeatures(botById(currentBot)).has(feature),
    /** 所有 Bot 的代號與名稱（操作紀錄頁的篩選） */
    bots: () => bots.map((b) => ({ id: b.id, name: botName(b) })),
    refreshBotChip: refreshBots,
    dispose() {
      disposed = true;
      for (const fn of cleanups) { try { fn(); } catch {} }
      cleanups.clear();
    },
  };
}

function disposePage() {
  current?.ctx.dispose();
  current = null;
}

// #/<Bot>/<頁面>；也接受 #/<頁面>（沿用目前的 Bot）。回傳實際要顯示的 Bot 與頁面
function resolveHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
    .map((p) => { try { return decodeURIComponent(p); } catch { return ''; } });
  let botId = null;
  let pageId = parts[0];
  if (parts[0] && botById(parts[0])) { botId = parts[0]; pageId = parts[1]; }
  const saved = savedBot();
  botId ??= botById(currentBot) ? currentBot : botById(saved) ? saved : bots[0]?.id ?? null;
  let page = PAGES.get(pageId);
  if (!page || !pageAvailable(page, botId)) page = PAGES.get(botId ? 'overview' : 'audit');
  return { botId, page };
}

function selectBot(botId) {
  currentBot = botId;
  setCurrentBot(botId);
  if (botId) rememberBot(botId);
}

async function route() {
  if (suppressHash) { suppressHash = false; return; }
  if (!shell) return;
  const { botId, page } = resolveHash();
  const id = page.id;
  const key = page.panel ? id : `${botId}/${id}`;
  const canonical = pageHash(id, botId);
  if (location.hash !== canonical) history.replaceState(null, '', canonical);
  if (current?.key === key) {
    if (botId !== currentBot) { selectBot(botId); paintBots(); }
    return;
  }

  if (current?.ctx.isDirty()) {
    const leave = await confirmDialog({ title: '還有未儲存的變更', message: '離開這一頁後，尚未儲存的內容會遺失。確定要離開嗎？', confirmText: '離開' });
    if (!leave) {
      suppressHash = true;
      location.hash = pageHash(current.id, current.bot);
      return;
    }
  }

  disposePage();
  selectBot(botId);
  shell.title.textContent = page.title;
  shell.sub.textContent = page.sub;
  shell.actions.replaceChildren();
  document.title = page.panel || !botId
    ? `${page.title} · ${PANEL_TITLE}`
    : `${page.title} · ${botName(botById(botId))} · ${PANEL_TITLE}`;
  current = { key, id, bot: botId, ctx: null };
  paintBots();
  for (const a of [...shell.nav.querySelectorAll('a'), ...shell.tabbar.querySelectorAll('a')]) {
    if (a.dataset.page === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  shell.moreBtn.classList.toggle('is-active', !TABS.some(([tab]) => tab === id));

  const ctx = createCtx();
  current.ctx = ctx;
  const container = h('div', { class: 'page' });
  shell.content.replaceChildren(container);
  window.scrollTo(0, 0);
  try {
    page.mount(container, ctx);
  } catch (err) {
    toastError(err);
  }
}

async function startApp() {
  await loadBots();
  shell = buildShell();
  current = null;
  route();
}

// ════════════════════════════════════════════════════════
//  啟動
// ════════════════════════════════════════════════════════
setUnauthorizedHandler(() => { if (shell) showLogin('登入已過期，請重新登入'); });
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (current?.ctx.isDirty()) { e.preventDefault(); e.returnValue = ''; }
});
// 側邊欄的 Bot 狀態每分鐘更新一次
setInterval(() => { if (shell && !document.hidden) refreshBots(); }, 60 * 1000);

(async () => {
  try {
    await startApp();
  } catch (err) {
    if (err.status === 401) showLogin();
    else {
      root.className = '';
      root.replaceChildren(h('main', { class: 'login-wrap' }, h('div', { class: 'card login-card' },
        h('div', { class: 'error-box' }, icon('alert'), h('div', null, err.message),
          h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, icon('refresh'), '重新整理')))));
    }
  }
})();
