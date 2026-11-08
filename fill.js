// 脸部补光：像在暗的一侧加一盏柔光灯。
// 侧光阴影主要是左右方向的明暗差。把脸分成 4 段（额头/眼/脸颊/下巴）× 10 竖条，
// 每格量亮度（去掉头发眉眼这类很暗的点和反光），得到平滑的明暗图，每段里暗的一侧按比例提亮到亮的一侧。
// 只提亮、不压暗，增益平滑过渡，五官和形状不变。face = { cx, cy, rx, ry }（输出图像素），strength 0..1

const ell = (f, x, y) => Math.hypot((x - f.cx) / f.rx, (y - f.cy) / f.ry);
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const NX = 14, NY = 8;
// 只量皮肤：偏红黄的像素（R>G>B），排除头发、眉毛、胡茬、背景。暗面的皮肤也满足这个色相条件。
const skin = (d, i) => { const r = d[i], g = d[i + 1], b = d[i + 2]; return r > g && g >= b * 0.9 && r - b > 18 && r > 45; };

function shadeMap(img, f) {
  const { data: d, width: W, height: H } = img;
  const vals = Array.from({ length: NX * NY }, () => []);
  const xa = Math.max(0, Math.floor(f.cx - f.rx)), xb = Math.min(W, Math.ceil(f.cx + f.rx));
  const ya = Math.max(0, Math.floor(f.cy - f.ry)), yb = Math.min(H, Math.ceil(f.cy + f.ry));
  const step = Math.max(1, Math.round(f.rx / 60));
  for (let y = ya; y < yb; y += step) for (let x = xa; x < xb; x += step) {
    if (ell(f, x, y) > 0.97) continue;
    const bx = Math.min(NX - 1, Math.max(0, Math.floor((x - (f.cx - f.rx)) / (2 * f.rx) * NX)));
    const by = Math.min(NY - 1, Math.max(0, Math.floor((y - (f.cy - f.ry)) / (2 * f.ry) * NY)));
    const i = (y * W + x) * 4;
    if (!skin(d, i)) continue;
    vals[by * NX + bx].push(lum(d, i));
  }
  // 每格取 35–85 分位平均：去掉眼睛眉毛胡茬（暗）和反光（亮）
  let M = vals.map((v) => { if (v.length < 6) return null; v.sort((a, b) => a - b); const s = v.slice(Math.floor(v.length * 0.2), Math.ceil(v.length * 0.6)); return s.reduce((a, b) => a + b, 0) / s.length; });
  // 空格（椭圆角上）用同一行最近的格补
  for (let by = 0; by < NY; by++) for (let bx = 0; bx < NX; bx++) {
    if (M[by * NX + bx] != null) continue;
    for (let k = 1; k < NX; k++) {
      const a = M[by * NX + Math.max(0, bx - k)], b = M[by * NX + Math.min(NX - 1, bx + k)];
      if (a != null || b != null) { M[by * NX + bx] = a != null && b != null ? (a + b) / 2 : a ?? b; break; }
    }
  }
  if (M.some((v) => v == null)) return null;
  // 平滑：横向两遍 1-2-1，纵向一遍
  for (let p = 0; p < 2; p++) M = M.map((v, i) => { const x = i % NX, r = i - x; return (M[r + Math.max(0, x - 1)] + 2 * v + M[r + Math.min(NX - 1, x + 1)]) / 4; });
  M = M.map((v, i) => { const y = Math.floor(i / NX), x = i % NX; return (M[Math.max(0, y - 1) * NX + x] + 2 * v + M[Math.min(NY - 1, y + 1) * NX + x]) / 4; });
  // 左右对称处理：每格只和它的镜像格比，暗的那格提到镜像格的亮度。
  // 这样只消除左右明暗差，不会把脸边缘提到鼻梁的亮度（那样会过头，反而另一侧更亮）。
  // 中间阴影（两侧来光时鼻梁、人中、下巴中间一竖条发暗）：只看中间 4 列（两边各半列过渡），
  // 目标 = 左右内侧脸颊（第 2–4 列和第 9–11 列）里较暗那侧的亮度。脸颊本身和脸边缘不受影响。
  const V = M.map((v, i) => {
    const x = i % NX, r = i - x, w = x >= 5 && x <= 8 ? 1 : x === 4 || x === 9 ? 0.5 : 0;
    if (!w) return v;
    const side = (k0, k1) => { let m = 0; for (let k = k0; k <= k1; k++) m = Math.max(m, M[r + k]); return m; };
    const t = Math.min(side(2, 4), side(9, 11));
    return t > v ? v + w * (t - v) : v;
  });
  const Ts = M.map((v, i) => { const x = i % NX, r = i - x; return Math.max(v, M[r + NX - 1 - x]); });
  const T = Ts.map((v, i) => Math.max(v, V[i]));
  return { M, T, Ts };
}

export function fillLight(img, face, strength) {
  if (!face || !(strength > 0)) return;
  const S = shadeMap(img, face);
  if (!S) return;
  const { data: d, width: W, height: H } = img;
  // 增益表（格中心），之后双线性插值
  // 加法补光：每格要补的亮度差 = 镜像格 − 本格。加同样的亮度而不是乘倍数，
  // 暗侧的颧骨高光就不会被放大成一块亮斑，局部明暗关系保持原样。
  const Gt = S.M.map((v, i) => Math.min(0.7 * (S.Ts[i] - v), v * 1.2));
  // 中间阴影另算一张表：这部分用更多中性灰加亮，避免额头、人中的纹理被按比例放大成发红的斑块
  const Gv = S.M.map((v, i) => Math.min(0.7 * (S.T[i] - S.Ts[i]), v * 1.2));
  const bil = (G, x, y) => {
    const fx = Math.min(NX - 1, Math.max(0, (x - (face.cx - face.rx)) / (2 * face.rx) * NX - 0.5));
    const fy = Math.min(NY - 1, Math.max(0, (y - (face.cy - face.ry)) / (2 * face.ry) * NY - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(NX - 1, x0 + 1), y1 = Math.min(NY - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return (G[y0 * NX + x0] * (1 - tx) + G[y0 * NX + x1] * tx) * (1 - ty) + (G[y1 * NX + x0] * (1 - tx) + G[y1 * NX + x1] * tx) * ty;
  };
  const cellAt = (x, y) => {
    const fx = Math.min(NX - 1, Math.max(0, (x - (face.cx - face.rx)) / (2 * face.rx) * NX - 0.5));
    const fy = Math.min(NY - 1, Math.max(0, (y - (face.cy - face.ry)) / (2 * face.ry) * NY - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(NX - 1, x0 + 1), y1 = Math.min(NY - 1, y0 + 1), tx = fx - x0, ty = fy - y0, M = S.M;
    return (M[y0 * NX + x0] * (1 - tx) + M[y0 * NX + x1] * tx) * (1 - ty) + (M[y1 * NX + x0] * (1 - tx) + M[y1 * NX + x1] * tx) * ty;
  };
  const R = 1.25;
  const xa = Math.max(0, Math.floor(face.cx - face.rx * R)), xb = Math.min(W, Math.ceil(face.cx + face.rx * R));
  const ya = Math.max(0, Math.floor(face.cy - face.ry * R)), yb = Math.min(H, Math.ceil(face.cy + face.ry * R));
  // 局部亮度（小块平均）：眼珠、眉毛这种小的暗点比周围暗 → 按比例提亮保色；
  // 大片阴影（额头、鼻梁中线）跟周围差不多亮 → 当皮肤处理，不会被按比例放大成发红的斑块。
  const bs = Math.max(4, Math.round(face.rx / 10)), BW = Math.ceil((xb - xa) / bs), BH = Math.ceil((yb - ya) / bs);
  const Ls = new Float32Array(BW * BH), Ln = new Float32Array(BW * BH);
  for (let y = ya; y < yb; y += 2) for (let x = xa; x < xb; x += 2) { const b = Math.floor((y - ya) / bs) * BW + Math.floor((x - xa) / bs); Ls[b] += lum(d, (y * W + x) * 4); Ln[b]++; }
  for (let b = 0; b < Ls.length; b++) Ls[b] = Ln[b] ? Ls[b] / Ln[b] : 128;
  const localAt = (x, y) => {
    const fx = Math.min(BW - 1, Math.max(0, (x - xa) / bs - 0.5)), fy = Math.min(BH - 1, Math.max(0, (y - ya) / bs - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(BW - 1, x0 + 1), y1 = Math.min(BH - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return (Ls[y0 * BW + x0] * (1 - tx) + Ls[y0 * BW + x1] * tx) * (1 - ty) + (Ls[y1 * BW + x0] * (1 - tx) + Ls[y1 * BW + x1] * tx) * ty;
  };
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
    const r = ell(face, x, y);
    if (r >= R) continue;
    const w = r < 1 ? 1 : Math.pow(1 - (r - 1) / (R - 1), 2);
    const as = strength * w * bil(Gt, x, y), av = strength * w * bil(Gv, x, y), add = as + av;
    if (add < 0.5) continue;
    const i = (y * W + x) * 4;
    // 皮肤：一半按比例、一半加中性灰（防发橙、不出亮斑）。
    // 五官暗部（眼珠、眉毛、睫毛、鼻孔）：纯按比例提亮，跟真实打光一样，颜色不变，眼珠不会变灰。
    const L0 = lum(d, i), ref = Math.max(8, cellAt(x, y)), loc = Math.max(8, localAt(x, y)), t = (L0 / loc - 0.55) / 0.3;
    const keep = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    const G = Math.min(1.6, 1 + add / ref); // 很暗的点（胡茬、深阴影）最多提 60%，避免放大成发红的斑块
    // 皮肤部分：对称补光一半中性灰；中间阴影 60% 中性灰
    const nf = (0.5 * as + 0.6 * av) / add;
    const k = (1 - nf) * add / Math.max(25, L0), n = nf * add;
    for (let c = 0; c < 3; c++) { const v = d[i + c], m = v * G, s2 = v * (1 + k) + n; d[i + c] = Math.min(255, m + (s2 - m) * keep); }
  }
}

// 左右脸明暗差 → 建议补光强度（0..100）；脸很均匀时为 0
export function suggestFill(img, face) {
  if (!face) return 0;
  const S = shadeMap(img, face);
  if (!S) return 0;
  let worst = 1;
  for (let i = 0; i < S.M.length; i++) worst = Math.min(worst, S.M[i] / S.T[i]);
  if (worst > 0.95) return 0;
  return Math.round(Math.min(100, (1 - worst) * 400));
}

// 测试用：脸左右两半的平均亮度（35–85 分位）
export function lrBalance(img, f) {
  const { data: d, width: W } = img, L = [], R = [];
  for (let y = Math.floor(f.cy - f.ry); y < f.cy + f.ry; y += 2) for (let x = Math.floor(f.cx - f.rx); x < f.cx + f.rx; x += 2) {
    if (ell(f, x, y) > 0.9 || Math.abs(x - f.cx) < f.rx * 0.1) continue;
    const i = (y * W + x) * 4; if (!skin(d, i)) continue;
    (x < f.cx ? L : R).push(lum(d, i));
  }
  const m = (v) => { v.sort((a, b) => a - b); const s = v.slice(Math.floor(v.length * 0.35), Math.ceil(v.length * 0.85)); return s.reduce((a, b) => a + b, 0) / s.length; };
  return { L: Math.round(m(L)), R: Math.round(m(R)) };
}
