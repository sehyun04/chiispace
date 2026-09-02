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
   **조합을 닫는 길은 여러 개여야 한다.** `compositionend` 하나만 믿으면, 조합 도중에
   다른 pane 을 누르거나 탭을 바꾸거나 pane 을 끌어 옮겨 DOM 이 움직일 때 그 이벤트가
   오지 않아 플래그가 켜진 채로 박힌다. 그러면 그 pane 은 한글도 영문도 백스페이스도
   안 먹는 먹통이 된다. `blur` 와 keydown 의 `isComposing` 으로도 풀어 준다.
   그 keydown 에서 **keyCode 229 를 예외로 두면 안 된다** — 한글 IME 는 조합을 여는
   첫 키도 229 로 주는데 그때의 `isComposing` 은 아직 false 다. 예외를 두면 플래그가
   잘못 켜졌을 때 한글로는 영영 못 푼다: 치면 칠수록 229 만 오니 계속 먹통이다.
5. **배치가 바뀌면 포커스를 손으로 되돌려야 한다.** 1번(평평하게 깔고 좌표만 준다)이
   PTY 를 살려 주는 대신 치르는 값이다. 배치 트리가 바뀌면 `rects()` 순서가 바뀌고
   React 가 slot DOM 을 실제로 옮기는데(`insertBefore`), DOM 이 움직이면 그 안의
   xterm textarea 는 blur 된다. 이때 `focused` prop 은 그대로라 Term 쪽 effect 가
   다시 돌지 않아 포커스가 영영 안 돌아온다 — 그 pane 은 한글도 영문도 백스페이스도
   안 먹고, 다시 눌러도 state 가 안 바뀌어 살아나지 않는다. App 에서 배치·포커스가
   바뀔 때마다 `__terms[id].focus()` 로 되돌리고, pane 을 누를 때도 state 와 무관하게
   직접 준다.
6. **"지금 터미널"을 전역 하나로 들지 않는다.** `window.__term` 은 Term 의 focused
   effect 에서만 갱신되므로 5번과 같은 이유로 낡는다. 복사·붙여넣기가 엉뚱한 pane 을
   보게 된다. 포커스된 pane 의 id 로 `__terms` 에서 찾는다.
7. **앱이 닫히는 중에는 `pty:exit` 을 웹뷰로 보내지 않는다.** 그 부고는 "이 pane 을
   배치에서 지워라"는 뜻인데, 웹뷰는 그것을 사용자가 `exit` 을 친 것과 구별할 수 없다.
   종료할 때 PTY 가 줄줄이 죽으면 pane 이 다 지워지고 그 빈 배치가 세션 파일에 저장돼
   다음에 켤 때 전부 날아간다. claude 처럼 종료가 느린 프로세스가 있으면 400ms 저장
   디바운스 창이 확실히 열린다 — cmd 만 있을 때는 종료가 빨라 재현되지 않는다.
8. **되살릴 정보는 누적해서 들고 있는다.** "이 pane 이 무엇을 돌리는가"를 `pane_status`
   스냅샷으로만 계산해 저장하면 안 된다. `pty:exit` 을 막아도 폴링은 800ms 마다 계속
   도는데, 종료 중 PTY 가 `panes` 맵에서 빠지면 그 폴링이 빈 목록을 주고 그 순간
   저장이 돌아 `procs` 가 통째로 지워진다. 배치는 `tabs` 에 있어 살아남으므로 **배치만
   남고 명령만 날아간다** — 증상이 "일부만 복원된다"라서 원인을 엉뚱한 데서 찾게 된다.
   목록에서 사라진 pane 은 "명령이 끝났다"가 아니라 "PTY 가 이미 죽었다"일 수 있고,
   그 둘은 스냅샷만으로 구별되지 않는다.
9. **에이전트는 이어 열고, 실행까지 한다.** claude 를 켜 둔 채 껐다면 `claude` 가 아니라
   `claude --continue` 를 **자동 실행**한다. 그냥 `claude` 는 새 대화이고, 명령을 쳐 두기만
   하는 것도 사용자에게는 "세션이 안 돌아온 것"과 같다 — 실제로 그렇게 만들었다가
   "cmd 창에 클로드 컨티뉴만 있고 복구가 안 된다"는 말을 들었다. 이어 여는 것은 대화를
   불러오는 것뿐이라 부작용이 없다. 반면 빌드·배포 같은 일반 명령은 여전히 쳐 두기만
   한다. 실행은 `pty_write` 로 보낸다 — `paste` 는 bracketed paste 로 감싸서 셸이
   명령으로 실행하지 않는다.
10. **claude 는 `--continue` 가 아니라 `--resume <세션 ID>` 로 되살린다.** `--continue` 는
   "그 폴더의 가장 최근"이라 pane 이 여럿이면 전부 같은 대화로 몰리고, 다른 창에서
   claude 를 돌리면 엉뚱한 것이 열린다. 대화는 `~/.claude/projects/<경로별 폴더>/<UUID>.jsonl`
   이고 파일 이름이 곧 세션 ID다. pane 에서 claude 가 잡히면 잠시 뒤 그 폴더에서 아직
   다른 pane 이 가져가지 않은 가장 최근 파일을 그 pane 에 붙인다. 폴더는 claude 의 인코딩
   규칙을 흉내 내지 말고 **영숫자만 남겨 비교**해서 찾는다 — 구분자·대소문자 처리가 바뀌면
   조용히 못 찾게 된다.
11. **`CLAUDE_CODE_CHILD_SESSION` 을 물려주지 않는다.** 이 앱이 claude code 안에서
   실행되면 그 표시를 상속하고, pane 에서 띄운 claude 가 "Transcript saving is off" 로
   뜬다. 대화가 저장되지 않으니 다음에 `--continue` 로 이어 열 것도 없다 — 세션 복원이
   조용히 무의미해진다. 앱 시작 때 `remove_var` 로 끊는다.

`tap_bytes_with_snapshot()` 을 구독 등록과 화면 채취 둘로 쪼개지 않는 이유는 README 에 있다.

**빌드가 갑자기 ``crate `softbuffer` required to be available in rlib format`` 으로 깨지면
코드가 아니라 `target` 의 fingerprint 가 상한 것이다.** 그 rlib 은 `target/release/deps` 에
멀쩡히 있는데도 cargo 가 다른 해시를 기대하며 다시 만들지도 않는다. `cargo clean -p <크레이트>`
로는 안 풀리고 `cargo clean` 전체가 필요하다(재빌드 2~3분). crate-type 이나 의존성을
건드려 고치려 들지 마라 — 원인이 아니다.

**에이전트가 도는 pane 은 스크롤백을 0 으로 둔다.** 엔진이 claude 에게 대체 화면을 못 쓰게
막아 두어서(`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`), claude 가 화면을 고쳐 그릴 때마다 그
내용이 스크롤백에 통째로 쌓인다. 조금만 써도 700줄이 넘고 아래로 내려도 끝이 안 난다.
그 표시는 `PtyOptions.env` 로 "0" 을 덮어써도 안 풀린다 — claude 가 값이 아니라 **존재
여부**만 보기 때문이다(실제로 시도해서 확인했다). 그래서 쌓이는 쪽을 막는다. 전체 화면
TUI 는 자기 스크롤이 있어 잃는 것이 없다.

**`.term-host` 의 상하 여백은 최소로.** 8px 을 주면 fit 이 버리는 자투리(셀 높이의 나머지)와
합쳐져 한 줄이 넘는 빈 띠가 아래에 남고, 줄 수도 하나 손해 본다(12줄 -> 13줄로 늘었다).

**`stat` 을 effect deps 로 쓸 때 800ms 보다 긴 타이머를 걸지 마라.** `pane_status` 폴링이
800ms 마다 새 객체를 주므로 effect 가 그 주기로 재실행되고, 그보다 긴 타이머는 매번
취소되었다가 다시 걸려 **영영 터지지 않는다**. 세션 ID 를 붙이는 2.5초 타이머가 이걸로
한 번 죽었다(저장 쪽 400ms 는 우연히 짧아서 살아남았다). 목록처럼 값이 같으면 참조도
같아지는 형태(정렬된 문자열)로 좁혀 deps 에 넣는다.

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
