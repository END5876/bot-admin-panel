// 總覽：Bot 狀態、外部服務、今日 AI 用量、語音連線、模組開機摘要、伺服器清單

import { h, icon, setVar } from '../dom.js';
import { api } from '../api.js';
import { fmtCompact, fmtDateTime, fmtDuration, fmtInt, fmtPercent } from '../format.js';
import { avatar, card, emptyState, errorState, freshness, loadingState, statusBadge, toastError } from '../ui.js';
import { LOGS_LEVEL_KEY } from './logs.js';

const CHECK = {
  ok: ['good', '正常'],
  recovering: ['warn', '重新連線中'],
  down: ['bad', '離線'],
  disabled: ['neutral', '未設定'],
};
const MODULE = { ok: ['is-good', 'check', '正常'], warn: ['is-warn', 'alert', '降級運作'], off: ['is-off', 'x', '未啟用'] };
const UNKNOWN = ['neutral', '未知'];
const VOICE = { ready: ['good', '已連線'], signalling: ['warn', '連線中'], connecting: ['warn', '連線中'], disconnected: ['bad', '已斷線'] };

function stat(label, value, sub, extra) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
    extra,
  );
}

function budgetMeter(used, budget) {
  const ratio = budget > 0 ? used / budget : 0;
  const meter = h('div', {
    class: ['meter', ratio >= 1 ? 'is-bad' : ratio >= 0.8 && 'is-warn'],
    role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': budget, 'aria-valuenow': Math.min(used, budget),
    'aria-label': '今日 token 預算使用量',
  }, h('span'));
  setVar(meter, '--w', `${Math.min(100, ratio * 100)}%`);
  return meter;
}

function checkRow(name, check, detail, stale) {
  // 「未設定」是設定上的事實，資料過期也不會變，不要改成「未知」
  const [kind, text] = stale && check.status !== 'disabled' ? UNKNOWN : CHECK[check.status] ?? CHECK.down;
  return h('div', { class: 'row' },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, name), detail ? h('div', { class: 'row-sub' }, detail) : null),
    statusBadge(kind, text),
  );
}

// 異常排前面：離線 → 重新連線中 → 正常 → 未設定
const CHECK_ORDER = { down: 0, recovering: 1, ok: 2, disabled: 3 };
const MODULE_ORDER = { warn: 0, ok: 1, off: 2 };

/** 總覽狀態帶要列出的「要注意的事」：未設定（disabled）、未啟用的模組都不算 */
function collectIssues(d) {
  const { checks } = d.health;
  const issues = [];
  if (checks.discord.status !== 'ok') {
    issues.push({ text: `Discord ${(CHECK[checks.discord.status] ?? CHECK.down)[1]}`, target: 'services' });
  }
  for (const [key, label] of [['oww', '喚醒詞服務（OWW）'], ['potProvider', 'YouTube PO Token 服務']]) {
    const c = checks[key];
    if (!c || c.status === 'ok' || c.status === 'disabled') continue;
    const detail = probeDetail(c);
    issues.push({ text: `${label}${(CHECK[c.status] ?? CHECK.down)[1]}${detail ? `：${detail}` : ''}`, target: 'services' });
  }
  for (const m of d.modules) {
    if (m.status === 'warn') issues.push({ text: `${m.name}降級運作${m.detail ? `：${m.detail}` : ''}`, target: 'modules' });
  }
  const budget = d.usage.limits.dailyBudget;
  if (budget > 0 && d.usage.billable / budget >= 0.8) {
    issues.push({ text: `今日 AI 用量已達 ${fmtPercent(d.usage.billable / budget)}`, target: 'stats' });
  }
  return issues;
}

function probeDetail(check) {
  if (check.status === 'disabled') return '未設定位址';
  if (check.error) return check.error === 'timeout' ? '逾時沒有回應' : check.error;
  return check.httpStatus ? `HTTP ${check.httpStatus}` : null;
}

export default function mountOverview(root, ctx) {
  let last = null;
  // 連續更新失敗時：數值變灰、狀態改成「未知」，用最後一次的資料重畫
  const fresh = freshness({
    onStaleChange: (stale) => {
      root.classList.toggle('is-stale', stale);
      if (last) render(last);
    },
  });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(true) }, icon('refresh', 'ic-sm'), '重新整理');
  ctx.setActions(fresh.stamp, refreshBtn);
  root.append(loadingState());

  async function load(manual = false) {
    if (last) root.classList.add('is-refreshing');
    try {
      const data = await api.get('/api/overview');
      if (ctx.disposed) return;
      last = data;
      render(data);
      fresh.ok();
      if (manual) ctx.refreshBotChip();
    } catch (err) {
      if (ctx.disposed) return;
      if (!last) root.replaceChildren(errorState(err, () => load(true)));
      else {
        fresh.fail();
        if (manual) toastError(err);
      }
    } finally {
      root.classList.remove('is-refreshing');
    }
  }

  function render(d) {
    const { stale } = fresh;
    const { checks } = d.health;
    const discord = checks.discord;
    const [dKind, dText] = stale ? UNKNOWN : CHECK[discord.status] ?? CHECK.down;

    // 狀態帶：一句話結論。正常時一行；有異常時列出要注意的事，每項可以點到對應的卡片
    const name = d.bot?.name ?? ctx.botName();
    const issues = stale ? [] : collectIssues(d);
    const jump = (target) => {
      const el = root.querySelector(`.ov-${target}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.tabIndex = -1; // 讓鍵盤與報讀器的焦點跟著移過去
      el.focus({ preventScroll: true });
    };
    const headline = stale ? `${name} 狀態未知`
      : issues.length ? `有 ${issues.length} 件事要注意`
        : `${name} 運作正常・已運行 ${fmtDuration(d.health.uptimeSec)}`;
    const shortcuts = issues.length ? [
      ctx.has('logs') ? h('a', {
        class: 'btn btn-sm', href: `#/${ctx.bot}/logs`,
        onclick: () => { try { sessionStorage.setItem(LOGS_LEVEL_KEY, '3'); } catch {} },
      }, icon('terminal', 'ic-sm'), '看錯誤日誌') : null,
      ctx.has('maintenance') ? h('a', { class: 'btn btn-sm', href: `#/${ctx.bot}/maintenance` }, icon('power', 'ic-sm'), `重新啟動 ${name}…`) : null,
    ] : null;
    const hero = h('section', { class: ['card', 'hero', 'status-band', stale ? 'is-unknown' : issues.length ? 'is-bad' : 'is-good'], role: 'status' },
      avatar({ url: d.bot?.avatarUrl, name: d.bot?.name, size: 'lg' }),
      h('div', { class: 'row-main' },
        h('div', { class: 'hero-name' }, headline),
        issues.length
          ? h('ul', { class: 'band-issues' }, issues.map((i) => h('li', null,
            h('button', { type: 'button', class: 'band-link', onclick: () => jump(i.target) }, i.text))))
          : h('div', { class: 'hero-meta' },
            d.bot ? h('span', { class: 'mono' }, d.bot.tag) : h('span', null, '尚未登入 Discord'),
            statusBadge(dKind, `Discord ${dText}`),
          ),
      ),
      shortcuts ? h('div', { class: 'hero-aside' }, shortcuts) : null,
    );

    const { usage } = d;
    const budget = usage.limits.dailyBudget;
    const stats = h('div', { class: 'stats ov-stats' },
      stat('運行時間', fmtDuration(d.health.uptimeSec)),
      stat('記憶體', `${fmtInt(d.health.memoryMB)} MB`, '程序常駐記憶體（RSS）'),
      stat('Discord 延遲', discord.ping >= 0 ? `${fmtInt(discord.ping)} ms` : '—', `WebSocket：${discord.wsStatus}`),
      stat('伺服器', fmtInt(d.guilds.length), `${fmtInt(d.voice.length)} 個語音連線`),
      stat('今日 AI 用量', `${fmtCompact(usage.billable)} tokens`,
        budget > 0 ? `全體每日上限 ${fmtCompact(budget)}（已用 ${fmtPercent(usage.billable / budget)}）` : `${fmtInt(usage.total.calls)} 次呼叫`,
        budget > 0 ? budgetMeter(usage.billable, budget) : null),
    );
    // 用量格字最多：寬度夠排 3 欄以下時跨 2 欄，不會被擠成落單的窄格
    stats.lastElementChild.classList.add('stat-wide');

    const serviceRows = [
      [discord, checkRow('Discord Gateway', discord, `狀態 ${discord.wsStatus}・${fmtInt(discord.guilds)} 個伺服器`, stale)],
      [checks.oww, checkRow('喚醒詞服務（OWW）', checks.oww, probeDetail(checks.oww), stale)],
      [checks.potProvider, checkRow('YouTube PO Token 服務', checks.potProvider, probeDetail(checks.potProvider), stale)],
    ].sort((a, b) => (CHECK_ORDER[a[0].status] ?? 0) - (CHECK_ORDER[b[0].status] ?? 0)).map(([, row]) => row);
    const services = card({
      title: '外部服務',
      iconName: 'server',
      className: 'ov-services',
      body: h('div', { class: 'rows' }, serviceRows),
      tight: true,
      note: 'Discord 斷線超過 60 秒時，健康檢查會回報不健康；其他服務離線時 Bot 會降級運作。',
    });

    const voice = card({
      title: '語音連線',
      iconName: 'headphones',
      actions: h('a', { class: 'btn btn-sm', href: '#/voice' }, '前往控制', icon('chevron', 'ic-sm')),
      tight: true,
      body: d.voice.length
        ? h('div', { class: 'rows' }, d.voice.map((v) => {
          const [kind, text] = stale ? UNKNOWN : VOICE[v.status] ?? ['warn', v.status];
          const parts = [v.channelName ? `🔊 ${v.channelName}` : '頻道未知'];
          if (v.listeners != null) parts.push(`${v.listeners} 人在頻道`);
          return h('div', { class: 'row' },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' }, v.guildName),
              h('div', { class: 'row-sub' }, parts.join('・')),
              v.nowPlaying ? h('div', { class: 'row-sub truncate' }, icon('music', 'ic-sm'), ' ', v.nowPlaying, v.queueLength ? `（佇列 ${v.queueLength} 首）` : '') : null,
            ),
            statusBadge(kind, text),
          );
        }))
        : emptyState('Bot 目前不在任何語音頻道', 'volume'),
    });

    const modules = card({
      title: '模組狀態',
      sub: '開機時回報',
      iconName: 'sliders',
      className: 'ov-modules',
      tight: true,
      body: h('div', { class: 'rows' }, [...d.modules].sort((a, b) => (MODULE_ORDER[a.status] ?? 0) - (MODULE_ORDER[b.status] ?? 0)).map((m) => {
        const [cls, ic, label] = MODULE[m.status] ?? MODULE.off;
        return h('div', { class: 'row module-row' },
          h('span', { class: ['status-ic', cls], title: label, 'aria-label': label, role: 'img' }, icon(ic)),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, m.name),
            m.detail ? h('div', { class: 'row-sub' }, m.detail) : null,
          ),
        );
      })),
    });

    const guilds = card({
      title: '伺服器',
      sub: `${d.guilds.length} 個`,
      iconName: 'server',
      tight: true,
      body: d.guilds.length
        ? h('div', { class: 'rows' }, d.guilds.map((g) => h('div', { class: 'row' },
          avatar({ url: g.iconUrl, name: g.name, square: true }),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, g.name),
            h('div', { class: 'row-sub mono' }, g.id),
          ),
          g.memberCount != null ? h('span', { class: 'badge' }, icon('user'), fmtInt(g.memberCount)) : null,
        )))
        : emptyState('Bot 還沒加入任何伺服器'),
    });

    // 上一次未捕捉例外的原因（utils/crashLog.js）；重啟後 log 已經看不到，只有這裡留著
    const crash = d.lastCrash ? card({
      title: '上次崩潰',
      sub: fmtDateTime(d.lastCrash.at),
      iconName: 'alert',
      body: h('div', { class: 'rows' },
        h('div', { class: 'row' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, `${d.lastCrash.name}: ${d.lastCrash.message}`),
            h('div', { class: 'row-sub' }, `${d.lastCrash.origin}・啟動後 ${fmtDuration(d.lastCrash.uptimeSec)} 發生`),
            h('pre', { class: 'row-sub mono crash-stack' }, d.lastCrash.stack.split('\n').slice(0, 8).join('\n')),
          ),
        ),
      ),
      tight: true,
      note: '程序已自動重新啟動。這裡只保留最近一次（data/lastCrash.json）。',
    }) : null;

    // 原生 replaceChildren 會把 null 變成文字「null」，沒有崩潰紀錄時不要傳進去
    root.replaceChildren(...[
      fresh.banner,
      hero,
      // 摘要格依「內容」寬度決定欄數（外層是 container），不受側欄寬窄影響
      h('div', { class: 'ov-stats-wrap' }, stats),
      crash,
      h('div', { class: 'grid grid-2' }, services, voice),
      h('div', { class: 'grid grid-2' }, modules, guilds),
    ].filter(Boolean));
  }

  load();
  ctx.poll(load, 15000);
}
