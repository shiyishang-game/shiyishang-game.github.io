// 撸城 · 游玩看板（给作者自己看）：游戏线上状态 + Umami 匿名统计。
// - 纯静态页，只读：统计数据走 Umami 的「分享链接」只读令牌，不需要账号密码 / API key。
// - 分享码只放在网址 # 后面（# 后面的内容浏览器不会发给任何服务器），记在本机 localStorage；页面和仓库里都不存。
//   没有分享码的人打开这页，只能看到游戏线上状态。
// - 所有文字都用 textContent 写入；CSP 只放开 cloud.umami.is 和 api.github.com 两个读接口。
import { WEBSITE } from '../js/stats.js';

const API_BASES = ['https://cloud.umami.is/analytics/us/api', 'https://cloud.umami.is/analytics/eu/api'];
const REPO = 'shiyishang-game/shiyishang-game.github.io';
const TZ = 'Asia/Shanghai';
const TZ_MS = 8 * 3600e3;
const DAY = 864e5;
const LAUNCH = Date.UTC(2026, 9, 30) - TZ_MS;   // 10/30 00:00 北京时间，统计从这天起
const REFRESH_MS = 60e3;
const GH_MS = 15 * 60e3;                        // GitHub 匿名接口每小时只给 60 次（同一出口 IP 共用），少查
const SHARE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const KINDS = { prologue: '序章结局', hidden: '隐藏结局', if: 'IF 结局', death: '死亡结局' };
const DEVICES = { mobile: '手机', desktop: '电脑', laptop: '笔记本', tablet: '平板' };
const BROWSERS = { ios: 'iPhone Safari', 'ios-webview': 'App 内打开（iOS）', 'chromium-webview': 'App 内打开（安卓）', crios: 'iPhone Chrome',
  chrome: 'Chrome', safari: 'Safari', 'edge-chromium': 'Edge', edge: 'Edge', firefox: 'Firefox', samsung: '三星浏览器', miui: '小米浏览器' };
const RANGES = [
  { id: 'today', name: '今天', start: function (now) { return dayStart(now); }, unit: 'hour' },
  { id: 'd7', name: '7 天', start: function (now) { return dayStart(now) - 6 * DAY; }, unit: 'day' },
  { id: 'd30', name: '30 天', start: function (now) { return dayStart(now) - 29 * DAY; }, unit: 'day' },
  { id: 'all', name: '上线以来', start: function () { return LAUNCH; }, unit: 'day' },
];

// ---------- 小工具 ----------
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
function num(v) {
  if (v && typeof v === 'object') v = v.value;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function dayStart(t) { return Math.floor((t + TZ_MS) / DAY) * DAY - TZ_MS; }
const fmtTime = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtClock = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let regionName = null;
try { regionName = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch (e) { regionName = null; }
function pct(a, b) { return b > 0 ? Math.round(a * 100 / b) + '%' : '—'; }
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

// ---------- 分享码 ----------
function readShare() {
  let raw = '';
  try { raw = decodeURIComponent(location.hash.slice(1)); } catch (e) { raw = ''; }
  const m = /\/share\/([A-Za-z0-9_-]+)/.exec(raw);     // 整条分享链接贴在 # 后面也认
  if (m) raw = m[1];
  if (SHARE_RE.test(raw)) {
    try { localStorage.setItem('dash.share', raw); } catch (e) { /* 无痕模式 */ }
    return raw;
  }
  try {
    const s = localStorage.getItem('dash.share') || '';
    return SHARE_RE.test(s) ? s : '';
  } catch (e) {
    return '';
  }
}

// ---------- Umami 只读接口 ----------
const um = { slug: '', base: '', token: '', wid: '', err: '' };

async function umLogin() {
  um.token = '';
  for (const b of API_BASES) {
    try {
      const r = await fetch(b + '/share/' + encodeURIComponent(um.slug), { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      const wid = j.websiteId || (Array.isArray(j.websiteIds) && j.websiteIds[0]);
      if (j.token && wid) {
        um.base = b; um.token = j.token; um.wid = wid; um.err = '';
        return true;
      }
    } catch (e) { /* 换下一个区 */ }
  }
  um.err = '分享码打不开（失效 / 没开分享 / 网络不通）';
  return false;
}

async function umGet(path, q) {
  const u = new URL(um.base + '/websites/' + encodeURIComponent(um.wid) + path);
  Object.keys(q || {}).forEach(function (k) { u.searchParams.set(k, q[k]); });
  const r = await fetch(u.toString(), {
    headers: { 'x-umami-share-token': um.token, 'x-umami-share-context': '1' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (r.status === 401 || r.status === 403) {
    um.token = '';                                  // 令牌过期：下次刷新重新换
    throw new Error('auth');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function rows(res) {
  const v = res && res.status === 'fulfilled' ? res.value : null;
  const arr = Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : []);
  return arr.map(function (x) { return [x.x == null || x.x === '' ? '（直接打开）' : String(x.x), num(x.y)]; });
}

// ---------- 剧本：结局 -> 线 / 类型 ----------
const story = { ok: false, version: '', ends: {}, total: 0, lines: [], lineName: {} };

function loadStory(s) {
  story.version = s.version || '';
  story.ends = {};
  story.lineName = {};
  Object.keys(s.lines || {}).forEach(function (id) { story.lineName[id] = s.lines[id].name || id; });
  const locked = function (id) { return !!(s.lines[id] && s.lines[id].locked); };
  Object.keys(s.cards || {}).forEach(function (id) {
    const c = s.cards[id];
    if (!c.end || locked(c.ln)) return;
    story.ends[c.end.title] = { id: id, line: c.ln, kind: c.end.kind };
  });
  story.total = Object.keys(story.ends).length;
  story.lines = ['common'].concat((s.order || []).filter(function (id) { return !locked(id); }));
  story.ok = true;
}

// ---------- 页面骨架 ----------
const app = document.getElementById('app');
clear(app);
const top = h('div', 'top');
const title = h('h1');
const gameLink = h('a', '', '撸城 · 看板');
gameLink.href = '../';
title.appendChild(gameLink);
const upd = h('div', 'upd', '加载中…');
top.appendChild(title);
top.appendChild(upd);
app.appendChild(top);

const tabs = h('div', 'btnrow');
app.appendChild(tabs);
const secStatus = h('section', 'panel');
const secKpi = h('section', 'kpis');
const secTrend = h('section', 'panel');
const secFunnel = h('section', 'panel');
const twin = h('div', 'cols2');
const secPick = h('section', 'panel');
const secMisc = h('section', 'panel');
twin.appendChild(secPick);
twin.appendChild(secMisc);
const secEnds = h('section', 'panel');
const secWho = h('section', 'panel');
[secStatus, secKpi, secTrend, secFunnel, twin, secEnds, secWho].forEach(function (s) { app.appendChild(s); });

let range = RANGES[0];
let busy = false;
let lastOk = 0;

function drawTabs() {
  clear(tabs);
  RANGES.forEach(function (r) {
    const b = h('button', r === range ? 'on' : '', r.name);
    b.type = 'button';
    b.addEventListener('click', function () { range = r; drawTabs(); refresh(); });
    tabs.appendChild(b);
  });
  const rb = h('button', '', '刷新');
  rb.type = 'button';
  rb.addEventListener('click', function () { refresh(); checkGame(true); });
  tabs.appendChild(rb);
  if (um.slug) {
    const fb = h('button', '', '本机忘记分享码');
    fb.type = 'button';
    fb.addEventListener('click', function () {
      try { localStorage.removeItem('dash.share'); } catch (e) { /* 无所谓 */ }
      location.replace(location.pathname);
    });
    tabs.appendChild(fb);
  }
}

// ---------- 游戏线上状态 ----------
const game = { site: null, ms: 0, lm: '', asset: null, gh: null, ghAt: 0, checkedAt: 0 };

function stItem(parent, k, dot, v, sub) {
  const box = h('div', 'st');
  box.appendChild(h('span', 'k', k));
  const vv = h('span', 'v');
  if (dot) vv.appendChild(h('span', 'dot ' + dot));
  vv.appendChild(document.createTextNode(v));
  box.appendChild(vv);
  if (sub) box.appendChild(h('span', 'note', sub));
  parent.appendChild(box);
}

async function checkGame(forceGh) {
  const t0 = performance.now();
  try {
    const r = await fetch('../index.html', { cache: 'no-store', credentials: 'omit' });
    game.site = r.ok;
    game.ms = Math.round(performance.now() - t0);
    game.lm = r.headers.get('last-modified') || '';
  } catch (e) {
    game.site = false;
  }
  try {
    const r = await fetch('../data/story.json', { cache: 'no-store', credentials: 'omit' });
    if (r.ok) loadStory(await r.json());
  } catch (e) { /* 剧本读不到就不显示结局分组 */ }
  try {
    const r = await fetch('../assets/img/ui/title.webp', { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    game.asset = r.ok;
  } catch (e) {
    game.asset = false;
  }
  if (forceGh || Date.now() - game.ghAt > GH_MS) {
    game.ghAt = Date.now();
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs?per_page=1', { credentials: 'omit', cache: 'no-store' });
      if (r.status === 403 || r.status === 429) game.gh = { limited: true };
      else if (r.ok) {
        const run = ((await r.json()).workflow_runs || [])[0];
        game.gh = run ? {
          status: run.status, conclusion: run.conclusion, at: Date.parse(run.updated_at),
          msg: String((run.head_commit && run.head_commit.message) || '').split('\n')[0].slice(0, 40),
        } : null;
      }
    } catch (e) {
      game.gh = { failed: true };
    }
  }
  game.checkedAt = Date.now();
  drawStatus();
}

function drawStatus() {
  clear(secStatus);
  const hd = h('h2', '', '游戏线上状态');
  hd.appendChild(h('small', '', game.checkedAt ? '检查于 ' + fmtClock.format(game.checkedAt) : ''));
  secStatus.appendChild(hd);
  const grid = h('div', 'status');
  if (game.site == null) stItem(grid, '网站', 'wait', '检查中…');
  else stItem(grid, '网站', game.site ? 'ok' : 'bad', game.site ? '在线' : '打不开', game.site ? '首页响应 ' + game.ms + ' ms' : '');
  stItem(grid, '素材', game.asset == null ? 'wait' : (game.asset ? 'ok' : 'bad'), game.asset == null ? '检查中…' : (game.asset ? '正常' : '图片读不到'));
  if (story.ok) stItem(grid, '剧本', 'ok', 'v' + story.version, story.total + ' 个结局 · ' + (story.lines.length - 1) + ' 条可玩线');
  const lm = Date.parse(game.lm);
  if (lm) stItem(grid, '最后部署', '', fmtTime.format(lm), ago(lm));
  const g = game.gh;
  if (g && g.limited) stItem(grid, 'GitHub 构建', 'wait', '暂时查不到', 'GitHub 匿名接口限流，过会儿自动再查');
  else if (g && g.failed) stItem(grid, 'GitHub 构建', 'wait', '暂时查不到');
  else if (g) {
    const ok = g.status === 'completed' && g.conclusion === 'success';
    const doing = g.status !== 'completed';
    stItem(grid, 'GitHub 构建', ok ? 'ok' : (doing ? 'wait' : 'bad'), ok ? '成功' : (doing ? '构建中' : '失败：' + g.conclusion), g.msg + ' · ' + ago(g.at));
  }
  stItem(grid, '统计开关', WEBSITE ? 'ok' : 'bad', WEBSITE ? '已开启' : '关闭（stats.js 没填 ID）');
  if (um.slug) stItem(grid, '统计接口', um.err ? 'bad' : (um.token ? 'ok' : 'wait'), um.err ? '出错' : (um.token ? '已连上' : '连接中…'), um.err || '');
  secStatus.appendChild(grid);
}

// ---------- 统计 ----------
function kpi(k, v, d, cls) {
  const box = h('div', 'kpi' + (cls ? ' ' + cls : ''));
  box.appendChild(h('div', 'k', k));
  box.appendChild(h('div', 'v', v));
  if (d) box.appendChild(d);
  secKpi.appendChild(box);
}
function delta(cur, prev, label) {
  const d = h('div', 'd');
  if (prev == null) return d;
  const x = cur - prev;
  const s = h('span', x > 0 ? 'up' : (x < 0 ? 'down' : ''), (x > 0 ? '+' : '') + x);
  d.appendChild(document.createTextNode(label + ' '));
  d.appendChild(s);
  return d;
}

function bucketKey(x, unit) {
  let s = String(x);
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {           // 带时区的时间戳：换成北京时间再取
    const t = Date.parse(s);
    if (!isNaN(t)) s = new Date(t + TZ_MS).toISOString();
  }
  s = s.replace('T', ' ');
  return unit === 'hour' ? s.slice(0, 13) : s.slice(0, 10);
}

function drawTrend(series, t0, now) {
  clear(secTrend);
  const hd = h('h2', '', range.unit === 'hour' ? '今天每小时' : '每天');
  hd.appendChild(h('small', '', '人数 = 去重访客'));
  secTrend.appendChild(hd);
  const pv = {}, uv = {};
  (series && series.pageviews || []).forEach(function (p) { pv[bucketKey(p.x, range.unit)] = num(p.y); });
  (series && series.sessions || []).forEach(function (p) { uv[bucketKey(p.x, range.unit)] = num(p.y); });
  const keys = [];
  const step = range.unit === 'hour' ? 3600e3 : DAY;
  for (let t = t0; t <= now; t += step) {
    const iso = new Date(t + TZ_MS).toISOString().replace('T', ' ');
    keys.push(range.unit === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10));
  }
  const max = Math.max(1, ...keys.map(function (k) { return Math.max(pv[k] || 0, uv[k] || 0); }));
  const chart = h('div', 'chart');
  const every = Math.ceil(keys.length / 7);
  keys.forEach(function (k, i) {
    const col = h('div', 'col');
    const bars = h('div', 'bars');
    const a = h('div', 'b uv'); a.style.height = ((uv[k] || 0) / max * 100) + '%';
    const b = h('div', 'b pv'); b.style.height = ((pv[k] || 0) / max * 100) + '%';
    a.title = (uv[k] || 0) + ' 人';
    b.title = (pv[k] || 0) + ' 次浏览';
    bars.appendChild(a); bars.appendChild(b);
    col.appendChild(bars);
    if (uv[k]) col.appendChild(h('span', 'n', uv[k]));
    const lb = range.unit === 'hour' ? (+k.slice(11, 13)) + '时' : (+k.slice(5, 7)) + '/' + (+k.slice(8, 10));
    col.appendChild(h('span', 'lb', i % every === 0 || i === keys.length - 1 ? lb : ''));
    chart.appendChild(col);
  });
  secTrend.appendChild(chart);
  const lg = h('div', 'legend');
  const l1 = h('span'); l1.appendChild(h('i', 'uv')); l1.appendChild(document.createTextNode('人数'));
  const l2 = h('span'); l2.appendChild(h('i', 'pv')); l2.appendChild(document.createTextNode('浏览次数'));
  lg.appendChild(l1); lg.appendChild(l2);
  secTrend.appendChild(lg);
}

function barRow(parent, name, value, max, cls, side) {
  const r = h('div', 'row');
  const n = h('span', 'name', name);
  n.title = name;
  r.appendChild(n);
  const tr = h('div', 'track');
  const f = h('div', 'fill' + (cls ? ' ' + cls : ''));
  f.style.width = (max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0) + '%';
  tr.appendChild(f);
  r.appendChild(tr);
  const v = h('span', 'num', value);
  if (side) v.appendChild(h('small', '', side));
  r.appendChild(v);
  parent.appendChild(r);
}

function drawFunnel(visits, ev) {
  clear(secFunnel);
  const hd = h('h2', '', '玩家走到哪一步');
  hd.appendChild(h('small', '', '按次数，不是人数'));
  secFunnel.appendChild(hd);
  const box = h('div', 'funnel');
  const sum = function (pre) { return Object.keys(ev).reduce(function (a, k) { return a + (k.indexOf(pre) === 0 ? ev[k] : 0); }, 0); };
  let good = 0;
  Object.keys(ev).forEach(function (k) {
    if (k.indexOf('结局·') !== 0) return;
    const e = story.ends[k.slice(3)];
    if (e && (e.kind === 'prologue' || e.kind === 'hidden')) good += ev[k];
  });
  const steps = [['打开页面', visits], ['点「进入」', ev['开始'] || 0], ['选了世一上', sum('选人·')], ['打出结局', sum('结局·')], ['打出序章/隐藏', good]];
  const top = Math.max(1, steps[0][1], steps[1][1]);
  steps.forEach(function (s, i) {
    barRow(box, s[0], s[1], top, i === 4 ? 'k-prologue' : '', i ? pct(s[1], steps[0][1]) : '');
  });
  secFunnel.appendChild(box);
  secFunnel.appendChild(h('p', 'note', '读档继续不算「进入」；同一个人多次打开会算多次。'));
}

function drawPick(ev) {
  clear(secPick);
  secPick.appendChild(h('h2', '', '选人分布'));
  const box = h('div', 'hbar');
  const picks = story.lines.filter(function (id) { return id !== 'common'; }).map(function (id) {
    const n = story.lineName[id];
    return [n, ev['选人·' + n] || 0];
  });
  Object.keys(ev).forEach(function (k) {             // 剧本里找不到的名字（改过名）也列出来
    if (k.indexOf('选人·') === 0 && !picks.some(function (p) { return '选人·' + p[0] === k; })) picks.push([k.slice(3), ev[k]]);
  });
  picks.sort(function (a, b) { return b[1] - a[1]; });
  const tot = picks.reduce(function (a, p) { return a + p[1]; }, 0);
  const max = Math.max(1, ...picks.map(function (p) { return p[1]; }));
  picks.forEach(function (p) { barRow(box, p[0], p[1], max, '', pct(p[1], tot)); });
  if (!picks.length) box.appendChild(h('p', 'empty', '还没有数据'));
  secPick.appendChild(box);
}

function drawMisc(ev, stats) {
  clear(secMisc);
  secMisc.appendChild(h('h2', '', '其它'));
  const t = h('table', 'tbl');
  const add = function (k, v) {
    const tr = h('tr');
    tr.appendChild(h('td', '', k));
    tr.appendChild(h('td', '', v));
    t.appendChild(tr);
  };
  const ends = Object.keys(ev).reduce(function (a, k) { return a + (k.indexOf('结局·') === 0 ? ev[k] : 0); }, 0);
  const got = Object.keys(ev).filter(function (k) { return k.indexOf('结局·') === 0 && story.ends[k.slice(3)]; }).length;
  add('读档（回到过去重来）', ev['读档'] || 0);
  add('生成分享海报', ev['海报'] || 0);
  add('每人平均打开', stats.visitors ? (stats.visits / stats.visitors).toFixed(1) + ' 次' : '—');
  add('每次「进入」平均打出结局', ev['开始'] ? (ends / ev['开始']).toFixed(1) + ' 个' : '—');
  add('平均停留', stats.visits ? Math.round(stats.totaltime / stats.visits / 60 * 10) / 10 + ' 分钟' : '—');
  add('玩家打出过的结局种类', got + ' / ' + (story.total || '?'));
  secMisc.appendChild(t);
}

function drawEnds(ev) {
  clear(secEnds);
  const hd = h('h2', '', '结局排行');
  const hit = Object.keys(ev).filter(function (k) { return k.indexOf('结局·') === 0; });
  hd.appendChild(h('small', '', '玩家打出过 ' + hit.filter(function (k) { return story.ends[k.slice(3)]; }).length + ' / ' + (story.total || '?') + ' 种'));
  secEnds.appendChild(hd);
  const kinds = h('div', 'kinds');
  Object.keys(KINDS).forEach(function (k) {
    const s = h('span');
    s.appendChild(h('i', 'fill k-' + k));
    s.appendChild(document.createTextNode(KINDS[k]));
    kinds.appendChild(s);
  });
  secEnds.appendChild(kinds);
  const max = Math.max(1, ...hit.map(function (k) { return ev[k]; }));
  const groups = story.lines.concat(['?']);
  groups.forEach(function (ln) {
    const titles = Object.keys(story.ends).filter(function (t) { return story.ends[t].line === ln; });
    const extra = ln === '?' ? hit.map(function (k) { return k.slice(3); }).filter(function (t) { return !story.ends[t]; }) : [];
    const all = titles.concat(extra);
    if (!all.length) return;
    const got = all.filter(function (t) { return ev['结局·' + t]; });
    const name = ln === '?' ? '剧本里已没有的结局' : (ln === 'common' ? '撸城（共通）' : story.lineName[ln]);
    secEnds.appendChild(h('div', 'gh', name + ' · 打出 ' + got.length + ' / ' + all.length + ' 种'));
    const box = h('div', 'hbar');
    got.sort(function (a, b) { return ev['结局·' + b] - ev['结局·' + a]; }).forEach(function (t) {
      const e = story.ends[t];
      barRow(box, t, ev['结局·' + t], max, 'k-' + (e ? e.kind : 'misc'), e ? KINDS[e.kind] : '');
    });
    secEnds.appendChild(box);
    const miss = all.filter(function (t) { return !ev['结局·' + t]; });
    if (miss.length) {
      const chips = h('div', 'chips');
      miss.forEach(function (t) { chips.appendChild(h('span', 'chip', t)); });
      secEnds.appendChild(chips);
    }
  });
}

function drawWho(ref, country, device, browser, os) {
  clear(secWho);
  secWho.appendChild(h('h2', '', '从哪来 · 用什么玩'));
  const grid = h('div', 'cols2');
  const block = function (title, list, rename) {
    const b = h('div');
    b.appendChild(h('div', 'gh', title));
    const max = Math.max(1, ...list.map(function (x) { return x[1]; }));
    const box = h('div', 'hbar');
    list.slice(0, 8).forEach(function (x) { barRow(box, rename ? rename(x[0]) : x[0], x[1], max, 'k-misc', ''); });
    if (!list.length) box.appendChild(h('p', 'empty', '还没有数据'));
    b.appendChild(box);
    grid.appendChild(b);
  };
  block('来源网站', ref, function (x) { return x.replace(/^https?:\/\//, '').replace(/\/$/, ''); });
  block('地区', country, function (x) {
    try { return regionName && /^[A-Z]{2}$/.test(x) ? regionName.of(x) : x; } catch (e) { return x; }
  });
  block('设备', device, function (x) { return DEVICES[x] || x; });
  block('浏览器', browser, function (x) { return BROWSERS[x] || x; });
  block('系统', os, null);
  secWho.appendChild(grid);
}

function drawNoShare() {
  [secKpi, secTrend, secFunnel, secPick, secMisc, secEnds, secWho].forEach(clear);
  secFunnel.appendChild(h('h2', '', '游玩统计'));
  secFunnel.appendChild(h('p', '', '这台设备还没记住统计的分享码。'));
  secFunnel.appendChild(h('p', 'note', '用法：在这个网址后面加上 # 和 Umami 分享链接最后那段（例如 …/dash/#abc123），打开一次就会记住。# 后面的内容不会发给任何服务器。'));
  upd.textContent = '';
}

async function refresh() {
  if (!um.slug) { drawNoShare(); return; }
  if (busy) return;
  busy = true;
  upd.textContent = '更新中…';
  um.err = '';
  try {
    if (!um.token && !(await umLogin())) throw new Error(um.err);
    drawStatus();
    const now = Date.now();
    const t0 = range.start(now);
    const q = { startAt: t0, endAt: now };
    const res = await Promise.allSettled([
      umGet('/stats', q),
      umGet('/pageviews', Object.assign({ unit: range.unit, timezone: TZ }, q)),
      umGet('/metrics', Object.assign({ type: 'event', limit: 500 }, q)),
      umGet('/active', {}),
      umGet('/metrics', Object.assign({ type: 'referrer', limit: 10 }, q)),
      umGet('/metrics', Object.assign({ type: 'country', limit: 10 }, q)),
      umGet('/metrics', Object.assign({ type: 'device', limit: 10 }, q)),
      umGet('/metrics', Object.assign({ type: 'browser', limit: 6 }, q)),
      umGet('/metrics', Object.assign({ type: 'os', limit: 6 }, q)),
    ]);
    if (res[0].status !== 'fulfilled') throw res[0].reason;
    const s = res[0].value || {};
    const c = s.comparison || {};
    const stats = { visitors: num(s.visitors), visits: num(s.visits), pageviews: num(s.pageviews), totaltime: num(s.totaltime) };
    const prev = s.comparison ? { visitors: num(c.visitors), visits: num(c.visits), pageviews: num(c.pageviews) } : null;
    const ev = {};
    rows(res[2]).forEach(function (r) { ev[r[0]] = (ev[r[0]] || 0) + r[1]; });
    const act = res[3].status === 'fulfilled' ? res[3].value : null;
    const active = act ? num(act.visitors != null ? act.visitors : act.x) : null;

    clear(secKpi);
    const vs = range.id === 'today' ? '比昨天' : '比上一段';
    kpi('正在玩（5 分钟内）', active == null ? '—' : active, null, 'live');
    kpi(range.name + '玩家', stats.visitors, range.id === 'all' ? null : delta(stats.visitors, prev && prev.visitors, vs));
    kpi('打开次数', stats.visits, range.id === 'all' ? null : delta(stats.visits, prev && prev.visits, vs));
    kpi('点「进入」', ev['开始'] || 0, null);
    kpi('打出结局', Object.keys(ev).reduce(function (a, k) { return a + (k.indexOf('结局·') === 0 ? ev[k] : 0); }, 0), null);
    drawTrend(res[1].status === 'fulfilled' ? res[1].value : null, t0, now);
    drawFunnel(stats.visits, ev);
    drawPick(ev);
    drawMisc(ev, stats);
    drawEnds(ev);
    drawWho(rows(res[4]), rows(res[5]), rows(res[6]), rows(res[7]), rows(res[8]));
    lastOk = Date.now();
    um.err = '';
    upd.textContent = '更新于 ' + fmtClock.format(lastOk) + ' · 每分钟自动刷新';
  } catch (e) {
    um.err = um.err || ('读取失败：' + (e && e.message === 'auth' ? '令牌过期，下次自动重连' : (e && e.message) || e));
    upd.textContent = (lastOk ? '上次更新 ' + fmtClock.format(lastOk) + ' · ' : '') + um.err;
    upd.classList.add('warn');
  } finally {
    busy = false;
    if (!um.err) upd.classList.remove('warn');
    drawStatus();
  }
}

// ---------- 启动 ----------
um.slug = readShare();
drawTabs();
drawStatus();
checkGame(false).then(function () { refresh(); });
setInterval(function () {
  if (document.hidden) return;
  refresh();
  checkGame(false);
}, REFRESH_MS);
window.addEventListener('hashchange', function () { location.reload(); });
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && Date.now() - lastOk > REFRESH_MS) { refresh(); checkGame(false); }
});
