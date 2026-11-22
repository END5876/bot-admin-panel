// 共用的介面元件：Toast、對話框、開關、分段選擇、頭像、各種狀態畫面

import { h, icon } from './dom.js';
import { fmtTime } from './format.js';

// ── Toast ──────────────────────────────────────────────
// 容器會在 body 和開著的對話框之間搬來搬去（見 homeToasts），先記住它，不要每次用 id 找
let toastBox = null;
const toastsEl = () => (toastBox ??= document.getElementById('toasts'));

// 三個產品共用的規則（ui-review DECISIONS 第 3 題）：
// - 輕量成功／說明：3 秒後消失
// - 帶動作（action：{ label, onClick }，例如復原、重試）：8 秒，滑鼠移上去、手指按住或鍵盤聚焦時暫停倒數
// - 錯誤：不自動消失，紅底白字、有關閉鈕、role="alert"
// - 要後續處理的錯誤（例如重啟超過 3 分鐘）不要用 toast，改放卡片內的常駐提示
const MAX_TOASTS = 4;
export function toast(message, { type = 'success', timeout, action } = {}) {
  const box = toastsEl();
  if (!box) return;
  const isError = type === 'error';
  const iconName = isError ? 'alert' : type === 'info' ? 'info' : 'check';
  const el = h('div', { class: ['toast', `toast-${type}`], role: isError ? 'alert' : null },
    icon(iconName), h('span', { class: 'toast-msg' }, message));
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) {
    el.append(h('button', { type: 'button', class: 'toast-act', onclick: () => { dismiss(); action.onClick(); } }, action.label));
  }
  if (isError) {
    el.append(h('button', { type: 'button', class: 'toast-close', 'aria-label': '關閉這則提示', onclick: dismiss }, icon('x')));
  }
  // 同一句錯誤還開著就不再疊一則（例如連按幾次儲存都失敗）
  if (isError && [...box.querySelectorAll('.toast-error:not(.is-leaving) .toast-msg')].some((m) => m.textContent === message)) return;
  box.append(el);
  // 太多則同時堆著時，先收掉最舊的一般提示；錯誤要等使用者自己關，不算在內
  const all = [...box.querySelectorAll('.toast:not(.is-leaving):not(.toast-error)')];
  for (const old of all.slice(0, Math.max(0, all.length - MAX_TOASTS))) old.remove();
  if (isError) return;

  const ms = timeout ?? (action ? 8000 : 3000);
  let remaining = ms;
  let startedAt = Date.now();
  let paused = false;
  timer = setTimeout(dismiss, ms);
  // 指標在上面或鍵盤焦點在裡面時暫停；兩者都離開後才繼續（至少再留 1.5 秒）
  const pause = () => {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    remaining -= Date.now() - startedAt;
  };
  const maybeResume = () => setTimeout(() => {
    if (!paused || el.matches(':hover') || el.contains(document.activeElement)) return;
    paused = false;
    startedAt = Date.now();
    timer = setTimeout(dismiss, Math.max(1500, remaining));
  }, 0);
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', maybeResume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', maybeResume);
}

export const toastError = (err) => toast(err?.message || String(err), { type: 'error' });

// ── 對話框（原生 <dialog>：焦點鎖定、Esc 關閉都由瀏覽器處理）────
/**
 * @param {{ title: string, body: Node|Node[], footer?: Node[], wide?: boolean, onClose?: () => void,
 *           beforeClose?: () => boolean | Promise<boolean> }} opts
 * beforeClose：使用者按 ×、Esc 或點背景時先問它，回傳 false 就不關閉（程式呼叫 close() 不受影響）
 */
export function openModal({ title, body, footer, wide = false, onClose, beforeClose }) {
  const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '關閉' }, icon('x'));
  const dialog = h('dialog', { class: ['modal', wide && 'modal-wide'] },
    h('div', { class: 'modal-head' }, h('h2', null, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const close = () => { if (dialog.open) dialog.close(); };
  const requestClose = async () => {
    if (!beforeClose || await beforeClose()) close();
  };
  closeBtn.addEventListener('click', requestClose);
  // 點背景關閉（點在 dialog 本身而不是內容上）
  dialog.addEventListener('click', (e) => { if (e.target === dialog) requestClose(); });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });
  // 先把提示訊息的容器搬回去再移除對話框，不然容器會跟著對話框一起被刪掉
  dialog.addEventListener('close', () => { homeToasts(); dialog.remove(); onClose?.(); });
  document.body.append(dialog);
  dialog.showModal();
  homeToasts();
  return { dialog, close };
}

// showModal() 會把對話框放進 top layer，body 底下的 #toasts 再高的 z-index 都會被遮罩蓋住；
// 所以有對話框開著時，把提示訊息的容器搬進最上層的對話框，全部關閉後再搬回 body
function homeToasts() {
  const box = toastsEl();
  if (!box) return;
  const top = [...document.querySelectorAll('dialog.modal[open]')].pop() ?? document.body;
  if (box.parentElement !== top) top.append(box);
}

/**
 * 確認對話框，回傳 Promise<boolean>
 * confirmText 必填，寫具體動作（例如「刪除人格」），不要用「確定」；
 * danger 時預設聚焦「取消」，避免連按 Enter 就執行危險操作
 */
export function confirmDialog({ title, message, confirmText, cancelText = '取消', danger = false }) {
  if (!confirmText) console.warn('confirmDialog: 缺少 confirmText，請寫具體的動作', title);
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { type: 'button', class: ['btn', danger ? 'btn-danger-solid' : 'btn-primary'] }, confirmText || '繼續');
    const cancel = h('button', { type: 'button', class: 'btn' }, cancelText);
    const modal = openModal({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: [h('span', { class: 'spacer' }), cancel, ok],
      onClose: () => resolve(result),
    });
    ok.addEventListener('click', () => { result = true; modal.close(); });
    cancel.addEventListener('click', () => modal.close());
    (danger ? cancel : ok).focus();
  });
}

/**
 * 背景自動更新的新鮮度：成功時顯示「更新於 16:27:05」，
 * 連續失敗 2 次後顯示琥珀色常駐警告，並呼叫 onStaleChange(true) 讓頁面把數值變灰、狀態改成「未知」；
 * 恢復後自動收起
 */
export function freshness({ onStaleChange } = {}) {
  let lastOk = 0;
  let fails = 0;
  let stale = false;
  const stamp = h('span', { class: 'hint updated-at', hidden: true });
  const text = h('span');
  const banner = h('div', { class: 'callout callout-warn stale-banner', role: 'status', hidden: true }, icon('alert', 'ic-sm'), text);
  const setStale = (v) => {
    if (v === stale) return;
    stale = v;
    banner.hidden = !v;
    onStaleChange?.(v);
  };
  return {
    stamp,
    banner,
    get stale() { return stale; },
    ok() {
      lastOk = Date.now();
      fails = 0;
      stamp.hidden = false;
      stamp.textContent = `更新於 ${fmtTime(lastOk)}`;
      setStale(false);
    },
    fail() {
      fails += 1;
      if (fails < 2) return;
      text.textContent = lastOk
        ? `無法更新狀態（${fmtTime(lastOk)} 之後的資料沒有取得），正在重試…`
        : '無法更新狀態，正在重試…';
      setStale(true);
    },
  };
}

/** 執行非同步動作時讓按鈕顯示轉圈、暫時停用；失敗時顯示錯誤 Toast，回傳是否成功 */
export async function withBusy(button, fn) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ...original.filter((n) => n.nodeType === Node.TEXT_NODE));
  try {
    await fn();
    return true;
  } catch (err) {
    toastError(err);
    return false;
  } finally {
    if (button.isConnected) {
      button.replaceChildren(...original);
      button.disabled = false;
    }
  }
}

// ── 開關 ───────────────────────────────────────────────
/**
 * 切換時呼叫 onChange(checked)；回傳的 Promise 失敗會自動切回原狀並顯示錯誤
 */
export function switchControl({ checked, label, ariaLabel, onChange, disabled = false }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: !!checked, disabled, 'aria-label': label ? null : ariaLabel });
  const el = h('label', { class: 'switch' },
    input,
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
    label ? h('span', { class: 'switch-label' }, label) : null,
  );
  input.addEventListener('change', async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      await onChange(next);
    } catch (err) {
      input.checked = !next;
      toastError(err);
    } finally {
      input.disabled = disabled;
    }
  });
  el.input = input;
  return el;
}

// ── 分段選擇 ───────────────────────────────────────────
/**
 * @param {{ options: Array<{ value: any, label: string, icon?: string }>, value: any,
 *           onChange?: (value) => any, ariaLabel: string, small?: boolean }} opts
 * onChange 回傳的 Promise 失敗時會切回原本的選項
 */
export function segmented({ options, value, onChange, ariaLabel, small = false }) {
  let current = value;
  const group = h('div', { class: ['seg', small && 'seg-sm'], role: 'radiogroup', 'aria-label': ariaLabel });
  const buttons = options.map((opt) => h('button', {
    type: 'button',
    class: 'seg-btn',
    role: 'radio',
    'aria-checked': String(opt.value === value),
    onclick: () => select(opt.value),
  }, opt.icon ? icon(opt.icon, 'ic-sm') : null, opt.label));
  group.append(...buttons);

  function mark(v) {
    current = v;
    options.forEach((opt, i) => buttons[i].setAttribute('aria-checked', String(opt.value === v)));
  }

  async function select(v) {
    if (v === current) return;
    const prev = current;
    mark(v);
    try {
      await onChange?.(v);
    } catch (err) {
      mark(prev);
      toastError(err);
    }
  }

  group.setValue = mark;
  return group;
}

// ── 頭像 ───────────────────────────────────────────────
export function avatar({ url, name, size = '', square = false }) {
  const cls = ['avatar', size && `avatar-${size}`, square && 'avatar-square'];
  if (url) return h('img', { class: cls, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return h('span', { class: cls, 'aria-hidden': 'true' }, initial);
}

/** 使用者顯示：頭像＋名稱＋ @帳號 / ID */
export function userCell(user) {
  const missing = !user || user.missing;
  return h('div', { class: 'user-cell' },
    avatar({ url: user?.avatarUrl, name: user?.name, size: 'sm' }),
    h('div', { class: 'row-main' },
      h('div', { class: 'user-cell-name truncate' }, missing ? '（找不到使用者）' : user.name),
      h('div', { class: 'user-cell-sub mono truncate' }, missing ? user?.id ?? '' : `@${user.username} · ${user.id}`),
    ),
  );
}

// ── 狀態標籤 ───────────────────────────────────────────
/** kind：good / warn / bad / neutral；顏色一定搭配文字 */
export function statusBadge(kind, text) {
  const cls = { good: 'badge-good', warn: 'badge-warn', bad: 'badge-bad', accent: 'badge-accent' }[kind];
  // 灰點在這個面板代表「沒連上」，中性與強調狀態不畫圓點，免得誤會
  const dot = kind === 'neutral' || kind === 'accent' ? null : h('span', { class: ['dot', `dot-${kind}`] });
  return h('span', { class: ['badge', cls] }, dot, text);
}

// ── 狀態畫面 ───────────────────────────────────────────
export const loadingState = (text = '載入中…') =>
  h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);

export const emptyState = (text, iconName = 'info') =>
  h('div', { class: 'empty' }, icon(iconName), h('div', null, text));

export function errorState(err, retry) {
  return h('div', { class: 'error-box', role: 'alert' },
    icon('alert'),
    h('div', null, err?.message || '載入失敗'),
    retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, icon('refresh'), '重試') : null,
  );
}

export function card({ title, sub, actions, body, foot, note, iconName, tight = false, className }) {
  return h('section', { class: ['card', className] },
    title ? h('div', { class: 'card-head' },
      h('h2', null, iconName ? icon(iconName) : null, title),
      sub ? h('span', { class: 'card-sub' }, sub) : null,
      actions ? h('div', { class: 'card-head-actions' }, actions) : null,
    ) : null,
    body !== undefined ? h('div', { class: ['card-body', tight && 'tight'] }, body) : null,
    foot ? h('div', { class: 'card-foot' }, foot) : null,
    note ? h('div', { class: 'card-note' }, icon('info', 'ic-sm'), h('span', null, note)) : null,
  );
}

/** 有頭有尾的 <select>；groups：[{ label, options: [{ value, label }] }] */
export function selectEl({ groups, options, value, placeholder, ariaLabel, onchange, className }) {
  const sel = h('select', { class: ['select', className], 'aria-label': ariaLabel, onchange });
  if (placeholder) sel.append(h('option', { value: '' }, placeholder));
  const opt = (o) => h('option', { value: o.value, disabled: !!o.disabled }, o.label);
  if (groups) for (const g of groups) sel.append(h('optgroup', { label: g.label }, g.options.map(opt)));
  if (options) sel.append(...options.map(opt));
  sel.value = value ?? '';
  return sel;
}
