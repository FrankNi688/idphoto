// 证件照尺寸计算（纯函数，无 DOM，可在 Node 里测试）
// 约定：图片坐标单位为原图像素；ppm = 原图每毫米多少像素（决定缩放）。
export const MM_PER_IN = 25.4;

export function mmToPx(mm, dpi) { return Math.round((mm / MM_PER_IN) * dpi); }

// 成品像素尺寸
export function outputPixels(p) {
  return { w: mmToPx(p.wMm, p.dpi), h: mmToPx(p.hMm, p.dpi) };
}

// 参数检查，返回错误键列表（空数组 = 没问题），界面用 i18n 翻译
export function validate(p) {
  const e = [];
  const pos = (v) => Number.isFinite(v) && v > 0;
  if (!pos(p.wMm) || !pos(p.hMm)) e.push('e_size');
  if (!pos(p.headMin) || !pos(p.headMax)) e.push('e_head');
  if (p.headMin > p.headMax) e.push('e_minmax');
  if (!(Number.isFinite(p.top) && p.top >= 0)) e.push('e_top');
  if (!pos(p.dpi) || p.dpi > 1200) e.push('e_dpi');
  if (pos(p.hMm) && p.top + p.headMax > p.hMm) e.push('e_fit');
  return e;
}

// 自动裁剪：让头高落在范围中点，头顶距上边 = 头顶留白，脸水平居中。
// det = { crownY, chinY, cx }（原图像素）
export function autoCrop(p, det) {
  const headPx = det.chinY - det.crownY;
  const targetMm = (p.headMin + p.headMax) / 2;
  const ppm = headPx / targetMm;
  return { cx: det.cx, top: det.crownY - p.top * ppm, ppm };
}

// 当前状态对应原图里的裁剪矩形
export function cropRect(p, s) {
  const w = p.wMm * s.ppm, h = p.hMm * s.ppm;
  return { x: s.cx - w / 2, y: s.top, w, h };
}

// 当前状态下的头高（mm）和头顶留白（mm）
export function measure(p, s, det) {
  return {
    headMm: (det.chinY - det.crownY) / s.ppm,
    topMm: (det.crownY - s.top) / s.ppm,
    offsetMm: (det.cx - s.cx) / s.ppm,
  };
}

// 以裁剪框中心为基准缩放（factor > 1 = 放大人像）
export function zoomAt(p, s, factor) {
  const r = cropRect(p, s);
  const cy = r.y + r.h / 2;
  const ppm = s.ppm / factor;
  return { cx: s.cx, top: cy - (p.hMm * ppm) / 2, ppm };
}

// 4×6 英寸拼版：自动选横/竖，排满，单张之间留 gapMm。
// 四周至少留 SAFE_MM 安全边：网上冲印（无边框）常会裁掉纸边 1–2 mm，照片不能进这个区域。
// 先试带间距的排法；如果去掉间距（相邻照片共用一条裁切线）能多放，就用无间距排法
export const SAFE_MM = 3;
export function sheetLayout(p, opt = {}) {
  const m = opt.marginMm ?? SAFE_MM;
  const a = sheetLayoutWith(p, opt.gapMm ?? 2, m, opt);
  const b = sheetLayoutWith(p, 0, m, opt);
  return b.n > a.n ? b : a;
}

function sheetLayoutWith(p, gap, margin, opt) {
  const dpi = p.dpi;
  const shortIn = opt.shortIn ?? 4, longIn = opt.longIn ?? 6;
  const { w: pw, h: ph } = outputPixels(p);
  const g = mmToPx(gap, dpi), m = mmToPx(margin, dpi);
  const fit = (W, H) => {
    const cols = Math.max(0, Math.floor((W - 2 * m + g) / (pw + g)));
    const rows = Math.max(0, Math.floor((H - 2 * m + g) / (ph + g)));
    return { W, H, cols, rows, n: cols * rows };
  };
  const L = Math.round(longIn * dpi), S = Math.round(shortIn * dpi);
  const a = fit(L, S), b = fit(S, L);
  const best = b.n > a.n ? b : a; // 一样多时用横版
  const usedW = best.cols * pw + Math.max(0, best.cols - 1) * g;
  const usedH = best.rows * ph + Math.max(0, best.rows - 1) * g;
  const x0 = Math.round((best.W - usedW) / 2), y0 = Math.round((best.H - usedH) / 2);
  const cells = [];
  for (let r = 0; r < best.rows; r++)
    for (let c = 0; c < best.cols; c++)
      cells.push({ x: x0 + c * (pw + g), y: y0 + r * (ph + g), w: pw, h: ph });
  return { ...best, pw, ph, gapPx: g, cells };
}

// 从人脸关键点 + 人像分割估算 头顶/下巴/中心
// lm: 归一化关键点数组（FaceLandmarker 478 点）；W,H 图像尺寸
// mask: 可选 { data: Float32Array, w, h } 人像置信度（与原图同比例）
export function headFromLandmarks(lm, W, H, mask) {
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const chin = P(152), fore = P(10), L = P(234), R = P(454);
  const leftEye = P(33), rightEye = P(263);
  const faceW = Math.hypot(R.x - L.x, R.y - L.y);
  const cx = (L.x + R.x) / 2;
  const roll = (Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180) / Math.PI;
  // 没有分割时的估计：头顶 ≈ 额头点再往上 0.25×(下巴-额头)
  let crownY = fore.y - 0.25 * (chin.y - fore.y), crownSrc = 'estimate';
  if (mask) {
    const sx = mask.w / W, sy = mask.h / H;
    const x1 = Math.max(0, Math.round((cx - faceW * 0.2) * sx));
    const x2 = Math.min(mask.w - 1, Math.round((cx + faceW * 0.2) * sx));
    const yStop = Math.round(fore.y * sy);
    const yLimit = Math.max(0, Math.round((fore.y - (chin.y - fore.y)) * sy)); // 最多往上找一个脸长
    for (let y = yLimit; y <= yStop; y++) {
      let hit = 0;
      for (let x = x1; x <= x2; x++) if (mask.data[y * mask.w + x] > 0.5) hit++;
      if (hit >= (x2 - x1 + 1) * 0.3) { crownY = y / sy; crownSrc = 'mask'; break; }
    }
  }
  return { crownY, chinY: chin.y, cx, faceW, roll, crownSrc };
}
