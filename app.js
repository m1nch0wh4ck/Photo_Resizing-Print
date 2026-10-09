// 화면: 파일 목록, 설정, 순차 변환, 내려받기.
import { analyzeFile, convertFile, DEFAULTS } from "./lib/convert.js";
import { EXT, LABEL, MIME } from "./lib/meta.js";
import { makeZip } from "./lib/zip.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const tick = () => new Promise((r) => setTimeout(r, 0));
const ACCEPT = /\.(png|jpe?g|webp)$/i;
const FOLDER = "NAImage_Cleaner"; // ZIP 을 풀면 생기는 폴더 이름
// 휴대폰·태블릿(터치)에서만 "전체 공유" 버튼을 보인다. PC는 ZIP·개별 받기로 충분
const TOUCH = matchMedia("(any-pointer: coarse)").matches;
const CAN_SHARE_FILES = (() => {
  try { return !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], "a.png", { type: "image/png" })] }); }
  catch { return false; }
})();

const state = { items: [], running: false, nextId: 1, shareFrom: 0 };

/* ---------- 설정 ---------- */
function settings() {
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    format: document.querySelector('input[name="format"]:checked').value,
    quality: Number($("#quality").value),
    background: document.querySelector('input[name="bg"]:checked').value,
    scrubRgb: $("#scrub-rgb").checked,
  };
}
function outExt(s = settings()) { return s.mode === "transparent" ? "png" : EXT[s.format]; }

function syncOptions() {
  const s = settings();
  $("#opts-normal").hidden = s.mode !== "normal";
  $("#opts-transparent").hidden = s.mode !== "transparent";
  $("#quality-out").textContent = `${s.quality}%`;
  updateConvertButton();
}

function onSettingsChanged() {
  syncOptions();
  let reset = 0;
  for (const it of state.items) {
    if (it.result || it.state === "failed") { it.result = null; it.state = "waiting"; it.error = null; it.failedChecks = null; reset++; }
  }
  if (reset) toast("설정이 바뀌어서 다시 변환해야 합니다.");
  renderAll();
}

/* ---------- 목록 ---------- */
function addFiles(list) {
  if (state.running) { toast("변환이 끝난 뒤에 추가해 주세요."); return; }
  let skipped = 0;
  for (const file of list) {
    if (!(ACCEPT.test(file.name) || /^image\/(png|jpeg|webp)$/.test(file.type))) { skipped++; continue; }
    state.items.push({ id: state.nextId++, file, thumb: null, analysis: null, analyzing: true, state: "waiting", result: null, error: null, outName: null });
  }
  if (skipped) toast(`PNG·JPEG·WebP가 아닌 파일 ${skipped}개는 뺐습니다.`);
  renderAll();
  analyzeQueue();
}

let analyzing = false;
async function analyzeQueue() {
  if (analyzing) return;
  analyzing = true;
  try {
    for (let it; (it = state.items.find((x) => x.analyzing)); ) {
      try { it.thumb = await makeThumb(it.file); } catch { it.thumb = null; }
      try {
        const a = await analyzeFile(it.file);
        if (a.stealth?.text && a.stealth.text.length > 4000) a.stealth.text = a.stealth.text.slice(0, 4000) + " …";
        it.analysis = a;
      } catch (e) {
        it.analysis = { error: e.message || String(e) };
      }
      it.analyzing = false;
      if (state.items.includes(it)) renderItem(it); else revokeThumb(it);
      updateConvertButton();
      await tick();
    }
  } finally { analyzing = false; }
}

async function makeThumb(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  try { img.src = url; await img.decode(); } finally { URL.revokeObjectURL(url); }
  const k = 128 / Math.max(img.naturalWidth, img.naturalHeight);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * Math.min(1, k)));
  c.height = Math.max(1, Math.round(img.naturalHeight * Math.min(1, k)));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  c.width = c.height = 0;
  img.src = "";
  return blob ? URL.createObjectURL(blob) : null;
}
function revokeThumb(it) { if (it.thumb) { URL.revokeObjectURL(it.thumb); it.thumb = null; } }

function removeItem(id) {
  const i = state.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  revokeThumb(state.items[i]);
  state.items.splice(i, 1);
  assignNames();
  renderAll();
}

function clearAll() {
  if (state.running) return;
  state.items.forEach(revokeThumb);
  state.items = [];
  renderAll();
}

/** 결과 이름: 원래 이름 + 새 확장자. 같은 이름이 겹치면(대소문자 무시) " (2)", " (3)" … */
function assignNames() {
  state.shareFrom = 0;
  const used = new Set();
  for (const it of state.items) {
    if (!it.result) { it.outName = null; continue; }
    const base = it.file.name.replace(/\.[^.]*$/, "") || "image";
    const ext = EXT[it.result.format];
    let name = `${base}.${ext}`, n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).${ext}`;
    used.add(name.toLowerCase());
    it.outName = name;
  }
}

/* ---------- 그리기 ---------- */
function inputChips(it) {
  const a = it.analysis;
  if (it.analyzing) return `<span class="chip">원본 검사 중…</span>`;
  if (!a) return "";
  if (a.error) return `<span class="chip fail">열 수 없음: ${esc(a.error)}</span>`;
  const chips = [];
  const sens = a.meta.filter((m) => m.sensitive);
  if (sens.length) chips.push(`<span class="chip warn" title="${esc(a.meta.map((m) => m.label).join("\n"))}">메타데이터 ${a.meta.length}개</span>`);
  else if (a.meta.length) chips.push(`<span class="chip" title="${esc(a.meta.map((m) => m.label).join("\n"))}">부가 정보 ${a.meta.length}개</span>`);
  else chips.push(`<span class="chip">일반 메타데이터 안 보임</span>`);
  if (a.stealth) chips.push(`<span class="chip fail">스텔스 정보 (${a.stealth.mode === "alpha" ? "알파" : "RGB"})</span>`);
  const mode = settings().mode;
  if (a.transparent && mode === "normal") chips.push(`<span class="chip warn">투명 영역 있음 → 투명 모드 권장</span>`);
  if (!a.transparent && mode === "transparent") chips.push(`<span class="chip">투명 영역 없음 → 일반 모드가 더 작음</span>`);
  return chips.join("");
}

function foundDetails(it) {
  const a = it.analysis;
  if (!a || a.error || (!a.meta.length && !a.stealth)) return "";
  const lines = a.meta.map((m) => `• ${m.label} (${fmtSize(m.size)})`);
  if (a.stealth) {
    lines.push(`• 스텔스 ${a.stealth.signature} — ${a.stealth.mode === "alpha" ? "알파" : "RGB"} 최하위 비트`);
    if (a.stealth.text) lines.push("", a.stealth.text);
    else if (a.stealth.error) lines.push(`  (내용은 풀지 못함: ${a.stealth.error})`);
  }
  return `<details class="found"><summary>원본에서 찾은 정보 보기</summary><pre>${esc(lines.join("\n"))}</pre></details>`;
}

function resultBlock(it) {
  if (it.state === "converting") return `<div class="result"><span class="status">변환하고 검증하는 중…</span></div>`;
  if (it.state === "failed") {
    const checks = it.failedChecks ? checkList(it.failedChecks, true) : "";
    return `<div class="result"><span class="status err">❌ ${esc(it.error || "실패")}</span>${checks}</div>`;
  }
  if (!it.result) return "";
  const r = it.result;
  const diff = r.blob.size / it.file.size - 1;
  const pct = `${diff <= 0 ? "−" : "+"}${Math.abs(diff * 100).toFixed(Math.abs(diff) > 0.99 && Math.abs(diff) < 1 ? 1 : 0)}%`;
  const extra = [];
  if (r.stats.psnr != null && isFinite(r.stats.psnr)) extra.push(`PSNR ${r.stats.psnr.toFixed(1)} dB`);
  if (r.format === "png") {
    extra.push(`알파 바뀐 픽셀 ${r.stats.alphaChanged.toLocaleString()}개 (최대 ${r.stats.maxAlphaDelta}단계)`);
    if (r.stats.hiddenRgbCleared) extra.push(`투명 픽셀 숨은 색 ${r.stats.hiddenRgbCleared.toLocaleString()}개 비움`);
  }
  if (r.encoder === "libwebp(WASM)") extra.push("libwebp(WASM)로 인코딩");
  const canShare = !!navigator.canShare;
  return `<div class="result">
    <div class="result-head">
      <span class="result-name">${esc(it.outName)}</span>
      <span class="tnum">${fmtSize(r.blob.size)}</span>
      <span class="saving ${diff > 0 ? "up" : ""} tnum">${pct}</span>
    </div>
    <div class="chips"><span class="chip ok">✔ 검증 완료 · 메타데이터·스텔스 정보 없음</span></div>
    ${extra.length ? `<div class="file-meta">${extra.map((e) => `<span>${esc(e)}</span>`).join("")}</div>` : ""}
    ${checkList(r.checks, false)}
    <div class="result-actions">
      <button class="btn small primary" data-act="save" data-id="${it.id}" type="button">받기</button>
      ${canShare ? `<button class="btn small" data-act="share" data-id="${it.id}" type="button">공유 · 사진에 저장</button>` : ""}
    </div>
  </div>`;
}

function checkList(checks, open) {
  return `<details class="checks"${open ? " open" : ""}><summary>검증 항목 ${checks.filter((c) => c.ok).length}/${checks.length}</summary><ul>${checks
    .map((c) => `<li><span class="${c.ok ? "ok-mark" : "fail-mark"}">${c.ok ? "✔" : "✘"}</span><span><b>${esc(c.label)}</b>${esc(c.detail)}</span></li>`)
    .join("")}</ul></details>`;
}

function itemHtml(it) {
  const a = it.analysis;
  const meta = [fmtSize(it.file.size)];
  if (a && !a.error) meta.unshift(`${LABEL[a.format]} · ${a.width}×${a.height}`);
  const cls = it.state === "failed" ? "failed" : it.result ? "done" : "";
  return `<li class="file ${cls}" data-id="${it.id}">
    ${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : `<div class="thumb" aria-hidden="true"></div>`}
    <div class="file-main">
      <div class="file-head">
        <span class="file-name">${esc(it.file.name)}</span>
        ${state.running ? "" : `<button class="x-btn" data-act="remove" data-id="${it.id}" type="button" aria-label="${esc(it.file.name)} 빼기">×</button>`}
      </div>
      <div class="file-meta">${meta.map((m) => `<span class="tnum">${esc(m)}</span>`).join("")}</div>
      <div class="chips">${inputChips(it)}</div>
      ${foundDetails(it)}
      ${resultBlock(it)}
    </div>
  </li>`;
}

function renderItem(it) {
  const old = document.querySelector(`.file[data-id="${it.id}"]`);
  const openDetails = old ? [...old.querySelectorAll("details")].map((d) => d.open) : [];
  const tpl = document.createElement("template");
  tpl.innerHTML = itemHtml(it).trim();
  const el = tpl.content.firstChild;
  el.querySelectorAll("details").forEach((d, i) => { if (openDetails[i]) d.open = true; });
  if (old) old.replaceWith(el); else $("#files").append(el);
  updateSummary();
}

function renderAll() {
  $("#files").innerHTML = state.items.map(itemHtml).join("");
  updateSummary();
  updateConvertButton();
}

function updateSummary() {
  const n = state.items.length;
  $("#file-count").textContent = n ? `${n}개` : "";
  $("#list-tools").hidden = !n;
  const total = state.items.reduce((s, it) => s + it.file.size, 0);
  const done = state.items.filter((it) => it.result);
  const outTotal = done.reduce((s, it) => s + it.result.blob.size, 0);
  $("#list-summary").textContent = `원본 ${fmtSize(total)}` + (done.length ? ` → 결과 ${done.length}개 ${fmtSize(outTotal)}` : "");
  $("#clear-btn").disabled = state.running;
}

function updateConvertButton() {
  const btn = $("#convert-btn");
  const todo = state.items.filter((it) => !it.result && !it.analysis?.error);
  const done = state.items.filter((it) => it.result);
  btn.disabled = state.running || !todo.length;
  btn.textContent = state.running ? "변환 중…" : todo.length ? `${todo.length}개 ${outExt().toUpperCase()}로 변환` : done.length ? "변환 완료" : "변환하기";
  $("#zip-btn").disabled = state.running || !done.length;
  $("#zip-btn").textContent = done.length ? `전체 ZIP (${done.length})` : "전체 ZIP";
  const sb = $("#share-all-btn");
  sb.disabled = state.running || !done.length;
  sb.textContent = shareLabel(done.length);
  $("#file-input").disabled = state.running;
  document.querySelectorAll('.card input[type="radio"], #quality, #scrub-rgb').forEach((el) => { el.disabled = state.running; });
}

function setProgress(done, total, label) {
  $("#progress").hidden = total === 0;
  $("#progress-fill").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("#progress-text").textContent = label ?? `${done} / ${total}`;
}

/* ---------- 변환 ---------- */
async function convertAll() {
  if (state.running) return;
  const queue = state.items.filter((it) => !it.result && !it.analysis?.error);
  if (!queue.length) return;
  state.running = true;
  const s = settings();
  renderAll();
  let ok = 0, fail = 0;
  setProgress(0, queue.length);
  for (let i = 0; i < queue.length; i++) {
    const it = queue[i];
    if (!state.items.includes(it)) continue;
    it.state = "converting"; it.error = null; it.result = null; it.failedChecks = null;
    renderItem(it);
    setProgress(i, queue.length, `${i + 1} / ${queue.length} · ${it.file.name}`);
    await tick();
    try {
      const r = await convertFile(it.file, s);
      if (r.verified) { it.result = r; it.state = "done"; ok++; }
      else { it.state = "failed"; it.error = "검증을 통과하지 못해 내려받기를 막았습니다."; it.failedChecks = r.checks; fail++; }
    } catch (e) {
      console.error(e);
      it.state = "failed"; it.error = e.message || String(e); fail++;
    }
    assignNames();
    renderItem(it);
    setProgress(i + 1, queue.length);
    await tick();
  }
  state.running = false;
  assignNames();
  renderAll();
  setProgress(queue.length, queue.length, fail ? `완료 ${ok}개 · 실패 ${fail}개` : `완료 ${ok}개 · 모두 검증 통과`);
  if (ok) toast(fail ? `${ok}개 변환, ${fail}개 실패` : `${ok}개 모두 변환하고 검증했습니다.`);
}

/* ---------- 내려받기 ---------- */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000); // 바로 지우면 사파리에서 받기가 끊긴다
}

async function share(it) {
  const file = new File([it.result.blob], it.outName, { type: MIME[it.result.format] });
  if (!navigator.canShare?.({ files: [file] })) { download(it.result.blob, it.outName); return; }
  try { await navigator.share({ files: [file] }); }
  catch (e) { if (e.name !== "AbortError") toast("공유하지 못했습니다. 받기 버튼을 써 주세요."); }
}

/* 전체 공유: 공유 시트로 결과를 한꺼번에 넘긴다 (아이폰·아이패드 "파일에 저장"에서 폴더를 한 번만 고르면 됨).
   한 번에 넘길 수 있는 파일 수가 정해진 브라우저(안드로이드 크롬 등)는 SHARE_BATCH 개씩 나눠서, 버튼을 다시 누르게 한다. */
const SHARE_BATCH = 10;
let shareBatch = null; // 이 기기에서 한 번에 넘길 수 있는 개수 (처음 공유할 때 정함)
function shareLabel(total) {
  if (!total) return "전체 공유";
  if (state.shareFrom > 0 && state.shareFrom < total) return `이어서 ${state.shareFrom + 1}~${Math.min(total, state.shareFrom + (shareBatch || SHARE_BATCH))} / ${total}`;
  return `공유·저장 (${total})`;
}

async function shareAll() {
  const done = state.items.filter((it) => it.result);
  if (!done.length) return;
  if (state.shareFrom >= done.length) state.shareFrom = 0;
  // 공유는 버튼을 누른 직후에 바로 불러야 해서, 파일 준비는 기다림 없이 한다
  const files = done.map((it) => new File([it.result.blob], it.outName, { type: MIME[it.result.format] }));
  if (shareBatch === null) shareBatch = navigator.canShare?.({ files }) ? files.length : SHARE_BATCH;
  const part = files.slice(state.shareFrom, state.shareFrom + shareBatch);
  if (!navigator.canShare?.({ files: part })) { toast("이 기기에서는 한꺼번에 공유할 수 없습니다. 전체 ZIP을 써 주세요."); return; }
  try {
    await navigator.share({ files: part });
    state.shareFrom += part.length;
    if (state.shareFrom < files.length) toast(`${state.shareFrom}개 넘김. 버튼을 다시 눌러 나머지를 넘겨 주세요.`);
    else { state.shareFrom = 0; toast(`${files.length}개 모두 넘겼습니다.`); }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (shareBatch > SHARE_BATCH) { shareBatch = SHARE_BATCH; toast(`한 번에 ${SHARE_BATCH}개씩 나눠서 넘깁니다. 다시 눌러 주세요.`); }
    else toast("공유하지 못했습니다. 전체 ZIP을 써 주세요.");
  } finally {
    updateConvertButton();
  }
}

async function downloadZip() {
  const done = state.items.filter((it) => it.result);
  if (!done.length) return;
  $("#zip-btn").disabled = true;
  try {
    const zip = await makeZip(done.map((it) => ({ name: `${FOLDER}/${it.outName}`, blob: it.result.blob })),
      (i, n) => setProgress(i, n, `ZIP 묶는 중 ${i} / ${n}`));
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    download(zip, `${FOLDER}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`);
    setProgress(done.length, done.length, `ZIP ${fmtSize(zip.size)} 받기 시작`);
  } catch (e) {
    toast(`ZIP을 만들지 못했습니다: ${e.message}`);
  } finally {
    updateConvertButton();
  }
}

/* ---------- 기타 ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

const THEMES = ["auto", "light", "dark"], THEME_LABEL = { auto: "자동", light: "라이트", dark: "다크" };
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("#theme-btn").textContent = THEME_LABEL[t];
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0e1413" : "#0d6b63";
}
let theme = "auto";
try { theme = localStorage.getItem("sanitizer-theme") || "auto"; } catch {}
if (!THEMES.includes(theme)) theme = "auto";

function init() {
  applyTheme(theme);
  $("#theme-btn").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem("sanitizer-theme", theme); } catch {}
    applyTheme(theme);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(theme));
  $("#help-btn").addEventListener("click", () => {
    const h = $("#help");
    h.hidden = !h.hidden;
    if (!h.hidden) h.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelectorAll('input[name="mode"], input[name="format"], input[name="bg"], #scrub-rgb')
    .forEach((el) => el.addEventListener("change", onSettingsChanged));
  $("#quality").addEventListener("input", syncOptions);
  $("#quality").addEventListener("change", onSettingsChanged);

  $("#file-input").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  const drop = $("#drop");
  let depth = 0;
  addEventListener("dragenter", (e) => { e.preventDefault(); if (++depth === 1) drop.classList.add("over"); });
  addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.classList.remove("over"); } });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove("over");
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  $("#files").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const it = state.items.find((x) => x.id === Number(b.dataset.id));
    if (!it) return;
    if (b.dataset.act === "remove" && !state.running) removeItem(it.id);
    else if (b.dataset.act === "save" && it.result) download(it.result.blob, it.outName);
    else if (b.dataset.act === "share" && it.result) share(it);
  });
  $("#clear-btn").addEventListener("click", clearAll);
  $("#convert-btn").addEventListener("click", convertAll);
  $("#zip-btn").addEventListener("click", downloadZip);
  if (TOUCH && CAN_SHARE_FILES) {
    $("#share-all-btn").hidden = false;
    document.querySelector(".actions").classList.add("has-share");
    document.body.classList.add("has-share");
  }
  $("#share-all-btn").addEventListener("click", shareAll);
  addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });

  syncOptions();
  renderAll();
  if ("serviceWorker" in navigator && window.isSecureContext && location.protocol === "https:")
    navigator.serviceWorker.register("sw.js").catch(() => {});
  window.__sanitizer = { state, settings, DEFAULTS }; // 테스트용
}
init();
