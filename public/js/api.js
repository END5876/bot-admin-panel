// 呼叫管理面板 API。所有請求都帶 x-mousebot-admin header（伺服器端的 CSRF 檢查），
// 回應 401 時交給 app.js 顯示登入畫面。
//
// 面板自己的 API（登入、Bot 清單、操作紀錄）直接呼叫；其他 /api/* 都是「目前選擇的 Bot」的 API，
// 自動改寫成 /api/bots/<代號>/…，由面板轉發給那隻 Bot。各頁面照舊寫 /api/voice 這種路徑即可。

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const PANEL_PATHS = ['/api/login', '/api/logout', '/api/bots', '/api/audit'];

let onUnauthorized = () => {};
let currentBot = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** 之後的 Bot API 都送到這隻 Bot（PANEL_BOTS 的代號） */
export function setCurrentBot(id) {
  currentBot = id;
}

export const getCurrentBot = () => currentBot;

const isPanelPath = (path) => PANEL_PATHS.some((p) => path === p || path.startsWith(`${p}?`));

/** 把 Bot 的 API 路徑改寫成經由面板轉發的路徑：/api/voice → /api/bots/<代號>/voice */
export function botPath(path, bot = currentBot) {
  if (isPanelPath(path) || !path.startsWith('/api/')) return path;
  if (!bot) throw new ApiError(0, '還沒有選擇 Bot');
  return `/api/bots/${encodeURIComponent(bot)}${path.slice(4)}`;
}

/** fetch 的共用選項（下載檔案這種不走 JSON 的請求也要帶） */
export const fetchInit = () => ({
  credentials: 'same-origin',
  cache: 'no-store',
  headers: { 'x-mousebot-admin': '1' },
});

async function request(method, path, body) {
  const init = { ...fetchInit(), method };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const target = botPath(path);
  let res;
  try {
    res = await fetch(target, init);
  } catch {
    throw new ApiError(0, '無法連線到管理面板，請確認網路連線');
  }

  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/login') {
    onUnauthorized();
    throw new ApiError(401, data?.error || '請先登入');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `請求失敗（HTTP ${res.status}）`);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path, {}),
};

/** 組出帶查詢字串的路徑：qs('/api/x', { a: 1 }) → /api/x?a=1 */
export function qs(path, params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) search.set(k, String(v));
  const s = search.toString();
  return s ? `${path}?${s}` : path;
}

/** 路徑片段編碼（ID、模式代號） */
export const seg = (v) => encodeURIComponent(v);
