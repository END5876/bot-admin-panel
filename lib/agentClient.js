'use strict';
// lib/agentClient.js
// ─────────────────────────────────────────────────────────────
// 呼叫各 Bot 的管理 API（Bot 端的 admin/agent.js，協定見那個檔案的開頭）。

const SUPPORTED_PROTOCOL = 1;
const INFO_TIMEOUT_MS = 4000;
// 點歌、加入語音頻道、同步指令可能要十幾秒
const REQUEST_TIMEOUT_MS = 55 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

class AgentError extends Error {
  /**
   * @param {number} status 回給瀏覽器的狀態碼
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

function decodeAudit(header) {
  if (!header) return [];
  try {
    const list = JSON.parse(Buffer.from(String(header), 'base64url').toString('utf8'));
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s).map((s) => s.slice(0, 500)) : [];
  } catch {
    return [];
  }
}

/**
 * @param {{ id: string, url: string, token: string }} bot
 * @param {{ method?: string, path: string, search?: string, body?: Buffer|null, contentType?: string, source?: string, timeoutMs?: number }} req
 *   path：以 /api/ 開頭的路徑
 * @returns {Promise<{ status: number, headers: Headers, body: Buffer, audit: string[] }>}
 */
async function callAgent(bot, { method = 'GET', path, search = '', body = null, contentType, source, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const headers = { authorization: `Bearer ${bot.token}` };
  if (body?.length) headers['content-type'] = contentType || 'application/json';
  // 來源可能含中文（「，經由 …」），HTTP 標頭只能放 ASCII：URL 編碼後再送
  if (source) headers['x-admin-source'] = encodeURIComponent(source);

  let res;
  try {
    res = await fetch(`${bot.url}${path}${search}`, {
      method,
      headers,
      body: body?.length ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new AgentError(504, `「${bot.id}」超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應`);
    throw new AgentError(502, `無法連線到「${bot.id}」，請確認 Bot 是否正在執行`);
  }

  // 金鑰不對：不能把 401 原樣傳給瀏覽器（網頁會以為面板的登入過期）
  if (res.status === 401) {
    throw new AgentError(502, `「${bot.id}」拒絕了面板的金鑰：請確認面板的 PANEL_TOKEN 與 Bot 的 ADMIN_AGENT_TOKEN 相同`);
  }

  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) throw new AgentError(502, `「${bot.id}」的回應太大`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_RESPONSE_BYTES) throw new AgentError(502, `「${bot.id}」的回應太大`);

  return {
    status: res.status,
    headers: res.headers,
    body: data,
    audit: res.ok ? decodeAudit(res.headers.get('x-admin-audit')) : [],
  };
}

/**
 * Bot 的身分、連線狀態與支援的功能（側邊欄的 Bot 清單用）；連不上時回傳 online: false 與原因
 * @param {{ id: string, url: string, token: string }} bot
 */
async function fetchInfo(bot) {
  try {
    const res = await callAgent(bot, { path: '/api/me', timeoutMs: INFO_TIMEOUT_MS });
    const info = JSON.parse(res.body.toString('utf8'));
    if (res.status !== 200) return { id: bot.id, online: false, error: info?.error || `HTTP ${res.status}` };
    if (info.protocol !== SUPPORTED_PROTOCOL) {
      return { id: bot.id, online: false, error: `管理 API 版本不相容（Bot 是 ${info.protocol}，面板是 ${SUPPORTED_PROTOCOL}）` };
    }
    return {
      id: bot.id,
      online: true,
      app: info.app ?? null,
      features: Array.isArray(info.features) ? info.features : [],
      ready: !!info.ready,
      ping: info.ping ?? -1,
      bot: info.bot ?? null,
    };
  } catch (err) {
    return { id: bot.id, online: false, error: err instanceof AgentError ? err.message : `回應格式錯誤：${err.message}` };
  }
}

module.exports = { callAgent, fetchInfo, AgentError, decodeAudit, SUPPORTED_PROTOCOL };
