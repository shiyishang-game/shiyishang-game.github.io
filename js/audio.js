// WebAudio：第一次用户点击时创建并 resume；同一时间只播一句；文件缺失静默。
let ctx = null;
let muted = false;
let current = null;
let seq = 0;
const cache = new Map(); // key -> AudioBuffer | null（null 表示缺失）
const pending = new Map();

export function init(initialMuted) {
  muted = !!initialMuted;
}

export function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  } catch (e) { /* ignore */ }
}

export function isUnlocked() { return !!ctx && ctx.state === 'running'; }
export function isMuted() { return muted; }

export function setMuted(m) {
  muted = !!m;
  if (muted) stop();
}

export function stop() {
  seq++;
  if (current) {
    try { current.onended = null; current.stop(); } catch (e) { /* ignore */ }
    current = null;
  }
}

function decode(buf) {
  return new Promise(function (resolve) {
    try {
      const p = ctx.decodeAudioData(buf, resolve, function () { resolve(null); });
      if (p && p.then) p.then(resolve, function () { resolve(null); });
    } catch (e) {
      resolve(null);
    }
  });
}

function load(key) {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);
  const p = fetch('assets/sfx/' + key + '.mp3')
    .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
    .then(function (b) { return b ? decode(b) : null; })
    .catch(function () { return null; })
    .then(function (buf) {
      cache.set(key, buf);
      pending.delete(key);
      return buf;
    });
  pending.set(key, p);
  return p;
}

/**
 * 预取并解码一批原声放进缓存，下一张卡要播时就不用等。
 * 只在已经解锁（用户点过）且没静音时才做；文件缺失静默。
 */
export function preload(keys) {
  if (!ctx || muted || !keys || !keys.length) return;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]) load(keys[i]);
  }
}

export function play(key) {
  stop();
  if (!key || muted || !ctx) return Promise.resolve(false);
  const mine = seq;
  return load(key).then(function (buf) {
    if (!buf || mine !== seq || muted) return false;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = function () { if (current === src) current = null; };
      current = src;
      src.start(0);
      return true;
    } catch (e) {
      return false;
    }
  });
}
