// 分享海报：Canvas 1080x1920，本地生成，toDataURL 输出 PNG。
//
// 版式（自上而下，互不重叠）：
//   页眉：游戏名
//   正文：结局图（原剧帧按原比例；太方/太竖的图完整显示，两侧垫模糊同图，不裁）→ 我成为了【…】→ 类型角标 → 结局名 → 关键选择
//         正文整体在页眉和页脚之间竖向居中；放不下时先压缩图的高度
//   页脚：二维码 + 网址 + 声明，贴底
//   底层：结局图的模糊放大版 + 暗色渐变（不用 ctx.filter，Safari 不支持；改用“缩小再放大”）
const W = 1080;
const H = 1920;
const M = 60;                       // 左右边距
const FONT = '"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const KIND = {
  death: { name: '作死结局', color: '#e5484d' },
  prologue: { name: '序章结局', color: '#f5c542' },
  if: { name: 'IF · 平行番外', color: '#4a90e2' },
  hidden: { name: '隐藏结局', color: '#9b59b6' },
};
const IMG_W = W - 2 * M;            // 结局图显示宽 960
const IMG_H_MAX = 620;              // 图的最大显示高度；2.12:1 / 16:9 的原帧按原比例，不会碰到这个上限
const IMG_H_MIN = 340;              // 空间不够时最多压到这么矮
// qr.png 是 37 格（29 格码 + 4 格静区×2）× 每格 10px = 370px。画成 296px = 每格正好 8px，边缘不糊
const QR_PX = 296;

function loadImage(src) {
  return new Promise(function (resolve) {
    if (!src) { resolve(null); return; }
    const im = new Image();
    im.onload = function () { resolve(im); };
    im.onerror = function () { resolve(null); };
    im.src = src;
  });
}

function wrap(ctx, text, maxW) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') { out.push(line); line = ''; continue; }
    if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else { line += ch; }
  }
  if (line) out.push(line);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cover(ctx, im, x, y, w, h) {
  const s = Math.max(w / im.width, h / im.height);
  const dw = im.width * s;
  const dh = im.height * s;
  ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 字号从 size 往下缩到 minSize，放进 maxW；还不行就截断加省略号。font 形如 'bold ' / 'italic bold '。 */
function fitText(ctx, text, font, size, minSize, maxW) {
  for (let s = size; s >= minSize; s -= 2) {
    ctx.font = font + s + 'px ' + FONT;
    if (ctx.measureText(text).width <= maxW) return { size: s, text: text };
  }
  ctx.font = font + minSize + 'px ' + FONT;
  let t = String(text);
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return { size: minSize, text: t + '…' };
}

/** 把图模糊后铺满 (x,y,w,h)：缩成很小的图再两级放大，等效高斯模糊（不用 ctx.filter，Safari 不支持） */
function blurRect(ctx, im, x, y, w, h) {
  const tw = 40;
  const th = Math.max(8, Math.round(tw * h / w));
  const tiny = document.createElement('canvas');
  tiny.width = tw;
  tiny.height = th;
  const t = tiny.getContext('2d');
  t.imageSmoothingQuality = 'high';
  cover(t, im, 0, 0, tw, th);
  const mid = document.createElement('canvas');
  mid.width = tw * 6;
  mid.height = th * 6;
  const m = mid.getContext('2d');
  m.imageSmoothingEnabled = true;
  m.imageSmoothingQuality = 'high';
  m.drawImage(tiny, 0, 0, mid.width, mid.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid, x, y, w, h);
}

function blurFill(ctx, im) {
  blurRect(ctx, im, 0, 0, W, H);
}

function drawBackdrop(ctx, art) {
  if (art) {
    blurFill(ctx, art);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#4a2468');
    g.addColorStop(1, '#1b2f5e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const sh = ctx.createLinearGradient(0, 0, 0, H);
  sh.addColorStop(0, 'rgba(10,8,20,0.55)');
  sh.addColorStop(0.5, 'rgba(10,8,20,0.72)');
  sh.addColorStop(1, 'rgba(10,8,20,0.95)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, W, H);
}

function drawArt(ctx, art, kind, y, h) {
  const x = M;
  const w = IMG_W;
  ctx.save();                                   // 先画一块带阴影的底
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 44;
  ctx.shadowOffsetY = 14;
  roundRect(ctx, x, y, w, h, 24);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, x, y, w, h, 24);
  ctx.clip();
  if (art) {
    const r = art.width / art.height;
    if (r >= (w / h) * 0.85) {
      cover(ctx, art, x, y, w, h);                 // 比例接近：铺满，最多裁掉一点边
    } else {
      blurRect(ctx, art, x, y, w, h);              // 太方/太竖：整张完整显示，两侧垫模糊放大的同一张图
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, y, w, h);
      const dw = h * r;
      ctx.drawImage(art, x + (w - dw) / 2, y, dw, h);
    }
  } else {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#5a2a6e');
    g.addColorStop(1, '#1d3a6b');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  roundRect(ctx, x, y, w, h, 24);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.stroke();
  // 类型色的细条贴在图下沿，把图和下面的字自然连起来
  ctx.fillStyle = kind.color;
  ctx.fillRect(x + 40, y + h + 14, w - 80, 4);
}

/** 页脚：二维码 + 网址 + 声明，贴底。返回页脚区域的顶部 y。 */
function drawFooter(ctx, qr) {
  const pad = 20;
  const panel = QR_PX + pad * 2;
  const py = H - 132 - panel;
  const px = W - M - panel;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 50px ' + FONT;
  ctx.fillText('你也来当世一上', M, py + 118);
  ctx.fillStyle = '#ff7ab8';
  ctx.font = '38px ' + FONT;
  ctx.fillText('shiyishang-game.github.io', M, py + 186);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '28px ' + FONT;
  ctx.fillText('长按识别二维码，来撸城', M, py + 246);

  ctx.fillStyle = '#fff';
  roundRect(ctx, px, py, panel, panel, 20);
  ctx.fill();
  if (qr) {
    ctx.imageSmoothingEnabled = false;          // 保持方块边缘锐利，方便识别
    ctx.drawImage(qr, px + pad, py + pad, QR_PX, QR_PX);
    ctx.imageSmoothingEnabled = true;
  } else {
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 3;
    roundRect(ctx, px + pad, py + pad, QR_PX, QR_PX, 16);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#888';
    ctx.font = '28px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText('二维码', px + panel / 2, py + panel / 2 + 10);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '30px ' + FONT;
  ctx.fillText('AI 生成内容 · 同人非商业', W / 2, H - 62);
  return py - 44;
}

/** info: engine 的结局信息；返回 Promise<dataURL> */
export function makePoster(info) {
  return Promise.all([
    loadImage(info.img ? 'assets/img/' + info.img + '.webp' : ''),
    loadImage('assets/ui/qr.png'),
  ]).then(function (res) {
    const art = res[0];
    const qr = res[1];
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const kind = KIND[info.kind] || KIND.prologue;
    const isCommon = info.line === 'common';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';

    drawBackdrop(ctx, art);

    // 页眉
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 60px ' + FONT;
    ctx.fillText('撸城：谁是世一上', W / 2, 118);
    const headBottom = 150;

    // 页脚（先画，拿到它的顶）
    const footTop = drawFooter(ctx, qr);

    // ---- 量正文各块的高度 ----
    const textW = IMG_W - 40;
    const headline = isCommon ? '我在撸城的结局是——' : '我成为了【' + (info.lineName || '') + '】';
    const headFit = fitText(ctx, headline, 'bold ', 56, 36, textW);
    const headH = 56;
    const badgeH = 62;
    const title = fitTitle(ctx, String(info.title || ''), textW);
    const titleH = title.lines.length * Math.round(title.size * 1.2);

    const keys = (info.keys || []).slice(0, 3);
    let tail = null;                       // 关键选择，或没有关键选择时的结局文案
    let tailH = 0;
    if (keys.length) {
      tailH = 44 + 12 + keys.length * 74;
      tail = { type: 'keys' };
    } else {
      ctx.font = '40px ' + FONT;
      const quote = wrap(ctx, String(info.say || ''), IMG_W - 120).slice(0, 4);
      if (quote.length) {
        tail = { type: 'quote', lines: quote };
        tailH = 36 + quote.length * 56;
      }
    }

    const gaps = { art: 50, head: 30, badge: 26, title: tail ? 44 : 0 };
    let artH = art ? Math.max(IMG_H_MIN, Math.min(IMG_H_MAX, Math.round(IMG_W * art.height / art.width))) : 440;
    const rest = headH + gaps.head + badgeH + gaps.badge + titleH + gaps.title + tailH;
    const avail = footTop - headBottom - 36;
    const total = artH + gaps.art + rest;
    if (total > avail) artH = Math.max(IMG_H_MIN, artH - (total - avail));
    const used = artH + gaps.art + rest;
    let y = headBottom + 18 + Math.max(0, Math.round((avail - used) / 2));

    // ---- 画正文 ----
    drawArt(ctx, art, kind, y, artH);
    y += artH + gaps.art;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#f5c542';
    ctx.font = 'bold ' + headFit.size + 'px ' + FONT;
    ctx.fillText(headFit.text, W / 2, y + headH - 12);
    y += headH + gaps.head;

    ctx.font = 'bold 36px ' + FONT;
    const kw = ctx.measureText(kind.name).width + 56;
    roundRect(ctx, (W - kw) / 2, y, kw, badgeH, badgeH / 2);
    ctx.fillStyle = kind.color;
    ctx.fill();
    ctx.fillStyle = isLight(kind.color) ? '#222' : '#fff';
    ctx.fillText(kind.name, W / 2, y + 43);
    y += badgeH + gaps.badge;

    ctx.font = 'italic bold ' + title.size + 'px ' + FONT;
    ctx.fillStyle = '#ff4fa3';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(6, Math.round(title.size / 11));
    const lh = Math.round(title.size * 1.2);
    title.lines.forEach(function (ln) {
      ctx.strokeText(ln, W / 2, y + Math.round(title.size * 0.92));
      ctx.fillText(ln, W / 2, y + Math.round(title.size * 0.92));
      y += lh;
    });
    y += gaps.title;

    if (tail && tail.type === 'keys') {
      ctx.textAlign = 'center';
      ctx.font = '34px ' + FONT;
      ctx.fillStyle = '#bbb';
      ctx.fillText('我的关键选择', W / 2, y + 32);
      y += 44 + 12;
      keys.forEach(function (k) {
        roundRect(ctx, M + 10, y, IMG_W - 20, 64, 14);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9fb0b0';
        ctx.font = '30px ' + FONT;
        ctx.fillText(k.key, M + 34, y + 43);
        const keyW = ctx.measureText(k.key).width;
        const lab = fitText(ctx, String(k.label), 'bold ', 36, 24, IMG_W - 20 - 68 - keyW - 30);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'right';
        ctx.fillText(lab.text, W - M - 34, y + 44);
        y += 74;
      });
    } else if (tail && tail.type === 'quote') {
      ctx.textAlign = 'center';
      ctx.font = '40px ' + FONT;
      roundRect(ctx, M + 10, y, IMG_W - 20, tailH - 6, 18);
      ctx.fillStyle = 'rgba(255,255,255,0.09)';
      ctx.fill();
      ctx.fillStyle = '#e8e8f0';
      tail.lines.forEach(function (ln, i) {
        ctx.fillText(ln, W / 2, y + 50 + i * 56);
      });
    }

    return cv.toDataURL('image/png');
  });
}

/** 结局名：先尽量一行（字号从 88 缩到 56），再不行拆成两行。 */
function fitTitle(ctx, text, maxW) {
  for (let size = 88; size >= 56; size -= 4) {
    ctx.font = 'italic bold ' + size + 'px ' + FONT;
    if (ctx.measureText(text).width <= maxW) return { size: size, lines: [text] };
  }
  const size = 64;
  ctx.font = 'italic bold ' + size + 'px ' + FONT;
  let lines = wrap(ctx, text, maxW);
  if (lines.length > 2) {
    lines = lines.slice(0, 2);
    lines[1] = lines[1].slice(0, -1) + '…';
  }
  return { size: size, lines: lines };
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r * 0.299 + g * 0.587 + b * 0.114 > 150;
}
