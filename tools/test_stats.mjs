// 统计模块测试：只在正式网址开启；录屏 / debug / 请勿追踪 / 本地一律不发；请求体格式；每页上限；来源只留域名。
// 用法：node tools/test_stats.mjs
import assert from 'node:assert/strict';
import * as S from '../js/stats.js';

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok  ', name); }
function env(over) {
  const calls = [];
  const e = {
    location: { protocol: 'https:', hostname: S.HOST },
    navigator: { language: 'zh-CN' },
    screen: { width: 390, height: 844 },
    document: { referrer: '' },
    fetch: (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); },
  };
  Object.assign(e, over || {});
  e.calls = calls;
  return e;
}
const live = !!S.WEBSITE;

t('WEBSITE 是空串或 UUID（公开 ID，不是密钥）', () => {
  assert.ok(S.WEBSITE === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(S.WEBSITE));
  assert.equal(S.ENDPOINT, 'https://cloud.umami.is/api/send');
});
t('本地 / http / 录屏 / debug / DNT / GPC：不开、不发', () => {
  const cases = [
    env({ location: { protocol: 'http:', hostname: '127.0.0.1' } }),
    env({ location: { protocol: 'https:', hostname: 'evil.example' } }),
    env({ navigator: { doNotTrack: '1' } }),
    env({ navigator: { globalPrivacyControl: true } }),
  ];
  for (const e of cases) { assert.equal(S.initStats({}, e), false); S.pageview(); S.track('x'); assert.equal(e.calls.length, 0); }
  for (const o of [{ rec: true }, { debug: true }]) { const e = env(); assert.equal(S.initStats(o, e), false); S.pageview(); assert.equal(e.calls.length, 0); }
});
if (live) {
  t('正式网址：pageview / track 的请求体', () => {
    const e = env({ document: { referrer: 'https://www.bilibili.com/video/BV1xx?spm=abc' } });
    assert.equal(S.initStats({}, e), true);
    S.pageview();
    S.track('结局·黄金之路', { id: 'bin.end.gold', line: 'bin', kind: 'prologue' });
    assert.equal(e.calls.length, 2);
    for (const c of e.calls) {
      assert.equal(c.url, S.ENDPOINT);
      assert.equal(c.init.method, 'POST'); assert.equal(c.init.credentials, 'omit'); assert.equal(c.init.keepalive, true);
      const b = JSON.parse(c.init.body);
      assert.equal(b.type, 'event');
      assert.equal(b.payload.website, S.WEBSITE); assert.equal(b.payload.hostname, S.HOST); assert.equal(b.payload.url, '/');
      assert.equal(b.payload.referrer, 'https://www.bilibili.com/');          // 只留域名
      assert.equal(b.payload.screen, '390x844'); assert.equal(b.payload.language, 'zh-CN');
      assert.deepEqual(Object.keys(b.payload).filter((k) => !['website', 'hostname', 'url', 'title', 'language', 'screen', 'referrer', 'name', 'data'].includes(k)), []);
    }
    const ev = JSON.parse(e.calls[1].init.body).payload;
    assert.equal(ev.name, '结局·黄金之路'); assert.deepEqual(ev.data, { id: 'bin.end.gold', line: 'bin', kind: 'prologue' });
    assert.equal(JSON.parse(e.calls[0].init.body).payload.name, undefined);
  });
  t('同站来源不记 referrer；事件名截到 50 字', () => {
    const e = env({ document: { referrer: 'https://' + S.HOST + '/?x=1' } });
    S.initStats({}, e);
    S.track('长'.repeat(80));
    const p = JSON.parse(e.calls[0].init.body).payload;
    assert.equal(p.referrer, undefined); assert.equal(p.name.length, 50);
  });
  t('每页最多 MAX_SENDS 条；fetch 抛错 / reject 都不外泄', () => {
    const e = env();
    S.initStats({}, e);
    for (let i = 0; i < S.MAX_SENDS + 20; i++) S.track('读档');
    assert.equal(e.calls.length, S.MAX_SENDS);
    const bad = env({ fetch: () => { throw new Error('boom'); } });
    S.initStats({}, bad); assert.equal(S.track('x'), false);
    const rej = env({ fetch: () => Promise.reject(new Error('net')) });
    S.initStats({}, rej); assert.equal(S.track('x'), true);
  });
} else {
  t('WEBSITE 为空：正式网址上也不发', () => {
    const e = env(); assert.equal(S.initStats({}, e), false); S.pageview(); assert.equal(e.calls.length, 0);
  });
}
console.log(`\nALL PASSED (${pass} tests)${live ? '' : '  [WEBSITE 未填，只测了关闭路径]'}`);
