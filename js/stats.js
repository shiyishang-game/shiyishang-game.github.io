// 匿名游玩统计：直接把计数请求发给 Umami Cloud（cloud.umami.is，国内直连约 0.3 s）。
// - 不加载任何第三方脚本：只有一个 fetch POST，CSP 只放开 connect-src 这一个域名。
// - 不用 Cookie / localStorage，不发设备 ID；访客去重由 Umami 服务端按「IP+UA+站点」的轮换哈希算，看不到原始 IP。
// - 只发：页面地址、语言、屏幕尺寸、来源网站的域名（不带路径），以及事件名（开始 / 选人 / 结局 / 海报 / 读档）。
// - 只在正式网址上统计；本地、?rec=1 录屏、?debug=1、浏览器开了「请勿追踪」/ GPC 时一律不发。
// - 失败静默：统计永远不影响游戏。

export const ENDPOINT = 'https://cloud.umami.is/api/send';
/** Umami 后台的 Website ID（公开值，写在网页里没关系，不是密钥）。为空 = 统计关闭。 */
export const WEBSITE = '';
export const HOST = 'shiyishang-game.github.io';
/** 每次打开页面最多发这么多条（免费额度 10 万条/月，防止刷屏的人把额度用光）。 */
export const MAX_SENDS = 30;

let on = false;
let sent = 0;
let ref = '';
let win = null;

/** opts: {rec, debug}；env 只给测试用（默认取浏览器全局）。返回是否开启。 */
export function initStats(opts, env) {
  win = env || (typeof window !== 'undefined' ? window : null);
  sent = 0;
  on = false;
  if (!WEBSITE || !win || (opts && (opts.rec || opts.debug))) return on;
  try {
    const loc = win.location;
    if (loc.protocol !== 'https:' || loc.hostname !== HOST) return on;
    const nav = win.navigator || {};
    if (nav.doNotTrack === '1' || win.doNotTrack === '1' || nav.globalPrivacyControl === true) return on;
    ref = '';
    const r = win.document && win.document.referrer;
    if (r) {
      const u = new URL(r);
      if (u.hostname !== HOST) ref = u.protocol + '//' + u.hostname + '/';   // 只留来源域名，丢掉路径和参数
    }
    on = typeof win.fetch === 'function';
  } catch (e) {
    on = false;
  }
  return on;
}

function base() {
  const nav = win.navigator || {};
  const scr = win.screen || {};
  const p = {
    website: WEBSITE,
    hostname: HOST,
    url: '/',
    title: '撸城：谁是世一上',
    language: String(nav.language || '').slice(0, 35),
    screen: (scr.width | 0) + 'x' + (scr.height | 0),
  };
  if (ref) p.referrer = ref;
  return p;
}

function send(payload) {
  if (!on || sent >= MAX_SENDS) return false;
  sent++;
  try {
    win.fetch(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ type: 'event', payload }),
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
      mode: 'cors',
      cache: 'no-store',
    }).catch(function () { /* 静默 */ });
  } catch (e) {
    return false;
  }
  return true;
}

/** 打开页面（Umami 里算一次浏览，并据此算访客数）。 */
export function pageview() {
  return send(base());
}

/** 自定义事件：name 进事件列表（≤50 字），data 进事件属性（只放剧本里的 id / 名字，不放玩家输入——本来也没有输入）。 */
export function track(name, data) {
  const p = base();
  p.name = String(name).slice(0, 50);
  if (data) p.data = data;
  return send(p);
}
