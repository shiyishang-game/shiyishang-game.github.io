// 启动、屏幕切换、渲染。剧情文本一律用 textContent，不用 innerHTML。
import { Engine } from './engine.js';
import * as store from './store.js';
import * as audio from './audio.js';
import { attachDrag, attachKeys } from './swipe.js';
import { makePoster } from './poster.js';

const KIND_NAME = { death: '作死结局', prologue: '序章结局', if: 'IF · 平行番外', hidden: '隐藏结局' };
const FLY_MS = 220;
const LOCKED_TOAST = '完整版解锁 · S16 决赛后上线';
/** 关于本作：原样展示，不要改字。 */
const ABOUT_LINES = [
  'AI生成视频，非真实事件，台词和动作基于短剧模仿设计，并非针对选手，各位选手仅作为演员出场，请勿上纲上线。',
  '本作为 B 站 UP 主 九夜听风《三年之期已到，恭迎世一上归位！》的同人互动游戏，经原作者授权使用剧集画面与原声。',
  '同人 · 非官方 · 非商业。与 Riot Games、腾讯及各战队无关。',
  '代码 MIT；剧本文字 CC BY-NC-SA 4.0；剧集画面与原声版权归原作者，不在开源许可范围内。',
];
const FRAME_ASPECT = { min: 1.4, max: 2.4 };   // 宽帧/结局图的盒子比例跟随原图，但夹在这个范围内
let DEBUG = false;   // ?debug=1：占位图上显示素材 key（只给作者用）

// ---------- 小工具 ----------
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
/**
 * 防“孤字行”：每段最后 4 个字放进一个不换行的 span，换行时它们一起走，最后一行至少 4 个字。
 * 仍然只用 DOM 节点 + textContent 写入，不碰 innerHTML；el.textContent 与原文完全一致。
 */
function fillText(el, text) {
  String(text == null ? '' : text).split('\n').forEach(function (p, i) {
    if (i > 0) el.appendChild(document.createTextNode('\n'));
    const a = Array.from(p);
    if (a.length < 8) { el.appendChild(document.createTextNode(p)); return; }
    el.appendChild(document.createTextNode(a.slice(0, -4).join('')));
    el.appendChild(h('span', 'nw', a.slice(-4).join('')));
  });
  return el;
}
function button(cls, text, fn) {
  const b = h('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
function hue(key) {
  let x = 7;
  for (let i = 0; i < key.length; i++) x = (x * 31 + key.charCodeAt(i)) % 360;
  return x;
}
/** 占位渐变：色相限制在品牌的紫—品红—蓝一带，同一个 key 永远同一个色。 */
function grad(key) {
  const a = 235 + (hue(key || '?') % 110);
  return 'linear-gradient(135deg, hsl(' + a + ',38%,24%), hsl(' + ((a + 38) % 360) + ',44%,11%))';
}
/**
 * 带占位的图片盒。文件缺失（或没写图）时显示渐变加一行小字“素材制作中”；
 * 原始 key 只在 ?debug=1 时给作者看，玩家永远看不到。
 * opts.quiet：占位时不写字（标题主视觉、小卡片用）；
 * opts.aspect：{min, max}，图加载后让盒子的宽高比跟随图片原比例（夹在 min..max 之间）。
 */
function imgBox(key, cls, opts) {
  opts = opts || {};
  const box = h('div', 'imgbox' + (cls ? ' ' + cls : ''));
  box.style.background = grad(key);
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  let fill = null;
  if (opts.aspect) {            // 垫在主图下面；只有比例被夹住（图太方/太竖）时才真正加载并显示
    fill = document.createElement('img');
    fill.className = 'bgfill';
    fill.alt = '';
    fill.draggable = false;
    box.appendChild(fill);
  }
  box.appendChild(img);
  const ph = h('div', 'ph');
  if (!opts.quiet) ph.appendChild(h('span', 'pht', '素材制作中'));
  if (DEBUG) ph.appendChild(h('span', 'phk', key || '(无图)'));
  box.appendChild(ph);
  if (!key) {
    box.classList.add('missing');
    return box;
  }
  const fit = function () {
    if (!opts.aspect || !img.naturalWidth || !img.naturalHeight) return;
    const raw = img.naturalWidth / img.naturalHeight;
    const r = Math.max(opts.aspect.min, Math.min(opts.aspect.max, raw));
    box.style.aspectRatio = r.toFixed(4) + ' / 1';
    box.style.background = '#000';
    const padded = Math.abs(raw - r) > 0.02;      // 被夹住：图完整显示，露出的边用模糊放大的同图填，不留死黑边
    box.classList.toggle('padded', padded);
    if (padded && fill && !fill.getAttribute('src')) fill.src = img.currentSrc || img.src;
  };
  img.addEventListener('load', fit);
  img.addEventListener('error', function () { box.classList.add('missing'); });
  img.src = 'assets/img/' + key + '.webp';
  if (img.complete && img.naturalWidth) fit();   // 命中缓存时同步拿到尺寸，避免版面跳一下
  return box;
}

// ---------- 全局状态 ----------
const ui = {
  story: null, engine: null, rec: false,
  screen: 'title', modal: false, busy: false,
  cardEl: null, stampEl: null, meterEls: {}, previews: {},
  kbN: null, savedStatus: 'none', savedRun: null,
  menuBackup: null,   // 从菜单“返回选人”时暂存的本局，选人页点“返回游戏”可恢复
};
const els = {};

function boot() {
  let framed = false;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (framed) {
    try { window.top.location.replace(window.self.location.href); } catch (e) { /* 静默 */ }
    return;
  }

  // URL 参数白名单：rec=1、reset=1、debug=1，其余忽略
  let params = null;
  try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
  ui.rec = !!params && params.get('rec') === '1';
  DEBUG = !!params && params.get('debug') === '1';
  const reset = !!params && params.get('reset') === '1';
  if (reset) {
    let ok = false;
    try { ok = window.confirm('清除本地存档（进度和结局图鉴）？'); } catch (e) { ok = false; }
    if (ok) store.clearAll();
  }
  try {
    const keep = [];
    if (ui.rec) keep.push('rec=1');
    if (DEBUG) keep.push('debug=1');
    window.history.replaceState(null, '', window.location.pathname + (keep.length ? '?' + keep.join('&') : ''));
  } catch (e) { /* ignore */ }

  if (ui.rec) document.body.classList.add('rec');
  buildDom();
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);

  audio.init(store.loadSettings().muted);
  updateMuteBtn();

  fetch('data/story.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(start)
    .catch(function () {
      showFatal('剧情加载失败，请刷新重试。');
    });
}

function showFatal(msg) {
  clear(els.stage);
  els.stage.appendChild(h('div', 'noscript', msg));
}

function layout() {
  const root = document.documentElement;
  root.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
  if (ui.rec) {
    const s = Math.min(window.innerWidth / 405, window.innerHeight / 720);
    root.style.setProperty('--s', String(s));
  }
  if (els.stage) els.stage.style.setProperty('--cw', Math.max(200, els.stage.clientWidth - 32) + 'px');
}

// ---------- DOM 骨架 ----------
function buildDom() {
  const app = document.getElementById('app');
  clear(app);
  const stage = h('div', 'stage');
  els.stage = stage;
  els.bg = h('img', 'bg hide');
  els.bg.alt = '';
  els.bg.addEventListener('error', function () { els.bg.classList.add('hide'); });
  stage.appendChild(els.bg);

  // 游戏屏（一直存在，其他屏盖在上面）
  const game = h('div', 'screen game on');
  els.game = game;
  const top = h('div', 'topbar');
  els.topbar = top;
  els.meters = h('div', 'meters');
  top.appendChild(els.meters);
  els.muteBtn = button('iconbtn mute-btn', '', onMute);
  els.menuBtn = button('iconbtn menu-btn', '☰', openMenu);
  top.appendChild(els.muteBtn);
  top.appendChild(els.menuBtn);
  game.appendChild(top);

  els.cardwrap = h('div', 'cardwrap');
  els.cardwrap.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  game.appendChild(els.cardwrap);

  els.optbar = h('div', 'optbar');
  game.appendChild(els.optbar);
  els.bottombar = h('div', 'bottombar');
  game.appendChild(els.bottombar);
  stage.appendChild(game);

  ['title', 'cine', 'select', 'news', 'end'].forEach(function (name) {
    els[name] = h('div', 'screen ' + name);
    stage.appendChild(els[name]);
  });
  els.modal = h('div', 'modal');
  els.modal.addEventListener('click', function (e) { if (e.target === els.modal) closeModal(); });
  stage.appendChild(els.modal);
  els.toasts = h('div', 'toasts');
  stage.appendChild(els.toasts);
  app.appendChild(stage);

  attachDrag(els.cardwrap, {
    enabled: function () { return ui.screen === 'game' && !ui.busy && !ui.modal && !!ui.cardEl; },
    getWidth: function () { return ui.cardEl ? ui.cardEl.offsetWidth : 300; },
    onStart: onDragStart,
    onMove: onDragMove,
    onEnd: onDragEnd,
  });
  attachKeys(onKey, function () { return !ui.modal; });
}

function setScreen(name) {
  ui.screen = name || 'game';
  els.stage.classList.toggle('s-select', name === 'select');
  els.game.classList.toggle('on', !name);
  ['title', 'cine', 'select', 'news', 'end'].forEach(function (n) {
    els[n].classList.toggle('on', n === name);
  });
  ui.kbN = null;
}

function setBg(key) {
  if (!key) { els.bg.classList.add('hide'); return; }
  els.bg.classList.remove('hide');
  els.bg.src = 'assets/img/' + key + '.webp';
}

function toast(text) {
  const t = h('div', 'toast', text);
  els.toasts.appendChild(t);
  void t.offsetWidth; // 强制回流后再加 show，触发过渡
  t.classList.add('show');
  setTimeout(function () { t.classList.remove('show'); }, 1800);
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2150);
}

// ---------- 启动流程 ----------
function start(story) {
  ui.story = story;
  const gallery = store.loadGallery();
  ui.engine = new Engine(story, { gallery });

  const last = store.getVer();
  if (last && last !== story.version) toast('新篇章上线');
  store.setVer(story.version);

  const run = store.loadRun();
  ui.savedRun = run;
  ui.savedStatus = ui.engine.loadRun(run);
  showTitle();
}

function save() {
  const e = ui.engine;
  // 从菜单“返回选人”期间，存档里仍是原来那一局（点“返回游戏”能接着玩，关页面也不丢）
  const run = ui.menuBackup || e.exportRun();
  if (run) store.saveRun(run);
  store.saveGallery(e.gallery);
}

function flushEvents() {
  ui.engine.drainEvents().forEach(function (ev) {
    if (ev.type === 'toast') toast(ev.text);
  });
}

// ---------- 标题页 ----------
function showTitle() {
  setScreen('title');
  setBg('');
  const t = els.title;
  clear(t);
  t.appendChild(imgBox('ui/title', 'art', { quiet: true }));
  t.appendChild(h('div', 'artshade'));
  t.appendChild(h('h1', 'gname', '撸城：谁是世一上'));
  t.appendChild(h('div', 'gsub', '《三年之期已到，恭迎世一上归位！》同人互动游戏'));
  t.appendChild(button('btn primary', '点击进入', function () {
    audio.unlock();
    startNew();
  }));
  if (ui.savedStatus === 'ok' || ui.savedStatus === 'outdated') {
    t.appendChild(button('btn', '继续', function () {
      audio.unlock();
      continueRun();
    }));
  }
  const gv = ui.engine.galleryView();
  t.appendChild(button('btn', '结局图鉴 ' + gv.got + '/' + gv.total, function () { audio.unlock(); openGallery(); }));
  t.appendChild(h('div', 'foot', 'AI 生成内容 · 同人非商业 · 经九夜听风授权'));
  t.appendChild(button('about-link', '关于本作', openAbout));
}

function startNew() {
  const res = ui.engine.startLine('common');
  enterGame();
  render(res);
}

function continueRun() {
  const e = ui.engine;
  if (ui.savedStatus === 'ok') {
    enterGame();
    render(e.current());
    return;
  }
  // outdated：剧情已更新，从本线开头开始
  toast('剧情已更新，从本线开头开始');
  const line = ui.savedRun && ui.story.lines[ui.savedRun.line] ? ui.savedRun.line : 'common';
  const res = e.startLine(line);
  enterGame();
  render(res);
}

function enterGame() {
  ui.menuBackup = null;
  setScreen(null);
  buildMeters();
  closeModal();
}

// ---------- 渲染入口 ----------
function render(res) {
  if (!res) return;
  save();
  flushEvents();
  updateMeters();
  updateProps();
  if (res.kind === 'end') {
    showEnd(res.end, res.card);
  } else if (res.kind === 'screen') {
    handleScreen(res.card);
  } else {
    if (ui.screen !== 'game') setScreen(null);
    showCard(res.card);
  }
  preloadAround(res.card);
}

function go(sel) {
  let res;
  try {
    res = ui.engine.choose(sel);
  } catch (err) {
    toast('出错了，请重开本线');
    return;
  }
  render(res);
}

function handleScreen(card) {
  if (card.sfx) audio.play(card.sfx);
  if (card.screen === 'cinematic') runCinematic(card);
  else if (card.screen === 'select') showSelect();
  else if (card.screen === 'news') showNews();
  else go('N');
}

// ---------- 数值与道具 ----------
function buildMeters() {
  clear(els.meters);
  ui.meterEls = {};
  const ln = ui.engine.line();
  const names = ln ? ln.meters : [];
  // 序章（common）里没有任何数值变化：不显示数值栏和道具栏，免得一排不动的 50%
  const prelude = !!ui.engine.s && ui.engine.s.line === 'common';
  els.game.classList.toggle('prelude', prelude);
  els.topbar.classList.toggle('nometers', names.length === 0 || prelude);
  names.forEach(function (n) {
    const m = h('div', 'meter');
    const dot = h('div', 'mdot');
    const box = h('div', 'mbox');
    const fill = h('div', 'mfill');
    box.appendChild(fill);
    box.appendChild(h('div', 'mglyph', n.charAt(0)));
    m.appendChild(dot);
    m.appendChild(box);
    m.appendChild(h('div', 'mname', n));
    els.meters.appendChild(m);
    ui.meterEls[n] = { dot: dot, fill: fill };
  });
}

function updateMeters() {
  const s = ui.engine.s;
  if (!s) return;
  for (const n in ui.meterEls) {
    const v = s.m[n];
    ui.meterEls[n].fill.style.height = (v === undefined ? 0 : v) + '%';
  }
}

function showDots(preview) {
  for (const n in ui.meterEls) {
    const d = preview ? Math.abs(preview[n] || 0) : 0;
    ui.meterEls[n].dot.className = 'mdot' + (d === 0 ? '' : d <= 10 ? ' d1' : d <= 25 ? ' d2' : ' d3');
  }
}

function updateProps() {
  const s = ui.engine.s;
  clear(els.bottombar);
  for (let i = 0; i < 3; i++) {
    const name = s ? s.props[i] : null;
    const slot = h('button', 'slot' + (name ? ' has' : ''));
    slot.type = 'button';
    if (name) {
      slot.appendChild(h('span', 'sicon', name.charAt(0)));
      slot.appendChild(h('span', 'sname', name));
      slot.addEventListener('click', function () { openPropInfo(name); });
    } else {
      slot.textContent = '空';
    }
    els.bottombar.appendChild(slot);
  }
}

function openPropInfo(name) {
  const sheet = h('div', 'sheet');
  sheet.appendChild(h('h3', '', '【' + name + '】'));
  sheet.appendChild(h('p', 'pdesc', (ui.story.props && ui.story.props[name]) || '暂无说明。'));
  sheet.appendChild(button('btn close', '好', closeModal));
  openModal(sheet);
}

// ---------- 卡片 ----------
function showCard(card) {
  clear(els.cardwrap);
  ui.busy = false;
  setBg(card.mode === 'text' ? '' : card.img);
  const el = h('div', 'card ' + card.mode + ' enter');
  el.style.background = grad(card.img || card.id);
  if (card.mode === 'text') {
    el.style.background = '#000';
    const wrap = h('div', 'card-text');
    if (card.who) wrap.appendChild(h('span', 'who', card.who));
    fillText(wrap, card.say);
    el.appendChild(wrap);
  } else if (card.mode === 'full') {
    el.appendChild(imgBox(card.img, 'card-full'));
    el.appendChild(h('div', 'shade'));
    el.appendChild(buildCaption(card));
  } else {
    if (card.img) {
      const bg = document.createElement('img');
      bg.className = 'card-bg';
      bg.alt = '';
      bg.addEventListener('error', function () { bg.style.display = 'none'; });
      bg.src = 'assets/img/' + card.img + '.webp';
      el.appendChild(bg);
    }
    el.appendChild(h('div'));
    const frame = imgBox(card.img, 'frame', { aspect: FRAME_ASPECT });
    if (card.tag) frame.appendChild(h('div', 'tag', card.tag));   // 名牌贴在原帧的左下角
    el.appendChild(frame);
    el.appendChild(buildCaption(card));
  }
  const stamp = h('div', 'stamp L');
  el.appendChild(stamp);
  els.cardwrap.appendChild(el);
  el.addEventListener('animationend', function () { el.classList.remove('enter'); });
  ui.cardEl = el;
  ui.stampEl = stamp;
  showDots(null);

  // 预览缓存 + 选项区
  const opts = ui.engine.options();
  ui.previews = {};
  opts.forEach(function (o) { ui.previews[o.sel] = ui.engine.preview(o.sel); });
  buildOptions(opts);
  if (card.sfx) audio.play(card.sfx);
}

function buildCaption(card) {
  const cap = h('div', 'caption');
  if (card.who) cap.appendChild(h('div', 'who', card.who));
  if (card.say) cap.appendChild(fillText(h('div', 'say'), card.say));
  return cap;
}

function buildOptions(opts) {
  clear(els.optbar);
  opts.filter(function (o) { return o.side === 'P'; }).forEach(function (o) {
    els.optbar.appendChild(button('propbtn', '使用【' + o.prop + '】：' + o.label, function () { commit(o.sel, 0); }));
  });
  const pills = h('div', 'pills');
  const n = opts.filter(function (o) { return o.side === 'N'; })[0];
  if (n) {
    pills.appendChild(button('pill continue', '左右滑动继续', function () { commit('N', 1); }));
  } else {
    const l = opts.filter(function (o) { return o.side === 'L'; })[0];
    const r = opts.filter(function (o) { return o.side === 'R'; })[0];
    if (l) pills.appendChild(button('pill', '← ' + l.label, function () { commit('L', -1); }));
    if (r) pills.appendChild(button('pill', r.label + ' →', function () { commit('R', 1); }));
  }
  els.optbar.appendChild(pills);
}

// ---------- 拖拽 ----------
function selForSide(side) {
  const opts = ui.engine.options();
  if (opts.length === 1 && opts[0].side === 'N') return 'N';
  const o = opts.filter(function (x) { return x.side === side; })[0];
  return o ? o.sel : null;
}

function onDragStart() {
  if (ui.cardEl) {
    ui.cardEl.classList.remove('enter', 'back');
    ui.cardEl.classList.add('dragging');
  }
}

function onDragMove(dx) {
  const el = ui.cardEl;
  if (!el) return;
  const w = el.offsetWidth || 300;
  const rot = Math.max(-12, Math.min(12, (dx / w) * 24));
  el.style.transform = 'translateX(' + dx + 'px) rotate(' + rot + 'deg)';
  const side = dx < 0 ? 'L' : 'R';
  const sel = selForSide(side);
  const st = ui.stampEl;
  if (!sel) { st.style.opacity = '0'; showDots(null); return; }
  const o = ui.engine.options().filter(function (x) { return x.sel === sel; })[0];
  st.className = 'stamp ' + side;
  st.textContent = o ? o.label : '';
  st.style.opacity = String(Math.min(1, Math.abs(dx) / (w * 0.28)));
  showDots(Math.abs(dx) > 10 ? ui.previews[sel] : null);
}

function onDragEnd(dx, side) {
  const el = ui.cardEl;
  if (!el) return;
  const sel = side ? selForSide(side) : null;
  if (sel) {
    commit(sel, dx < 0 ? -1 : 1);
    return;
  }
  el.classList.remove('dragging');
  el.classList.add('back');
  el.style.transform = '';
  ui.stampEl.style.opacity = '0';
  showDots(null);
}

/** 提交选项：卡片飞出后再进入下一张。dir：-1 向左飞，1 向右，0 向上（道具）。 */
function commit(sel, dir) {
  if (ui.busy || ui.modal || ui.screen !== 'game' || !ui.cardEl) return;
  ui.busy = true;
  const el = ui.cardEl;
  const w = els.stage.clientWidth;
  el.classList.remove('dragging', 'enter', 'back');
  el.style.transition = 'transform ' + FLY_MS + 'ms ease-in, opacity ' + FLY_MS + 'ms ease-in';
  if (dir === 0) el.style.transform = 'translateY(-' + (w * 0.6) + 'px) scale(0.9)';
  else el.style.transform = 'translateX(' + (dir * w * 1.2) + 'px) rotate(' + (dir * 16) + 'deg)';
  el.style.opacity = '0';
  showDots(null);
  setTimeout(function () {
    ui.busy = false;
    go(sel);
  }, FLY_MS);
}

function onKey(sel) {
  if (ui.screen !== 'game') {
    if (sel === 'N' && ui.kbN) ui.kbN();
    return;
  }
  if (ui.busy || !ui.cardEl) return;
  const opts = ui.engine.options();
  if (!opts.length) return;
  if (opts.length === 1 && opts[0].side === 'N') {
    if (sel === 'N' || sel === 'L' || sel === 'R') commit('N', sel === 'L' ? -1 : 1);
    return;
  }
  if (sel === 'P') {
    const p = opts.filter(function (x) { return x.side === 'P'; })[0];
    if (p) commit(p.sel, 0);
    return;
  }
  if (sel === 'L' || sel === 'R') {
    const o = opts.filter(function (x) { return x.side === sel; })[0];
    if (o) commit(o.sel, sel === 'L' ? -1 : 1);
  }
}

// ---------- 开场动画 ----------
function runCinematic(card) {
  setScreen('cine');
  setBg('');
  const root = els.cine;
  clear(root);
  const frames = card.frames || [];
  const cap = h('div', 'cine-cap');
  root.appendChild(h('div', 'cine-vig'));
  root.appendChild(cap);
  let idx = 0;
  let timer = null;
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    go('N');
  }
  root.appendChild(button('skip', '跳过', finish));
  ui.kbN = finish;
  function step() {
    if (done) return;
    if (idx >= frames.length) { finish(); return; }
    const f = frames[idx];
    const layer = h('div', 'cine-layer' + (idx % 2 ? ' alt' : ''));
    layer.appendChild(imgBox(f.img));
    root.appendChild(layer);
    cap.textContent = f.cap;
    const all = root.querySelectorAll('.cine-layer');
    for (let i = 0; i < all.length - 1; i++) {
      (function (node) { setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 500); })(all[i]);
    }
    idx++;
    timer = setTimeout(step, 2500);
  }
  step();
}

// ---------- 选人页 ----------
/** 回到选人入口：经 common.hchk（四线序章结局都通关后会被引向隐藏结局，否则落到选人页）。 */
function goHub() {
  const res = ui.engine.toHub();
  enterGame();
  render(res);
}

/** 菜单里的“返回选人”：同样走 common.hchk，但把当前这一局暂存起来，选人页能“返回游戏”。 */
function menuToHub() {
  closeModal();
  const e = ui.engine;
  const backup = e.s ? JSON.parse(JSON.stringify(e.s)) : null;
  const res = e.toHub();
  enterGame();
  // 落在选人页才保留原来那一局；被引去隐藏结局的话，原来那一局不再保留
  if (res.kind === 'screen' && res.screen === 'select') ui.menuBackup = backup;
  render(res);
}

function backToGame() {
  const bk = ui.menuBackup;
  const e = ui.engine;
  if (bk && e.loadRun(bk) === 'ok') {
    enterGame();
    render(e.current());
  } else if (bk && ui.story.lines[bk.line]) {
    toast('剧情已更新，从本线开头开始');
    const res = e.startLine(bk.line);
    enterGame();
    render(res);
  }
}

function showSelect() {
  setScreen('select');
  setBg('');
  const root = els.select;
  clear(root);
  root.scrollTop = 0;
  root.appendChild(h('h2', '', '选择你的世一上'));

  const order = ui.story.order;
  const open = order.filter(function (id) { return !ui.story.lines[id].locked; });
  const shut = order.filter(function (id) { return ui.story.lines[id].locked; });

  // 可玩的 4 位：2×2 大卡
  const grid = h('div', 'grid');
  const detail = h('div', 'detail');
  const tiles = {};
  let selected = null;
  function renderDetail() {
    clear(detail);
    detail.classList.toggle('empty', !selected);
    if (!selected) {
      detail.appendChild(h('div', 'dhint', '点一张卡看详情，再点“成为他”'));
      return;
    }
    const ln = ui.story.lines[selected];
    const info = h('div', 'dinfo');
    info.appendChild(h('div', 'dname', ln.name + (ln.team ? ' · ' + ln.team : '')));
    info.appendChild(h('div', 'dmotto', '“' + ln.motto + '”'));
    const chips = h('div', 'chips');
    ln.meters.forEach(function (m) { chips.appendChild(h('span', 'chip', m)); });
    info.appendChild(chips);
    detail.appendChild(info);
    const id = selected;
    detail.appendChild(button('btn primary dgo', '成为他', function () { becomeHim(id); }));
  }
  open.forEach(function (id) {
    const ln = ui.story.lines[id];
    const tile = h('button', 'tile');
    tile.type = 'button';
    tile.appendChild(imgBox(ln.portrait));
    tile.appendChild(h('div', 'tshade'));
    const info = h('div', 'tinfo');
    info.appendChild(h('div', 'tname', ln.name));
    info.appendChild(h('div', 'tteam', ln.team));
    info.appendChild(fillText(h('div', 'tmotto'), ln.motto));
    tile.appendChild(info);
    tile.addEventListener('click', function () {
      selected = id;
      for (const k in tiles) tiles[k].classList.toggle('sel', k === id);
      renderDetail();
    });
    tiles[id] = tile;
    grid.appendChild(tile);
  });
  root.appendChild(grid);
  root.appendChild(detail);
  renderDetail();

  // 完整版才解锁的人物：灰色小卡，横向滑动，点一下只弹提示
  if (shut.length) {
    root.appendChild(h('div', 'lockhead', '完整版解锁'));
    const row = h('div', 'lockrow');
    shut.forEach(function (id) {
      const ln = ui.story.lines[id];
      const t = h('button', 'ltile');
      t.type = 'button';
      t.appendChild(imgBox(ln.portrait, null, { quiet: true }));
      t.appendChild(h('div', 'tshade'));
      const info = h('div', 'linfo');
      info.appendChild(h('div', 'lname', ln.name));
      info.appendChild(h('div', 'lteam', ln.team));
      info.appendChild(h('div', 'lmotto', ln.motto));
      t.appendChild(info);
      t.addEventListener('click', function () { toast(LOCKED_TOAST); });
      row.appendChild(t);
    });
    // 电脑上滚轮纵向滚动也能带动这一排横向滑
    row.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const before = row.scrollLeft;
      row.scrollLeft += e.deltaY;
      if (row.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    root.appendChild(row);
  }

  if (ui.menuBackup) {
    const back = button('btn backbtn', '返回游戏', backToGame);
    root.appendChild(back);
  }
}

function becomeHim(id) {
  const res = ui.engine.startLine(id);
  enterGame();
  render(res);
}

// ---------- 江湖快报 ----------
function showNews() {
  fetch('data/world.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (w) {
      const items = (w && Array.isArray(w.items) ? w.items : [])
        .filter(function (it) { return it && typeof it.text === 'string'; })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
        .slice(0, 3);
      if (!items.length) { go('N'); return; }
      setScreen('news');
      setBg('');
      const root = els.news;
      clear(root);
      const paper = h('div', 'paper');
      paper.appendChild(h('h2', '', '江湖快报'));
      paper.appendChild(h('div', 'upd', '更新于 ' + String(w.updated || '')));
      items.forEach(function (it) {
        const row = h('div', 'item');
        row.appendChild(h('b', '', String(it.date || '')));
        row.appendChild(document.createTextNode(it.text));
        paper.appendChild(row);
      });
      root.appendChild(paper);
      let moved = false;
      const next = function () { if (moved) return; moved = true; go('N'); };
      root.appendChild(button('btn primary', '继续', next));
      ui.kbN = next;
    })
    .catch(function () { go('N'); });
}

// ---------- 结局屏 ----------
function showEnd(info, card) {
  setScreen('end');
  setBg(card.img);
  const root = els.end;
  clear(root);
  root.scrollTop = 0;
  root.appendChild(imgBox(info.img, 'eimg', { aspect: FRAME_ASPECT }));
  root.appendChild(h('div', 'badge kind-' + info.kind, KIND_NAME[info.kind] || info.kind));
  root.appendChild(h('div', 'etitle', info.title));
  if (info.say) root.appendChild(fillText(h('div', 'esay'), info.say));
  if (info.keys.length) {
    const keys = h('div', 'keys');
    keys.appendChild(h('h4', '', '你的关键选择'));
    info.keys.forEach(function (k) {
      const row = h('div', 'k');
      row.appendChild(h('span', '', k.key));
      row.appendChild(h('span', '', k.label));
      keys.appendChild(row);
    });
    root.appendChild(keys);
  }
  const missed = info.missed();
  if (missed.length) {
    const m = missed[0];
    const row = h('div', 'missed');
    row.appendChild(h('span', '', '你错过了一次相遇：' + m.meet));
    row.appendChild(button('btn', '从那里重来', function () {
      const res = ui.engine.restore(m.histIndex);
      enterGame();
      render(res);
    }));
    root.appendChild(row);
  }
  const btns = h('div', 'ebtns');
  btns.appendChild(button('btn primary', '生成分享海报', function () { openPoster(info); }));
  // 菜是原罪（common）没选过人，只给“重新开始”；隐藏结局之后可以回选人
  if (info.line !== 'common' || info.kind === 'hidden') btns.appendChild(button('btn', '换个世一上', goHub));
  btns.appendChild(button('btn', '结局图鉴', openGallery));
  btns.appendChild(button('btn', info.line === 'common' ? '重新开始' : '重开本线', restartLine));
  root.appendChild(btns);
}

function restartLine() {
  const line = ui.engine.s ? ui.engine.s.line : 'common';
  const res = ui.engine.startLine(line);
  enterGame();
  render(res);
}

// ---------- 浮层 ----------
function openModal(node) {
  clear(els.modal);
  els.modal.appendChild(node);
  els.modal.classList.add('on');
  els.modal.classList.toggle('poster', node.classList.contains('posterbox'));
  ui.modal = true;
}
function closeModal() {
  els.modal.classList.remove('on');
  clear(els.modal);
  ui.modal = false;
}

function openGallery() {
  const gv = ui.engine.galleryView();
  const sheet = h('div', 'sheet');
  sheet.appendChild(h('h3', '', '结局图鉴 ' + gv.got + '/' + gv.total));
  gv.groups.forEach(function (g) {
    sheet.appendChild(h('div', 'gh', g.name));
    const grid = h('div', 'ggrid');
    g.ends.forEach(function (e) {
      const label = e.unlocked ? e.title : (e.secret ? '？？？' : '?');
      const cls = e.unlocked ? 'unlocked k-' + e.kind : 'locked' + (e.secret ? ' secret' : '');
      grid.appendChild(h('div', 'gcell ' + cls, label));
    });
    sheet.appendChild(grid);
  });
  sheet.appendChild(button('btn close', '关闭', closeModal));
  openModal(sheet);
}

function openPoster(info) {
  const box = h('div', 'posterbox');
  box.appendChild(h('div', 'phint', '正在生成海报…'));
  openModal(box);
  makePoster(info).then(function (url) {
    clear(box);
    const img = document.createElement('img');
    img.alt = '分享海报';
    img.src = url;
    box.appendChild(img);
    box.appendChild(h('div', 'phint', '长按图片保存或分享'));
    box.appendChild(button('btn', '关闭', closeModal));
  }).catch(function () {
    clear(box);
    box.appendChild(h('div', 'phint', '海报生成失败'));
    box.appendChild(button('btn', '关闭', closeModal));
  });
}

function openMenu() {
  const sheet = h('div', 'sheet');
  sheet.appendChild(h('h3', '', '菜单'));
  const row = h('div', 'row');
  row.appendChild(button('btn', '结局图鉴', openGallery));
  row.appendChild(button('btn', '重开本线', function () { closeModal(); restartLine(); }));
  row.appendChild(button('btn', '返回选人', menuToHub));
  row.appendChild(button('btn', '关于本作', openAbout));
  sheet.appendChild(row);
  sheet.appendChild(button('btn close', '关闭', closeModal));
  openModal(sheet);
}

/** 关于本作：免责声明和署名，原文展示（textContent），不要改字。 */
function openAbout() {
  const sheet = h('div', 'sheet about');
  sheet.appendChild(h('h3', '', '关于本作'));
  ABOUT_LINES.forEach(function (t) { sheet.appendChild(h('p', 'about-p', t)); });
  sheet.appendChild(button('btn close', '关闭', closeModal));
  openModal(sheet);
}

// ---------- 预加载 ----------
// 进卡后顺手把“一跳之内可能进入的卡”的图片和原声拉下来，滑过去时不用等。
// 标题页不调用，所以没点“进入”之前不会下载任何卡片素材。
const preloaded = new Set();
const holdImgs = [];
const MAX_HOLD = 40;

function saveData() {
  try { return !!(navigator.connection && navigator.connection.saveData); } catch (e) { return false; }
}

function preloadImg(key) {
  if (!key || preloaded.has(key)) return;
  preloaded.add(key);
  const im = new Image();
  im.decoding = 'async';
  try { im.fetchPriority = 'low'; } catch (e) { /* ignore */ }
  im.src = 'assets/img/' + key + '.webp';
  holdImgs.push(im);   // 拿着引用，免得被回收后请求被取消
  if (holdImgs.length > MAX_HOLD) holdImgs.shift();
}

function preloadAround(card) {
  if (!card || saveData()) return;
  let pl;
  try { pl = ui.engine.preloadList(card); } catch (e) { return; }
  pl.imgs.forEach(preloadImg);
  audio.preload(pl.sfx);   // 音频还没解锁（没点过）时 audio 自己会跳过
}

// ---------- 静音 ----------
function updateMuteBtn() {
  els.muteBtn.textContent = audio.isMuted() ? '🔇' : '🔊';
}
function onMute() {
  audio.unlock();
  audio.setMuted(!audio.isMuted());
  store.saveSettings({ muted: audio.isMuted() });
  updateMuteBtn();
  toast(audio.isMuted() ? '已静音' : '已开启声音');
}

boot();
