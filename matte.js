// 单色背景下的精细抠图：模型给出大致人像，再用「和背景颜色差多少」把边缘（尤其头发）抠细。
// 纯函数，输入输出都是数组，Node 里也能测。

// 双线性把模型置信度（mw×mh）放大到 w×h
export function upsample(src, mw, mh, w, h) {
  const out = new Float32Array(w * h);
  const kx = mw / w, ky = mh / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * mw + x0] * (1 - tx) + src[y0 * mw + x1] * tx;
      const b = src[y1 * mw + x0] * (1 - tx) + src[y1 * mw + x1] * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// 可分离方框模糊（两遍近似高斯）
export function boxBlur(src, w, h, r) {
  let a = src, b = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = s / (2 * r + 1);
        s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    const c = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        c[y * w + x] = s / (2 * r + 1);
        s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
    a = c;
  }
  return a;
}

// 背景颜色模型：把确定是背景的像素按网格平均，空格子用邻居补，得到平滑（可带渐变/明暗）的背景色。
export function bgModel(px, conf, w, h, GW = 12) {
  const GH = Math.max(2, Math.round(GW * h / w));
  const sum = new Float64Array(GW * GH * 3), cnt = new Float64Array(GW * GH);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GH - 1, Math.floor(y * GH / h));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (conf[i] > 0.05) continue;
      const g = gy * GW + Math.min(GW - 1, Math.floor(x * GW / w));
      sum[g * 3] += px[i * 4]; sum[g * 3 + 1] += px[i * 4 + 1]; sum[g * 3 + 2] += px[i * 4 + 2]; cnt[g]++;
    }
  }
  const minN = (w * h) / (GW * GH) * 0.08;
  const grid = new Float32Array(GW * GH * 3), has = new Uint8Array(GW * GH);
  let any = false;
  for (let g = 0; g < GW * GH; g++) if (cnt[g] >= minN) { for (let c = 0; c < 3; c++) grid[g * 3 + c] = sum[g * 3 + c] / cnt[g]; has[g] = 1; any = true; }
  if (!any) return null;
  // 补空格子：反复取已知邻居平均
  for (let it = 0; it < GW + GH; it++) {
    let missing = 0; const add = [];
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const g = gy * GW + gx; if (has[g]) continue; missing++;
      let n = 0, r = 0, gg = 0, b = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x2 = gx + dx, y2 = gy + dy;
        if (x2 < 0 || y2 < 0 || x2 >= GW || y2 >= GH) continue;
        const k = y2 * GW + x2; if (!has[k]) continue;
        r += grid[k * 3]; gg += grid[k * 3 + 1]; b += grid[k * 3 + 2]; n++;
      }
      if (n) add.push([g, r / n, gg / n, b / n]);
    }
    for (const [g, r, gg, b] of add) { grid[g * 3] = r; grid[g * 3 + 1] = gg; grid[g * 3 + 2] = b; has[g] = 1; }
    if (!missing) break;
  }
  return { GW, GH, grid };
}

// 在归一化坐标 (u,v ∈ 0..1) 取背景色
export function bgAt(m, u, v, out) {
  const fx = Math.min(m.GW - 1, Math.max(0, u * m.GW - 0.5)), fy = Math.min(m.GH - 1, Math.max(0, v * m.GH - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(m.GW - 1, x0 + 1), y1 = Math.min(m.GH - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0, G = m.grid, W = m.GW;
  for (let c = 0; c < 3; c++) {
    const a = G[(y0 * W + x0) * 3 + c] * (1 - tx) + G[(y0 * W + x1) * 3 + c] * tx;
    const b = G[(y1 * W + x0) * 3 + c] * (1 - tx) + G[(y1 * W + x1) * 3 + c] * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

// 和背景的颜色差，但把「同色、只是暗一些」（墙上的影子，亮度 55%–110%）当成背景
export function shadowDist(r, g, b, B) {
  const bb = B[0] * B[0] + B[1] * B[1] + B[2] * B[2] + 1;
  const k = (r * B[0] + g * B[1] + b * B[2]) / bb;
  const kc = Math.min(1.1, Math.max(0.55, k));
  const chroma = Math.hypot(r - k * B[0], g - k * B[1], b - k * B[2]);
  return chroma + Math.abs(k - kc) * Math.sqrt(bb);
}

// 主函数。px = RGBA（w×h），conf = 已放大的模型置信度。
// 返回 { alpha: Float32Array, model, plain, noise }；背景不够单色时 plain=false，alpha 仍是模型结果（稍微拉陡）。
export function refineMatte(px, conf, w, h) {
  const model = bgModel(px, conf, w, h);
  const hard = (c) => Math.min(1, Math.max(0, (c - 0.3) / 0.4));
  const alpha = new Float32Array(w * h);
  if (!model) { for (let i = 0; i < w * h; i++) alpha[i] = hard(conf[i]); return { alpha, model: null, plain: false, noise: 999 }; }
  // 背景有多「干净」：确定背景像素与背景模型的颜色差，取 90 分位
  const B = [0, 0, 0], hist = new Uint32Array(442);
  let n = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = y * w + x; if (conf[i] > 0.02) continue;
    bgAt(model, (x + 0.5) / w, (y + 0.5) / h, B);
    const d = Math.hypot(px[i * 4] - B[0], px[i * 4 + 1] - B[1], px[i * 4 + 2] - B[2]);
    hist[Math.min(441, Math.round(d))]++; n++;
  }
  let acc = 0, noise = 0;
  for (let d = 0; d < 442; d++) { acc += hist[d]; if (acc >= n * 0.9) { noise = d; break; } }
  const plain = n > 1000 && noise <= 26;
  if (!plain) { for (let i = 0; i < w * h; i++) alpha[i] = hard(conf[i]); return { alpha, model, plain, noise }; }
  // 只在人像边缘一圈带子里用颜色判断；里面保持实心、外面保持干净
  const R = Math.max(2, Math.round(Math.max(w, h) * 0.012));
  const soft = boxBlur(conf, w, h, R);
  const t0 = noise + 8, t1 = t0 + Math.max(28, noise * 1.5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, s = soft[i], c = conf[i];
    if (s <= 0.02) { alpha[i] = 0; continue; }
    if (s >= 0.98 && c > 0.5) { alpha[i] = 1; continue; }
    bgAt(model, (x + 0.5) / w, (y + 0.5) / h, B);
    const d = shadowDist(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], B);
    const ac = Math.min(1, Math.max(0, (d - t0) / (t1 - t0)));
    const inner = Math.min(1, Math.max(0, (c - 0.75) / 0.2));   // 模型很确定是人 → 保留（如浅色衣服）
    alpha[i] = Math.max(ac, inner);
  }
  return { alpha, model, plain, noise };
}
