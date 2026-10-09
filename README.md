# AI 이미지 정리기

NovelAI 등으로 만든 이미지에서 **일반 메타데이터**(PNG 텍스트 청크·EXIF·XMP 등)와
**알파 채널에 숨은 스텔스 메타데이터**(`stealth_pngcomp` 등)를 지우고, 용도에 맞는 형식으로 한꺼번에 바꾸는 웹 도구입니다.
개인이 만든 도구이며 NovelAI 공식 도구가 아닙니다.

- **이미지는 기기 밖으로 나가지 않습니다.** 서버가 없고, 페이지의 보안 정책(CSP)으로 외부 전송 자체를 막아 두었습니다.
- **일반 이미지 모드** — WebP 또는 JPEG(품질 기본 85%). 알파 채널을 없애고(흰/검은 배경에 합성) 새로 인코딩합니다.
  PC용 `cwebp -q 85 -metadata none -noalpha` 와 같은 효과입니다.
- **투명 이미지 모드** — PNG 고정. 알파값을 4단위로 반올림해(`webp_converter.py`와 같은 식) 최하위 2비트를 지웁니다.
  완전 불투명(255)·완전 투명(0)은 그대로, 반투명 가장자리는 최대 2단계만 바뀝니다. 투명 픽셀 뒤에 숨은 색도 비우고,
  RGB 최하위 비트도 정리합니다(끌 수 있음).
- 변환이 끝나면 결과 파일을 다시 열어 **파일 구조·메타데이터 낱말·스텔스 서명·픽셀**을 검사하고, 모두 통과해야만
  "검증 완료"를 표시하고 내려받기를 엽니다.
- 여러 장을 한 번에 넣고, 하나씩 또는 ZIP으로 받습니다. 이름은 원래 이름 그대로 확장자만 바뀌고, 겹치면 `이름 (2).webp` 처럼 붙습니다.
- 안드로이드 크롬: 메뉴(⋮) → **앱 설치** / 아이폰 사파리: 공유 → **홈 화면에 추가**. 한 번 열어 두면 인터넷 없이도 열립니다.

## 주소
https://m1nch0wh4ck.github.io/NAImage_Cleaner/

GitHub Pages 설정: 저장소 **Settings → Pages** 에서 Source를 **Deploy from a branch**, 브랜치를 `main` / `/ (root)` 로 둡니다.
내용을 고친 뒤에는 `sw.js` 맨 위의 `VERSION` 숫자를 올려야 휴대폰에 저장된 옛 파일이 바뀝니다.

## 파일 구성
| 파일 | 하는 일 |
|---|---|
| `index.html`, `style.css`, `theme.js` | 화면 (모바일 우선, 라이트/다크) |
| `app.js` | 파일 목록, 순차 변환, 진행률, 개별·ZIP 받기 |
| `lib/convert.js` | 변환 흐름: 읽기 → 픽셀 다시 짜기 → 인코딩 → 정리 → 검증 |
| `lib/png.js` | PNG 직접 읽기/쓰기 (알파를 미리 곱하지 않아 반투명 픽셀이 정확함) |
| `lib/stealth.js` | 스텔스 판독기 (NovelAI 판독기와 같은 순서, 알파·RGB 모드) |
| `lib/meta.js` | 형식 판별, 메타데이터 목록, 허용 목록 정리, 결과 검증 |
| `lib/zip.js` | ZIP 만들기 (무압축, 한글 이름 UTF-8) |
| `vendor/webp_enc.*` | libwebp WASM 인코더 — 캔버스로 WebP를 못 만드는 아이폰 사파리용 |
| `sw.js`, `manifest.webmanifest`, 아이콘 | 앱 설치·오프라인 |

## 오픈소스 고지
- `vendor/webp_enc.js`, `vendor/webp_enc.wasm`: [jSquash](https://github.com/jamsinclair/jSquash) `@jsquash/webp` 1.5.0
  (Squoosh에서 다시 묶은 libwebp 인코더). Apache License 2.0 — `vendor/LICENSE-jsquash-webp.txt`.
  libwebp 는 BSD 3-Clause 라이선스입니다 (Copyright Google Inc.).
