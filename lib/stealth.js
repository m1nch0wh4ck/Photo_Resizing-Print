// 스텔스 메타데이터(LSB 스테가노그래피) 판독기.
// NovelAI 공식 판독기(novelai-image-metadata의 LSBExtractor)와 같은 순서로 읽는다:
//   열 우선(x 바깥, y 안쪽), 바이트 안에서는 먼저 읽은 비트가 상위 비트.
// - 알파 모드: 픽셀마다 알파의 최하위 비트 1개 ("stealth_pnginfo" / "stealth_pngcomp", NAI 기본)
// - RGB 모드: 픽셀마다 R, G, B 최하위 비트 3개 ("stealth_rgbinfo" / "stealth_rgbcomp", WebUI 확장)
import { gunzip } from "./png.js";

const SIGS = {
  alpha: ["stealth_pnginfo", "stealth_pngcomp"],
  rgb: ["stealth_rgbinfo", "stealth_rgbcomp"],
};
const SIG_LEN = 15;
const MAX_PAYLOAD_BITS = 64 * 1024 * 1024 * 8;

function makeReader(rgba, width, height, mode) {
  const perPixel = mode === "alpha" ? 1 : 3;
  const total = width * height * perPixel;
  let pos = 0;
  const bit = () => {
    const pixel = Math.floor(pos / perPixel), k = pos % perPixel;
    const x = Math.floor(pixel / height), y = pixel % height;
    pos++;
    return rgba[(y * width + x) * 4 + (mode === "alpha" ? 3 : k)] & 1;
  };
  return {
    left: () => total - pos,
    bytes(n) {
      if (n * 8 > total - pos) return null;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bit(); out[i] = b; }
      return out;
    },
  };
}

/**
 * 스텔스 정보를 찾는다. 반환: null 또는 { mode, compressed, signature, bits, text|null, error|null }
 * text 는 내용을 풀 수 있었을 때만 채운다(풀지 못해도 서명이 있으면 '발견'으로 본다).
 */
export async function findStealth(rgba, width, height, { decodeText = true } = {}) {
  for (const mode of ["alpha", "rgb"]) {
    const r = makeReader(rgba, width, height, mode);
    const sigBytes = r.bytes(SIG_LEN);
    if (!sigBytes) continue;
    const sig = String.fromCharCode(...sigBytes);
    if (!SIGS[mode].includes(sig)) continue;
    const compressed = sig.endsWith("comp");
    const lenBytes = r.bytes(4);
    const bits = lenBytes ? ((lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3]) >>> 0 : 0;
    const found = { mode, compressed, signature: sig, bits, text: null, error: null };
    if (!decodeText) return found;
    try {
      if (!bits || bits > MAX_PAYLOAD_BITS || bits > r.left()) throw new Error("길이 값이 이상합니다");
      let data = r.bytes(Math.floor(bits / 8));
      if (compressed) data = await gunzip(data);
      found.text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    } catch (e) {
      found.error = String(e.message || e);
    }
    return found;
  }
  return null;
}

/** 서명 일부라도("stealth_") 남아 있는지 — 검증용 느슨한 검사 */
export function hasStealthPrefix(rgba, width, height) {
  for (const mode of ["alpha", "rgb"]) {
    const b = makeReader(rgba, width, height, mode).bytes(8);
    if (b && String.fromCharCode(...b) === "stealth_") return mode;
  }
  return null;
}
