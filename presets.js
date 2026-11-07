// 官方证件照规格（2026-11-07 核对官网）。内置预设不可改；要改就选「自定义」。
// head = 下巴到头顶（含头发）mm；top = 头顶到上边 mm（官方给范围时取中间）；
// dpi 的取值同时满足官方电子照片像素要求；kbMin/kbMax = 电子版文件大小要求（导出单张时自动调质量）。
export const BUILTIN = [
  {
    id: 'cn-passport', en: 'China passport', zh: '中国护照',
    wMm: 33, hMm: 48, headMin: 28, headMax: 33, top: 4, dpi: 300, bg: '#ffffff', kbMin: 30, kbMax: 80,
    noteEn: '33×48 mm · head 28–33 mm · 3–5 mm above head · ≥7 mm below chin · white background, dark top, ears visible · JPEG 30–80 KB (Embassy in Canada)',
    noteZh: '33×48 mm · 头高 28–33 mm · 头顶留白 3–5 mm · 下巴下方 ≥7 mm · 纯白背景、深色上衣、露双耳 · 电子版 JPEG 30–80 KB（驻加使馆）',
  },
  {
    id: 'cn-visa', en: 'China visa', zh: '中国签证',
    wMm: 33, hMm: 48, headMin: 28, headMax: 33, top: 4, dpi: 290, bg: '#ffffff', kbMin: 40, kbMax: 120,
    noteEn: '33×48 mm · head 28–33 mm · 3–5 mm above head · white background, ears visible · digital 354×472 to 420×560 px, JPEG 40–120 KB',
    noteZh: '33×48 mm · 头高 28–33 mm · 头顶留白 3–5 mm · 白色背景、露双耳 · 电子版 354×472 到 420×560 像素，JPEG 40–120 KB',
  },
  {
    id: 'ca-passport', en: 'Canada passport', zh: '加拿大护照',
    wMm: 50, hMm: 70, headMin: 31, headMax: 36, top: 5, dpi: 300, bg: '#ffffff',
    noteEn: '50×70 mm · chin to crown 31–36 mm · plain white or light background · no shadows · print on photo paper. IRCC requires a commercial photographer and unedited photos for passports.',
    noteZh: '50×70 mm · 下巴到头顶 31–36 mm · 纯白或浅色背景 · 无阴影 · 相纸冲印。注意：加拿大护照官方要求照相馆拍摄、不得做任何修改。',
  },
  {
    id: 'ca-passport-digital', en: 'Canada passport (online renewal, digital)', zh: '加拿大护照（在线续签电子版）',
    wMm: 40, hMm: 60, headMin: 27, headMax: 30, top: 6, dpi: 762, bg: '#ffffff', kbMin: 200, kbMax: 5120,
    noteEn: 'Digital photo for online renewal · 3:2 portrait, 1200×1800 px (max 3000×4500) · chin to crown 45–50% of photo height · JPEG 200 KB–5 MB · plain white or light background, no shadows. IRCC asks for the studio name, address and photo date when you upload.',
    noteZh: '在线续签用电子照 · 竖向 3:2，1200×1800 像素（最大 3000×4500）· 下巴到头顶占照片高度 45–50% · JPEG 200 KB–5 MB · 纯白或浅色背景、无阴影。上传时官网要求填照相馆名称、地址和拍摄日期。',
  },
  {
    id: 'ca-pr', en: 'Canada PR card', zh: '加拿大 PR 卡',
    wMm: 50, hMm: 70, headMin: 31, headMax: 36, top: 5, dpi: 400, bg: '#ffffff', kbMax: 4096,
    noteEn: '50×70 mm · chin to natural top of head 31–36 mm · plain white background · digital 715×1000 to 2000×2800 px, JPEG ≤4 MB',
    noteZh: '50×70 mm · 下巴到头顶 31–36 mm · 纯白背景 · 电子版 715×1000 到 2000×2800 像素，JPEG ≤4 MB',
  },
  {
    id: 'ca-visa', en: 'Canada visa', zh: '加拿大签证',
    wMm: 35, hMm: 45, headMin: 31, headMax: 36, top: 3.5, dpi: 400, bg: '#ffffff',
    noteEn: '35×45 mm (minimum) · chin to crown 31–36 mm · show top of shoulders · plain white or light background · digital at least 420×540 px',
    noteZh: '35×45 mm（最小）· 下巴到头顶 31–36 mm · 要露出肩膀上沿 · 纯白或浅色背景 · 电子版至少 420×540 像素',
  },
  {
    id: 'us-visa', en: 'US visa', zh: '美国签证',
    wMm: 50.8, hMm: 50.8, headMin: 25.4, headMax: 34.9, top: 6, dpi: 300, bg: '#ffffff', kbMax: 240,
    noteEn: '2×2 in (51×51 mm) · head 1 to 1 3/8 in (25–35 mm) · white or off-white background · no glasses · digital 600×600 px, JPEG ≤240 KB',
    noteZh: '2×2 英寸（51×51 mm）· 头高 25–35 mm · 白色或米白背景 · 不能戴眼镜 · 电子版 600×600 像素，JPEG ≤240 KB',
  },
];
