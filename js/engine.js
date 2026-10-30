// 纯逻辑引擎：不碰 DOM、不碰 localStorage，可在 node 下单测。
// 状态结构见 ENGINE_SPEC 第 4 节。

const MAX_HIST = 300;
const MAX_PROPS = 3;
const MAX_HOPS = 20;
/** _search 默认预算：最多展开多少个沙盒状态；超了按“找不到”处理（保守，不会推荐走不通的路）。 */
export const SEARCH_BUDGET = 6000;
const END_KIND_ORDER = ['death', 'prologue', 'if', 'hidden'];
/** “换个世一上”“返回选人”的统一入口：条件卡，四线通关后会把人引向隐藏结局，否则落到选人页。 */
export const HUB_CARD = 'common.hchk';
const HUB_FALLBACK = 'common.select';

function clamp(v) {
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

function cmp(a, op, b) {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    case '==': return a === b;
    default: return false;
  }
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------------------------------------------------------------------------
// 共用核心：条件 / 效果 / 死亡 / 进卡 / 选项。
// 全部作用于“传入的状态对象 s + 全局旗标对象 globals + 事件数组 events”，
// 真实引擎传 this.s / gallery.globals / this.events，沙盒搜索（Engine._search）传自己的副本和 null，
// 两边跑的是同一份代码，语义不会分叉。events 为 null 时不记事件。
// ---------------------------------------------------------------------------
function checkCond(conds, s, globals) {
  if (!conds || !conds.length) return true;
  for (const k of conds) {
    let ok;
    if (k.t === 'p') ok = s.props.indexOf(k.n) >= 0;
    else if (k.t === 'f') ok = !!s.flags[k.n];
    else if (k.t === 'g') ok = !!globals[k.n];
    else if (k.t === 'm') ok = s.m[k.n] !== undefined && cmp(s.m[k.n], k.o, k.v);
    else ok = false;
    if (k.neg) ok = !ok;
    if (!ok) return false;
  }
  return true;
}

function applyFxCore(list, s, globals, events) {
  if (!list) return;
  for (const e of list) {
    if (e.t === 'm') {
      const cur = s.m[e.n];
      if (cur === undefined) continue;
      s.m[e.n] = clamp(e.o === '+' ? cur + e.v : e.o === '-' ? cur - e.v : e.v);
    } else if (e.t === 'p') {
      const i = s.props.indexOf(e.n);
      if (e.o === '+') {
        if (i >= 0) continue;
        s.props.push(e.n);
        if (s.props.length > MAX_PROPS) {
          const dropped = s.props.shift();
          if (events) events.push({ type: 'toast', text: '道具栏已满，【' + dropped + '】被顶掉了' });
        }
      } else if (i >= 0) {
        s.props.splice(i, 1);
      }
    } else if (e.t === 'f') {
      if (e.o === '+') s.flags[e.n] = true; else delete s.flags[e.n];
    } else if (e.t === 'g') {
      if (e.o === '+') globals[e.n] = true; else delete globals[e.n];
      if (events) events.push({ type: 'gallery' });
    }
  }
}

function deathOf(ln, s) {
  if (!ln || !ln.deaths) return null;
  for (const d of ln.deaths) {
    const v = s.m[d.meter];
    if (v !== undefined && cmp(v, d.op, d.val)) return d.end;
  }
  return null;
}

/**
 * 进卡：if/else 链 -> 记 s.card -> 进卡 fx -> meet / seen -> 非结局卡再判死亡（死了就改道进结局卡）。
 * 返回最终进入的那张卡对象；结局登记（_reachEnd）不在这里，由真实引擎在外面做。
 */
function enterCore(cards, ln, s, globals, events, cardId, redirects) {
  let id = cardId;
  let hops = 0;
  let c;
  for (;;) {
    c = cards[id];
    if (!c) throw new Error('missing card ' + id);
    if (c.if && c.if.length && !checkCond(c.if, s, globals)) {
      if (++hops > MAX_HOPS) throw new Error('if/else chain longer than ' + MAX_HOPS + ' at ' + cardId);
      if (!c.else) throw new Error('if card without else: ' + id);
      id = c.else;
      continue;
    }
    break;
  }
  s.card = id;
  applyFxCore(c.fx, s, globals, events);
  if (c.meet && s.meets.indexOf(c.meet) < 0) s.meets.push(c.meet);
  if (s.seen.indexOf(id) < 0) s.seen.push(id);
  if (!c.end) {
    const dead = deathOf(ln, s);
    if (dead) {
      const n = (redirects || 0) + 1;
      if (n > MAX_HOPS) throw new Error('death redirect loop at ' + id);
      return enterCore(cards, ln, s, globals, events, dead, n);
    }
  }
  return c;
}

/** 选中一个选项之后发生的事：选项 fx -> 死亡检查 -> 进卡。返回最终进入的那张卡。 */
function stepCore(cards, ln, s, globals, events, opt) {
  applyFxCore(opt.fx, s, globals, events);
  const dead = deathOf(ln, s);
  return enterCore(cards, ln, s, globals, events, dead || opt.to);
}

function optOf(c, sel, props) {
  if (sel === 'N') return c.next ? { t: '继续', fx: [], to: c.next } : null;
  if (sel === 'L' || sel === 'R') return c[sel] || null;
  if (typeof sel === 'string' && sel.indexOf('P:') === 0) {
    const name = sel.slice(2);
    if (props.indexOf(name) < 0) return null;
    const list = c.P || [];
    for (const p of list) if (p.p === name) return p;
  }
  return null;
}

function optionsOf(c, props) {
  const out = [];
  if (c.L || c.R) {
    if (c.L) out.push({ side: 'L', sel: 'L', label: c.L.t });
    if (c.R) out.push({ side: 'R', sel: 'R', label: c.R.t });
    for (const p of (c.P || [])) {
      if (props.indexOf(p.p) >= 0) {
        out.push({ side: 'P', sel: 'P:' + p.p, label: p.t, prop: p.p });
      }
    }
  } else if (c.next) {
    out.push({ side: 'N', sel: 'N', label: '继续' });
  }
  return out;
}

/** 某张卡上某个选择的显示文字。 */
function labelOf(c, sel) {
  if (!c || !sel) return '';
  if (sel === 'N') return '继续';
  if (sel === 'L' || sel === 'R') return c[sel] ? c[sel].t : '';
  if (sel.indexOf('P:') === 0) {
    const name = sel.slice(2);
    for (const p of (c.P || [])) if (p.p === name) return p.t;
  }
  return '';
}

/** excludeSel 排除谁：精确匹配；旧存档只有 side 'P' 时（不知道用的哪个道具）排除所有 P:*。 */
function isExcluded(sel, ex) {
  if (!ex) return false;
  return sel === ex || (ex === 'P' && sel.indexOf('P:') === 0);
}

export function majorOf(version) {
  const n = parseInt(String(version || '0').split('.')[0], 10);
  return isNaN(n) ? 0 : n;
}

export class Engine {
  /**
   * @param {object} story  data/story.json 的内容
   * @param {{gallery?: object, now?: function}} opts
   *   gallery: {ends:{id:ts}, globals:{}}，引擎直接就地修改，调用方负责持久化
   */
  constructor(story, opts) {
    opts = opts || {};
    this.story = story;
    this.gallery = opts.gallery || { ends: {}, globals: {} };
    if (!this.gallery.ends) this.gallery.ends = {};
    if (!this.gallery.globals) this.gallery.globals = {};
    this.now = opts.now || function () { return new Date().toISOString(); };
    this.s = null;
    this.events = [];
    this._meetCache = {};
    /** 引路：{meet, path:[{card,sel,label}], i}。只在内存里，不进存档。 */
    this.guide = null;
    /** 沙盒搜索的累计统计（测试 / 性能报告用）：调用次数、展开状态数、超预算次数。 */
    this._stat = { searches: 0, expanded: 0, truncated: 0 };
    this._reach = {};
    this._rev = null;
    this._rel = null;
  }

  // ---- 基本访问 ----
  card(id) { return this.story.cards[id] || null; }
  get cur() { return this.s ? this.card(this.s.card) : null; }
  line() { return this.s ? this.story.lines[this.s.line] : null; }
  drainEvents() { const e = this.events; this.events = []; return e; }

  lineMeets(lineId) {
    if (!this._meetCache[lineId]) {
      const out = [];
      const cards = this.story.cards;
      for (const id in cards) {
        const c = cards[id];
        if (c.ln === lineId && c.meet && out.indexOf(c.meet) < 0) out.push(c.meet);
      }
      this._meetCache[lineId] = out;
    }
    return this._meetCache[lineId];
  }

  // ---- 开始 / 存档 ----
  _fresh(id) {
    const ln = this.story.lines[id];
    if (!ln) throw new Error('unknown line ' + id);
    const m = {};
    ln.meters.forEach((n, i) => { m[n] = clamp(ln.init[i] === undefined ? 50 : ln.init[i]); });
    this.s = {
      v: this.story.version, line: id, card: null, m,
      props: [], flags: {}, keys: [], meets: [], hist: [], seen: [],
    };
    this.guide = null;
    return ln;
  }

  startLine(id) {
    const ln = this._fresh(id);
    return this.enter(ln.start);
  }

  /** 以 lineId 的全新状态直接进入 cardId（本局状态被替换；图鉴和全局旗标不动）。 */
  startAt(lineId, cardId) {
    if (!this.card(cardId)) throw new Error('missing card ' + cardId);
    this._fresh(lineId);
    return this.enter(cardId);
  }

  /** 回到选人入口：经 common.hchk 条件卡（旧剧本没有它就直接去 common.select）。 */
  toHub() {
    return this.startAt('common', this.card(HUB_CARD) ? HUB_CARD : HUB_FALLBACK);
  }

  exportRun() { return this.s; }

  /** 读档。返回 'ok' | 'none' | 'outdated'。outdated 时本局状态未载入。 */
  loadRun(run) {
    this.guide = null;
    if (!run || typeof run !== 'object' || !run.line) return 'none';
    if (majorOf(run.v) !== majorOf(this.story.version)) return 'outdated';
    if (!this.story.lines[run.line] || !this.card(run.card)) return 'outdated';
    if (this.card(run.card).ln !== run.line) return 'outdated';
    const ln = this.story.lines[run.line];
    const m = {};
    ln.meters.forEach((n, i) => {
      const v = run.m && typeof run.m[n] === 'number' ? run.m[n] : ln.init[i];
      m[n] = clamp(v === undefined ? 50 : v);
    });
    const hist = (Array.isArray(run.hist) ? run.hist : []).filter(
      (h) => h && this.card(h.card) && h.snap && this.card(h.snap.card));
    this.s = {
      v: this.story.version, line: run.line, card: run.card, m,
      props: Array.isArray(run.props) ? run.props.slice(0, MAX_PROPS) : [],
      flags: run.flags && typeof run.flags === 'object' ? clone(run.flags) : {},
      keys: Array.isArray(run.keys) ? clone(run.keys) : [],
      meets: Array.isArray(run.meets) ? run.meets.slice() : [],
      hist: hist.slice(-MAX_HIST),
      seen: Array.isArray(run.seen) ? run.seen.slice() : [],
    };
    return 'ok';
  }

  /** 当前卡的结果描述，不改状态。UI 读档后用它来渲染。 */
  current() {
    const c = this.cur;
    return c ? this._result(c) : null;
  }

  // ---- 条件与效果（核心在文件顶部的共用函数里，这里只是绑定真实状态的外壳）----
  check(conds) {
    return checkCond(conds, this.s, this.gallery.globals);
  }

  applyFx(list) {
    applyFxCore(list, this.s, this.gallery.globals, this.events);
  }

  checkDeath() {
    return deathOf(this.line(), this.s);
  }

  // ---- 进卡 ----
  enter(cardId) {
    const s = this.s;
    const c = enterCore(this.story.cards, this.story.lines[s.line], s, this.gallery.globals, this.events, cardId);
    return this._result(c);
  }

  _result(c) {
    if (c.end) return { kind: 'end', id: c.id, card: c, end: this._reachEnd(c) };
    if (c.screen) return { kind: 'screen', id: c.id, card: c, screen: c.screen };
    return { kind: 'card', id: c.id, card: c };
  }

  _reachEnd(c) {
    const first = !this.gallery.ends[c.id];
    if (first) {
      this.gallery.ends[c.id] = this.now();
      this.events.push({ type: 'gallery' });
    }
    const s = this.s;
    const ln = this.story.lines[s.line];
    const self = this;
    return {
      id: c.id,
      kind: c.end.kind,
      title: c.end.title,
      say: c.say || '',
      img: c.img || '',
      mode: c.mode,
      line: s.line,
      lineName: ln ? ln.name : '',
      keys: s.keys.slice(0, 3),
      first,
      missed() { return self.missed(); },
    };
  }

  // ---- 选项 ----
  options() {
    const c = this.cur;
    if (!c || c.end || c.screen) return [];
    const out = optionsOf(c, this.s.props);
    const g = this.guide;
    if (g) {
      const st = g.path[g.i];
      if (st && st.card === c.id) {
        for (const o of out) if (o.sel === st.sel) o.guide = g.meet;
      }
    }
    return out;
  }

  _opt(c, sel) {
    return optOf(c, sel, this.s.props);
  }

  /** 该选项会改变的数值：{数值名: delta}（不含 0）。 */
  preview(sel) {
    const c = this.cur;
    if (!c) return {};
    const opt = this._opt(c, sel);
    if (!opt) return {};
    const sim = Object.assign({}, this.s.m);
    for (const e of opt.fx) {
      if (e.t !== 'm' || sim[e.n] === undefined) continue;
      sim[e.n] = clamp(e.o === '+' ? sim[e.n] + e.v : e.o === '-' ? sim[e.n] - e.v : e.v);
    }
    const out = {};
    for (const n in sim) {
      const d = sim[n] - this.s.m[n];
      if (d !== 0) out[n] = d;
    }
    return out;
  }

  _snap() {
    const s = this.s;
    return {
      card: s.card, m: Object.assign({}, s.m), props: s.props.slice(),
      flags: Object.assign({}, s.flags), keys: clone(s.keys),
      meets: s.meets.slice(), seen: s.seen.slice(),
    };
  }

  choose(sel) {
    const c = this.cur;
    if (!c || c.end) throw new Error('cannot choose on an end card');
    const opt = this._opt(c, sel);
    if (!opt) throw new Error('no such option ' + sel + ' on ' + c.id);
    const s = this.s;
    s.hist.push({ card: c.id, side: sel.charAt(0), sel, snap: this._snap() });
    if (s.hist.length > MAX_HIST) s.hist.shift();
    if (c.key && sel !== 'N') {
      const i = s.keys.findIndex((k) => k.key === c.key);
      const rec = { key: c.key, label: opt.t };
      if (i >= 0) s.keys[i] = rec; else s.keys.push(rec);
    }
    const fin = stepCore(this.story.cards, this.story.lines[s.line], s, this.gallery.globals, this.events, opt);
    const res = this._result(fin);
    this._advanceGuide(c.id, sel, res);
    return res;
  }

  /** 玩家按引路选了 -> 前进一步；选了别的 / 见到了目标 / 进了结局 / 走完 -> 清掉引路。 */
  _advanceGuide(cardId, sel, res) {
    const g = this.guide;
    if (!g) return;
    const st = g.path[g.i];
    if (!st || st.card !== cardId || st.sel !== sel || res.kind === 'end' || this.s.meets.indexOf(g.meet) >= 0) {
      this.guide = null;
      return;
    }
    g.i++;
    const nx = g.path[g.i];
    if (!nx || nx.card !== this.s.card) this.guide = null;
  }

  // ---- 沙盒搜索：错过的相遇 / 读档推荐 ----
  /**
   * 从 hist 某点的快照出发，在“沙盒”里按真实 choose 的语义（选项 fx -> 死亡检查 -> if/else -> 进卡 fx -> 死亡检查）
   * 最佳优先（静态图上离目标最近的先展开）找一条通往 goal 的选择序列：长线上目标在一百多步之外也能很快找到；
   * 找不到时同样会穷尽整张可达图，所以“没超预算 + 没找到”仍然等于“确实走不到”。沙盒是状态的副本：不碰 this.s / this.gallery / this.events，不登记结局。
   *   goal = {meet:'杰克爱'}：最终停在一张带该 meet 的普通卡上即成功（进卡就被 fx 弄死的不算，玩家根本看不到那张卡）；
   *   goal = {alive:true}：进入非 death 类结局卡即成功；
   *   其它结局卡 / screen 卡 = 这一支失败。
   * excludeSel：第一步排除的选择（当时实际选的那个；旧存档的 'P' 表示排除所有道具选项）。
   * budget：最多展开多少个状态（默认 SEARCH_BUDGET），超了按“找不到”处理（保守）。
   * memo：可选 Map，一次 missed()/rewindPoints() 内共享“已证明走不通”的状态，避免重复搜索。
   * 返回 null 或 [{card, sel, label}]（从该卡的第一步开始，到目标那一步为止）。
   */
  _search(snap, cardId, excludeSel, goal, budget, memo) {
    const stat = this._stat;
    stat.searches++;
    this._last = { expanded: 0, truncated: false, found: false };
    const root = this.card(cardId);
    if (!root || root.end || root.screen || !snap) return null;
    const ln = this.story.lines[(this.s && this.s.line) || root.ln];      // 死亡规则按“本局的线”判，和真实 enter 一致
    if (!ln) return null;
    const cards = this.story.cards;
    const limit = budget === undefined || budget === null ? SEARCH_BUDGET : budget;
    const rel = this._relevance();
    const reach = this._reachSet(goal);
    const dist = this._distTo(goal);
    const meters = (ln.meters || []).filter((n) => rel.meters.has(n));
    const fl = rel.flags;
    const gl = rel.globals;
    const wantMeet = goal.meet;
    const goalKey = wantMeet ? 'm:' + wantMeet : 'alive';
    let dead = null;
    if (memo) {
      dead = memo.get(goalKey);
      if (!dead) { dead = new Set(); memo.set(goalKey, dead); }
    }
    // 去重键：卡 + 影响行为的数值 + 道具（保持顺序：满 3 个会顶掉最早的）+ 被条件读到的 flags / 全局旗标
    const keyOf = (st, g) => {
      let k = st.card + '|';
      for (let i = 0; i < meters.length; i++) k += st.m[meters[i]] + ',';
      k += '|' + st.props.join(',') + '|';
      for (let i = 0; i < fl.length; i++) k += st.flags[fl[i]] ? '1' : '0';
      k += '|';
      for (let i = 0; i < gl.length; i++) k += g[gl[i]] ? '1' : '0';
      return k;
    };
    const rootS = {
      card: cardId, m: Object.assign({}, snap.m), props: (snap.props || []).slice(),
      flags: Object.assign({}, snap.flags || {}), meets: [], seen: [],
    };
    const rootG = Object.assign({}, this.gallery.globals);
    const visited = new Set();
    // 小顶堆：先比静态距离，再比入堆顺序（同距离时先进先出，保持确定性）
    const heap = [];
    let seq = 0;
    const less = (a, b) => a.pri < b.pri || (a.pri === b.pri && a.seq < b.seq);
    const push = (n) => {
      heap.push(n);
      let i = heap.length - 1;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (!less(heap[i], heap[pi])) break;
        const t = heap[i]; heap[i] = heap[pi]; heap[pi] = t; i = pi;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l], heap[m])) m = l;
          if (r < heap.length && less(heap[r], heap[m])) m = r;
          if (m === i) break;
          const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
        }
      }
      return top;
    };
    push({ s: rootS, g: rootG, parent: null, step: null, pri: 0, seq: seq++ });
    let expanded = 0;
    let truncated = false;
    let hit = null;
    while (heap.length && !hit) {
      if (expanded >= limit) { truncated = true; break; }
      expanded++;
      const node = pop();
      const c = cards[node.s.card];
      const isRoot = node.parent === null;
      const opts = optionsOf(c, node.s.props);
      for (let oi = 0; oi < opts.length; oi++) {
        const o = opts[oi];
        if (isRoot && isExcluded(o.sel, excludeSel)) continue;
        const opt = optOf(c, o.sel, node.s.props);
        if (!opt) continue;
        const ps = node.s;
        const cs = { card: ps.card, m: Object.assign({}, ps.m), props: ps.props.slice(), flags: Object.assign({}, ps.flags), meets: [], seen: [] };
        const cg = Object.assign({}, node.g);
        let fin;
        try {
          fin = stepCore(cards, ln, cs, cg, null, opt);
        } catch (e) {
          continue;                     // 剧本在这条分支上会抛错：当作走不通（真实游戏里同样走不下去）
        }
        const step = { card: c.id, sel: o.sel, label: opt.t };
        if (fin.end) {
          if (!wantMeet && fin.end.kind !== 'death') { hit = { parent: node, step }; break; }
          continue;
        }
        if (fin.screen) continue;
        if (wantMeet && fin.meet === wantMeet) { hit = { parent: node, step }; break; }
        if (!reach.has(fin.id)) continue;           // 静态图上都到不了目标：剪掉
        const key = keyOf(cs, cg);
        if (visited.has(key) || (dead && dead.has(key))) continue;
        visited.add(key);
        push({ s: cs, g: cg, parent: node, step, pri: dist[fin.id], seq: seq++ });
      }
    }
    stat.expanded += expanded;
    this._last = { expanded, truncated, found: !!hit };
    if (hit) {
      const path = [hit.step];
      for (let n = hit.parent; n && n.step; n = n.parent) path.push(n.step);
      return path.reverse();
    }
    if (truncated) {
      stat.truncated++;
    } else if (dead) {
      for (const k of visited) dead.add(k);         // 整张可达图都穷尽了还没有目标：里面每个状态都走不通
    }
    return null;
  }

  /** 静态图（忽略一切条件）上各卡的“反向邻居”：else / L / R / P / next，以及非结局卡 -> 本线死亡规则的结局。 */
  _staticRev() {
    if (this._rev) return this._rev;
    const rev = {};
    const add = (from, to) => { if (to) (rev[to] = rev[to] || []).push(from); };
    const cards = this.story.cards;
    for (const id in cards) {
      const c = cards[id];
      add(id, c.else);
      if (c.L) add(id, c.L.to);
      if (c.R) add(id, c.R.to);
      for (const p of (c.P || [])) add(id, p.to);
      add(id, c.next);
      if (!c.end) {
        const ln = this.story.lines[c.ln];
        for (const d of ((ln && ln.deaths) || [])) add(id, d.end);
      }
    }
    this._rev = rev;
    return rev;
  }

  /** 静态图上能走到目标的卡集合：只用来剪枝（它是真实可达的超集，剪掉的一定走不到）。 */
  _reachSet(goal) {
    const gk = goal.meet ? 'm:' + goal.meet : 'alive';
    if (this._reach[gk]) return this._reach[gk];
    const cards = this.story.cards;
    const rev = this._staticRev();
    const set = new Set();
    const q = [];
    for (const id in cards) {
      const c = cards[id];
      const isGoal = goal.meet ? (!c.end && !c.screen && c.meet === goal.meet) : !!(c.end && c.end.kind !== 'death');
      if (isGoal) { set.add(id); q.push(id); }
    }
    while (q.length) {
      const x = q.pop();
      for (const p of (rev[x] || [])) if (!set.has(p)) { set.add(p); q.push(p); }
    }
    this._reach[gk] = set;
    return set;
  }

  /** 静态图上各卡到目标的最少步数（_reachSet 的带距离版），给最佳优先搜索排序用。 */
  _distTo(goal) {
    const gk = 'd:' + (goal.meet ? 'm:' + goal.meet : 'alive');
    if (this._reach[gk]) return this._reach[gk];
    const cards = this.story.cards;
    const rev = this._staticRev();
    const dist = {};
    const q = [];
    for (const id in cards) {
      const c = cards[id];
      const isGoal = goal.meet ? (!c.end && !c.screen && c.meet === goal.meet) : !!(c.end && c.end.kind !== 'death');
      if (isGoal) { dist[id] = 0; q.push(id); }
    }
    for (let h = 0; h < q.length; h++) {
      const x = q[h];
      for (const p of (rev[x] || [])) if (dist[p] === undefined) { dist[p] = dist[x] + 1; q.push(p); }
    }
    this._reach[gk] = dist;
    return dist;
  }

  /** 会影响行为的名字：被 if 条件读到的 flags / 全局旗标 / 数值，加上死亡规则读的数值。没人读的不进去重键（合并等价状态）。 */
  _relevance() {
    if (this._rel) return this._rel;
    const flags = new Set();
    const globals = new Set();
    const meters = new Set();
    for (const id in this.story.cards) {
      for (const k of (this.story.cards[id].if || [])) {
        if (k.t === 'f') flags.add(k.n);
        else if (k.t === 'g') globals.add(k.n);
        else if (k.t === 'm') meters.add(k.n);
      }
    }
    for (const lid in this.story.lines) {
      for (const d of (this.story.lines[lid].deaths || [])) meters.add(d.meter);
    }
    this._rel = { flags: Array.from(flags).sort(), globals: Array.from(globals).sort(), meters };
    return this._rel;
  }

  /** hist 记录的完整选择。旧存档没有 sel：L/R/N 直接用 side；side 为 P 时按快照里的道具推断，推断不出就返回 'P'（= 所有道具选项）。 */
  _selOf(h, i) {
    if (h.sel) return h.sel;
    if (h.side !== 'P') return h.side;
    const c = this.card(h.card);
    const props = (h.snap && h.snap.props) || [];
    const cand = ((c && c.P) || []).filter((p) => props.indexOf(p.p) >= 0);
    if (cand.length === 1) return 'P:' + cand[0].p;
    const hist = this.s.hist;
    const after = i + 1 < hist.length ? hist[i + 1].snap.props : this.s.props;
    const used = cand.filter((p) => after.indexOf(p.p) < 0);
    return used.length === 1 ? 'P:' + used[0].p : 'P';
  }

  /**
   * 错过的相遇：本线每个还没遇见的 meet，从最近的 hist 点往前扫，取第一个（最晚的）在沙盒里真正走得到的点，
   * 返回 {meet, histIndex, cardId, path}，最多 3 个。path 是从该点换个选项一路走到那张 meet 卡的选择序列。
   */
  missed() {
    const s = this.s;
    const out = [];
    if (!s) return out;
    const memo = new Map();
    for (const meet of this.lineMeets(s.line)) {
      if (s.meets.indexOf(meet) >= 0) continue;
      for (let i = s.hist.length - 1; i >= 0; i--) {
        const h = s.hist[i];
        if (!this.card(h.card)) continue;
        const path = this._search(h.snap, h.card, this._selOf(h, i), { meet }, SEARCH_BUDGET, memo);
        if (path) {
          out.push({ meet, histIndex: i, cardId: h.card, path });
          break;
        }
      }
      if (out.length >= 3) break;
    }
    return out;
  }

  /** 本局 hist 里“当时有 ≥2 个可选项”的抉择点，最近的在前。便宜（不搜索）：UI 用它决定要不要显示“读档”。 */
  decisionPoints() {
    const s = this.s;
    const out = [];
    if (!s) return out;
    for (let i = s.hist.length - 1; i >= 0; i--) {
      const h = s.hist[i];
      const c = this.card(h.card);
      if (!c || c.end || c.screen) continue;
      if (optionsOf(c, (h.snap && h.snap.props) || []).length < 2) continue;
      const sel = this._selOf(h, i);
      const full = Array.from(String(c.say || c.who || '').replace(/\s+/g, ' ').trim());
      const text = full.slice(0, 16).join('');
      // more：卡面不止 16 字（UI 据此加省略号；刚好 16 字的不加）
      out.push({ histIndex: i, cardId: h.card, label: labelOf(c, sel) || '使用道具', text, more: full.length > 16, step: i + 1 });
    }
    return out;
  }

  /**
   * 读档面板的数据：{points, recommend, recommendPath}。
   * points：最近的 limit 个抉择点（最近的在前；推荐点若更早，会顶掉最后一格，保证它在表里）；
   * recommend：最晚的一个“换个选项还能走到非死亡结局”的点的 histIndex（用 {alive:true} 沙盒搜索），没有则 -1；
   * recommendPath：对应的选择序列（没有则 null）。
   */
  rewindPoints(limit) {
    const lim = limit === undefined ? 6 : limit;
    const all = this.decisionPoints();
    let recommend = -1;
    let recommendPath = null;
    if (all.length) {
      const memo = new Map();
      const hist = this.s.hist;
      for (const p of all) {
        const h = hist[p.histIndex];
        const path = this._search(h.snap, h.card, this._selOf(h, p.histIndex), { alive: true }, SEARCH_BUDGET, memo);
        if (path) { recommend = p.histIndex; recommendPath = path; break; }
      }
    }
    let points = all.slice(0, lim);
    if (recommend >= 0 && lim > 0 && !points.some((p) => p.histIndex === recommend)) {
      points = points.slice(0, lim - 1).concat(all.filter((p) => p.histIndex === recommend));
    }
    return { points, recommend, recommendPath };
  }

  /**
   * 回到 hist[idx] 那张卡，恢复当时的状态，不重复应用进卡 fx。
   * guide = {meet, path}：带上引路（options() 会给引路的下一步选项加 guide 标记）；不带则清掉引路。
   */
  restore(idx, guide) {
    const s = this.s;
    const h = s && s.hist[idx];
    if (!h) throw new Error('bad hist index ' + idx);
    const sn = clone(h.snap);
    s.m = sn.m;
    s.props = sn.props;
    s.flags = sn.flags;
    s.keys = sn.keys;
    s.meets = sn.meets;
    s.seen = sn.seen;
    s.card = h.card;
    s.hist = s.hist.slice(0, idx);
    this.guide = guide && guide.meet && Array.isArray(guide.path) && guide.path.length
      ? { meet: guide.meet, path: guide.path.map((x) => ({ card: x.card, sel: x.sel, label: x.label })), i: 0 }
      : null;
    return this._resultNoEnd(this.card(h.card));
  }

  _resultNoEnd(c) {
    if (c.screen) return { kind: 'screen', id: c.id, card: c, screen: c.screen };
    return { kind: 'card', id: c.id, card: c };
  }

  // ---- 图鉴视图 ----
  /**
   * 图鉴：先 common（序章、隐藏结局），再按选人页顺序每线一组。
   * locked 线和编译器标出的“永远到不了”的结局不计入；隐藏结局带 secret 标记，未解锁时 UI 显示“？？？”。
   */
  galleryView() {
    const groups = [];
    let got = 0;
    let total = 0;
    const skip = new Set(this.story.unreachable || []);
    const ids = ['common'].concat(this.story.order);
    for (const lid of ids) {
      const ln = this.story.lines[lid];
      if (!ln || ln.locked) continue;
      const ends = [];
      for (const id in this.story.cards) {
        const c = this.story.cards[id];
        if (c.ln !== lid || !c.end || skip.has(id)) continue;
        const unlocked = !!this.gallery.ends[id];
        ends.push({
          id, kind: c.end.kind, title: c.end.title, unlocked,
          secret: c.end.kind === 'hidden', at: this.gallery.ends[id] || null,
        });
        total++;
        if (unlocked) got++;
      }
      ends.sort((a, b) => END_KIND_ORDER.indexOf(a.kind) - END_KIND_ORDER.indexOf(b.kind));
      if (ends.length) groups.push({ line: lid, name: lid === 'common' ? '序章 · 隐藏' : ln.name, ends });
    }
    return { groups, got, total };
  }

  // ---- 预加载清单 ----
  /**
   * 从 card 出发一跳内可能进入的卡 id（L/R、持有道具时的 P、叙述卡的 next；
   * 目标若带 if/else，则把 else 链也算进去）。不改状态。
   */
  nextIds(card) {
    const c = card || this.cur;
    const out = [];
    if (!c || c.end) return out;
    const raw = [];
    if (c.L || c.R) {
      if (c.L) raw.push(c.L.to);
      if (c.R) raw.push(c.R.to);
      for (const p of (c.P || [])) {
        if (!this.s || this.s.props.indexOf(p.p) >= 0) raw.push(p.to);
      }
    } else if (c.next) {
      raw.push(c.next);
    }
    const add = (id, depth) => {
      const t = id ? this.card(id) : null;
      if (!t || out.indexOf(id) >= 0) return;
      out.push(id);
      if (t.if && t.if.length && t.else && depth < MAX_HOPS) add(t.else, depth + 1);
    };
    raw.forEach((id) => add(id, 0));
    return out;
  }

  /** 一跳内可能进入的卡所需素材：{imgs:[key], sfx:[key]}（去重）。只给出清单，不加载。 */
  preloadList(card) {
    const imgs = [];
    const sfx = [];
    const addImg = (k) => { if (k && imgs.indexOf(k) < 0) imgs.push(k); };
    for (const id of this.nextIds(card)) {
      const t = this.card(id);
      if (t.img && (t.mode !== 'text' || t.end)) addImg(t.img);
      if (t.frames) t.frames.forEach((f) => addImg(f.img));
      if (t.screen === 'select') {
        this.story.order.forEach((lid) => addImg(this.story.lines[lid].portrait));
      }
      if (t.sfx && sfx.indexOf(t.sfx) < 0) sfx.push(t.sfx);
    }
    return { imgs, sfx };
  }
}
