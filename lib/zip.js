// 무압축(STORE) ZIP 만들기. 이미지는 이미 압축돼 있어서 다시 압축해도 거의 줄지 않는다.
// 파일 이름은 UTF-8 표시(비트 11)를 켜서 한글 이름이 깨지지 않게 한다.
import { crc32 } from "./png.js";

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** entries: [{ name, blob }] → Blob(application/zip). 한 번에 파일 하나씩만 메모리로 읽는다. */
export async function makeZip(entries, onProgress) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(new Date());
  const parts = [], central = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const { name, blob } = entries[i];
    const nameBytes = enc.encode(name);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const size = blob.size;
    if (offset + size > 0xffffffff) throw new Error("ZIP이 4GB를 넘습니다. 나눠서 받아 주세요.");
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); cv.setUint32(24, size, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    parts.push(local, blob);
    central.push(cen);
    offset += local.length + size;
    onProgress?.(i + 1, entries.length);
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
