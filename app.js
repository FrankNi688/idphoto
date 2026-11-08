// 证件照 PWA 主程序：选图 → 识别人脸 → 按参数裁剪 → 调光 → 换背景 → 导出
import { outputPixels, validate, autoCrop, cropRect, measure, zoomAt, sheetLayout, headFromLandmarks } from './crop.js';
import { DEFAULT_ADJ, buildLUT, applyLUT, autoAdjust, isNeutral } from './light.js';
import { t, lang, setLang, applyStatic } from './i18n.js';
import { BUILTIN } from './presets.js';
import { upsample, refineMatte, bgAt } from './matte.js';
import { fillLight, suggestFill } from './fill.js';

const VERSION = 'v1.2.5';
const $ = (id) => document.getElementById(id);
$('ver').textContent = VERSION;

// ---------- 预设：内置官方规格（只读）+ 自己存的 ----------
const PRESET_KEY = 'idp-presets-v2', LAST_KEY = 'idp-last-preset';
const FIELDS = ['wMm', 'hMm', 'headMin', 'headMax', 'top', 'dpi', 'bg'];
let presets = loadPresets();   // 自己存的
let cur = null;                // 当前选中的预设对象（内置或自定义）；null = 手动

function loadPresets() {
  try { const a = JSON.parse(localStorage.getItem(PRESET_KEY)); if (Array.isArray(a)) return a; } catch {}
  // 迁移 v1 存的自定义（去掉当年的示例）
  try { const a = JSON.parse(localStorage.getItem('idp-presets-v1')); if (Array.isArray(a)) return a.filter((p) => !/50×70 mm$/.test(p.name)); } catch {}
  return [];
}
function savePresets() { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); }
const bName = (b) => (lang === 'zh' ? b.zh : b.en);
function fillPresetSel(val) {
  const esc = (x) => String(x).replace(/</g, '&lt;');
  $('presetSel').innerHTML =
    `<optgroup label="${t('official')}">` + BUILTIN.map((b) => `<option value="b:${b.id}">${esc(bName(b))}</option>`).join('') + '</optgroup>' +
    (presets.length ? `<optgroup label="${t('mine')}">` + presets.map((p, i) => `<option value="c:${i}">${esc(p.name)}</option>`).join('') + '</optgroup>' : '') +
    `<option value="manual">${t('manual')}</option>`;
  $('presetSel').value = val;
  if ($('presetSel').value !== val) $('presetSel').value = 'b:' + BUILTIN[0].id;
}
function setParams(p) { for (const f of FIELDS) $('p_' + f).value = p[f]; }
function getParams() {
  const p = {};
  for (const f of FIELDS) p[f] = f === 'bg' ? $('p_bg').value : parseFloat($('p_' + f).value);
  if (cur) { p.kbMin = cur.kbMin; p.kbMax = cur.kbMax; }
  return p;
}
function applyPresetSel(reAuto) {
  const v = $('presetSel').value;
  localStorage.setItem(LAST_KEY, v);
  cur = v.startsWith('b:') ? BUILTIN.find((b) => 'b:' + b.id === v) : v.startsWith('c:') ? presets[+v.slice(2)] : null;
  const locked = v.startsWith('b:');
  if (cur) setParams(cur);
  for (const f of FIELDS) $('p_' + f).disabled = locked && f !== 'bg';
  $('presetSave').hidden = locked;
  $('presetDel').hidden = !v.startsWith('c:');
  $('specNote').textContent = locked ? (lang === 'zh' ? cur.noteZh : cur.noteEn) : '';
  onParams(reAuto);
}
$('presetSel').onchange = () => applyPresetSel(true);
$('presetSave').onclick = () => {
  const p = getParams();
  if (validate(p).length) return alert(t('fixFirst'));
  const name = prompt(t('presetName'), `${p.wMm}×${p.hMm} mm`);
  if (!name) return;
  const i = presets.findIndex((x) => x.name === name);
  const item = { name, ...p };
  if (i >= 0) presets[i] = item; else presets.push(item);
  savePresets(); fillPresetSel('c:' + (i >= 0 ? i : presets.length - 1)); applyPresetSel(false);
};
$('presetDel').onclick = () => {
  const v = $('presetSel').value; if (!v.startsWith('c:')) return;
  const i = +v.slice(2);
  if (!confirm(t('delConfirm', presets[i].name))) return;
  presets.splice(i, 1); savePresets(); fillPresetSel('b:' + BUILTIN[0].id); applyPresetSel(true);
};
for (const f of FIELDS) $('p_' + f).addEventListener('input', () => {
  // 手动改了数值（自定义预设里）就变成「手动」
  if (f !== 'bg' && $('presetSel').value.startsWith('c:')) { $('presetSel').value = 'manual'; cur = null; $('presetDel').hidden = true; }
  onParams(false);
});

let params = null;
function onParams(reAuto) {
  const p = getParams();
  const errs = validate(p);
  $('paramErr').textContent = errs.map((k) => t(k)).join('\n');
  if (errs.length) { $('pxInfo').textContent = '–'; return; }
  const sizeChanged = !params || params.wMm !== p.wMm || params.hMm !== p.hMm || params.headMin !== p.headMin || params.headMax !== p.headMax || params.top !== p.top;
  params = p;
  const { w, h } = outputPixels(p);
  $('pxInfo').textContent = `${w} × ${h} px`;
  if (state.det && (reAuto || sizeChanged)) doAuto();
  schedule();
}

// ---------- 状态 ----------
const state = {
  img: null, W: 0, H: 0,      // 原图（已按 EXIF 摆正）
  det: null,                  // { crownY, chinY, cx, faceW, roll, crownSrc }
  crop: null,                 // { cx, top, ppm }
  adj: { ...DEFAULT_ADJ }, fill: 0,
  mask: null,                 // 人像分割 canvas（alpha = 人像）
  maskStatus: 'idle',
};
window.__idp = { state, get params() { return params; } }; // 便于测试

// ---------- 模型（全部本地 vendor 加载） ----------
let vision = null, faceLm = null, segmenter = null;
async function loadVision() {
  if (vision) return vision;
  const mod = await import('./vendor/mediapipe/vision_bundle.mjs');
  const fileset = await mod.FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', location.href).href);
  vision = { mod, fileset };
  return vision;
}
async function getFaceLm() {
  if (faceLm) return faceLm;
  const { mod, fileset } = await loadVision();
  faceLm = await mod.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('vendor/models/face_landmarker.task', location.href).href, delegate: 'CPU' },
    runningMode: 'IMAGE', numFaces: 2,
  });
  return faceLm;
}
async function getSegmenter() {
  if (segmenter) return segmenter;
  const { mod, fileset } = await loadVision();
  segmenter = await mod.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('vendor/models/selfie_segmenter.tflite', location.href).href, delegate: 'CPU' },
    runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMask: true,
  });
  return segmenter;
}

// ---------- 读图 ----------
const MAX_SIDE = 3000;
async function loadFile(file) {
  if (!file) return;
  busy(t('reading'));
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();            // 浏览器会按 EXIF 方向摆正
    let W = img.naturalWidth, H = img.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(W, H));
    W = Math.round(W * k); H = Math.round(H * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d').drawImage(img, 0, 0, W, H);
    URL.revokeObjectURL(url);
    await setImage(c);
  } catch (e) {
    console.error(e); alert(t('readFail') + e.message);
  } finally { busy(false); }
}
$('camIn').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
$('fileIn').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };

async function setImage(canvas) {
  state.img = canvas; state.W = canvas.width; state.H = canvas.height;
  state.det = null; state.crop = null; state.mask = null; state.maskStatus = 'idle';
  state.adj = { ...DEFAULT_ADJ }; state.fill = 0; syncAdjUI();
  clearExport();
  for (const id of ['cropCard', 'lightCard', 'bgCard', 'exportCard']) $(id).hidden = false;
  $('detWarn').textContent = '';
  busy(t('detecting'));
  try {
    // 人像分割同时用于找头顶（头发）和换背景
    await runSegmentation();
    const fl = await getFaceLm();
    const res = fl.detect(canvas);
    const faces = res.faceLandmarks || [];
    if (!faces.length) {
      $('detWarn').textContent = t('noFace');
      state.det = null;
      manualDefault();
    } else {
      if (faces.length > 1) $('detWarn').textContent = t('multiFace');
      const big = faces.map((f) => ({ f, w: Math.abs(f[454].x - f[234].x) })).sort((a, b) => b.w - a.w)[0].f;
      state.det = headFromLandmarks(big, state.W, state.H, state.maskData);
      const warns = [];
      if (Math.abs(state.det.roll) > 4) warns.push(t('tilt', Math.abs(state.det.roll).toFixed(0)));
      if (state.det.crownSrc !== 'mask') warns.push(t('crownEst'));
      if ($('detWarn').textContent) warns.unshift($('detWarn').textContent);
      $('detWarn').textContent = warns.join('\n');
      doAuto();
    }
  } catch (e) {
    console.error(e);
    $('detWarn').textContent = t('modelFail', e.message);
    manualDefault();
  } finally { busy(false); }
  schedule();
  $('cropCard').scrollIntoView({ behavior: 'smooth' });
}

function manualDefault() {
  if (!params) return;
  // 没有识别结果：让照片宽度刚好填满
  const ppm = state.W / params.wMm;
  state.crop = { cx: state.W / 2, top: Math.max(0, (state.H - params.hMm * ppm) / 2), ppm };
}
function doAuto() {
  if (!params) return;
  if (!state.det) { manualDefault(); schedule(); return; }
  state.crop = autoCrop(params, state.det);
  $('zoom').value = 0; zoomBase = state.crop.ppm;
  schedule();
}
$('reAuto').onclick = doAuto;

async function runSegmentation() {
  state.maskStatus = 'running'; updateBgHint();
  try {
    const seg = await getSegmenter();
    // 分割在缩小图上做，最长边 1024
    const k = Math.min(1, 1024 / Math.max(state.W, state.H));
    const w = Math.round(state.W * k), h = Math.round(state.H * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(state.img, 0, 0, w, h);
    const r = seg.segment(c);
    const m = r.confidenceMasks[0];
    const data = m.getAsFloat32Array().slice();
    const mw = m.width, mh = m.height;
    r.close?.();
    state.maskData = { data, w: mw, h: mh };
    // 在 ≤1600 px 的工作图上精修边缘：背景是单色时按颜色差抠头发
    const k2 = Math.min(1, 1600 / Math.max(state.W, state.H));
    const ww = Math.round(state.W * k2), wh = Math.round(state.H * k2);
    const wc = document.createElement('canvas'); wc.width = ww; wc.height = wh;
    const wctx = wc.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(state.img, 0, 0, ww, wh);
    const px = wctx.getImageData(0, 0, ww, wh).data;
    const conf = upsample(data, mw, mh, ww, wh);
    const mt = refineMatte(px, conf, ww, wh);
    state.matte = { model: mt.model, plain: mt.plain, noise: mt.noise };
    const id = wctx.createImageData(ww, wh);
    for (let i = 0; i < ww * wh; i++) id.data[i * 4 + 3] = Math.round(mt.alpha[i] * 255);
    wctx.putImageData(id, 0, 0);
    state.mask = wc; state.maskStatus = 'ok';
  } catch (e) {
    console.error(e); state.maskData = null; state.mask = null; state.matte = null; state.maskStatus = 'fail';
  }
  updateBgHint();
}
function updateBgHint() {
  const m = { idle: '', running: t('segRunning'), ok: state.matte?.plain ? t('segPlain') : t('segNotPlain'), fail: t('segFail') };
  $('bgHint').textContent = m[state.maskStatus];
  $('bgHint').className = state.maskStatus === 'ok' && !state.matte?.plain ? 'warn' : 'hint';
  $('bgOn').disabled = state.maskStatus !== 'ok';
}

// ---------- 渲染：裁剪 + 调光 + 背景（预览和导出共用） ----------
function renderCrop(outW, outH) {
  const p = params, s = state.crop;
  const r = cropRect(p, s);
  const c = document.createElement('canvas'); c.width = outW; c.height = outH;
  const ctx = c.getContext('2d');
  const sx = outW / r.w, sy = outH / r.h;
  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  // 照片层
  const photo = document.createElement('canvas'); photo.width = outW; photo.height = outH;
  const pc = photo.getContext('2d');
  pc.imageSmoothingEnabled = true; pc.imageSmoothingQuality = 'high';
  pc.fillStyle = p.bg; pc.fillRect(0, 0, outW, outH);
  pc.drawImage(state.img, -r.x * sx, -r.y * sy, state.W * sx, state.H * sy);
  const luts = isNeutral(state.adj) ? null : buildLUT(state.adj);
  const face = state.det && state.fill > 0 ? faceEllipse(r, sx, sy) : null;
  if (luts || face) {
    const id = pc.getImageData(0, 0, outW, outH);
    if (luts) applyLUT(id, luts);
    if (face) fillLight(id, face, state.fill / 100);
    pc.putImageData(id, 0, 0);
  }
  if ($('bgOn').checked && state.mask) {
    // 人像 alpha
    // 人像 alpha：先画到小画布再放大，相当于柔化边缘（不依赖 ctx.filter，iOS 也能用）
    const f = +$('feather').value;
    const ds = f ? 1 / (1 + f * outW / 400) : 1;
    const sw = Math.max(1, Math.round(outW * ds)), sh = Math.max(1, Math.round(outH * ds));
    const small = document.createElement('canvas'); small.width = sw; small.height = sh;
    const scx = small.getContext('2d'); scx.imageSmoothingEnabled = true; scx.imageSmoothingQuality = 'high';
    const kx = state.mask.width / state.W;
    scx.drawImage(state.mask, -r.x * sx * ds, -r.y * sy * ds, (state.mask.width / kx) * sx * ds, (state.mask.height / kx) * sy * ds);
    const m = document.createElement('canvas'); m.width = outW; m.height = outH;
    const mc = m.getContext('2d'); mc.imageSmoothingEnabled = true; mc.imageSmoothingQuality = 'high';
    mc.drawImage(small, 0, 0, outW, outH);
    if (state.matte?.model) {
      // 合成时去掉边缘里残留的旧背景色（头发丝不会带一圈灰边）
      const P = pc.getImageData(0, 0, outW, outH), A = mc.getImageData(0, 0, outW, outH).data, d = P.data;
      const N = hexRgb(p.bg), B = [0, 0, 0];
      for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
        const i = (y * outW + x) * 4, a = A[i + 3] / 255;
        if (a >= 0.99) continue;
        if (a <= 0.01) { d[i] = N[0]; d[i + 1] = N[1]; d[i + 2] = N[2]; continue; }
        bgAt(state.matte.model, (r.x + (x + 0.5) / sx) / state.W, (r.y + (y + 0.5) / sy) / state.H, B);
        for (let c = 0; c < 3; c++) {
          const b = luts ? luts[c][Math.min(255, Math.max(0, Math.round(B[c])))] : B[c];
          const f = Math.min(255, Math.max(0, (d[i + c] - (1 - a) * b) / a));
          d[i + c] = a * f + (1 - a) * N[c];
        }
      }
      pc.putImageData(P, 0, 0);
    } else {
      pc.globalCompositeOperation = 'destination-in';
      pc.drawImage(m, 0, 0);
      pc.globalCompositeOperation = 'source-over';
    }
  }
  ctx.drawImage(photo, 0, 0);
  return c;
}

function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
// 脸部椭圆（输出图坐标）：头顶到下巴的下 70%，避开头发
function faceEllipse(r, sx, sy) {
  const d = state.det, H = d.chinY - d.crownY;
  return { cx: (d.cx - r.x) * sx, cy: (d.crownY + H * 0.6 - r.y) * sy, rx: d.faceW * 0.5 * sx, ry: H * 0.42 * sy };
}

// ---------- 预览 ----------
const pv = $('preview');
const PAD = 0.12; // 裁剪框四周露出的比例
let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawPreview(); }); }

function previewGeom() {
  const cssW = pv.clientWidth || 320;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const aspect = params.hMm / params.wMm;
  const frameW = cssW / (1 + 2 * PAD);
  const frameH = frameW * aspect;
  const padX = frameW * PAD, padY = frameW * PAD;
  return { cssW, cssH: frameH + 2 * padY, frameW, frameH, padX, padY, dpr };
}

function drawPreview() {
  if (!state.img || !params || !state.crop) return;
  const g = previewGeom();
  pv.style.height = g.cssH + 'px';
  pv.width = Math.round(g.cssW * g.dpr); pv.height = Math.round(g.cssH * g.dpr);
  const ctx = pv.getContext('2d');
  ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
  ctx.fillStyle = '#2b3038'; ctx.fillRect(0, 0, g.cssW, g.cssH);
  const r = cropRect(params, state.crop);
  const k = g.frameW / r.w; // 原图像素 → CSS 像素
  // 框外：原图变暗
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.drawImage(state.img, g.padX - r.x * k, g.padY - r.y * k, state.W * k, state.H * k);
  ctx.restore();
  // 框内：成品效果
  const out = renderCrop(Math.round(g.frameW * g.dpr), Math.round(g.frameH * g.dpr));
  ctx.drawImage(out, g.padX, g.padY, g.frameW, g.frameH);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(g.padX, g.padY, g.frameW, g.frameH);

  const mmY = (mm) => g.padY + (mm / params.hMm) * g.frameH;
  if ($('showGuides').checked) {
    // 头顶目标线
    ctx.strokeStyle = '#2f80ed'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    line(ctx, g.padX - 8, mmY(params.top), g.padX + g.frameW + 8, mmY(params.top));
    ctx.setLineDash([]);
    // 下巴范围带
    ctx.fillStyle = 'rgba(39,174,96,0.25)';
    ctx.fillRect(g.padX, mmY(params.top + params.headMin), g.frameW, mmY(params.top + params.headMax) - mmY(params.top + params.headMin));
    ctx.strokeStyle = '#27ae60'; ctx.lineWidth = 1.5;
    line(ctx, g.padX, mmY(params.top + params.headMin), g.padX + g.frameW, mmY(params.top + params.headMin));
    line(ctx, g.padX, mmY(params.top + params.headMax), g.padX + g.frameW, mmY(params.top + params.headMax));
    // 中线
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    line(ctx, g.padX + g.frameW / 2, g.padY, g.padX + g.frameW / 2, g.padY + g.frameH);
    ctx.setLineDash([]);
    // 识别到的头顶/下巴（橙色小三角）
    if (state.det) {
      const y1 = g.padY + (state.det.crownY - r.y) * k, y2 = g.padY + (state.det.chinY - r.y) * k;
      ctx.fillStyle = '#f2994a';
      tri(ctx, g.padX + g.frameW + 2, y1); tri(ctx, g.padX + g.frameW + 2, y2);
    }
  }
  updateMeasure();
}
function line(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function tri(ctx, x, y) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 9, y - 6); ctx.lineTo(x + 9, y + 6); ctx.closePath(); ctx.fill(); }

function updateMeasure() {
  if (!state.det) { $('measure').textContent = t('noFaceMeasure'); return; }
  const m = measure(params, state.crop, state.det);
  const okH = m.headMm >= params.headMin - 0.05 && m.headMm <= params.headMax + 0.05;
  const okT = Math.abs(m.topMm - params.top) <= 1;
  $('measure').innerHTML =
    `${t('head')} <span class="${okH ? 'ok' : 'bad'}">${m.headMm.toFixed(1)} mm</span> (${t('need')} ${params.headMin}–${params.headMax})　` +
    `${t('topSpace')} <span class="${okT ? 'ok' : 'bad'}">${m.topMm.toFixed(1)} mm</span>`;
}

// 拖动 / 双指缩放
const pointers = new Map();
let pinch0 = null, zoomBase = 1;
pv.addEventListener('pointerdown', (e) => { if (!state.crop) return; pv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch0 = null; });
pv.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !state.crop) return;
  const prev = pointers.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, cur);
  const g = previewGeom();
  const r = cropRect(params, state.crop);
  const k = r.w / g.frameW; // CSS 像素 → 原图像素
  if (pointers.size === 1) {
    state.crop.cx -= (cur.x - prev.x) * k;
    state.crop.top -= (cur.y - prev.y) * k;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0) state.crop = zoomAt(params, state.crop, d / pinch0);
    pinch0 = d;
    syncZoomSlider();
  }
  schedule();
});
const endPtr = (e) => { pointers.delete(e.pointerId); pinch0 = null; };
pv.addEventListener('pointerup', endPtr); pv.addEventListener('pointercancel', endPtr);
pv.addEventListener('wheel', (e) => { if (!state.crop) return; e.preventDefault(); state.crop = zoomAt(params, state.crop, Math.exp(-e.deltaY / 500)); syncZoomSlider(); schedule(); }, { passive: false });
// 滑块：相对自动对齐时的缩放，±100 = ×2 / ÷2
$('zoom').addEventListener('input', () => {
  if (!state.crop) return;
  const target = zoomBase / Math.pow(2, $('zoom').value / 100);
  state.crop = zoomAt(params, state.crop, state.crop.ppm / target);
  schedule();
});
function syncZoomSlider() { $('zoom').value = Math.round(Math.log2(zoomBase / state.crop.ppm) * 100); }
$('showGuides').onchange = schedule;
window.addEventListener('resize', schedule);

// ---------- 调光 ----------
const ADJ_KEYS = Object.keys(DEFAULT_ADJ);
function syncAdjUI() {
  $('a_fill').value = state.fill; $('a_fill').nextElementSibling.textContent = state.fill;
  for (const k of ADJ_KEYS) { const el = $('a_' + k); el.value = state.adj[k]; el.nextElementSibling.textContent = fmtAdj(k, state.adj[k]); }
}
function fmtAdj(k, v) { return k === 'exposure' ? (v > 0 ? '+' : '') + (+v).toFixed(2) : (v > 0 ? '+' : '') + v; }
for (const k of ADJ_KEYS) $('a_' + k).addEventListener('input', (e) => { state.adj[k] = parseFloat(e.target.value); e.target.nextElementSibling.textContent = fmtAdj(k, state.adj[k]); schedule(); });
$('a_fill').addEventListener('input', (e) => { state.fill = +e.target.value; e.target.nextElementSibling.textContent = state.fill; schedule(); });
$('resetLight').onclick = () => { state.adj = { ...DEFAULT_ADJ }; state.fill = 0; syncAdjUI(); schedule(); };
$('autoLight').onclick = () => {
  if (!state.crop) return;
  const save = state.adj, saveFill = state.fill; state.adj = { ...DEFAULT_ADJ }; state.fill = 0;
  const bgWas = $('bgOn').checked; $('bgOn').checked = false;
  const w = 300, h = Math.round(300 * params.hMm / params.wMm);
  const c = renderCrop(w, h);
  $('bgOn').checked = bgWas;
  const id = c.getContext('2d').getImageData(0, 0, w, h);
  let face = null;
  if (state.det) {
    const r = cropRect(params, state.crop), k = w / r.w;
    const fw = state.det.faceW * 0.6, fh = (state.det.chinY - state.det.crownY) * 0.5;
    face = { x: (state.det.cx - fw / 2 - r.x) * k, y: (state.det.crownY + (state.det.chinY - state.det.crownY) * 0.3 - r.y) * k, w: fw * k, h: fh * k };
  }
  // 先补光（去侧面阴影），再按补光后的脸定曝光
  if (state.det) {
    const rr = cropRect(params, state.crop), fe = faceEllipse(rr, w / rr.w, w / rr.w);
    state.fill = suggestFill(id, fe);
    fillLight(id, fe, state.fill / 100);
  } else state.fill = saveFill;
  state.adj = autoAdjust(id, face) || save;
  syncAdjUI(); schedule();
};

// ---------- 背景 ----------
$('bgOn').onchange = schedule;
$('feather').addEventListener('input', (e) => { e.target.nextElementSibling.textContent = e.target.value; schedule(); });
$('feather').nextElementSibling.textContent = $('feather').value;

// ---------- 导出 ----------
let lastBlob = null, lastName = '';
function clearExport() { $('expImg').removeAttribute('src'); $('expInfo').textContent = ''; $('expActions').hidden = true; lastBlob = null; }

// 把 JPEG 里 JFIF 头的分辨率改成 DPI（打印店软件会读这个）
async function setJpegDpi(blob, dpi) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[3] === 0xe0 &&
      buf[6] === 0x4a && buf[7] === 0x46 && buf[8] === 0x49 && buf[9] === 0x46) {
    buf[13] = 1; buf[14] = dpi >> 8; buf[15] = dpi & 255; buf[16] = dpi >> 8; buf[17] = dpi & 255;
  }
  return new Blob([buf], { type: 'image/jpeg' });
}
const toJpeg = (c, q = 0.95) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));
const kb = (b) => (b.size / 1024 < 1024 ? (b.size / 1024).toFixed(0) + ' KB' : (b.size / 1048576).toFixed(2) + ' MB');

function renderSingle() { const { w, h } = outputPixels(params); return renderCrop(w, h); }

function renderSheet() {
  const L = sheetLayout(params);
  if (!L.n) return { error: t('noFit') };
  // iPhone Safari 单个 canvas 上限约 1670 万像素，超了会画出空白图
  if (L.W * L.H > 16.7e6) return { error: t('tooBig', Math.floor(Math.sqrt(16.7e6 / 24))) };
  const c = document.createElement('canvas'); c.width = L.W; c.height = L.H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, L.W, L.H);
  const one = renderSingle();
  for (const cell of L.cells) ctx.drawImage(one, cell.x, cell.y);
  // 裁切线：每张四周细灰线 + 延伸到纸边的十字刀线
  const lw = Math.max(1, Math.round(params.dpi / 300));
  ctx.strokeStyle = '#9aa0a6'; ctx.lineWidth = lw;
  const xs = new Set(), ys = new Set();
  for (const cell of L.cells) { xs.add(cell.x); xs.add(cell.x + cell.w); ys.add(cell.y); ys.add(cell.y + cell.h); }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  ctx.beginPath();
  for (const x of xs) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, y0 - 2 * lw); ctx.moveTo(x + 0.5, y1 + 2 * lw); ctx.lineTo(x + 0.5, L.H); }
  for (const y of ys) { ctx.moveTo(0, y + 0.5); ctx.lineTo(x0 - 2 * lw, y + 0.5); ctx.moveTo(x1 + 2 * lw, y + 0.5); ctx.lineTo(L.W, y + 0.5); }
  ctx.stroke();
  ctx.lineWidth = lw;
  for (const cell of L.cells) ctx.strokeRect(cell.x - 0.5, cell.y - 0.5, cell.w + 1, cell.h + 1);
  return { canvas: c, L };
}

async function doExport(kind) {
  if (!state.crop || !params) return;
  busy(t('exporting'));
  try {
    let canvas, info;
    if (kind === 'single') {
      canvas = renderSingle();
      info = `${canvas.width} × ${canvas.height} px · ${params.wMm}×${params.hMm} mm @ ${params.dpi} DPI`;
      lastName = `idphoto_${params.wMm}x${params.hMm}mm_${canvas.width}x${canvas.height}.jpg`;
    } else {
      const r = renderSheet();
      if (r.error) { alert(r.error); return; }
      canvas = r.canvas;
      info = t('sheetInfo', canvas.width, canvas.height, r.L.n, r.L.cols, r.L.rows, params.dpi);
      lastName = `idphoto_4x6_${r.L.n}up_${canvas.width}x${canvas.height}.jpg`;
    }
    let q = 0.95, blob = await toJpeg(canvas, q);
    // 官方对电子版文件大小有要求时，自动调 JPEG 质量落进范围
    if (kind === 'single' && (params.kbMax || params.kbMin)) {
      const lo = (params.kbMin || 0) * 1024, hi = (params.kbMax || 1e9) * 1024;
      if (blob.size > hi) {
        let a = 0.3, b2 = 0.95;
        for (let i = 0; i < 8; i++) { q = (a + b2) / 2; blob = await toJpeg(canvas, q); if (blob.size > hi) b2 = q; else a = q; }
        if (blob.size > hi) { q = a; blob = await toJpeg(canvas, q); }
      } else if (blob.size < lo) { q = 1; blob = await toJpeg(canvas, 1); }
      info += ` · ${t('fileTarget')} ${params.kbMin || 0}–${params.kbMax} KB`;
    }
    lastBlob = await setJpegDpi(blob, Math.round(params.dpi));
    const url = URL.createObjectURL(lastBlob);
    $('expImg').src = url;
    $('expDl').href = url; $('expDl').download = lastName;
    $('expInfo').textContent = `${info} · ${kb(lastBlob)}`;
    $('expActions').hidden = false;
    window.__idp.lastExport = { w: canvas.width, h: canvas.height, bytes: lastBlob.size, name: lastName };
  } finally { busy(false); }
}
$('expSingle').onclick = () => doExport('single');
$('expSheet').onclick = () => doExport('sheet');
$('expShare').onclick = async () => {
  if (!lastBlob) return;
  const file = new File([lastBlob], lastName, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
  } else { $('expDl').click(); }
};

// ---------- 杂项 ----------
function busy(msg) { if (msg) { $('busyMsg').textContent = msg; $('busy').hidden = false; } else $('busy').hidden = true; }

applyStatic();
$('langBtn').textContent = lang === 'zh' ? 'EN' : '中文';
$('langBtn').onclick = () => {
  setLang(lang === 'zh' ? 'en' : 'zh');
  $('langBtn').textContent = lang === 'zh' ? 'EN' : '中文';
  fillPresetSel($('presetSel').value); applyPresetSel(false);
  updateBgHint(); if (state.crop) schedule();
};
fillPresetSel(localStorage.getItem(LAST_KEY) || 'b:' + BUILTIN[0].id); applyPresetSel(false);
// 自动更新：每次打开/切回 App 都去检查新版（绕过浏览器缓存），新版装好后自动刷新一次
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    // 正在编辑照片时不打断，等切到后台再刷新
    if (state.img && document.visibilityState === 'visible') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') location.reload(); }, { once: true });
      $('ver').textContent = VERSION + (lang === 'zh' ? ' · 新版已下载，下次打开生效' : ' · update ready, applies next launch');
    } else location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
// 测试钩子：直接塞一张 canvas 进来
window.__idp.setImage = setImage;
window.__idp.doAuto = doAuto;
window.__idp.schedule = schedule;
window.__idp.render = { single: renderSingle, sheet: renderSheet };
window.__idp.faceEllipse = faceEllipse;
window.__idp.cropRect = () => cropRect(params, state.crop);

// ---------- 取景相机：按所选证件画出头肩轮廓 ----------
let camStream = null, camFacing = 'user', camTimer = false, camZoom = 2, camLight = false, camCaps = {};
$('camBtn').onclick = openCam;
async function openCam() {
  if (!navigator.mediaDevices?.getUserMedia || !params) { $('camIn').click(); return; }
  try {
    await startStream();
    $('cam').hidden = false;
    drawGuide();
  } catch (e) {
    console.error(e); stopCam(); alert(t('camFail')); $('camIn').click();
  }
}
async function startStream() {
  camStream?.getTracks().forEach((tr) => tr.stop());
  camStream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: { facingMode: camFacing, width: { ideal: 1920 }, height: { ideal: 1920 } },
  });
  const v = $('camVideo');
  v.srcObject = camStream;
  v.classList.toggle('mirror', camFacing === 'user');
  await v.play().catch(() => {});
  await new Promise((r) => (v.videoWidth ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
  // 变焦和手电筒：先查手机支持不支持，不支持就不显示/不用（iPhone Safari、安卓 Chrome 都支持变焦，手电筒只有后置）
  const tr = camStream.getVideoTracks()[0];
  camCaps = (tr && tr.getCapabilities && tr.getCapabilities()) || {};
  $('camZoom').hidden = !camCaps.zoom || camCaps.zoom.max < 2;
  await applyZoom();
  await applyLight();
}
async function applyZoom() {
  const tr = camStream?.getVideoTracks()[0];
  $('camZoom').textContent = camZoom + '×';
  if (!tr || !camCaps.zoom || camCaps.zoom.max < 2) return;
  const z = Math.min(camCaps.zoom.max, Math.max(camCaps.zoom.min, camZoom));
  try { await tr.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) { console.warn('zoom', e); }
}
// 补光：后置有手电筒就开手电筒；前置（或没有手电筒）就把框外整屏变白当照脸灯
async function applyLight() {
  const tr = camStream?.getVideoTracks()[0];
  const torch = !!camCaps.torch && camFacing === 'environment';
  if (tr && camCaps.torch) { try { await tr.applyConstraints({ advanced: [{ torch: camLight && torch }] }); } catch (e) { console.warn('torch', e); } }
  $('cam').classList.toggle('screenFill', camLight && !torch);
  $('camLight').classList.toggle('on', camLight);
  if (!$('cam').hidden) drawGuide();
}
function stopCam() {
  camStream?.getTracks().forEach((tr) => tr.stop()); camStream = null;
  $('camVideo').srcObject = null; $('cam').hidden = true; $('camCount').textContent = '';
  camLight = false; $('cam').classList.remove('screenFill'); $('camLight').classList.remove('on');
}
$('camClose').onclick = stopCam;
$('camFlip').onclick = async () => { camFacing = camFacing === 'user' ? 'environment' : 'user'; try { await startStream(); drawGuide(); } catch (e) { console.error(e); } };
$('camTimer').onclick = () => { camTimer = !camTimer; $('camTimer').classList.toggle('on', camTimer); };
$('camZoom').onclick = () => { camZoom = camZoom === 2 ? 1 : 2; applyZoom(); };
$('camLight').onclick = () => { camLight = !camLight; applyLight(); };
window.addEventListener('resize', () => { if (!$('cam').hidden) drawGuide(); });

// 轮廓框：成品比例的框占画面约 78% 宽；头高按范围中点画
function guideGeom() {
  const W = innerWidth, H = innerHeight;
  const aspect = params.hMm / params.wMm;
  let fw = W * 0.78, fh = fw * aspect;
  if (fh > H * 0.62) { fh = H * 0.62; fw = fh / aspect; }
  return { W, H, fx: (W - fw) / 2, fy: (H - fh) / 2 - H * 0.02, fw, fh, k: fw / params.wMm };
}
function drawGuide() {
  const c = $('camGuide'), dpr = devicePixelRatio || 1, g = guideGeom();
  c.width = g.W * dpr; c.height = g.H * dpr;
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 框外压暗
  const fill = $('cam').classList.contains('screenFill');
  x.fillStyle = fill ? '#fff' : 'rgba(0,0,0,0.45)';
  x.beginPath(); x.rect(0, 0, g.W, g.H); x.rect(g.fx, g.fy, g.fw, g.fh); x.fill('evenodd');
  x.strokeStyle = fill ? '#888' : '#fff'; x.lineWidth = 2; x.strokeRect(g.fx, g.fy, g.fw, g.fh);
  const head = (params.headMin + params.headMax) / 2 * g.k;
  const crown = g.fy + params.top * g.k, chin = crown + head, cx = g.fx + g.fw / 2;
  const hw = head * 0.38; // 半个头宽（含头发）
  x.save(); x.beginPath(); x.rect(g.fx, g.fy, g.fw, g.fh); x.clip();
  // 头 + 脖子 + 肩膀轮廓
  x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 3; x.setLineDash([8, 6]);
  x.beginPath(); x.ellipse(cx, crown + head / 2, hw, head / 2, 0, 0, Math.PI * 2); x.stroke();
  const neckTop = chin - head * 0.08, neckW = head * 0.2, shY = chin + head * 0.32, shW = head * 1.25;
  x.beginPath();
  x.moveTo(cx - neckW, neckTop); x.lineTo(cx - neckW, chin + head * 0.12);
  x.quadraticCurveTo(cx - neckW - head * 0.1, shY - head * 0.08, cx - shW * 0.6, shY);
  x.quadraticCurveTo(cx - shW, shY + head * 0.05, cx - shW * 1.05, shY + head * 0.6);
  x.moveTo(cx + neckW, neckTop); x.lineTo(cx + neckW, chin + head * 0.12);
  x.quadraticCurveTo(cx + neckW + head * 0.1, shY - head * 0.08, cx + shW * 0.6, shY);
  x.quadraticCurveTo(cx + shW, shY + head * 0.05, cx + shW * 1.05, shY + head * 0.6);
  x.stroke(); x.setLineDash([]);
  // 头顶线（蓝）和下巴线（绿）
  x.lineWidth = 2.5;
  x.strokeStyle = '#4da3ff'; line(x, g.fx, crown, g.fx + g.fw, crown);
  x.strokeStyle = '#3ddc84'; line(x, g.fx, chin, g.fx + g.fw, chin);
  x.restore();
}
$('camShot').onclick = async () => {
  if (!camStream) return;
  if (camTimer) for (let n = 3; n > 0; n--) { $('camCount').textContent = n; await new Promise((r) => setTimeout(r, 1000)); }
  $('camCount').textContent = '';
  const v = $('camVideo'), vw = v.videoWidth, vh = v.videoHeight;
  // 只保留屏幕上看得到的那部分（object-fit: cover），这样构图和取景一致
  const W = innerWidth, H = innerHeight, sc = Math.max(W / vw, H / vh);
  const sw = W / sc, sh = H / sc, sx0 = (vw - sw) / 2, sy0 = (vh - sh) / 2;
  const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(v, sx0, sy0, sw, sh, 0, 0, c.width, c.height);
  stopCam();
  await setImageBusy(c);
};
async function setImageBusy(c) { busy(t('reading')); try { await setImage(c); } finally { busy(false); } }
