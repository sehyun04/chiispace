# kasaspace

터미널을 한 칸으로 두는 작업환경. 치이카와 테마.

**터미널은 만들지 않는다.** PTY 생성과 VT 파싱은
[2rami/kasaterm](https://github.com/2rami/kasaterm) 의 `kasa-pty` 를 git 의존성으로 그대로
당겨 쓰고, 화면은 웹뷰의 xterm.js 가 그린다. 이 레포의 코드는 그 위에 올라가는 것 —
배치, 파일, git, 에이전트 배선 — 만 갖는다.

```
셸 ──▶ kasa-pty (PTY·ConPTY) ──▶ tap_bytes ──▶ Tauri 이벤트 ──▶ xterm.js
                    ▲                                              │
                    └──────────── pty_write ◀── onData ────────────┘
```

`kasa_pty::PtySession::tap_bytes_with_snapshot()` 은 구독 등록과 "지금 화면"(ANSI) 채취를
락 하나 안에서 끝낸다. 둘로 나누면 그 사이 출력이 유실되거나 두 번 그려진다 — 엔진이
xterm.js 같은 소비자를 처음부터 상정하고 만들어져 있다.

| 남의 것 | 우리 것 |
|---|---|
| `kasa-pty` (rev 고정) | `src-tauri/src/lib.rs` — PTY ↔ 웹뷰 다리, pane 상태 |
| | `src-tauri/src/workspace.rs` — 파일트리 · git · 세션 |
| | `ui/App.tsx` — 탭 · 배치 · 단축키 |
| | `ui/layout.ts` — pane 배치 트리 |
| | `ui/Term.tsx` — xterm.js 배선 |
| | `ui/Tree.tsx` — 파일트리 |
| | `ui/app.css`, `ui/theme.css` — 치이카와 테마 |

## 단축키

| | |
|---|---|
| `Ctrl+Shift+D` / `E` | 좌우 / 상하 분할 |
| `Ctrl+Shift+W` | pane 닫기 |
| `Ctrl+Shift+←↑↓→` | 포커스 이동 |
| `Ctrl+Shift+T` | 새 탭 |
| `Ctrl+Shift+PgUp` / `PgDn` | 탭 이동 |
| `Ctrl+Shift+C` / `V` | 복사 / 붙여넣기 |
| `Ctrl+Shift+O` | 폴더 열기 |
| `Ctrl` `+` / `-` / `0` | 글자 크기 |

pane 을 옮기는 것은 마우스다. **헤더를 잡고 끌어다 놓는다** — 다른 pane 가운데에 놓으면
자리를 맞바꾸고, 가장자리에 놓으면 그쪽으로 갈라 붙는다. 놓기 전에 어디로 갈지 파란
영역으로 미리 보여 준다. 단축키로 두지 않은 이유: `Ctrl+Alt+방향키` 는 그래픽 드라이버가
화면 회전으로 먼저 채 가는 환경이 흔하다.

## 실행

개발 중에는:

```powershell
npm install
npm run tauri dev
```

`tauri dev` 는 **끝나지 않는 명령**이다. 그 셸을 계속 붙잡고 있으니 그냥 쓰려는 거라면
단독 exe 를 굽는 편이 낫다 — dist 를 안에 박아서 vite 도 터미널도 필요 없다.

```powershell
npm run build          # tsc --noEmit 을 먼저 돈다. npx vite build 는 타입을 안 본다
cd src-tauri; cargo build --release --features custom-protocol
# -> src-tauri/target/release/kasaspace.exe  (더블클릭으로 뜬다)
```

`--features custom-protocol` 을 빠뜨리면 안 된다. Tauri 는 릴리스 여부를 `--release`
가 아니라 이 feature 로 가른다 — 꺼져 있으면 `generate_context!` 가 dev 모드로
컴파일되어 dist 를 exe 안에 박지 않고 `devUrl`(vite) 을 본다. 그러면 release exe 인데
창에 "localhost 연결을 거부했습니다"(`ERR_CONNECTION_REFUSED`) 만 뜬다.

## 테마

`ui/theme.css` 한 파일이 색의 전부다. 값은 upstream 의 `theme-src-chiikawa/roster.json`
에서 왔다 — 그건 색 테마가 아니라 **캐릭터 로스터**(21명, 페르소나 + `header_color`)이고,
`desc.txt` 가 말하는 외형("순백 서양배 모양 몸 · 두꺼운 따뜻한 갈색 테두리 · 분홍 볼터치")이
곧 UI 규칙이다. 그래서 이건 어두운 터미널이 아니라 **밝은 터미널**이다. 의도된 것이다.

UI 폰트는 Galmuri11(OFL, `ui/assets/`). 터미널 글자는 시스템 등폭.

## 헤드리스 검증

```powershell
$env:KASASPACE_ROOT     = "C:/path/to/repo"    # 폴더를 연 채로 띄운다
$env:KASASPACE_AUTOKEYS = "C-S-d,C-S-t,C-="     # 단축키를 순서대로 쏜다
$env:KASASPACE_AUTOSEND = "dir /w"              # 이 문자열 + Enter 를 터미널에 주입
scripts\shot.ps1 -Out shot.png
```

`KASASPACE_AUTOKEYS` 는 진짜 `KeyboardEvent` 를 쏜다. 단축키 핸들러부터 그 뒤(배치
트리 · 새 PTY · 리사이즈)까지 제품 경로를 그대로 탄다.

`KASASPACE_AUTOSEND` 는 웹뷰의 `term.input()` 을 부른다. 사용자가 키를 친 것과 **같은
경로**(`onData` → `pty_write`)를 타므로 배선 전체가 검증된다.

`KASASPACE_AUTOMOUSE` 는 셀렉터가 가리키는 요소의 중앙을 눌러 끌고 놓는다.

```powershell
$env:KASASPACE_AUTOMOUSE = ".page:not(.off) .seam.vert@180,0"   # 경계선을 오른쪽으로 180px
$env:KASASPACE_AUTOMOUSE = ".tree .row.dir@0,0"                  # 0,0 이면 클릭
```

경계선 드래그·파일트리처럼 키보드로 못 만드는 경로가 여기에 걸린다. OS 마우스를 움직이지
않으므로 사용자 창을 건드리지 않는다. 중간 지점을 한 번 거쳐 mousemove 를 두 번 보내므로
드래그 도중에만 나는 버그도 잡힌다.

`KASASPACE_PROBE` 는 JS 표현식의 결과를 화면 아래 오버레이에 찍는다. 릴리스 웹뷰에는
콘솔이 없어서 스크린샷에 남기는 것이 유일한 통로다.

```powershell
$env:KASASPACE_PROBE = "document.querySelectorAll('.pane').length"
```

OS 로 키를 쏘는 방식(SendKeys 류)은 쓰지 않는다 — 포커스가 다른 창에 있으면 엉뚱한 앱에
타이핑된다. 실제로 한 번 새어 나갔다.

`scripts/shot.ps1` 이 넘어가는 함정 셋(전부 실제로 밟았다):

- 디버그 빌드는 콘솔 서브시스템이라 창을 **둘** 만든다. `MainWindowHandle` 이 콘솔 쪽을
  집으므로 제목으로 골라야 한다.
- `EnumWindows` 콜백을 인라인 람다로 넘기면 열거 도중 GC 되어 결과가 0개로 나온다.
- `SetProcessDPIAware()` 를 안 부르면 125% 배율에서 `GetWindowRect` 가 가상화된 좌표를
  줘 창의 80%만 찍힌다. 멀쩡한 레이아웃을 깨진 것으로 오진하게 된다.

## 엔진을 같이 고칠 때

`src-tauri/Cargo.toml` 아래쪽 `[patch]` 블록의 주석을 풀면 git 대신 옆 폴더의 kasaterm
작업 트리를 쓴다. 엔진 rev 를 박아 둔 이유는 upstream `main` 이 활발히 움직이기 때문이다 —
말없이 바뀌어 깨지는 것보다 의도적으로 올리는 편이 낫다.

주의: 로컬 kasaterm 클론의 `main` 은 upstream 과 크게 갈라져 있다. 엔진 API·LFS·테마를 확인할
때 로컬 파일을 보면 **없는 것처럼 보인다**. `git show origin/main:<경로>` 로 봐야 한다.

## 지금 되는 것

- **pane 분할** — 좌우 · 상하, 경계선 드래그, 방향키로 포커스 이동
- **pane 재배치** — 헤더를 끌어 옮긴다. 가운데는 맞바꾸기, 가장자리는 그쪽으로 갈라 붙이기.
  배치 트리를 다시 엮어도 PTY 는 안 죽는다 — slot 이 배치 모양이 아니라 id 로 짝지어져서다
- **탭** — 탭마다 자기 배치와 자기 폴더
- **파일트리 + git** — 브랜치 · ahead/behind · 파일별 M/A/D/? · 접힌 폴더의 변경 표시
- **pane 헤더** — 실행 중인 명령 이름, 에이전트 표시, 작업 중 바
- **세션 복원** — 탭 · 배치 · 폴더 · 글자 크기, 그리고 그 pane 이 돌리던 명령을
  프롬프트에 쳐 둔 채로. claude 를 켜 둔 pane 은 `claude --continue` 로 얹혀 Enter 한
  번에 이전 대화로 돌아간다. 실행까지 하지는 않는다 — 빌드나 배포가 저 혼자 다시 도는 건
  곤란하다. 프로세스 자체는 앱과 함께 죽었으므로 되살릴 수 있는 것은 여기까지다
- 복사/붙여넣기(bracketed paste 포함) — OS 클립보드를 직접 쓴다. 웹뷰의
  `navigator.clipboard` 는 창이 포커스를 갖고 있어야 하고 읽기에 권한이 따로 걸려
  WebView2 에서 `NotAllowedError` 로 조용히 거부된다
- 글자 크기, 링크 열기, 스크롤백 10000
- **파일 클릭** — 그 경로가 지금 보고 있는 셸에 들어간다. 셸이 선 곳 기준 상대 경로다
- 한글 입력·출력(IME 조합 중 자모는 확정 전까지 셸로 가지 않는다), 새 셸은 연 폴더에서 시작

## 아직 안 되는 것

- **pane 간 에이전트 연결** — 이 레포의 본론. `kasa-socket` 이 upstream 에 있다
- 창 분리(undock) · 설정 화면 · 테마 전환 · 터미널 내 검색
- 캐릭터 스프라이트 — `desc.txt` 만 있고 이미지는 아직 없다

## 라이선스

MIT. `kasa-pty` 는 kasaterm 것(MIT). Galmuri11 은 OFL(`ui/assets/OFL-Galmuri.txt`).
