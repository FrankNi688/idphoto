// 调光：只改亮度/对比度/曝光/阴影/色温，全部是逐像素的曲线（查表），不改任何形状。
// adj = { exposure: -2..2 (EV), brightness: -100..100, contrast: -100..100, shadows: 0..100, temp: -100..100 }
export const DEFAULT_ADJ = { exposure: 0, brightness: 0, contrast: 0, shadows: 0, temp: 0 };

export function isNeutral(a) {
  return !a.exposure && !a.brightness && !a.contrast && !a.shadows && !a.temp;
}

// 生成 R/G/B 三张 256 查找表
export function buildLUT(a) {
  const ev = Math.pow(2, a.exposure || 0);
  const br = (a.brightness || 0) / 100 * 0.25;     // ±25% 亮度
  const k = 1 + (a.contrast || 0) / 100;           // 0..2
  const sh = (a.shadows || 0) / 100;               // 暗部提亮
  const t = (a.temp || 0) / 100;                   // 正 = 暖
  const gain = [1 + 0.12 * t, 1 + 0.02 * t, 1 - 0.12 * t];
  const luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 256; i++) {
      let v = i / 255;
      v = v * gain[c];
      v = v * ev;
      if (sh > 0) { const w = Math.pow(1 - Math.min(1, Math.max(0, v)), 3); v = v + sh * 0.35 * w * (1 - v); }
      v = v + br;
      v = (v - 0.5) * k + 0.5;
      luts[c][i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return luts;
}

export function applyLUT(imgData, luts) {
  const d = imgData.data, [R, G, B] = luts;
  for (let i = 0; i < d.length; i += 4) { d[i] = R[d[i]]; d[i + 1] = G[d[i + 1]]; d[i + 2] = B[d[i + 2]]; }
  return imgData;
}

// 一键自动：脸部亮度拉到目标值、按全图灰度世界轻度校正色温、按百分位拉对比度
// face = 可选 {x,y,w,h}（在 imgData 坐标里）
export function autoAdjust(imgData, face) {
  const { data: d, width: W, height: H } = imgData;
  const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let sr = 0, sg = 0, sb = 0, n = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 16) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; hist[Math.round(lum(i))]++; }
  const mr = sr / n, mb = sb / n;
  // 色温：R/B 偏差的一半，限制在 ±40
  let temp = Math.round(((mb - mr) / Math.max(1, (mr + mb) / 2)) / 0.24 * 100 * 0.5);
  temp = Math.max(-40, Math.min(40, temp));
  // 脸部平均亮度
  let fl = 0, fn = 0;
  if (face) {
    const x1 = Math.max(0, Math.round(face.x)), y1 = Math.max(0, Math.round(face.y));
    const x2 = Math.min(W, Math.round(face.x + face.w)), y2 = Math.min(H, Math.round(face.y + face.h));
    for (let y = y1; y < y2; y += 2) for (let x = x1; x < x2; x += 2) { fl += lum((y * W + x) * 4); fn++; }
  }
  if (!fn) { let s = 0, c = 0; for (let v = 0; v < 256; v++) { s += v * hist[v]; c += hist[v]; } fl = s; fn = c; }
  const faceMean = fl / fn;
  let exposure = Math.log2(150 / Math.max(10, faceMean));
  exposure = Math.round(Math.max(-1, Math.min(1.5, exposure)) * 20) / 20;
  // 对比度：看 1%~99% 跨度
  const total = hist.reduce((a, b) => a + b, 0);
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  let contrast = Math.round((230 / span - 1) * 100 * 0.5);
  contrast = Math.max(-20, Math.min(25, contrast));
  // 阴影：脸偏暗才提一点
  const shadows = faceMean < 110 ? Math.min(40, Math.round((110 - faceMean) / 2)) : 0;
  return { exposure, brightness: 0, contrast, shadows, temp };
}
