// node tools/test_engine.mjs  —— 引擎单测，不依赖 DOM。
//   A. 真实剧本 data/story.json：序章流程、换个世一上 / 返回选人的路由（common.hchk）、
//      通关旗标（结局卡 fx）、跨局持久化、图鉴规则、预加载清单、随机游走、missed / restore、存档版本
//   B. 合成小剧本：道具上限、if/else 连跳上限、hist 上限、startAt / toHub 回退、nextIds 的 P 门控等边界
//   C. 老的示例剧本（review/sample_story）：临时编译到系统临时目录再跑；编译不了就跳过，不算失败
//   D. 编译器的数值死亡规则可达性：合成一个小剧本，临时编译，核对 unreachable / WARN / 图鉴总数（需要 python3，没有就跳过）
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, copyFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Engine, majorOf, HUB_CARD } from '../js/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const story = JSON.parse(readFileSync(join(root, 'data', 'story.json'), 'utf8'));
const C = story.cards;

// 带计数的断言：最后同时报告“用例数”和“断言数”
let asserts = 0;
const A = new Proxy(assert, {
  get(target, prop) {
    const f = target[prop];
    return typeof f === 'function' ? (...a) => { asserts++; return f.apply(target, a); } : f;
  },
});
let n = 0;
let skipped = 0;
function t(name, fn) {
  try {
    fn();
    n++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n       ') : e));
    process.exitCode = 1;
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const fresh = () => ({ ends: {}, globals: {} });
const mk = (gallery, st) => new Engine(st || story, { gallery: gallery || fresh(), now: () => 'T0' });
const S = (e) => e.s;
function rng(seed) { return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

// 沿着给定选择序列走；每项是 'L' | 'R' | 'N' | 'P:xxx'
function walk(e, line, seq) {
  let r = e.startLine(line);
  for (const sel of seq) r = e.choose(sel);
  return r;
}

// ---- 路线搜索：按静态图到目标结局的距离“有偏随机”地走，直到命中目标 ----
function succOf(c) {
  const out = [];
  if (c.else) out.push(c.else);
  if (c.L) out.push(c.L.to);
  if (c.R) out.push(c.R.to);
  for (const p of (c.P || [])) out.push(p.to);
  if (c.next) out.push(c.next);
  return out;
}
function distTo(st, target) {
  const rev = {};
  for (const id in st.cards) for (const x of succOf(st.cards[id])) (rev[x] = rev[x] || []).push(id);
  const d = { [target]: 0 };
  const q = [target];
  while (q.length) {
    const x = q.shift();
    for (const p of (rev[x] || [])) if (d[p] === undefined) { d[p] = d[x] + 1; q.push(p); }
  }
  return d;
}
function optTarget(c, sel) {
  if (sel === 'N') return c.next;
  if (sel === 'L' || sel === 'R') return c[sel].to;
  const name = sel.slice(2);
  return c.P.find((p) => p.p === name).to;
}
function findRoute(st, line, target, gallery, seed0) {
  const d = distTo(st, target);
  const rnd = rng(seed0 || 7);
  for (let attempt = 0; attempt < 5000; attempt++) {
    const e = new Engine(st, { gallery: clone(gallery || fresh()), now: () => 'T' });
    let r = e.startLine(line);
    const route = [];
    while (r.kind !== 'end' && route.length < 160) {
      const opts = e.options();
      if (!opts.length) break;
      const c = e.cur;
      let best = null;
      let bestV = Infinity;
      for (const o of opts) {
        const dd = d[optTarget(c, o.sel)];
        const v = (dd === undefined ? 999 : dd) + rnd() * 1.5;
        if (v < bestV) { bestV = v; best = o; }
      }
      const pick = rnd() < 0.12 ? opts[Math.floor(rnd() * opts.length)] : best;
      route.push(pick.sel);
      r = e.choose(pick.sel);
    }
    if (r.kind === 'end' && r.id === target) return route;
  }
  return null;
}
const playable = story.order.filter((l) => !story.lines[l].locked);
const prologueEnd = (line) => Object.values(C).find((c) => c.ln === line && c.end && c.end.kind === 'prologue');

// 随机玩到结局（或步数用完）
function randomRun(e, line, rnd, maxSteps) {
  let r = e.startLine(line);
  let steps = 0;
  while (r.kind !== 'end') {
    const opts = e.options();
    if (!opts.length) break;
    r = e.choose(opts[Math.floor(rnd() * opts.length)].sel);
    if (++steps > (maxSteps || 200)) throw new Error('no end within ' + (maxSteps || 200) + ' steps on ' + line);
  }
  return r;
}

// ======================================================================
console.log('A. 真实剧本');
console.log('== 序章与菜是原罪 ==');
t('common：恭迎卡 -> 带名牌和原声的 wide 卡 -> 江湖快报屏 -> 二选一', () => {
  const e = mk();
  let r = e.startLine('common');
  A.equal(r.id, 'common.001'); A.equal(r.card.mode, 'text');
  A.deepEqual(e.options().map((o) => o.side), ['N']);
  r = e.choose('N'); A.equal(r.id, 'common.002');
  A.equal(r.card.tag, '恭迎世一上归位'); A.ok(r.card.sfx); A.equal(r.card.mode, 'wide');
  r = e.choose('N'); A.equal(r.kind, 'screen'); A.equal(r.screen, 'news');
  r = e.choose('N'); A.equal(r.id, 'common.003');
  A.deepEqual(e.options().map((o) => [o.side, o.label]), [['L', '拜师当小弟'], ['R', '我要成为世一上']]);
});
t('拜师当小弟 -> 菜是原罪（death）并写入图鉴；二次到达不改首次时间', () => {
  const g = fresh();
  let now = 'T1';
  const e = new Engine(story, { gallery: g, now: () => now });
  const go = () => { e.startLine('common'); return ['N', 'N', 'N', 'L'].reduce((_, s) => e.choose(s), null); };
  let r = go();
  A.equal(r.kind, 'end'); A.equal(r.end.kind, 'death'); A.equal(r.end.title, '菜是原罪');
  A.equal(r.end.first, true); A.equal(g.ends['common.end.cai'], 'T1');
  A.deepEqual(e.options(), []);
  now = 'T2';
  r = go();
  A.equal(r.end.first, false); A.equal(g.ends['common.end.cai'], 'T1');
});
t('我要成为世一上 -> 开场动画（3~5 帧）-> 空图鉴时经 common.hchk 落到选人页', () => {
  const e = mk();
  e.startLine('common');
  let r = ['N', 'N', 'N', 'R'].reduce((_, s) => e.choose(s), null);
  A.equal(r.id, 'common.cine'); A.equal(r.kind, 'screen'); A.equal(r.screen, 'cinematic');
  A.ok(r.card.frames.length >= 3 && r.card.frames.length <= 5);
  r.card.frames.forEach((f) => A.ok(f.img && f.cap));
  r = e.choose('N');
  A.equal(r.kind, 'screen'); A.equal(r.screen, 'select'); A.equal(r.id, 'common.select');
});

console.log('== 换个世一上 / 返回选人：路由到 common.hchk ==');
t('剧本契约：hchk 是条件卡（四个通关旗标 + !隐藏已见），else 选人页，next 隐藏结局；cine 的 next 是 hchk', () => {
  A.equal(HUB_CARD, 'common.hchk');
  const h = C['common.hchk'];
  A.deepEqual(h.if.map((k) => [k.t, k.n, !!k.neg]),
    [['g', '通关bin', false], ['g', '通关shy', false], ['g', '通关369', false], ['g', '通关zeus', false], ['g', '隐藏已见', true]]);
  A.equal(h.else, 'common.select'); A.equal(h.next, 'common.hidden');
  A.equal(C['common.cine'].next, 'common.hchk');
  A.equal(C['common.hidden'].end.kind, 'hidden');
  A.ok(C['common.hidden'].fx.some((f) => f.t === 'g' && f.o === '+' && f.n === '隐藏已见'));
});
t('剧本契约：四条序章结局卡各带 +{{通关<线>}}', () => {
  A.deepEqual(playable.slice().sort(), ['369', 'bin', 'shy', 'zeus']);
  for (const line of playable) {
    const c = prologueEnd(line);
    A.ok(c, line + ' 有序章结局');
    A.ok(c.fx.some((f) => f.t === 'g' && f.o === '+' && f.n === '通关' + line), c.id + ' 带 通关' + line);
  }
});
t('toHub：空图鉴 -> 选人页；状态是全新的 common（图鉴、旗标不动）', () => {
  const g = fresh();
  g.globals['某个跨线旗标'] = true;
  const e = mk(g);
  walk(e, 'bin', ['N']);
  const r = e.toHub();
  A.equal(r.kind, 'screen'); A.equal(r.screen, 'select'); A.equal(r.id, 'common.select');
  A.equal(S(e).line, 'common'); A.equal(S(e).card, 'common.select');
  A.equal(S(e).hist.length, 0); A.deepEqual(S(e).props, []); A.deepEqual(S(e).keys, []);
  A.equal(g.globals['某个跨线旗标'], true);
});
t('toHub：走到死亡结局后回选人页，不会被旧线的 death 规则再判一次', () => {
  const rnd = rng(99);
  for (const line of playable) {
    const e = mk();
    const r = randomRun(e, line, rnd);
    A.equal(r.kind, 'end');
    const h = e.toHub();
    A.equal(h.id, 'common.select'); A.equal(S(e).line, 'common');
    A.deepEqual(Object.keys(S(e).m).sort(), story.lines.common.meters.slice().sort());
  }
});
t('四条序章结局：进入结局卡时 fx 生效，写入全局旗标 通关<线> 和图鉴', () => {
  for (const line of playable) {
    const end = prologueEnd(line);
    const route = findRoute(story, line, end.id, fresh(), 11);
    A.ok(route, '找得到通往 ' + end.id + ' 的路线');
    const g = fresh();
    const e = mk(g);
    const r = walk(e, line, route);
    A.equal(r.kind, 'end'); A.equal(r.id, end.id); A.equal(r.end.kind, 'prologue');
    A.equal(g.globals['通关' + line], true, '通关' + line);
    A.ok(g.ends[end.id]);
    const ev = e.drainEvents();
    A.ok(ev.some((x) => x.type === 'gallery'));
    for (const other of playable) if (other !== line) A.equal(g.globals['通关' + other], undefined);
  }
});

// 四线全通关的图鉴，后面几条用例共用（按路线真的玩出来，不是手写旗标）
const allCleared = fresh();
for (const line of playable) {
  const end = prologueEnd(line);
  // 路线要按“当时”的图鉴来找：别的线留下的全局旗标（六九归来、韩门）会改变后面线里的分支
  const route = findRoute(story, line, end.id, allCleared, 5);
  if (route) walk(mk(allCleared), line, route);
}
t('只通关三条线：toHub 仍是选人页', () => {
  const g = clone(allCleared);
  delete g.globals['通关zeus'];
  const r = mk(g).toHub();
  A.equal(r.id, 'common.select');
});
t('四线都通关：toHub -> hchk 文字卡 -> N -> 隐藏结局；隐藏已见写入，之后 toHub 回选人页', () => {
  const g = clone(allCleared);
  for (const line of playable) A.equal(g.globals['通关' + line], true);
  const e = mk(g);
  let r = e.toHub();
  A.equal(r.kind, 'card'); A.equal(r.id, 'common.hchk'); A.equal(r.card.mode, 'text');
  A.deepEqual(e.options().map((o) => o.side), ['N']);
  r = e.choose('N');
  A.equal(r.kind, 'end'); A.equal(r.id, 'common.hidden'); A.equal(r.end.kind, 'hidden'); A.equal(r.end.title, '谁是世一上');
  A.equal(g.globals['隐藏已见'], true); A.ok(g.ends['common.hidden']);
  r = e.toHub();
  A.equal(r.id, 'common.select');
});
t('跨局持久化：图鉴经 JSON 往返（模拟 localStorage / 刷新页面）后，新引擎仍能进隐藏结局，进过之后不再进', () => {
  const stored = JSON.stringify(allCleared);
  let e = mk(JSON.parse(stored));
  A.equal(e.toHub().id, 'common.hchk');
  const r = e.choose('N');
  A.equal(r.id, 'common.hidden');
  const stored2 = JSON.stringify(e.gallery);
  e = mk(JSON.parse(stored2));
  A.equal(e.toHub().id, 'common.select');
});
t('结局卡上也能 toHub（结局屏的“换个世一上”）；hidden 结局之后的 common 状态可继续选人', () => {
  const g = clone(allCleared);
  const e = mk(g);
  e.toHub();
  e.choose('N');
  A.equal(e.cur.end.kind, 'hidden');
  const r = e.toHub();
  A.equal(r.screen, 'select');
  const res = e.startLine('bin');
  A.equal(res.id, 'bin.001');
});
t('菜单“返回选人”再“返回游戏”：toHub 之前备份的本局，loadRun 能原样恢复', () => {
  const rnd = rng(8);
  for (const line of playable) {
    const e = mk();
    let r = e.startLine(line);
    for (let i = 0; i < 4 && r.kind !== 'end'; i++) {
      const o = e.options();
      r = e.choose(o[Math.floor(rnd() * o.length)].sel);
    }
    if (r.kind === 'end') continue;
    const backup = clone(S(e));
    A.equal(e.toHub().id, 'common.select');
    A.equal(S(e).line, 'common');
    A.equal(e.loadRun(backup), 'ok');
    A.deepEqual(S(e), backup);
    A.equal(S(e).line, line); A.equal(e.current().kind, r.kind);
  }
});
t('在选人页存档（common@common.select）：读档 ok，current() 是 select 屏', () => {
  const e = mk();
  e.toHub();
  const saved = clone(e.exportRun());
  const e2 = mk();
  A.equal(e2.loadRun(saved), 'ok');
  const r = e2.current();
  A.equal(r.kind, 'screen'); A.equal(r.screen, 'select');
});

console.log('== 图鉴 ==');
t('galleryView：common 在前，其后按选人页顺序；locked 线不出现', () => {
  const v = mk().galleryView();
  const names = v.groups.map((x) => x.line);
  A.deepEqual(names, ['common'].concat(playable));
  A.equal(v.groups[0].name, '序章 · 隐藏');
  for (const l of story.order) if (story.lines[l].locked) A.equal(names.includes(l), false);
  const all = v.groups.flatMap((x) => x.ends.map((y) => y.id));
  for (const l of story.order) if (story.lines[l].locked) A.equal(all.some((id) => C[id].ln === l), false);
});
t('galleryView：总数 = 可玩线（含 common）的结局数 - 编译器标出的到不了的；locked 占位结局写进图鉴也不计数', () => {
  const unreachable = new Set(story.unreachable || []);
  const expect = Object.values(C).filter((c) => c.end && c.ln !== undefined && story.lines[c.ln] && !story.lines[c.ln].locked && !unreachable.has(c.id)).length;
  const g = fresh();
  for (const l of story.order) if (story.lines[l].locked) g.ends[l + '.001'] = 'T';
  g.ends['common.end.cai'] = 'T';
  const v = mk(g).galleryView();
  A.equal(v.total, expect); A.equal(v.got, 1);
  A.ok(v.total >= 20 && v.total <= 40);
  A.equal(v.groups.reduce((s, x) => s + x.ends.length, 0), v.total);
});
t('galleryView：common 组 = 菜是原罪 + 谁是世一上；隐藏结局带 secret 标记，其余没有；按 death/prologue/if/hidden 排序', () => {
  const v = mk().galleryView();
  const com = v.groups[0];
  A.deepEqual(com.ends.map((x) => x.id), ['common.end.cai', 'common.hidden']);
  A.equal(com.ends[1].secret, true); A.equal(com.ends[0].secret, false);
  A.equal(com.ends[1].unlocked, false);
  const order = ['death', 'prologue', 'if', 'hidden'];
  for (const gp of v.groups) {
    const idx = gp.ends.map((x) => order.indexOf(x.kind));
    A.deepEqual(idx, idx.slice().sort((a, b) => a - b));
    for (const x of gp.ends) A.equal(x.secret, x.kind === 'hidden');
  }
  const g = fresh();
  g.ends['common.hidden'] = 'T9';
  const v2 = mk(g).galleryView();
  A.equal(v2.groups[0].ends[1].unlocked, true); A.equal(v2.groups[0].ends[1].at, 'T9');
});
t('编译器标出的“到不了的结局”不在图鉴里，随机游走也确实到不了', () => {
  const un = story.unreachable || [];
  const v = mk().galleryView();
  const all = v.groups.flatMap((x) => x.ends.map((y) => y.id));
  for (const id of un) A.equal(all.includes(id), false);
  const rnd = rng(2024);
  const hit = new Set();
  for (const line of playable) {
    for (let k = 0; k < 600; k++) hit.add(randomRun(mk(), line, rnd).id);
  }
  for (const id of un) A.equal(hit.has(id), false);
});

console.log('== 预加载清单 ==');
t('nextIds：L/R 目标；叙述卡看 next；目标带 if/else 时把 else 链也算上；结局卡为空', () => {
  const e = mk(); e.startLine('common');
  A.deepEqual(e.nextIds(C['common.003']), ['common.end.cai', 'common.cine']);
  A.deepEqual(e.nextIds(C['common.001']), ['common.002']);
  A.deepEqual(e.nextIds(C['common.cine']), ['common.hchk', 'common.select']);
  A.deepEqual(e.nextIds(C['common.end.cai']), []);
});
t('preloadList：common.003 -> 菜是原罪结局图 + 开场动画的全部帧；只一跳（不含更远的选人页立绘）', () => {
  const e = mk(); e.startLine('common');
  const pl = e.preloadList(C['common.003']);
  A.ok(pl.imgs.includes(C['common.end.cai'].img));
  for (const f of C['common.cine'].frames) A.ok(pl.imgs.includes(f.img));
  A.equal(pl.imgs.some((k) => k.indexOf('sel/') === 0), false);
  A.equal(new Set(pl.imgs).size, pl.imgs.length);
});
t('preloadList：开场动画 -> 选人页所有立绘；common.001 -> 只有 common.002 的图和原声', () => {
  const e = mk(); e.startLine('common');
  const pl = e.preloadList(C['common.cine']);
  for (const l of story.order) A.ok(pl.imgs.includes(story.lines[l].portrait), l);
  const p1 = e.preloadList(C['common.001']);
  A.deepEqual(p1.imgs, [C['common.002'].img]); A.deepEqual(p1.sfx, [C['common.002'].sfx]);
});
t('preloadList 不改状态；选人页 / 结局卡上调用是空清单', () => {
  const e = mk(); walk(e, 'bin', ['N']);
  const before = JSON.stringify(S(e));
  e.preloadList(e.cur);
  A.equal(JSON.stringify(S(e)), before);
  A.deepEqual(e.preloadList(C['common.select']), { imgs: [], sfx: [] });
  A.deepEqual(e.preloadList(C['common.end.cai']), { imgs: [], sfx: [] });
});

console.log('== 随机游走 / 错过的相遇 / 存档 ==');
t('随机游走：四条线各 400 局，200 步内必到结局，结局卡上没有选项，不抛错', () => {
  const rnd = rng(12345);
  for (const line of playable) {
    for (let k = 0; k < 400; k++) {
      const e = mk();
      const r = randomRun(e, line, rnd);
      A.equal(r.kind, 'end');
      A.equal(e.options().length, 0);
      A.ok(['death', 'prologue', 'if', 'hidden'].includes(r.end.kind));
      for (const m of e.missed()) A.equal(typeof m.histIndex, 'number');
    }
  }
});
t('随机游走：任意一局的数值始终在 0..100，道具不超过 3 个', () => {
  const rnd = rng(77);
  for (const line of playable) {
    for (let k = 0; k < 120; k++) {
      const e = mk();
      let r = e.startLine(line);
      while (r.kind !== 'end') {
        const o = e.options();
        r = e.choose(o[Math.floor(rnd() * o.length)].sel);
        for (const v of Object.values(S(e).m)) A.ok(v >= 0 && v <= 100);
        A.ok(S(e).props.length <= 3);
      }
    }
  }
});
t('missed / restore：找一局有“错过的相遇”的结局，restore 回到分歧卡，不重复应用 fx，另一侧可选', () => {
  const rnd = rng(31337);
  let tested = 0;
  for (let k = 0; k < 400 && tested < 5; k++) {
    const line = playable[k % playable.length];
    const e = mk();
    randomRun(e, line, rnd);
    const ms = e.missed();
    if (!ms.length) continue;
    const idx = ms[0].histIndex;
    const h = clone(S(e).hist[idx]);
    A.equal(h.card, ms[0].cardId);
    const r = e.restore(idx);
    A.equal(r.kind, 'card'); A.equal(r.id, ms[0].cardId);
    A.deepEqual(S(e).m, h.snap.m);                 // 没有重复应用进卡 fx
    A.deepEqual(S(e).props, h.snap.props);
    A.equal(S(e).hist.length, idx);
    A.ok(e.options().length >= 1);
    const other = h.side === 'L' && C[h.card].R ? 'R' : C[h.card].L ? 'L' : 'R';
    e.choose(other);                               // 不抛错
    tested++;
  }
  A.ok(tested >= 3, '至少找到 3 局带错过相遇的结局，实际 ' + tested);
});
t('restore 能走出死亡结局后继续游戏', () => {
  const rnd = rng(4242);
  for (let k = 0; k < 200; k++) {
    const e = mk();
    const r = randomRun(e, 'bin', rnd);
    if (r.end.kind !== 'death') continue;
    const i = S(e).hist.length - 1;
    const prev = clone(S(e).hist[i]);
    const back = e.restore(i);
    A.equal(back.kind, 'card'); A.equal(S(e).card, prev.card);
    A.deepEqual(S(e).m, prev.snap.m);
    return;
  }
  throw new Error('随机游走里没有走到死亡结局');
});
t('exportRun / loadRun 往返；主版本号变了 -> outdated 且状态未载入；次版本变化仍兼容', () => {
  const e = mk(); walk(e, 'bin', ['N']);
  const saved = clone(e.exportRun());
  const e2 = mk();
  A.equal(e2.loadRun(saved), 'ok'); A.deepEqual(S(e2), saved);
  A.equal(e2.current().kind, 'card');
  const e3 = new Engine(Object.assign({}, story, { version: '1.0.0' }));
  A.equal(e3.loadRun(saved), 'outdated'); A.equal(e3.s, null);
  A.equal(new Engine(Object.assign({}, story, { version: '0.9.0' })).loadRun(saved), 'ok');
  A.equal(majorOf('2.1.0'), 2); A.equal(majorOf(undefined), 0);
});
t('当前卡已不存在 / 线不存在 / 卡不属于该线 -> outdated；空档 -> none；失效 hist 被丢弃', () => {
  const e = mk(); walk(e, 'bin', ['N', 'L']);
  const saved = clone(e.exportRun());
  A.equal(mk().loadRun(Object.assign({}, saved, { card: 'bin.deleted' })), 'outdated');
  A.equal(mk().loadRun(Object.assign({}, saved, { line: 'nope' })), 'outdated');
  A.equal(mk().loadRun(Object.assign({}, saved, { line: 'shy' })), 'outdated');
  A.equal(mk().loadRun(null), 'none'); A.equal(mk().loadRun({}), 'none');
  const bad = clone(saved);
  bad.hist.push({ card: 'gone', side: 'L', snap: bad.hist[0].snap });
  const e2 = mk(); A.equal(e2.loadRun(bad), 'ok');
  A.ok(S(e2).hist.every((h) => h.card !== 'gone'));
});
t('outdated 后从本线开头重新开始', () => {
  const e = mk(); walk(e, 'shy', ['N']);
  const saved = clone(e.exportRun());
  const e2 = mk();
  A.equal(e2.loadRun(Object.assign({}, saved, { card: 'shy.gone' })), 'outdated');
  A.equal(e2.startLine(saved.line).id, story.lines.shy.start);
});
t('本局旗标不跨局；全局旗标跨局保留', () => {
  const g = fresh();
  const e = mk(g);
  e.startLine('bin');
  S(e).flags.x = true;
  e.startLine('bin');
  A.equal(S(e).flags.x, undefined);
  g.globals['六九归来'] = true;
  e.startLine('shy');
  A.equal(g.globals['六九归来'], true);
});

// ======================================================================
console.log('\nB. 合成小剧本（边界）');
// 合成剧本构造器：把 '+【A】' 之类简写解析成引擎格式
function mini(cards, start, extra) {
  const parseFx = (arr) => (arr || []).map((s) => {
    const m = s.match(/^([+-])【(.+)】$/); return { t: 'p', o: m[1], n: m[2] };
  });
  const parseCond = (arr) => (arr || []).map((s) => {
    let neg = false; if (s[0] === '!') { neg = true; s = s.slice(1); }
    let m = s.match(/^\{\{(.+)\}\}$/); if (m) return { t: 'g', n: m[1], neg };
    m = s.match(/^\{(.+)\}$/); return { t: 'f', n: m[1], neg };
  });
  const out = {};
  for (const id in cards) {
    const c = Object.assign({ id }, cards[id]);
    c.fx = parseFx(c.fx);
    if (c.if) c.if = parseCond(c.if);
    out[id] = c;
  }
  const first = start || Object.keys(cards)[0];
  return Object.assign({ version: '0.0.1', lines: { x: { name: 'x', meters: [], init: [], start: first, deaths: [], locked: false } },
    order: ['x'], props: {}, cards: out }, extra || {});
}
t('道具栏最多 3 个，满了顶掉最早的并 toast', () => {
  const st = mini({
    a: { ln: 'x', mode: 'text', fx: ['+【A】', '+【B】', '+【C】', '+【D】'], next: 'z' },
    z: { ln: 'x', mode: 'text', end: { kind: 'if', title: 'z' } },
  });
  const e = new Engine(st); e.startLine('x');
  A.deepEqual(S(e).props, ['B', 'C', 'D']);
  const ev = e.drainEvents();
  A.equal(ev.filter((x) => x.type === 'toast').length, 1);
  A.match(ev.find((x) => x.type === 'toast').text, /【A】/);
});
t('if/else 连跳超过 20 次抛错', () => {
  const cards = {};
  for (let i = 0; i < 25; i++) cards['c' + i] = { ln: 'x', mode: 'text', if: ['!{y}', '{y}'], else: 'c' + (i + 1), next: 'c' + (i + 1) };
  cards.c25 = { ln: 'x', mode: 'text', end: { kind: 'if', title: 'z' } };
  const e = new Engine(mini(cards, 'c0'));
  A.throws(() => e.startLine('x'), /longer than 20/);
});
t('hist 只保留最近 80 条', () => {
  const cards = {};
  for (let i = 0; i < 100; i++) cards['c' + i] = { ln: 'x', mode: 'text', next: 'c' + (i + 1) };
  cards.c100 = { ln: 'x', mode: 'text', end: { kind: 'if', title: 'z' } };
  const e = new Engine(mini(cards, 'c0')); e.startLine('x');
  for (let i = 0; i < 100; i++) e.choose('N');
  A.equal(S(e).hist.length, 80); A.equal(S(e).hist[0].card, 'c20');
});
t('startAt：未知卡抛错；换掉本局状态，图鉴和全局旗标不动', () => {
  const g = fresh(); g.globals.k = true; g.ends.old = 'T';
  const e = mk(g);
  walk(e, 'bin', ['N']);
  A.throws(() => e.startAt('common', 'common.nope'), /missing card/);
  A.equal(S(e).line, 'bin');                       // 抛错时本局不被破坏
  e.startAt('common', 'common.003');
  A.equal(S(e).line, 'common'); A.equal(S(e).card, 'common.003'); A.equal(S(e).hist.length, 0);
  A.equal(g.globals.k, true); A.equal(g.ends.old, 'T');
});
t('toHub：剧本里没有 common.hchk（旧剧本）时直接去 common.select', () => {
  const st = mini({
    'common.select': { ln: 'common', mode: 'text', screen: 'select' },
  }, 'common.select', { lines: { common: { name: '序', meters: [], init: [], start: 'common.select', deaths: [], locked: false } }, order: [] });
  const e = new Engine(st);
  const r = e.toHub();
  A.equal(r.id, 'common.select'); A.equal(r.screen, 'select');
  // 没有 select 卡时 startAt 抛错而不是静默
  const st2 = mini({ a: { ln: 'common', mode: 'text', next: 'a' } }, 'a', { lines: { common: { name: '序', meters: [], init: [], start: 'a', deaths: [], locked: false } }, order: [] });
  A.throws(() => new Engine(st2).toHub(), /missing card/);
});
t('nextIds：P 选项只在持有道具时计入；叙述卡看 next；目标 if/else 的 else 链被带上', () => {
  const st = mini({
    a: { ln: 'x', mode: 'wide', img: 'k/a', L: { t: 'l', fx: [], to: 'l1' }, R: { t: 'r', fx: [], to: 'r1' }, P: [{ p: '胶带', t: 'p', fx: [], to: 'p1' }] },
    l1: { ln: 'x', mode: 'wide', img: 'k/l1', if: ['{y}'], else: 'l2', next: 'z' },
    l2: { ln: 'x', mode: 'text', img: 'k/l2', next: 'z' },
    r1: { ln: 'x', mode: 'text', img: 'k/r1', say: '纯字卡不预载图', next: 'z' },
    p1: { ln: 'x', mode: 'full', img: 'k/p1', sfx: 's/p1', next: 'z' },
    z: { ln: 'x', mode: 'text', img: 'k/z', end: { kind: 'if', title: 'z' } },
  }, 'a');
  const e = new Engine(st); e.startLine('x');
  A.deepEqual(e.nextIds(st.cards.a), ['l1', 'l2', 'r1']);
  S(e).props.push('胶带');
  A.deepEqual(e.nextIds(st.cards.a), ['l1', 'l2', 'r1', 'p1']);
  const pl = e.preloadList(st.cards.a);
  A.deepEqual(pl.imgs, ['k/l1', 'k/p1']);          // l2、r1 是 text 卡，不预载图
  A.deepEqual(pl.sfx, ['s/p1']);
  A.deepEqual(e.nextIds(st.cards.p1), ['z']);
  A.deepEqual(e.preloadList(st.cards.p1).imgs, ['k/z']);   // 结局卡即使是 text 模式也预载它的图
  A.deepEqual(e.nextIds(st.cards.z), []);
});
t('galleryView（合成）：locked 线、到不了的结局都不计数；common 里的隐藏结局 secret', () => {
  const st = mini({
    a: { ln: 'x', mode: 'text', L: { t: 'l', fx: [], to: 'e1' }, R: { t: 'r', fx: [], to: 'e2' } },
    e1: { ln: 'x', mode: 'text', end: { kind: 'death', title: 'e1' } },
    e2: { ln: 'x', mode: 'text', end: { kind: 'if', title: 'e2' } },
    e3: { ln: 'x', mode: 'text', end: { kind: 'prologue', title: 'e3' } },
    h: { ln: 'common', mode: 'text', end: { kind: 'hidden', title: 'h' } },
    k1: { ln: 'k', mode: 'text', end: { kind: 'if', title: 'k1' } },
  }, 'a', {
    lines: {
      common: { name: '序', meters: [], init: [], start: 'h', deaths: [], locked: false },
      x: { name: 'x', meters: [], init: [], start: 'a', deaths: [], locked: false },
      k: { name: 'k', meters: [], init: [], start: 'k1', deaths: [], locked: true },
    },
    order: ['x', 'k'], unreachable: ['e3'],
  });
  const v = new Engine(st, { gallery: { ends: { k1: 'T', e1: 'T' }, globals: {} } }).galleryView();
  A.deepEqual(v.groups.map((g) => g.line), ['common', 'x']);
  A.equal(v.total, 3); A.equal(v.got, 1);
  A.deepEqual(v.groups[1].ends.map((x) => x.id), ['e1', 'e2']);
  A.equal(v.groups[0].ends[0].secret, true);
});
t('随机选择永远不会让 apply 出非法状态：对 if 条件里的全局旗标，条件读的是图鉴而不是本局', () => {
  const st = mini({
    a: { ln: 'x', mode: 'text', if: ['{{G}}'], else: 'b', next: 'c' },
    b: { ln: 'x', mode: 'text', next: 'c' },
    c: { ln: 'x', mode: 'text', end: { kind: 'if', title: 'c' } },
  }, 'a');
  const g = fresh();
  let e = new Engine(st, { gallery: g });
  A.equal(e.startLine('x').id, 'b');
  g.globals.G = true;
  e = new Engine(st, { gallery: JSON.parse(JSON.stringify(g)) });   // 跨“局”：新引擎读同一份图鉴数据
  A.equal(e.startLine('x').id, 'a');
});

// ======================================================================
console.log('\nC. 老的示例剧本（review/sample_story，临时编译）');
let sample = null;
const sampleDir = join(root, '..', 'review', 'sample_story');
if (existsSync(sampleDir)) {
  const tmp = mkdtempSync(join(tmpdir(), 'lc-sample-'));
  const copied = [];
  try {
    for (const f of readdirSync(sampleDir)) {
      // 只拿规范命名的剧本文件，忽略 *.used.txt 之类的杂物
      if (/^\d\d_[^.]+\.txt$/.test(f) || f === 'props.txt' || f === 'VERSION') {
        copyFileSync(join(sampleDir, f), join(tmp, f));
        copied.push(f);
      }
    }
    const out = join(tmp, 'sample.json');
    execFileSync('python3', [join(here, 'build_story.py'), '--story-dir', tmp, '--out', out], { stdio: 'pipe' });
    sample = JSON.parse(readFileSync(out, 'utf8'));
    copied.push('sample.json');
  } catch (e) {
    sample = null;
  } finally {
    for (const f of copied) { try { unlinkSync(join(tmp, f)); } catch (e) { /* ignore */ } }
    try { rmdirSync(tmp); } catch (e) { /* ignore */ }
  }
}
if (!sample) {
  skipped = 1;
  console.log('  skip 示例剧本编译不了（缺 python3 或 review/sample_story），跳过 C 部分');
} else {
  const mkS = (g) => mk(g, sample);
  t('示例：common 起点、拜师当小弟 -> 死亡结局、cinematic 3 帧', () => {
    const e = mkS();
    let r = e.startLine('common');
    A.equal(r.id, 'common.001');
    r = e.choose('N'); r = e.choose('N'); A.equal(r.screen, 'news');
    r = e.choose('N'); A.equal(r.id, 'common.004');
    r = e.choose('L'); A.equal(r.end.title, '菜是原罪');
    A.equal(sample.cards['common.cine'].frames.length, 3);
    A.equal(sample.cards['common.cine'].next, 'common.select');
  });
  t('示例：init、进卡 fx、死亡（战力归零 / 暴露度爆表）、夹值', () => {
    let e = mkS(); e.startLine('bin');
    A.deepEqual(S(e).m, { 战力: 50, 人气: 50, 家底: 50, 暴露度: 20 });
    e = mkS(); walk(e, 'bin', ['N']); A.equal(S(e).card, 'bin.003'); A.equal(S(e).m.人气, 55);
    e = mkS(); let r = walk(e, 'bin', ['N', 'R', 'N', 'L']);
    A.equal(r.id, 'bin.end.weak'); A.equal(S(e).m.战力, 0);
    e = mkS(); r = walk(e, 'bin', ['N', 'L', 'N', 'L', 'R']);
    A.equal(r.id, 'bin.end.exposed'); A.equal(S(e).m.暴露度, 100);
  });
  t('示例：道具选项（持有才出现 P，使用后消失）、preview 不含 0 且不改状态', () => {
    const e = mkS(); walk(e, 'bin', ['N', 'L', 'N']);
    A.equal(S(e).card, 'bin.006'); A.deepEqual(S(e).props, ['胶带']);
    const opts = e.options();
    A.deepEqual(opts.map((o) => o.side), ['L', 'R', 'P']); A.equal(opts[2].prop, '胶带');
    A.deepEqual(e.preview('P:胶带'), { 战力: 10, 人气: 10 });
    e.choose('P:胶带');
    A.equal(S(e).props.length, 0);
    const e2 = mkS(); walk(e2, 'bin', ['N', 'R', 'N']);
    A.deepEqual(e2.options().map((o) => o.side), ['L', 'R']);
    A.throws(() => e2.choose('P:胶带'));
  });
  t('示例：key 卡记录关键选择（最多 3 条）、条件 {signed} 与 战力>=40', () => {
    let e = mkS(); const r = walk(e, 'bin', ['N', 'L', 'N', 'R', 'N', 'L']);
    A.equal(r.id, 'bin.end.pro'); A.equal(r.end.keys.length, 3);
    A.deepEqual(r.end.keys[0], { key: '签不签协议', label: '签协议' });
    e = mkS(); walk(e, 'bin', ['N', 'L', 'N', 'R']); A.equal(S(e).card, 'bin.006b');
    e = mkS(); walk(e, 'bin', ['N', 'L', 'N', 'L']); A.equal(S(e).card, 'bin.007');
    e = mkS(); walk(e, 'bin', ['N', 'R', 'N', 'R']); A.equal(S(e).card, 'bin.007');
  });
  t('示例：宙斯线献祭写入全局旗标，阿Bin 线 if:{{zeus_seal}} 读到；没有旗标直接跳 else', () => {
    const g = fresh();
    let e = mkS(g);
    walk(e, 'zeus', ['N', 'R', 'L']);
    A.equal(g.globals.zeus_seal, true);
    e = mkS(g); e.startLine('bin'); e.choose('N');
    A.equal(S(e).card, 'bin.002'); A.equal(S(e).m.人气, 60);
    const e2 = mkS(); e2.startLine('bin'); e2.choose('N');
    A.equal(S(e2).card, 'bin.003');
  });
  t('示例：missed 报告姜爷并指向 bin.003；restore 不重复应用 fx；走遇到姜爷的路线则 missed 为空', () => {
    const e = mkS();
    const r = walk(e, 'bin', ['N', 'L', 'N', 'R', 'N', 'L']);
    const ms = r.end.missed();
    A.equal(ms.length, 1); A.equal(ms[0].meet, '姜爷'); A.equal(ms[0].cardId, 'bin.003');
    const back = e.restore(ms[0].histIndex);
    A.equal(back.id, 'bin.003'); A.equal(S(e).m.人气, 55);
    e.choose('R'); A.equal(S(e).card, 'bin.005'); A.deepEqual(S(e).meets, ['姜爷']);
    const e2 = mkS();
    const r2 = walk(e2, 'bin', ['N', 'R', 'N', 'R', 'L']);
    A.deepEqual(r2.end.missed(), []);
  });
  t('示例：宙斯线 missed（按兵不动路线错过超威）', () => {
    const e = mkS();
    const r = walk(e, 'zeus', ['N', 'R', 'R', 'R']);
    const ms = r.end.missed();
    A.equal(ms.length, 1); A.equal(ms[0].meet, '超威'); A.equal(ms[0].cardId, 'zeus.002');
  });
  t('示例：galleryView 按线分组，locked 线（chovy）不计入总数', () => {
    const g = { ends: { 'bin.end.pro': 'T', 'common.end.cai': 'T' }, globals: {} };
    const v = mkS(g).galleryView();
    A.equal(v.got, 2); A.equal(v.total, 1 + 4 * 4);
    A.equal(v.groups.some((x) => x.line === 'chovy'), false); A.equal(v.groups[0].line, 'common');
  });
  t('示例：随机游走每条线 300 局都能到结局', () => {
    const rnd = rng(12345);
    for (const line of sample.order.filter((l) => !sample.lines[l].locked)) {
      for (let k = 0; k < 300; k++) randomRun(mkS(), line, rnd, 100);
    }
    A.ok(true);
  });
}

// ======================================================================
console.log('\nD. 编译器：数值死亡规则的可达性（合成小剧本，临时编译）');
const CSRC = {
  '00_common.txt': `@line common
name: 序章
start: common.001

== common.001
mode: text
say: 开始。
next: common.end.cai

== common.end.cai
mode: text
end: death
title: 菜
say: 菜是原罪。
`,
  '10_x.txt': `@line x
name: X
team: T
motto: M
portrait: ph/a
meters: 战力 人气 家底 暴露度
init: 50 50 50 20
start: x.1
death: 战力<=0 x.end.weak
death: 暴露度>=100 x.end.exposed
death: 家底<=0 x.end.broke
locked: false

== x.1
mode: text
say: 第一步。
L: 甲 | 战力-30 暴露度+50 | -> x.2
R: 乙 | 战力-10 | -> x.2

== x.2
mode: text
say: 第二步。
L: 丙 | 暴露度+50 家底-10 | -> x.3
R: 丁 | 战力-10 | -> x.3

== x.3
mode: text
say: 第三步。
L: 戊 | -> x.end.fin
R: 己 | -> x.end.broke

== x.end.fin
mode: text
end: prologue
title: 完
say: 完结。

== x.end.weak
mode: text
end: death
title: 弱
say: 太弱了。

== x.end.exposed
mode: text
end: death
title: 暴露
say: 暴露了。

== x.end.broke
mode: text
end: death
title: 破产
say: 破产了。
`,
  'VERSION': '0.0.1\n',
  'props.txt': '',
};
let built = null;
let buildLog = '';
{
  const tmp = mkdtempSync(join(tmpdir(), 'lc-built-'));
  const made = [];
  try {
    for (const f of Object.keys(CSRC)) { writeFileSync(join(tmp, f), CSRC[f], 'utf8'); made.push(f); }
    const out = join(tmp, 'built.json');
    buildLog = execFileSync('python3', [join(here, 'build_story.py'), '--story-dir', tmp, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    made.push('built.json');
    built = JSON.parse(readFileSync(out, 'utf8'));
  } catch (e) {
    built = null;
  } finally {
    for (const f of made) { try { unlinkSync(join(tmp, f)); } catch (e) { /* ignore */ } }
    try { rmdirSync(tmp); } catch (e) { /* ignore */ }
  }
}
if (!built) {
  skipped = 1;
  console.log('  skip 合成小剧本编译不了（缺 python3），跳过 D 部分');
} else {
  t('死亡规则能不能触发按“数值沿剧情图能走到哪”判定：战力最低 10 → x.end.weak 到不了；暴露度能到 100 → 能触发', () => {
    A.deepEqual(built.unreachable, ['x.end.weak']);
    A.ok(/死亡规则 战力<=0 → x\.end\.weak 永远触发不了.*只会降到 10.*不计入图鉴/.test(buildLog));
    A.equal(/暴露度>=100 → x\.end\.exposed 永远触发不了/.test(buildLog), false);
  });
  t('有别的入口的死亡结局（x.end.broke 被选项直接指到）：规则触发不了会提示，但结局仍然算可达、计入图鉴', () => {
    A.ok(/死亡规则 家底<=0 → x\.end\.broke 永远触发不了.*只会降到 40/.test(buildLog));
    A.equal(/x\.end\.broke 永远触发不了.*不计入图鉴/.test(buildLog), false);
    A.equal(built.unreachable.includes('x.end.broke'), false);
    const v = mk(null, built).galleryView();
    A.deepEqual(v.groups.map((g) => g.line), ['common', 'x']);
    A.equal(v.total, 1 + 3);
    A.equal(v.groups[1].ends.some((x) => x.id === 'x.end.weak'), false);
  });
  t('合成小剧本：暴露度爆表照常走到死亡结局；随机游走绝不会走到 x.end.weak', () => {
    const e = mk(null, built);
    const r = walk(e, 'x', ['L', 'L']);
    A.equal(r.id, 'x.end.exposed'); A.equal(S(e).m.暴露度, 100);
    const rnd = rng(99);
    for (let k = 0; k < 300; k++) A.notEqual(randomRun(mk(null, built), 'x', rnd).id, 'x.end.weak');
  });
}

console.log('\n' + (process.exitCode ? 'FAILED' : 'ALL PASSED') + ' (' + n + ' tests passed, ' + asserts + ' assertions' + (skipped ? ', 示例剧本部分已跳过' : '') + ')');
