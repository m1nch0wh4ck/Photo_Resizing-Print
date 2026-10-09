// PNG 읽기/쓰기. 브라우저 내장 압축(CompressionStream)만 쓰고, 픽셀은 곱하기 전 알파(straight alpha) 그대로 다룬다.
// 캔버스를 거치면 반투명 픽셀의 RGB가 미리 곱해진 알파 때문에 뭉개지므로, 투명 모드는 이 모듈로 직접 읽고 쓴다.

export const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function isPng(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

const latin1 = (bytes, s, e) => { let out = ""; for (let i = s; i < e; i++) out += String.fromCharCode(bytes[i]); return out; };

/** 청크 목록: [{type, start(데이터 시작), length, crcOk}] */
export function readChunks(bytes) {
  if (!isPng(bytes)) throw new Error("PNG 파일이 아닙니다.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let p = 8;
  while (p + 12 <= bytes.length) {
    const length = dv.getUint32(p);
    const type = latin1(bytes, p + 4, p + 8);
    const start = p + 8;
    if (start + length + 4 > bytes.length) throw new Error("PNG 청크가 잘려 있습니다.");
    const crcOk = crc32(bytes, p + 4, start + length) === dv.getUint32(start + length);
    chunks.push({ type, start, length, crcOk });
    p = start + length + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

async function runStream(data, stream) {
  const res = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export const inflateZlib = (data) => runStream(data, new DecompressionStream("deflate"));
export const deflateZlib = (data) => runStream(data, new CompressionStream("deflate"));
export const gunzip = (data) => runStream(data, new DecompressionStream("gzip"));
export const hasNativeDeflate = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

const ADAM7 = [ // [x0, y0, dx, dy]
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw, offset, rows, rowBytes, bpp) {
  // raw[offset..] 에 [필터 1바이트 + 행] * rows. 결과: 필터를 푼 행들
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const f = raw[offset + y * (rowBytes + 1)];
    const src = offset + y * (rowBytes + 1) + 1;
    const cur = y * rowBytes, prev = cur - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[cur + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`알 수 없는 PNG 필터(${f})`);
      }
      out[cur + i] = v & 0xff;
    }
  }
  return out;
}

/**
 * PNG → RGBA8 (곱하기 전 알파). 반환: { width, height, data: Uint8ClampedArray, hasAlphaChannel }
 * 16비트는 상위 바이트를 쓴다. 감마·색 프로필 청크는 무시한다(출력에서도 지우므로 sRGB로 본다).
 */
export async function decodePng(bytes) {
  const chunks = readChunks(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR") throw new Error("IHDR 청크가 없습니다.");
  const width = dv.getUint32(ihdr.start), height = dv.getUint32(ihdr.start + 4);
  const depth = bytes[ihdr.start + 8], ctype = bytes[ihdr.start + 9], interlace = bytes[ihdr.start + 12];
  const ch = CHANNELS[ctype];
  if (!ch || ![1, 2, 4, 8, 16].includes(depth)) throw new Error("지원하지 않는 PNG 형식입니다.");
  if (!width || !height) throw new Error("PNG 크기가 0입니다.");

  let palette = null, trns = null;
  const idat = [];
  let idatLen = 0;
  for (const c of chunks) {
    if (c.type === "PLTE") palette = bytes.subarray(c.start, c.start + c.length);
    else if (c.type === "tRNS") trns = bytes.subarray(c.start, c.start + c.length);
    else if (c.type === "IDAT") { idat.push(bytes.subarray(c.start, c.start + c.length)); idatLen += c.length; }
  }
  if (!idat.length) throw new Error("IDAT 청크가 없습니다.");
  if (ctype === 3 && !palette) throw new Error("팔레트(PLTE)가 없습니다.");
  const z = new Uint8Array(idatLen);
  { let o = 0; for (const part of idat) { z.set(part, o); o += part.length; } }
  const raw = await inflateZlib(z);

  const bitsPP = ch * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const out = new Uint8ClampedArray(width * height * 4);

  // tRNS 투명색(그레이·RGB)은 원래 비트 깊이 값으로 비교한다
  const trnsGray = ctype === 0 && trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  const trnsRGB = ctype === 2 && trns && trns.length >= 6
    ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;

  const writePass = (rows, x0, y0, dx, dy, pw, ph) => {
    const rowBytes = Math.ceil((pw * bitsPP) / 8);
    if (depth === 8 && (ctype === 6 || (ctype === 2 && !trnsRGB))) { // 가장 흔한 경우는 빠르게
      for (let py = 0; py < ph; py++) {
        let r = py * rowBytes, o = ((y0 + py * dy) * width + x0) * 4;
        const step = dx * 4;
        for (let px = 0; px < pw; px++, o += step) {
          out[o] = rows[r++]; out[o + 1] = rows[r++]; out[o + 2] = rows[r++];
          out[o + 3] = ctype === 6 ? rows[r++] : 255;
        }
      }
      return;
    }
    for (let py = 0; py < ph; py++) {
      const r = py * rowBytes;
      const y = y0 + py * dy;
      for (let px = 0; px < pw; px++) {
        const x = x0 + px * dx;
        const o = (y * width + x) * 4;
        let s; // 각 채널의 원래 값 (sample)
        const sample = (k) => {
          if (depth === 8) return rows[r + px * ch + k];
          if (depth === 16) return (rows[r + (px * ch + k) * 2] << 8) | rows[r + (px * ch + k) * 2 + 1];
          const bit = (px * ch + k) * depth;
          return (rows[r + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        };
        const to8 = (v) => (depth === 16 ? v >> 8 : depth < 8 ? Math.round(v * scale) : v);
        switch (ctype) {
          case 0:
            s = sample(0);
            out[o] = out[o + 1] = out[o + 2] = to8(s);
            out[o + 3] = s === trnsGray ? 0 : 255;
            break;
          case 2: {
            const R = sample(0), G = sample(1), B = sample(2);
            out[o] = to8(R); out[o + 1] = to8(G); out[o + 2] = to8(B);
            out[o + 3] = trnsRGB && R === trnsRGB[0] && G === trnsRGB[1] && B === trnsRGB[2] ? 0 : 255;
            break;
          }
          case 3: {
            const idx = sample(0);
            if (idx * 3 + 2 >= palette.length) throw new Error("팔레트 범위를 벗어났습니다.");
            out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
            out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
            break;
          }
          case 4:
            out[o] = out[o + 1] = out[o + 2] = to8(sample(0));
            out[o + 3] = to8(sample(1));
            break;
          case 6:
            out[o] = to8(sample(0)); out[o + 1] = to8(sample(1)); out[o + 2] = to8(sample(2));
            out[o + 3] = to8(sample(3));
            break;
        }
      }
    }
  };

  if (interlace === 0) {
    const rowBytes = Math.ceil((width * bitsPP) / 8);
    if (raw.length < height * (rowBytes + 1)) throw new Error("PNG 이미지 데이터가 부족합니다.");
    writePass(unfilter(raw, 0, height, rowBytes, bpp), 0, 0, 1, 1, width, height);
  } else {
    let off = 0;
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const rowBytes = Math.ceil((pw * bitsPP) / 8);
      if (raw.length < off + ph * (rowBytes + 1)) throw new Error("PNG 이미지 데이터가 부족합니다.");
      writePass(unfilter(raw, off, ph, rowBytes, bpp), x0, y0, dx, dy, pw, ph);
      off += ph * (rowBytes + 1);
    }
  }
  return { width, height, data: out, hasAlphaChannel: ctype === 4 || ctype === 6 || !!trns };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * RGBA8 → PNG (IHDR, IDAT, IEND 세 청크만). 행마다 필터 5종 중 차이 합이 가장 작은 것을 고른다.
 * channels=3 이면 알파를 버리고 RGB로 쓴다.
 */
export async function encodePng(rgba, width, height, channels = 4) {
  const rowBytes = width * channels;
  const filtered = new Uint8Array(height * (rowBytes + 1));
  const prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  for (let y = 0; y < height; y++) {
    if (channels === 4) cur.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes));
    else for (let x = 0, s = y * width * 4; x < width; x++, s += 4) { cur[x * 3] = rgba[s]; cur[x * 3 + 1] = rgba[s + 1]; cur[x * 3 + 2] = rgba[s + 2]; }
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= channels ? cur[i - channels] : 0;
        const b = y > 0 ? prev[i] : 0;
        const cc = y > 0 && i >= channels ? prev[i - channels] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, cc);
        const v = (cur[i] - pred) & 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // break로 끊긴 후보는 덜 채워졌을 수 있으니 고른 필터로 다시 계산
    const c = cand[best];
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = y > 0 ? prev[i] : 0;
      const cc = y > 0 && i >= channels ? prev[i - channels] : 0;
      const pred = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, cc);
      c[i] = (cur[i] - pred) & 0xff;
    }
    const o = y * (rowBytes + 1);
    filtered[o] = best;
    filtered.set(c, o + 1);
    prev.set(cur);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", await deflateZlib(filtered)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export { chunk as makeChunk, latin1 };
