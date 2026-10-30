// 拖拽手势（pointer events）和键盘。只负责产生事件，不改 DOM。
const COMMIT_RATIO = 0.28;   // 位移超过卡宽 28% 就提交
const COMMIT_SPEED = 0.6;    // 速度大于 0.6 px/ms 也提交
const START_SLOP = 6;

/**
 * @param {HTMLElement} area 接收手势的区域
 * @param {object} h
 *   getWidth(): 卡片宽度
 *   enabled(): 是否可拖
 *   onStart(), onMove(dx), onEnd(dx, side|null)   side = 'L' | 'R' | null（回弹）
 */
export function attachDrag(area, h) {
  let id = null;
  let x0 = 0;
  let y0 = 0;
  let dragging = false;
  let lastX = 0;
  let lastT = 0;
  let v = 0;

  area.addEventListener('pointerdown', function (e) {
    if (id !== null || !h.enabled()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    id = e.pointerId;
    x0 = lastX = e.clientX;
    y0 = e.clientY;
    lastT = e.timeStamp;
    v = 0;
    dragging = false;
  });

  area.addEventListener('pointermove', function (e) {
    if (e.pointerId !== id) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.5) { id = null; return; }
      dragging = true;
      try { area.setPointerCapture(id); } catch (err) { /* ignore */ }
      h.onStart();
    }
    const dt = Math.max(1, e.timeStamp - lastT);
    v = 0.7 * v + 0.3 * ((e.clientX - lastX) / dt);
    lastX = e.clientX;
    lastT = e.timeStamp;
    h.onMove(dx);
  });

  function finish(e, cancelled) {
    if (e.pointerId !== id) return;
    const was = dragging;
    const dx = e.clientX - x0;
    id = null;
    dragging = false;
    try { area.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (!was) return;
    let side = null;
    if (!cancelled) {
      const far = Math.abs(dx) > h.getWidth() * COMMIT_RATIO;
      const fast = Math.abs(v) > COMMIT_SPEED && Math.abs(dx) > 12 && (v > 0) === (dx > 0);
      if (far || fast) side = dx < 0 ? 'L' : 'R';
    }
    h.onEnd(dx, side);
  }
  area.addEventListener('pointerup', function (e) { finish(e, false); });
  area.addEventListener('pointercancel', function (e) { finish(e, true); });
}

/**
 * 键盘。只报“按了哪一类键”，含义由调用方按当前卡片决定：
 *   'left'  A / ←        'right' D / →       'up' ↑      'down' ↓
 *   'prop'  W / E        'ok'    空格 / 回车
 * cb(key, event) 返回 true 表示它处理了这次按键（这里就 preventDefault）；
 * 返回 false 则保持浏览器默认行为（比如焦点在某个按钮上时回车/空格触发它的点击）。
 */
export function attachKeys(cb, active) {
  const handled = new Set();   // keydown 已处理的物理键：它的 keyup 也要吞掉，免得某些浏览器在 keyup 时给刚获得焦点的按钮补一个点击
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (!active()) return;
    let key = null;
    switch (e.key) {
      case 'a': case 'A': case 'ArrowLeft': key = 'left'; break;
      case 'd': case 'D': case 'ArrowRight': key = 'right'; break;
      case 'ArrowUp': key = 'up'; break;
      case 'ArrowDown': key = 'down'; break;
      case 'w': case 'W': case 'e': case 'E': key = 'prop'; break;
      case ' ': case 'Enter': key = 'ok'; break;
      default: return;
    }
    if (cb(key, e)) {
      e.preventDefault();
      handled.add(e.code || e.key);
    }
  });
  document.addEventListener('keyup', function (e) {
    const k = e.code || e.key;
    if (handled.has(k)) {
      handled.delete(k);
      e.preventDefault();
    }
  });
}
