// 本地存档：localStorage 不可用（隐私模式、部分 WebView）时退化为内存存档。
const KEYS = { run: 'lc.run', gallery: 'lc.gallery', settings: 'lc.settings', ver: 'lc.ver' };
const mem = {};
let ls = null;
try {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('lc.__t', '1');
    localStorage.removeItem('lc.__t');
    ls = localStorage;
  }
} catch (e) {
  ls = null;
}

function rawGet(k) {
  try {
    return ls ? ls.getItem(k) : (k in mem ? mem[k] : null);
  } catch (e) {
    return k in mem ? mem[k] : null;
  }
}

function rawSet(k, v) {
  mem[k] = v;
  try {
    if (ls) ls.setItem(k, v);
  } catch (e) { /* 配额满或被禁用：保留内存副本 */ }
}

function rawDel(k) {
  delete mem[k];
  try {
    if (ls) ls.removeItem(k);
  } catch (e) { /* ignore */ }
}

function getJSON(k, def) {
  const raw = rawGet(k);
  if (raw === null || raw === undefined) return def;
  try {
    const v = JSON.parse(raw);
    return v === null ? def : v;
  } catch (e) {
    return def;
  }
}

function setJSON(k, v) {
  try {
    rawSet(k, JSON.stringify(v));
  } catch (e) { /* ignore */ }
}

export function persistent() { return !!ls; }

export function loadRun() { return getJSON(KEYS.run, null); }
export function saveRun(run) { if (run) setJSON(KEYS.run, run); }
export function clearRun() { rawDel(KEYS.run); }

export function loadGallery() {
  const g = getJSON(KEYS.gallery, null);
  const ok = g && typeof g === 'object';
  return {
    ends: ok && g.ends && typeof g.ends === 'object' ? g.ends : {},
    globals: ok && g.globals && typeof g.globals === 'object' ? g.globals : {},
  };
}
export function saveGallery(g) { setJSON(KEYS.gallery, g); }

export function loadSettings() {
  const s = getJSON(KEYS.settings, {});
  return { muted: !!(s && s.muted) };
}
export function saveSettings(s) { setJSON(KEYS.settings, s); }

export function getVer() { return rawGet(KEYS.ver); }
export function setVer(v) { rawSet(KEYS.ver, String(v)); }

export function clearAll() {
  for (const k in KEYS) rawDel(KEYS[k]);
}
