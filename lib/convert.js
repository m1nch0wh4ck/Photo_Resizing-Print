// 변환 파이프라인: 읽기 → 픽셀 다시 짜기 → 새로 인코딩 → 허용 목록 정리 → 검증.
// 원본 File 은 읽기만 한다(arrayBuffer). 결과는 언제나 새로 만든 Blob 이다.
import { decodePng, encodePng, hasNativeDeflate } from "./png.js";
import { findStealth, hasStealthPrefix } from "./stealth.js";
import { sniff, analyzeContainer, sanitizeContainer, verifyContainer, MIME, LABEL } from "./meta.js";

export const DEFAULTS = { mode: "normal", format: "webp", quality: 85, background: "#ffffff", scrubRgb: true };

/* ---------- 픽셀 처리 (DOM 없이 동작) ---------- */

export function alphaStats(rgba) {
  let transparent = 0, semi = 0, opaque = 0, nearOpaque = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a === 0) transparent++;
    else if (a === 255) opaque++;
    else if (a >= 250) nearOpaque++; // NAI는 불투명 영역 알파를 254/255로 써서 정보를 숨긴다
    else semi++;
  }
  return { transparent, semi, opaque, nearOpaque, total: rgba.length / 4 };
}

/** 실제로 비쳐 보이는 투명 영역이 있는지 (알파 250 미만 픽셀이 0.1% 넘게 있으면) */
export const hasRealTransparency = (s) => s.transparent + s.semi > s.total * 0.001;

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 일반 모드: 배경색 위에 합성해서 알파를 없앤 새 픽셀 (A=255) */
export function flattenOnto(rgba, background) {
  const [br, bg, bb] = parseHex(background);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) { out[i] = rgba[i]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i + 2]; }
    else {
      const k = 255 - a;
      out[i] = (rgba[i] * a + br * k + 127) / 255;
      out[i + 1] = (rgba[i + 1] * a + bg * k + 127) / 255;
      out[i + 2] = (rgba[i + 2] * a + bb * k + 127) / 255;
    }
    out[i + 3] = 255;
  }
  return out;
}

/** 알파 정리: webp_converter.py 와 같은 식 — (a + 2) // 4 * 4, 255로 자름. 255 → 255, 0 → 0 */
export const scrubAlphaValue = (a) => Math.min(255, ((a + 2) >> 2) << 2);

/**
 * 투명 모드: 알파 하위 2비트 정리 + 완전 투명 픽셀의 숨은 RGB 비우기 + (선택) RGB 최하위 비트 정리.
 * 반환: { data, stats: { alphaChanged, maxAlphaDelta, opaqueIn, opaqueKept, hiddenRgbCleared } }
 */
export function scrubTransparent(rgba, { scrubRgb = true } = {}) {
  const out = new Uint8ClampedArray(rgba.length);
  let alphaChanged = 0, maxAlphaDelta = 0, opaqueIn = 0, opaqueKept = 0, hiddenRgbCleared = 0;
  const lut = new Uint8Array(256);
  for (let a = 0; a < 256; a++) lut[a] = scrubAlphaValue(a);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3], na = lut[a];
    if (a !== na) { alphaChanged++; const d = Math.abs(a - na); if (d > maxAlphaDelta) maxAlphaDelta = d; }
    if (a === 255) { opaqueIn++; if (na === 255) opaqueKept++; }
    if (na === 0) {
      if (rgba[i] | rgba[i + 1] | rgba[i + 2]) hiddenRgbCleared++;
      out[i] = out[i + 1] = out[i + 2] = 0;
    } else if (scrubRgb) {
      out[i] = rgba[i] & 0xfe; out[i + 1] = rgba[i + 1] & 0xfe; out[i + 2] = rgba[i + 2] & 0xfe;
    } else {
      out[i] = rgba[i]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i + 2];
    }
    out[i + 3] = na;
  }
  return { data: out, stats: { alphaChanged, maxAlphaDelta, opaqueIn, opaqueKept, hiddenRgbCleared } };
}

export function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; se += d * d; }
    n += 3;
  }
  if (se === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / (se / n));
}

/* ---------- 브라우저 코덱 ---------- */

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
// iOS 사파리는 캔버스 메모리를 바로 돌려주지 않으므로 크기를 0으로 줄여 놓는다
function releaseCanvas(c) { c.width = 0; c.height = 0; }

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 브라우저 디코더로 RGBA 얻기 (JPEG·WebP, 또는 직접 못 읽은 PNG). JPEG 회전(EXIF)은 그림에 반영된다. */
export async function decodeWithBrowser(blob) {
  let img;
  try { img = await loadImage(blob); } catch { throw new Error("이미지를 열 수 없습니다. 손상됐거나 이 브라우저가 지원하지 않는 형식입니다."); }
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = newCanvas(w, h);
  try {
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("캔버스를 만들 수 없습니다. 이미지가 너무 큽니다.");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    return { width: w, height: h, data };
  } catch (e) {
    throw new Error(`이미지가 너무 커서 이 기기에서 처리할 수 없습니다 (${w}×${h}).`);
  } finally {
    releaseCanvas(c);
    img.src = "";
  }
}

export async function decodeAny(bytes, format) {
  if (format === "png" && hasNativeDeflate()) {
    try { return await decodePng(bytes); } catch (e) { console.warn("PNG 직접 읽기 실패, 브라우저 디코더 사용:", e); }
  }
  return decodeWithBrowser(new Blob([bytes], { type: MIME[format] }));
}

async function canvasEncode(rgba, w, h, mime, quality) {
  const c = newCanvas(w, h);
  try {
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("캔버스를 만들 수 없습니다.");
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    return await new Promise((res) => c.toBlob(res, mime, quality));
  } finally {
    releaseCanvas(c);
  }
}

let nativeWebp = null;
/** 이 브라우저가 캔버스로 WebP를 만들 수 있는지 (iOS 사파리는 못 함 → WASM 인코더 사용) */
export async function supportsNativeWebp() {
  if (nativeWebp === null) {
    try {
      const b = await canvasEncode(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1, "image/webp", 0.8);
      nativeWebp = !!b && b.type === "image/webp";
    } catch { nativeWebp = false; }
  }
  return nativeWebp;
}

// libwebp WebPConfig 기본값 (Squoosh / jSquash 와 같음)
const WEBP_OPTIONS = {
  quality: 85, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60, filter_sharpness: 0,
  filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
  partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, lossless: 0, exact: 0,
  image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0, near_lossless: 100, use_delta_palette: 0,
  use_sharp_yuv: 0,
};
let wasmModule = null;
async function wasmWebp(rgba, w, h, quality) {
  if (!wasmModule) {
    wasmModule = import("../vendor/webp_enc.js").then((m) => m.default({ noInitialRun: true }));
    wasmModule.catch(() => { wasmModule = null; });
  }
  const mod = await wasmModule;
  const out = mod.encode(rgba, w, h, { ...WEBP_OPTIONS, quality });
  if (!out) throw new Error("WebP 인코딩에 실패했습니다.");
  return new Uint8Array(out); // WASM 메모리에서 복사
}

/** 테스트용: WASM 인코더를 강제로 쓰게 한다 */
export function forceWasmWebp(on) { nativeWebp = on ? false : null; }

/* ---------- 입력 분석 ---------- */

/** 원본 검사: 형식, 크기, 일반 메타데이터 목록, 스텔스 정보, 투명도 */
export async function analyzeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniff(bytes);
  if (!format) throw new Error("PNG·JPEG·WebP 파일만 넣을 수 있습니다.");
  let meta = [];
  try { meta = analyzeContainer(bytes, format); } catch (e) { meta = [{ key: "broken", label: `구조 오류: ${e.message}`, sensitive: true, size: 0 }]; }
  const img = await decodeAny(bytes, format);
  const stealth = await findStealth(img.data, img.width, img.height);
  const alpha = alphaStats(img.data);
  return { format, width: img.width, height: img.height, meta, stealth, alpha, transparent: hasRealTransparency(alpha) };
}

/* ---------- 변환 + 검증 ---------- */

/**
 * settings: { mode: 'normal'|'transparent', format: 'webp'|'jpeg', quality: 1~100, background, scrubRgb }
 * 반환: { blob, format, width, height, encoder, stats, checks: [{label, ok, detail}], verified }
 * verified 가 true 일 때만 "메타데이터 없음"을 표시한다.
 */
export async function convertFile(file, settings) {
  const s = { ...DEFAULTS, ...settings };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inFormat = sniff(bytes);
  if (!inFormat) throw new Error("PNG·JPEG·WebP 파일만 넣을 수 있습니다.");
  const src = await decodeAny(bytes, inFormat);
  const { width: w, height: h } = src;

  let pixels, stats = {}, outFormat, encoded, encoder;
  if (s.mode === "transparent") {
    outFormat = "png";
    const r = scrubTransparent(src.data, { scrubRgb: s.scrubRgb });
    pixels = r.data; stats = r.stats;
    if (hasNativeDeflate()) { encoded = await encodePng(pixels, w, h, 4); encoder = "직접 인코딩"; }
    else { encoded = new Uint8Array(await (await canvasEncode(pixels, w, h, "image/png")).arrayBuffer()); encoder = "브라우저"; }
  } else {
    outFormat = s.format === "jpeg" ? "jpeg" : "webp";
    pixels = flattenOnto(src.data, s.background);
    const q = Math.min(100, Math.max(1, Math.round(s.quality)));
    if (outFormat === "webp" && !(await supportsNativeWebp())) {
      encoded = await wasmWebp(pixels, w, h, q); encoder = "libwebp(WASM)";
    } else {
      const blob = await canvasEncode(pixels, w, h, MIME[outFormat], q / 100);
      if (!blob || blob.type !== MIME[outFormat]) throw new Error(`이 브라우저는 ${LABEL[outFormat]} 저장을 지원하지 않습니다.`);
      encoded = new Uint8Array(await blob.arrayBuffer()); encoder = "브라우저";
    }
  }
  src.data = null; // 원본 픽셀은 더 쓰지 않음

  // 인코더가 무엇을 붙였든 허용 목록 밖은 다시 지운다
  const clean = sanitizeContainer(encoded, outFormat);
  encoded = null;

  const checks = await verifyOutput(clean, outFormat, { w, h, pixels, mode: s.mode, stats });
  pixels = null;
  return {
    blob: new Blob([clean], { type: MIME[outFormat] }),
    format: outFormat, width: w, height: h, encoder, stats: { ...stats, psnr: checks.psnr },
    checks: checks.list, verified: checks.list.every((c) => c.ok),
  };
}

async function verifyOutput(bytes, format, { w, h, pixels, mode, stats }) {
  const list = [];
  const c = verifyContainer(bytes, format);
  list.push({ label: "파일 구조", ok: c.structureProblems.length === 0,
    detail: c.structureProblems.length ? c.structureProblems.join(" / ") : `그림 데이터만 남음 (${[...new Set(c.structure)].join(" · ")})` });
  list.push({ label: "메타데이터 낱말", ok: c.keywordHits.length === 0,
    detail: c.keywordHits.length ? `발견: ${c.keywordHits.join(", ")}` : "NovelAI·prompt·EXIF·XMP 등 없음" });

  let out;
  try {
    out = format === "png" && hasNativeDeflate() ? await decodePng(bytes) : await decodeWithBrowser(new Blob([bytes], { type: MIME[format] }));
  } catch (e) {
    list.push({ label: "다시 읽기", ok: false, detail: `결과 파일을 열 수 없습니다: ${e.message}` });
    return { list, psnr: null };
  }
  list.push({ label: "크기", ok: out.width === w && out.height === h, detail: `${out.width}×${out.height}` });
  const st = await findStealth(out.data, out.width, out.height, { decodeText: false });
  const prefix = hasStealthPrefix(out.data, out.width, out.height);
  list.push({ label: "스텔스 정보", ok: !st && !prefix,
    detail: st || prefix ? `서명 남음 (${(st && st.mode) || prefix})` : "알파·RGB 최하위 비트에서 서명 없음" });

  let p = null;
  if (mode === "transparent") {
    // 직접 디코딩하면 전부 비교. 옛 브라우저(캔버스 경로)는 반투명 RGB가 반올림되므로 알파와 불투명 픽셀만 비교
    const exact = hasNativeDeflate();
    let same = out.data.length === pixels.length;
    for (let i = 0; same && i < pixels.length; i += 4) {
      if (out.data[i + 3] !== pixels[i + 3]) same = false;
      else if (exact || pixels[i + 3] === 255)
        for (let k = 0; k < 3; k++) if (out.data[i + k] !== pixels[i + k]) same = false;
    }
    list.push({ label: "픽셀 보존", ok: same, detail: same ? "정리한 픽셀과 출력이 완전히 같음 (무손실)" : "출력 픽셀이 예상과 다릅니다" });
    const a = alphaStats(out.data);
    list.push({ label: "불투명 영역", ok: stats.opaqueKept === stats.opaqueIn,
      detail: `알파 255 픽셀 ${stats.opaqueKept.toLocaleString()}개 그대로 · 출력 기준 불투명 ${a.opaque.toLocaleString()}개` });
  } else {
    let opaque = true;
    for (let i = 3; i < out.data.length; i += 4) if (out.data[i] !== 255) { opaque = false; break; }
    list.push({ label: "알파 채널", ok: opaque, detail: opaque ? "알파 없음 (모든 픽셀 불투명)" : "투명 픽셀이 남아 있습니다" });
    if (out.data.length === pixels.length) p = psnr(pixels, out.data);
  }
  return { list, psnr: p };
}
