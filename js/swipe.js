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

/** 键盘：A/← 左，D/→ 右，W/↑/E 用道具，空格/回车 继续。cb(sel) sel = 'L'|'R'|'P'|'N' */
export function attachKeys(cb, active) {
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (!active()) return;
    let sel = null;
    switch (e.key) {
      case 'a': case 'A': case 'ArrowLeft': sel = 'L'; break;
      case 'd': case 'D': case 'ArrowRight': sel = 'R'; break;
      case 'w': case 'W': case 'ArrowUp': case 'e': case 'E': sel = 'P'; break;
      case ' ': case 'Enter': sel = 'N'; break;
      default: return;
    }
    e.preventDefault();
    cb(sel);
  });
}
