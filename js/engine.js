// 纯逻辑引擎：不碰 DOM、不碰 localStorage，可在 node 下单测。
// 状态结构见 ENGINE_SPEC 第 4 节。

const MAX_HIST = 80;
const MAX_PROPS = 3;
const MAX_HOPS = 20;
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

  // ---- 条件与效果 ----
  check(conds) {
    if (!conds || !conds.length) return true;
    const s = this.s;
    for (const k of conds) {
      let ok;
      if (k.t === 'p') ok = s.props.indexOf(k.n) >= 0;
      else if (k.t === 'f') ok = !!s.flags[k.n];
      else if (k.t === 'g') ok = !!this.gallery.globals[k.n];
      else if (k.t === 'm') ok = s.m[k.n] !== undefined && cmp(s.m[k.n], k.o, k.v);
      else ok = false;
      if (k.neg) ok = !ok;
      if (!ok) return false;
    }
    return true;
  }

  applyFx(list) {
    if (!list) return;
    const s = this.s;
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
            this.events.push({ type: 'toast', text: '道具栏已满，【' + dropped + '】被顶掉了' });
          }
        } else if (i >= 0) {
          s.props.splice(i, 1);
        }
      } else if (e.t === 'f') {
        if (e.o === '+') s.flags[e.n] = true; else delete s.flags[e.n];
      } else if (e.t === 'g') {
        if (e.o === '+') this.gallery.globals[e.n] = true; else delete this.gallery.globals[e.n];
        this.events.push({ type: 'gallery' });
      }
    }
  }

  checkDeath() {
    const ln = this.line();
    if (!ln || !ln.deaths) return null;
    for (const d of ln.deaths) {
      const v = this.s.m[d.meter];
      if (v !== undefined && cmp(v, d.op, d.val)) return d.end;
    }
    return null;
  }

  // ---- 进卡 ----
  enter(cardId) {
    const s = this.s;
    let id = cardId;
    let hops = 0;
    let c;
    for (;;) {
      c = this.card(id);
      if (!c) throw new Error('missing card ' + id);
      if (c.if && c.if.length && !this.check(c.if)) {
        if (++hops > MAX_HOPS) throw new Error('if/else chain longer than ' + MAX_HOPS + ' at ' + cardId);
        if (!c.else) throw new Error('if card without else: ' + id);
        id = c.else;
        continue;
      }
      break;
    }
    s.card = id;
    this.applyFx(c.fx);
    if (c.meet && s.meets.indexOf(c.meet) < 0) s.meets.push(c.meet);
    if (s.seen.indexOf(id) < 0) s.seen.push(id);
    if (!c.end) {
      const dead = this.checkDeath();
      if (dead) return this.enter(dead);
    }
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
    const out = [];
    if (c.L || c.R) {
      if (c.L) out.push({ side: 'L', sel: 'L', label: c.L.t });
      if (c.R) out.push({ side: 'R', sel: 'R', label: c.R.t });
      for (const p of (c.P || [])) {
        if (this.s.props.indexOf(p.p) >= 0) {
          out.push({ side: 'P', sel: 'P:' + p.p, label: p.t, prop: p.p });
        }
      }
    } else if (c.next) {
      out.push({ side: 'N', sel: 'N', label: '继续' });
    }
    return out;
  }

  _opt(c, sel) {
    if (sel === 'N') return c.next ? { t: '继续', fx: [], to: c.next } : null;
    if (sel === 'L' || sel === 'R') return c[sel] || null;
    if (typeof sel === 'string' && sel.indexOf('P:') === 0) {
      const name = sel.slice(2);
      if (this.s.props.indexOf(name) < 0) return null;
      const list = c.P || [];
      for (const p of list) if (p.p === name) return p;
    }
    return null;
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
    s.hist.push({ card: c.id, side: sel.charAt(0), snap: this._snap() });
    if (s.hist.length > MAX_HIST) s.hist.shift();
    if (c.key && sel !== 'N') {
      const i = s.keys.findIndex((k) => k.key === c.key);
      const rec = { key: c.key, label: opt.t };
      if (i >= 0) s.keys[i] = rec; else s.keys.push(rec);
    }
    this.applyFx(opt.fx);
    const dead = this.checkDeath();
    return this.enter(dead || opt.to);
  }

  // ---- 错过的相遇 ----
  _graphNext(c) {
    const out = [];
    if (c.else) out.push(c.else);
    if (c.L) out.push(c.L.to);
    if (c.R) out.push(c.R.to);
    for (const p of (c.P || [])) out.push(p.to);
    if (c.next) out.push(c.next);
    return out;
  }

  _canReachMeet(from, meet) {
    const cards = this.story.cards;
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const id = q.shift();
      const c = cards[id];
      if (!c) continue;
      if (c.meet === meet) return true;
      if (c.end) continue;
      for (const t of this._graphNext(c)) {
        if (t && !seen.has(t)) { seen.add(t); q.push(t); }
      }
    }
    return false;
  }

  missed() {
    const s = this.s;
    const out = [];
    for (const meet of this.lineMeets(s.line)) {
      if (s.meets.indexOf(meet) >= 0) continue;
      for (let i = s.hist.length - 1; i >= 0; i--) {
        const h = s.hist[i];
        const c = this.card(h.card);
        if (!c) continue;
        let found = false;
        for (const side of ['L', 'R']) {
          if (side === h.side || !c[side]) continue;
          if (this._canReachMeet(c[side].to, meet)) { found = true; break; }
        }
        if (found) {
          out.push({ meet, histIndex: i, cardId: h.card });
          break;
        }
      }
      if (out.length >= 3) break;
    }
    return out;
  }

  /** 回到 hist[idx] 那张卡，恢复当时的状态，不重复应用进卡 fx。 */
  restore(idx) {
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
