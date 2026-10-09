// 파일 형식 판별, 메타데이터 찾기, 허용 목록 밖의 조각 지우기, 지워졌는지 검증.
// 정리는 "허용 목록" 방식: 화면에 그리는 데 꼭 필요한 조각만 남기고 나머지는 모두 버린다.
import { isPng, readChunks, latin1, PNG_SIG, makeChunk } from "./png.js";

export function sniff(bytes) {
  if (isPng(bytes)) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length > 12 && latin1(bytes, 0, 4) === "RIFF" && latin1(bytes, 8, 12) === "WEBP") return "webp";
  return null;
}

export const EXT = { png: "png", jpeg: "jpg", webp: "webp" };
export const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
export const LABEL = { png: "PNG", jpeg: "JPEG", webp: "WebP" };

/* ---------- PNG ---------- */
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const PNG_NAMES = {
  tEXt: "텍스트", iTXt: "텍스트(국제)", zTXt: "텍스트(압축)", eXIf: "EXIF", iCCP: "색 프로필", sRGB: "sRGB 표시",
  gAMA: "감마", cHRM: "색도", pHYs: "해상도", tIME: "수정 시각", bKGD: "배경색", sBIT: "유효 비트", hIST: "히스토그램",
  sPLT: "추천 팔레트", caBX: "C2PA 출처 정보", acTL: "애니메이션",
};

function pngTextKeyword(bytes, c) {
  let e = c.start;
  const end = c.start + c.length;
  while (e < end && bytes[e] !== 0 && e - c.start < 80) e++;
  return latin1(bytes, c.start, e);
}

function analyzePng(bytes) {
  const items = [];
  for (const c of readChunks(bytes)) {
    if (PNG_KEEP.has(c.type)) continue;
    const isText = c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt";
    items.push({
      key: c.type,
      label: isText ? `텍스트 청크 · ${pngTextKeyword(bytes, c) || "(이름 없음)"}` : `${c.type} · ${PNG_NAMES[c.type] || "기타 청크"}`,
      sensitive: isText || c.type === "eXIf" || c.type === "caBX" || !PNG_NAMES[c.type],
      size: c.length,
    });
  }
  return items;
}

function sanitizePng(bytes) {
  const keep = readChunks(bytes).filter((c) => PNG_KEEP.has(c.type));
  const parts = [PNG_SIG, ...keep.map((c) => bytes.subarray(c.start - 8, c.start + c.length + 4))];
  return concat(parts);
}

/* ---------- JPEG ---------- */
// 세그먼트: [{marker, start(마커 위치), end(다음 위치), payloadStart}]
function readJpeg(bytes) {
  const segs = [];
  let p = 2;
  while (p < bytes.length) {
    if (bytes[p] !== 0xff) throw new Error("JPEG 구조가 올바르지 않습니다.");
    while (bytes[p] === 0xff && bytes[p + 1] === 0xff) p++; // 채움 바이트
    const m = bytes[p + 1];
    if (m === 0xd9) { segs.push({ marker: m, start: p, end: p + 2, payloadStart: p + 2 }); break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { segs.push({ marker: m, start: p, end: p + 2, payloadStart: p + 2 }); p += 2; continue; }
    if (p + 4 > bytes.length) throw new Error("JPEG가 잘려 있습니다.");
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    let end = p + 2 + len;
    if (end > bytes.length) throw new Error("JPEG가 잘려 있습니다.");
    if (m === 0xda) { // 스캔 데이터는 다음 마커(0xFF00, RST 제외)까지
      let q = end;
      while (q + 1 < bytes.length && !(bytes[q] === 0xff && bytes[q + 1] !== 0x00 && !(bytes[q + 1] >= 0xd0 && bytes[q + 1] <= 0xd7))) q++;
      end = q;
    }
    segs.push({ marker: m, start: p, end, payloadStart: p + 4 });
    p = end;
  }
  return segs;
}

function jpegAppName(bytes, s) {
  const id = latin1(bytes, s.payloadStart, Math.min(s.payloadStart + 30, s.end)).split("\0")[0];
  if (s.marker === 0xe1 && id.startsWith("Exif")) return "EXIF";
  if (s.marker === 0xe1 && id.includes("ns.adobe.com/xap")) return "XMP";
  if (s.marker === 0xe1 && id.includes("ns.adobe.com/xmp/extension")) return "XMP 확장";
  if (s.marker === 0xe2 && id.startsWith("ICC_PROFILE")) return "색 프로필(ICC)";
  if (s.marker === 0xe2 && id.startsWith("MPF")) return "다중 사진(MPF)";
  if (s.marker === 0xed) return "Photoshop/IPTC";
  if (s.marker === 0xeb) return "C2PA/JUMBF";
  if (s.marker === 0xe0 && id === "JFIF") return "JFIF";
  if (s.marker === 0xee && id.startsWith("Adobe")) return "Adobe 색 변환";
  return `APP${s.marker - 0xe0}${id ? " · " + id.replace(/[^\x20-\x7e]/g, "").slice(0, 20) : ""}`;
}

// 남겨도 되는 것: 그림을 그리는 데 쓰는 세그먼트 + JFIF 머리말 + Adobe 색 변환 표시(정보 없음)
function jpegKeep(bytes, s) {
  const m = s.marker;
  if (m === 0xd9 || m === 0xda || m === 0xdb || m === 0xc4 || m === 0xdd || m === 0xcc || (m >= 0xd0 && m <= 0xd7)) return true;
  if (m >= 0xc0 && m <= 0xcf) return true; // SOFn (C4, CC는 위에서)
  if (m === 0xe0 || m === 0xee) { const n = jpegAppName(bytes, s); return n === "JFIF" || n === "Adobe 색 변환"; }
  return false;
}

function analyzeJpeg(bytes) {
  const items = [];
  for (const s of readJpeg(bytes)) {
    if (jpegKeep(bytes, s)) continue;
    const name = s.marker === 0xfe ? "주석(COM)" : s.marker >= 0xe0 && s.marker <= 0xef ? jpegAppName(bytes, s) : `마커 0x${s.marker.toString(16)}`;
    items.push({ key: name, label: name, sensitive: name !== "색 프로필(ICC)", size: s.end - s.start });
  }
  return items;
}

function sanitizeJpeg(bytes) {
  const segs = readJpeg(bytes);
  return concat([bytes.subarray(0, 2), ...segs.filter((s) => jpegKeep(bytes, s)).map((s) => bytes.subarray(s.start, s.end))]);
}

/* ---------- WebP ---------- */
function readWebp(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  const end = Math.min(bytes.length, 8 + dv.getUint32(4, true));
  let p = 12;
  while (p + 8 <= end) {
    const type = latin1(bytes, p, p + 4), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > bytes.length) throw new Error("WebP 청크가 잘려 있습니다.");
    chunks.push({ type, start: p, dataStart: p + 8, size, end: p + 8 + size + (size & 1) });
    p += 8 + size + (size & 1);
  }
  return chunks;
}
const WEBP_NAMES = { EXIF: "EXIF", "XMP ": "XMP", ICCP: "색 프로필(ICC)", ANIM: "애니메이션", ANMF: "애니메이션 프레임" };

function analyzeWebp(bytes) {
  return readWebp(bytes)
    .filter((c) => !["VP8 ", "VP8L", "VP8X", "ALPH"].includes(c.type))
    .map((c) => ({ key: c.type.trim(), label: WEBP_NAMES[c.type] || `청크 ${c.type.trim()}`, sensitive: c.type !== "ICCP", size: c.size }));
}

function sanitizeWebp(bytes) {
  const chunks = readWebp(bytes);
  if (chunks.some((c) => c.type === "ANIM" || c.type === "ANMF")) throw new Error("움직이는 WebP는 지원하지 않습니다.");
  const image = chunks.find((c) => c.type === "VP8 " || c.type === "VP8L");
  if (!image) throw new Error("WebP 이미지 데이터가 없습니다.");
  const alph = chunks.find((c) => c.type === "ALPH");
  const vp8x = chunks.find((c) => c.type === "VP8X");
  const parts = [];
  if (alph && image.type === "VP8 ") { // 손실 압축 + 알파: VP8X(알파 표시만) + ALPH + VP8
    const x = new Uint8Array(18);
    x.set([86, 80, 56, 88, 10, 0, 0, 0, 0x10, 0, 0, 0]);
    x.set(bytes.subarray(vp8x.dataStart + 4, vp8x.dataStart + 10), 12); // 캔버스 크기 그대로
    parts.push(x, bytes.subarray(alph.start, alph.end), bytes.subarray(image.start, image.end));
  } else {
    parts.push(bytes.subarray(image.start, image.end));
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set([82, 73, 70, 70], 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set([87, 69, 66, 80], 8);
  out.set(body, 12);
  return out;
}

/* ---------- 공통 ---------- */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 원본에서 찾은 메타데이터 목록 */
export function analyzeContainer(bytes, format = sniff(bytes)) {
  if (format === "png") return analyzePng(bytes);
  if (format === "jpeg") return analyzeJpeg(bytes);
  if (format === "webp") return analyzeWebp(bytes);
  throw new Error("PNG·JPEG·WebP 파일만 넣을 수 있습니다.");
}

/** 허용 목록 밖의 조각을 모두 지운 새 바이트 */
export function sanitizeContainer(bytes, format = sniff(bytes)) {
  if (format === "png") return sanitizePng(bytes);
  if (format === "jpeg") return sanitizeJpeg(bytes);
  if (format === "webp") return sanitizeWebp(bytes);
  throw new Error("알 수 없는 형식입니다.");
}

// 압축된 데이터 속에서 우연히 나올 확률이 사실상 0인 7자 이상 낱말만 쓴다
const KEYWORDS = ["NovelAI", "stealth_", "xmpmeta", "x:xmpmeta", "\"prompt\"", "parameters", "Software", "Description",
  "Generation time", "\"sampler\"", "Exif\0\0", "ICC_PROFILE"];

function findBytes(hay, needle) {
  const n = Array.from(needle, (ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    if (hay[i] !== n[0]) continue;
    for (let j = 1; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * 출력 파일 검증. 반환: { structureProblems: [..], keywordHits: [..], structure: [조각 이름] }
 *  - structureProblems: 기대한 형식이 아니거나, 허용 목록 밖의 조각·CRC 오류·꼬리 데이터가 있음
 *  - keywordHits: 파일 전체 바이트에 메타데이터 낱말이 날것으로 들어 있음
 */
export function verifyContainer(bytes, expected) {
  const problems = [];
  const format = sniff(bytes);
  let structure = [];
  if (format !== expected) problems.push(`형식이 ${LABEL[expected]}가 아닙니다.`);
  try {
    if (format === "png") {
      const chunks = readChunks(bytes);
      structure = chunks.map((c) => c.type);
      for (const c of chunks) {
        if (!PNG_KEEP.has(c.type) || c.type === "PLTE" || c.type === "tRNS") problems.push(`남은 청크: ${c.type}`);
        if (!c.crcOk) problems.push(`CRC 오류: ${c.type}`);
      }
      const last = chunks[chunks.length - 1];
      if (!last || last.type !== "IEND" || last.start + 4 !== bytes.length) problems.push("IEND 뒤에 덧붙은 데이터가 있습니다.");
    } else if (format === "jpeg") {
      const segs = readJpeg(bytes);
      structure = segs.filter((s) => s.marker < 0xd0 || s.marker > 0xd7)
        .map((s) => (s.marker >= 0xe0 && s.marker <= 0xef ? jpegAppName(bytes, s) : JPEG_NAMES[s.marker] || "0x" + s.marker.toString(16)));
      for (const s of segs) if (!jpegKeep(bytes, s)) problems.push(`남은 세그먼트: ${s.marker === 0xfe ? "COM" : jpegAppName(bytes, s)}`);
      const last = segs[segs.length - 1];
      if (!last || last.marker !== 0xd9 || last.end !== bytes.length) problems.push("EOI 뒤에 덧붙은 데이터가 있습니다.");
    } else if (format === "webp") {
      const chunks = readWebp(bytes);
      structure = chunks.map((c) => c.type.trim());
      for (const c of chunks) if (!["VP8 ", "VP8L", "VP8X", "ALPH"].includes(c.type)) problems.push(`남은 청크: ${c.type.trim()}`);
      const x = chunks.find((c) => c.type === "VP8X");
      if (x && (bytes[x.dataStart] & ~0x10)) problems.push("VP8X에 메타데이터 표시가 켜져 있습니다.");
      const riffEnd = 8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
      if (riffEnd !== bytes.length) problems.push("RIFF 뒤에 덧붙은 데이터가 있습니다.");
    }
  } catch (e) {
    problems.push(`구조를 읽을 수 없습니다: ${e.message}`);
  }
  const keywordHits = KEYWORDS.filter((k) => findBytes(bytes, k) >= 0).map((k) => k.replace(/\0/g, ""));
  return { structureProblems: problems, keywordHits, structure };
}
const JPEG_NAMES = { 0xd8: "SOI", 0xd9: "EOI", 0xda: "SOS", 0xdb: "DQT", 0xc4: "DHT", 0xdd: "DRI", 0xc0: "SOF0", 0xc1: "SOF1", 0xc2: "SOF2" };

export { makeChunk };
