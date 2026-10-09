// 인터넷이 될 때는 항상 최신 파일을 받고, 안 될 때만 저장해 둔 파일로 연다.
// 내용을 바꾸면 VERSION을 올려서 휴대폰의 옛 캐시를 비운다.
const VERSION = "2";
const CACHE = `image-sanitizer-v${VERSION}`;
const FILES = [
  "./", "./index.html", "./style.css", "./theme.js", "./app.js",
  "./lib/convert.js", "./lib/meta.js", "./lib/png.js", "./lib/stealth.js", "./lib/zip.js",
  "./vendor/webp_enc.js", "./vendor/webp_enc.wasm",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png",
];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("image-sanitizer-") && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./"))));
});
