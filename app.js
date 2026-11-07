// 证件照 PWA 主程序：选图 → 识别人脸 → 按参数裁剪 → 调光 → 换背景 → 导出
import { outputPixels, validate, autoCrop, cropRect, measure, zoomAt, sheetLayout, headFromLandmarks } from './crop.js';
import { DEFAULT_ADJ, buildLUT, applyLUT, autoAdjust, isNeutral } from './light.js';
import { t, lang, setLang, applyStatic } from './i18n.js';

const VERSION = 'v1.1.1';
const $ = (id) => document.getElementById(id);
$('ver').textContent = VERSION;

// ---------- 预设 ----------
const PRESET_KEY = 'idp-presets-v1';
const EXAMPLE = { name: t('example'), wMm: 50, hMm: 70, headMin: 31, headMax: 36, top: 5, dpi: 300, bg: '#ffffff' };
const FIELDS = ['wMm', 'hMm', 'headMin', 'headMax', 'top', 'dpi', 'bg'];
let presets = loadPresets();

function loadPresets() {
  try { const a = JSON.parse(localStorage.getItem(PRESET_KEY)); if (Array.isArray(a) && a.length) return a; } catch {}
  return [EXAMPLE];
}
function savePresets() { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); }
function fillPresetSel(sel) {
  $('presetSel').innerHTML = presets.map((p, i) => `<option value="${i}">${p.name.replace(/</g, '&lt;')}</option>`).join('');
  $('presetSel').value = String(sel ?? 0);
}
function setParams(p) { for (const f of FIELDS) $('p_' + f).value = p[f]; }
function getParams() {
  const p = {};
  for (const f of FIELDS) p[f] = f === 'bg' ? $('p_bg').value : parseFloat($('p_' + f).value);
  return p;
}
$('presetSel').onchange = () => { setParams(presets[+$('presetSel').value]); onParams(true); };
$('presetSave').onclick = () => {
  const p = getParams();
  if (validate(p).length) return alert(t('fixFirst'));
  const name = prompt(t('presetName'), `${p.wMm}×${p.hMm} mm`);
  if (!name) return;
  const i = presets.findIndex((x) => x.name === name);
  const item = { name, ...p };
  if (i >= 0) presets[i] = item; else presets.push(item);
  savePresets(); fillPresetSel(i >= 0 ? i : presets.length - 1);
};
$('presetDel').onclick = () => {
  if (presets.length <= 1) return alert(t('keepOne'));
  const i = +$('presetSel').value;
  if (!confirm(t('delConfirm', presets[i].name))) return;
  presets.splice(i, 1); savePresets(); fillPresetSel(0); setParams(presets[0]); onParams(true);
};
for (const f of FIELDS) $('p_' + f).addEventListener('input', () => onParams(false));

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
  adj: { ...DEFAULT_ADJ },
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
  state.adj = { ...DEFAULT_ADJ }; syncAdjUI();
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
    // 做成 alpha 画布
    const mc = document.createElement('canvas'); mc.width = mw; mc.height = mh;
    const ctx = mc.getContext('2d');
    const id = ctx.createImageData(mw, mh);
    for (let i = 0; i < data.length; i++) {
      // 稍微拉陡一点，边缘更干净
      const a = Math.min(1, Math.max(0, (data[i] - 0.3) / 0.4));
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 0;
      id.data[i * 4 + 3] = Math.round(a * 255);
    }
    ctx.putImageData(id, 0, 0);
    state.mask = mc; state.maskStatus = 'ok';
  } catch (e) {
    console.error(e); state.maskData = null; state.mask = null; state.maskStatus = 'fail';
  }
  updateBgHint();
}
function updateBgHint() {
  const m = { idle: '', running: t('segRunning'), ok: t('segOk'), fail: t('segFail') };
  $('bgHint').textContent = m[state.maskStatus];
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
  if (!isNeutral(state.adj)) {
    const id = pc.getImageData(0, 0, outW, outH);
    applyLUT(id, buildLUT(state.adj));
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
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(m, 0, 0);
    pc.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(photo, 0, 0);
  return c;
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
  for (const k of ADJ_KEYS) { const el = $('a_' + k); el.value = state.adj[k]; el.nextElementSibling.textContent = fmtAdj(k, state.adj[k]); }
}
function fmtAdj(k, v) { return k === 'exposure' ? (v > 0 ? '+' : '') + (+v).toFixed(2) : (v > 0 ? '+' : '') + v; }
for (const k of ADJ_KEYS) $('a_' + k).addEventListener('input', (e) => { state.adj[k] = parseFloat(e.target.value); e.target.nextElementSibling.textContent = fmtAdj(k, state.adj[k]); schedule(); });
$('resetLight').onclick = () => { state.adj = { ...DEFAULT_ADJ }; syncAdjUI(); schedule(); };
$('autoLight').onclick = () => {
  if (!state.crop) return;
  const save = state.adj; state.adj = { ...DEFAULT_ADJ };
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
    lastBlob = await setJpegDpi(await toJpeg(canvas), Math.round(params.dpi));
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
  // 只有一组没改过的示例预设时，名字跟着语言走
  if (presets.length === 1 && /50×70/.test(presets[0].name) && !localStorage.getItem(PRESET_KEY)) { presets[0].name = t('example'); fillPresetSel(0); }
  onParams(false); updateBgHint(); if (state.crop) schedule();
};
fillPresetSel(0); setParams(presets[0]); onParams(false);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
// 测试钩子：直接塞一张 canvas 进来
window.__idp.setImage = setImage;
window.__idp.doAuto = doAuto;
window.__idp.schedule = schedule;
window.__idp.render = { single: renderSingle, sheet: renderSheet };
