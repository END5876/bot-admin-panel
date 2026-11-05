'use strict';
// lib/config.js
// ─────────────────────────────────────────────────────────────
// 面板設定：資料目錄，以及要管理哪些 Bot（PANEL_BOTS）。
//
// PANEL_BOTS：逗號分隔的「代號=管理 API 網址」，順序就是面板上的顯示順序，例如
//   PANEL_BOTS=mousebot=http://mousebot:3940,lite=http://mousebot-lite:3940
// 每隻 Bot 的金鑰：PANEL_TOKEN_<代號大寫，- 換成 _>，例如 PANEL_TOKEN_MOUSEBOT、PANEL_TOKEN_LITE，
// 要和那隻 Bot 的 ADMIN_AGENT_TOKEN 相同。所有 Bot 共用同一把金鑰時，也可以只設 PANEL_TOKEN。
// 新增 Bot：Bot 那邊設定 ADMIN_AGENT_TOKEN（並讓面板連得到它的 ADMIN_PORT），這裡加一筆、重新啟動面板。

const path = require('path');

const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(__dirname, '..', 'data');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MIN_TOKEN_LENGTH = 32;

const tokenEnvName = (id) => `PANEL_TOKEN_${id.toUpperCase().replace(/-/g, '_')}`;

/**
 * @param {string} raw PANEL_BOTS 的值
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ bots: Array<{ id: string, url: string, token: string }>, errors: string[] }}
 */
function parseBots(raw, env = process.env) {
  const bots = [];
  const errors = [];
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const id = (eq < 0 ? '' : part.slice(0, eq)).trim().toLowerCase();
    const rawUrl = (eq < 0 ? part : part.slice(eq + 1)).trim();
    if (!ID_RE.test(id)) {
      errors.push(`「${part}」：代號只能用小寫英數字與 -（格式：代號=網址）`);
      continue;
    }
    if (bots.some((b) => b.id === id)) {
      errors.push(`代號「${id}」重複`);
      continue;
    }
    let url;
    try {
      url = new URL(rawUrl);
      if (!/^https?:$/.test(url.protocol)) throw new Error('protocol');
    } catch {
      errors.push(`「${id}」的網址不正確：${rawUrl}`);
      continue;
    }
    const token = env[tokenEnvName(id)] || env.PANEL_TOKEN || '';
    if (token.length < MIN_TOKEN_LENGTH) {
      errors.push(`「${id}」沒有設定 ${tokenEnvName(id)}（或 PANEL_TOKEN），或少於 ${MIN_TOKEN_LENGTH} 個字元`);
      continue;
    }
    bots.push({ id, url: url.origin + url.pathname.replace(/\/+$/, ''), token });
  }
  return { bots, errors };
}

module.exports = { DATA_DIR, parseBots, tokenEnvName, MIN_TOKEN_LENGTH };
