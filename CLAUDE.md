# kasaspace

터미널을 한 칸으로 두는 작업환경. Tauri + xterm.js, 치이카와 테마.
PTY 는 만들지 않는다 — kasaterm 의 `kasa-pty` 를 git 의존성으로 당겨 쓴다.

[!] **구조·단축키·헤드리스 검증법·함정은 [README.md](./README.md) 에 있다.** 여기에 중복하지 않는다.
코드 만지기 전에 README 의 "헤드리스 검증"과 "엔진을 같이 고칠 때" 두 절을 먼저 읽어라.

---

## 핸드오프 — 2026-08-31

**직전 세션이 멈춘 지점: 사용자 실기 확인을 기다리는 중.**

커밋 12개, `master`, 워킹트리 깨끗, **원격 없음**(로컬 전용). 우리 코드 약 1,930줄.
직전 세션에서 pane 분할 · 탭 · 파일트리+git · pane 헤더 · 세션 복원까지 붙였고,
전부 스크린샷으로 실기 검증했다. 마지막 커밋은 `ca5e504 README 에 단독 exe 굽는 법 추가`.

### 사용자에게 확인 요청해 둔 것 (아직 답 못 받음)

`scripts/shot.ps1` 과 `KASASPACE_AUTOKEYS` 로도 못 만드는 경로들이다. 다음 세션은
**사용자에게 결과부터 물어보고** 시작해라 — 이미 확인했는데 다시 시키면 시간 낭비다.

1. **한글 IME 조합** — 제일 중요하다. `AUTOKEYS`/`AUTOSEND` 는 조합 이벤트를 못 만든다.
   조합 중인 자모(`ㄱ` → `가` → `강`)가 확정 전에 셸로 미리 새는지, 확정 뒤에만 들어가는지,
   조합 중 백스페이스가 정상인지.
2. **마우스** — 드래그 선택 시 분홍 하이라이트, `Ctrl+Shift+C` → `Ctrl+Shift+V`,
   pane 경계선 잡고 끌기. `AUTOKEYS` 는 키보드 이벤트만 만든다.
3. **`Ctrl+Shift+O`** — 다른 프로젝트 폴더 열기.

### 앱 띄우는 법 — dev 말고 단독 exe

```
src-tauri/target/release/kasaspace.exe
```

**`npm run tauri dev` 를 `!` 로 돌리지 마라.** 끝나지 않는 명령이라 셸을 붙잡은 채
출력이 안 보여서, 직전 세션이 "앱이 안 뜬다"고 오진하고 한참 헤맸다. 실제로는 잘 떠 있었다.
단독 exe 는 dist 가 안에 박혀 있어 vite 도 터미널도 안 붙잡고, 더블클릭으로 뜬다.
UI 를 고쳤으면 `npm run build` 후 `cd src-tauri; cargo build --release --features custom-protocol`
으로 다시 굽는다. **`npx vite build` 를 직접 부르지 마라** — esbuild 는 타입을 안 봐서
prop 하나를 구조분해에서 빠뜨린 것도 통과시키고, 흰 화면으로만 드러난다. 실제로 밟았다. feature 를 빠뜨리면 exe 가 vite 를 찾다가 연결 거부 페이지만 띄운다.

### 다음에 할 것

**pane 간 에이전트 연결** — 이 레포의 본론이자 가장 큰 구멍이다. upstream 에
`kasa-socket`(cmux 호환 소켓 서버)이 이미 있으니 `kasa-pty` 처럼 당겨 쓰면 된다.
그 밖에 창 분리 · 설정 화면 · 터미널 내 검색이 없다.

---

## 되돌리면 회귀하는 결정 셋

값을 치르고 알아낸 것이라 "왜 이렇게 짰지" 하고 정리하면 그대로 깨진다.

1. **pane 을 배치 트리 모양대로 DOM 중첩하지 않는다.** 평평하게 깔고 좌표만 준다.
   중첩하면 분할할 때마다 기존 pane 이 트리에서 깊어지며 React 가 언마운트하고,
   그때마다 PTY 가 죽는다.
2. **안 보이는 탭은 `visibility:hidden`, `display:none` 이 아니다.** 상자 크기가 남아
   있어야 xterm 이 자기 칸 수를 옳게 재고, `none` 이면 폭 0 이 PTY 까지 전달된다.
3. **단축키는 캡처 단계에서 잡는다.** xterm 은 숨은 textarea 로 키를 받아서 버블
   단계에서는 이미 셸로 흘러간 뒤다.
4. **한글 확정분은 xterm 이 아니라 우리가 보낸다.** 조합이 열려 있는 동안은 xterm 이
   무엇을 보내든 전부 버리고, `compositionend` 에서 직접 `pty_write` 한다. xterm 은
   확정분을 자기 경로로도 브라우저 input 이벤트로도 보내고 둘 다 `setTimeout(0)` 뒤라,
   WebView2 에서는 같은 글자가 두 번 들어가고 조합 중 자모까지 샌다. "조합 중이면
   막는다"로 되돌리면 이번엔 **한 글자밖에 못 친다** — 받침이 다음 글자 초성으로
   넘어가며 앞 글자가 확정될 때, 확정분이 도착할 무렵엔 이미 다음 조합이 열려 있다.
   둘 다 실제로 밟은 경로다.

`tap_bytes_with_snapshot()` 을 구독 등록과 화면 채취 둘로 쪼개지 않는 이유는 README 에 있다.

## 자율 테스트 우선

"테스트 해보세요"라고 떠넘기지 말고 직접 실행·확인·수정 사이클을 돌려라.
`KASASPACE_AUTOKEYS`(진짜 KeyboardEvent) · `KASASPACE_AUTOSEND`(`term.input()`) ·
`scripts/shot.ps1` 로 제품 경로를 그대로 탈 수 있다. 사용법은 README.

**OS 로 키를 쏘는 방식(SendKeys 류)은 쓰지 않는다** — 포커스가 다른 창에 있으면 사용자
창에 타이핑된다. 실제로 한 번 새어 나갔다. 손잡이가 없으면 앱 안에 env 로 만든다.

마우스도 `KASASPACE_AUTOMOUSE`(셀렉터 기준 좌표 드래그·클릭)로 만들 수 있게 됐다.
`KASASPACE_PROBE` 는 JS 결과를 화면 오버레이로 찍어 준다 — 릴리스 웹뷰에 콘솔이 없어서다.

사용자에게 넘길 수밖에 없는 것은 **IME 조합**뿐이다. 합성 CompositionEvent 로 우리 쪽
게이트는 검증되지만, 진짜 IME 가 WebView2 에 무엇을 보내는지는 실기로만 알 수 있다.

## 코드 맵

| | |
|---|---|
| `src-tauri/src/lib.rs` (226줄) | PTY ↔ 웹뷰 다리, pane 상태 |
| `src-tauri/src/workspace.rs` (178줄) | 파일트리 · git · 세션 |
| `ui/App.tsx` (505줄) | 탭 · 배치 · 단축키 |
| `ui/layout.ts` (122줄) | pane 배치 트리 |
| `ui/Term.tsx` (166줄) | xterm.js 배선 |
| `ui/Tree.tsx` (121줄) | 파일트리 |
| `ui/app.css` (548줄) · `ui/theme.css` (50줄) | 치이카와 테마 |

## 옆 폴더 kasaterm 을 볼 때

`~/desktop/sehyun/kasaterm` 의 로컬 `main` 은 upstream 과 크게 갈라져 있다(2026-08-30 기준
origin 이 1501커밋, 로컬이 1086커밋 각자 앞섬). 엔진 API·LFS·테마를 로컬 파일로 확인하면
**없는 것처럼 보인다** — 실제로 "LFS 없다", "theme-src-chiikawa 없다"고 오보한 적이 있다.
`git show origin/main:<경로>` 로 봐라. Git Bash 에서는 MSYS 경로 변환이 `origin/main:x` 를
`origin\main;x` 로 바꾸므로 `MSYS_NO_PATHCONV=1` 을 붙인다.
