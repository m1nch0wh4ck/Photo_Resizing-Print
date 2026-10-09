// 테마는 그리기 전에 정한다 (깜빡임 방지). 저장값: auto | light | dark
try {
  const t = localStorage.getItem("sanitizer-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) { /* 저장소를 못 쓰면 자동 */ }
