'use strict';
// lib/audit.js
// ─────────────────────────────────────────────────────────────
// 操作紀錄：誰（來源 IP）在什麼時候、對哪一隻 Bot 做了什麼，存在 data/adminAudit.json（保留最近 2000 筆）。
// Bot 的變更描述由 Bot 的管理 API 經由回應標頭 x-admin-audit 交回來（請求成功才有）；
// 登入、登出等面板自己的事件沒有 bot。

const path = require('path');
const logger = require('./logger');
const { DATA_DIR } = require('./config');
const { readJson, createDebouncedWriter } = require('./jsonStore');

// ADMIN_AUDIT_FILE：改放到別的位置（給測試用，避免寫進真正的 data/）
const AUDIT_PATH = process.env.ADMIN_AUDIT_FILE || path.join(DATA_DIR, 'adminAudit.json');
const MAX_ENTRIES = 2000;
// 不需要登入就能觸發的紀錄（登入失敗）最多佔這麼多筆，超過時刪掉最舊的那種紀錄：
// 換 IP 灌錯誤密碼也擠不掉真正的管理操作（每一次失敗仍會寫進 log，達到上限時也會通知維運）
const MAX_UNAUTH_ENTRIES = 200;
// 同一來源在這段時間內連續失敗：合併成一筆，記次數
const UNAUTH_MERGE_MS = 10 * 60 * 1000;

let entries = (() => {
  const saved = readJson(AUDIT_PATH, []);
  return Array.isArray(saved) ? saved.filter((e) => e && typeof e.ts === 'number' && typeof e.action === 'string') : [];
})();
let seq = entries.reduce((max, e) => Math.max(max, e.id ?? 0), 0);

const writer = createDebouncedWriter(AUDIT_PATH, () => entries, { debounceMs: 2000, label: 'Admin' });

/**
 * @param {string} action 給人看的描述，例如「新增自訂回應「欸」」
 * @param {{ source?: string, level?: 'info'|'warn', unauth?: boolean, bot?: string|null }} [opts]
 *   unauth：未登入就能觸發的紀錄（見 MAX_UNAUTH_ENTRIES）；bot：這個操作是對哪一隻 Bot（PANEL_BOTS 的代號）
 */
function record(action, { source = null, level = 'info', unauth = false, bot = null } = {}) {
  const now = Date.now();
  const same = unauth
    ? entries.findLast((e) => e.unauth && e.action === action && e.source === source && now - e.ts < UNAUTH_MERGE_MS)
    : null;
  if (same) {
    same.count = (same.count ?? 1) + 1;
  } else {
    entries.push({
      id: ++seq, ts: now, action, source, level,
      ...(bot ? { bot } : {}),
      ...(unauth ? { unauth: true } : {}),
    });
    if (unauth && entries.filter((e) => e.unauth).length > MAX_UNAUTH_ENTRIES) {
      entries.splice(entries.findIndex((e) => e.unauth), 1);
    }
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  }
  writer.schedule();
  logger[level === 'warn' ? 'warn' : 'info']('Admin', `📝 ${bot ? `[${bot}] ` : ''}${action}${source ? `（${source}）` : ''}`);
}

/**
 * 由新到舊列出
 * @param {{ before?: number, limit?: number, bot?: string|null }} [opts]
 *   before：只列出 id 比它小的（往前翻頁）；bot：只列出這隻 Bot 的操作（null＝全部，含登入紀錄）
 */
function list({ before = Infinity, limit = 100, bot = null } = {}) {
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (e.id < before && (!bot || e.bot === bot)) out.push(e);
  }
  return out;
}

/** 程序結束前呼叫：把還在等待合併的寫入立即寫出 */
function flush() {
  writer.flush();
}

module.exports = { record, list, flush };
