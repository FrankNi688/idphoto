// 离线：缓存整个 App 和本地模型。不从任何其他网站加载东西，照片永远不出手机。
const VERSION = 'idp-v1.2.5';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'crop.js', 'light.js', 'i18n.js', 'presets.js', 'matte.js', 'fill.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/models/face_landmarker.task', 'vendor/models/selfie_segmenter.tflite',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  // 先用缓存；没缓存的（如老设备才用的 nosimd wasm）联网取一次再存起来
  e.respondWith(caches.match(r, { ignoreSearch: true }).then((hit) => hit || fetch(r).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(r, copy)); }
    return res;
  })));
});
