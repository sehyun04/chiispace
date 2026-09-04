# chiispace

터미널을 **한 칸**으로 두는 작업환경. 여러 개를 나란히 띄워 놓고 각 칸에 에이전트를 하나씩
앉히는 것이 목적이다. 치이카와 테마.

Windows 전용. Tauri 2 + React + xterm.js.

**터미널은 만들지 않는다.** PTY 생성과 VT 파싱은
[2rami/kasaterm](https://github.com/2rami/kasaterm) 의 `kasa-pty` 를 git 의존성으로 그대로
당겨 쓰고, 화면은 웹뷰의 xterm.js 가 그린다. 이 레포의 코드는 그 위에 올라가는 것 — 배치,
세션, git, 에이전트 배선 — 만 갖는다.

```
셸 ──▶ kasa-pty (PTY·ConPTY) ──▶ tap_bytes ──▶ Tauri 이벤트 ──▶ xterm.js
                    ▲                                              │
                    └──────────── pty_write ◀── onData ────────────┘
```

`kasa_pty::PtySession::tap_bytes_with_snapshot()` 은 구독 등록과 "지금 화면"(ANSI) 채취를
락 하나 안에서 끝낸다. 둘로 나누면 그 사이 출력이 유실되거나 두 번 그려진다 — 엔진이
xterm.js 같은 소비자를 처음부터 상정하고 만들어져 있다.

> 로컬 폴더 이름만 `kasaspace` 로 남겨 두었다. claude 는 대화를
> `~/.claude/projects/<경로를 인코딩한 폴더>/` 에 쌓아서, 폴더를 옮기면 지금까지의 대화를
> 새 경로에서 못 찾는다. 이름과 상관없는 자리라 그냥 둔다.

## 코드 맵

| | |
|---|---|
| `src-tauri/src/lib.rs` | PTY ↔ 웹뷰 다리, 칸 상태, 헤드리스 검증 손잡이 |
| `src-tauri/src/workspace.rs` | git · 세션 파일 · claude 대화 목록과 이름 |
| `src-tauri/src/shells.rs` | 이 컴퓨터에 실제로 있는 셸 찾기 |
| `ui/App.tsx` | 얼개 — 탭 · 배치 · 단축키 · 세션 저장/복원 |
| `ui/Sidebar.tsx` | 옆칸. 그리기만 하고 판단은 App 이 준다 |
| `ui/session.ts` | 칸이 무엇을 돌고 있고 그것을 어떻게 되살리는가 |
| `ui/roster.tsx` | 치이카와 로스터 · 누가 어느 칸을 맡는가 |
| `ui/layout.ts` | 칸 배치 트리 · 끌어 옮기기 · 고르게 펴기 |
| `ui/Term.tsx` | xterm.js 배선 · 한글 IME · 복원 명령 |
| `ui/app.css`, `ui/theme.css` | 치이카와 테마 |

값을 치르고 알아낸 결정들("왜 이렇게 짰지" 하고 정리하면 그대로 깨지는 것들)은
[CLAUDE.md](./CLAUDE.md) 에 번호를 달아 모아 두었다.

## 되는 것

**칸 나누기** — 좌우·상하 분할, 경계선 드래그, 방향키로 포커스 이동. 칸을 늘리면 전체가
고르게 다시 나뉜다. 분할이 "지금 칸을 반으로"만 하면 같은 자리를 다섯 번 나눴을 때 456px
옆에 14px 이 남아 사실상 사라진다.

**칸 옮기기** — 헤더를 잡고 끌어다 놓는다. 다른 칸 가운데에 놓으면 자리를 맞바꾸고,
가장자리에 놓으면 그쪽으로 갈라 붙는다. 놓기 전에 어디로 갈지 파란 영역으로 보여 준다.
배치 트리를 다시 엮어도 PTY 는 안 죽는다 — 칸을 배치 모양대로 DOM 에 중첩하지 않고 평평하게
깔고 좌표만 주기 때문이다. 단축키로 두지 않은 이유는 `Ctrl+Alt+방향키` 를 그래픽 드라이버가
화면 회전으로 먼저 채 가는 환경이 흔해서다.

**탭과 셸 고르기** — 탭마다 자기 배치·자기 폴더·자기 셸을 갖는다. 옆칸의 `새 탭` 을 누르면
어느 셸로 열지 먼저 묻고, **이 컴퓨터에 실제로 있는 것만** 뜬다(명령 프롬프트 · Windows
PowerShell · PowerShell 7 · Git Bash). 목록을 앱에 박아 두면 없는 것을 골랐을 때 칸이
뜨자마자 죽는데, 그때 화면에 남는 건 빈 칸뿐이라 왜 안 되는지 알 수가 없다.

**세션 목록** — 탭 줄을 위에 따로 두지 않고 옆칸 목록에 묶음으로 넣었다. 같은 것을 두
군데서 고르게 하지 않으려고. 한 줄은 얼굴·이름·폴더이고, 누르면 그 탭으로 건너가 그 칸을
잡는다. 파일 탐색기는 두지 않는다 — 파일을 뒤지는 일은 칸 안의 에이전트가 한다.

**세션 복원** — 탭·배치·폴더·글자 크기, 그리고 그 칸이 돌리던 것까지 되살린다.

- claude 를 켜 둔 칸은 **그 대화가 저절로 다시 열린다.** 칸마다 어느 대화였는지를 세션
  ID(`~/.claude/projects/.../<UUID>.jsonl` 의 파일 이름)로 붙여 두었다가
  `claude --resume <id>` 로 연다. `--continue` 로는 안 된다 — 그건 "그 폴더의 가장 최근"
  이라 칸이 여럿이면 **전부 같은 대화로 몰린다.**
- ID 를 모르는 칸은 `--session-id <uuid>` 로 **우리가 낸 id** 를 주고 새로 연다. 그러지
  않으면 "방금 새로 생긴 대화 파일"을 뒤져 찾아야 하는데, 그 사이 다른 창에서 claude 를
  띄우면 그쪽 대화를 이 칸의 것으로 착각한다.
- 살아 있는 백그라운드 대화는 `--resume` 이 거절당하므로 `attach` 로 붙는다.
- 빌드·배포 같은 일반 명령은 **실행하지 않고 프롬프트에 쳐 두기만 한다.** 저 혼자 다시
  도는 건 곤란하다. 이어 여는 것은 대화를 불러오는 것뿐이라 부작용이 없어 그것만 실행한다.

**칸 이름** — 헤더를 두 번 누르면 붙는다. claude 가 도는 칸이면 `/rename` 으로 **대화
이름까지 같이** 바뀌어 `claude --resume` 목록에도 같은 이름으로 뜬다. 이름을 안 붙였으면
대화에 남은 이름을, 그것도 없으면 마지막으로 시킨 일을 대신 건다.

**캐릭터** — 칸마다 로스터에서 한 명이 맡는다. 옆칸에서 얼굴을 누르면 누가 맡을지 고를 수
있고, 배정은 세션에 남아 다시 켜도 같은 얼굴이 같은 칸에 붙는다. 그림이 들어온 사람만
세운다 — 스무 명을 다 세우면 색 동그라미가 섞여 나와 들어온 그림이 묻힌다.
`ui/assets/faces/<slug>.png` 를 넣으면 그때부터 그 얼굴이 붙고(vite 가 모아 준다),
`scripts/make-motion.py` 가 그 한 장에서 "일하는 중" 움직임을 구워 준다.

그 밖에 복사/붙여넣기(bracketed paste 포함, OS 클립보드 직접 사용) · git 브랜치와 변경
파일 수 · 글자 크기 · 링크 열기 · 스크롤백 10000 · 한글 입력.

## 단축키

| | |
|---|---|
| `Ctrl+Shift+D` / `E` | 좌우 / 상하 분할 |
| `Ctrl+Shift+W` | 칸 닫기 |
| `Ctrl+Shift+←↑↓→` | 포커스 이동 |
| `Ctrl+Shift+T` | 새 탭 (묻지 않고 지금 탭과 같은 셸로) |
| `Ctrl+Shift+PgUp` / `PgDn` | 탭 이동 |
| `Ctrl+Shift+C` / `V` | 복사 / 붙여넣기 |
| `Ctrl+Shift+O` | 폴더 열기 |
| `Ctrl+Shift+B` | 옆칸 접기·펴기 (왼쪽 위 단추로도) |
| `Ctrl` `+` / `-` / `0` | 글자 크기 |

단축키는 **캡처 단계에서** 잡는다. xterm 은 숨은 textarea 로 키를 받아서 버블 단계에서는
이미 셸로 흘러간 뒤다.

## 실행

```powershell
npm install
npm run tauri dev
```

`tauri dev` 는 끝나지 않는 명령이라 그 셸을 계속 붙잡는다. 그냥 쓰려는 거라면 단독 exe 를
굽는 편이 낫다 — dist 를 안에 박아서 vite 도 터미널도 필요 없다.

```powershell
npm run build          # tsc --noEmit 을 먼저 돈다. npx vite build 는 타입을 안 본다
cd src-tauri; cargo build --release --features custom-protocol
# -> src-tauri/target/release/chiispace.exe  (더블클릭으로 뜬다)
```

**`--features custom-protocol` 을 빠뜨리면 안 된다.** Tauri 는 릴리스 여부를 `--release`
가 아니라 이 feature 로 가른다. 꺼져 있으면 `generate_context!` 가 dev 모드로 컴파일되어
dist 를 exe 안에 박지 않고 `devUrl`(vite) 을 본다. 그러면 release exe 인데 창에
"localhost 연결을 거부했습니다"(`ERR_CONNECTION_REFUSED`) 만 뜬다.

빌드가 갑자기 ``crate `softbuffer` required to be available in rlib format`` 으로 깨지면
코드가 아니라 `target` 의 fingerprint 가 상한 것이다. `cargo clean -p` 로는 안 풀리고
`cargo clean` 전체가 필요하다. crate-type 이나 의존성을 건드려 고치려 들지 마라.

## 테마

굵은 테두리는 **캐릭터에만** 쓴다. 화면 구조까지 두르면 카드가 여러 장 놓인 모양이 되어
터미널보다 상자가 먼저 보인다 — 칸은 틈과 바탕색으로 가르고, 지금 보고 있는 칸만 안쪽에
얇은 선을 두른다. 칸 머리줄은 투명하고 아래 선 한 줄로만 나뉜다.

`ui/theme.css` 한 파일이 색의 전부다. 값은 upstream 의 `theme-src-chiikawa/roster.json` 에서
왔다 — 그건 색 테마가 아니라 **캐릭터 로스터**(21명, 페르소나 + `header_color`)이고,
`desc.txt` 가 말하는 외형("순백 서양배 모양 몸 · 두꺼운 따뜻한 갈색 테두리 · 분홍 볼터치")이
곧 UI 규칙이다. 그래서 이건 어두운 터미널이 아니라 **밝은 터미널**이다. 의도된 것이다.

UI 폰트는 Quicksand + 주아(둘 다 OFL, `ui/assets/`). 라틴·숫자를 Quicksand 가 먼저
가져가는 것은 멋이 아니라 필요다 — 한글 폰트는 백슬래시를 원화(₩)로 그려서 옆칸의 윈도우
경로가 `C:₩Users₩...` 로 보인다.

터미널 글자는 **D2Koding Ligature Nerd Font**(시스템 설치본, 레포에 넣지 않는다 — 6.6MB 다).
claude 상태줄이 브랜치·폴더 아이콘을 사설 영역 글자(`U+E0A0`, `U+F07B` …)로 찍는데 Nerd
판이 아니면 그 자리가 전부 두부(□)가 된다. **"Mono" 붙은 변형은 쓰지 마라** — 한글까지 한
칸으로 좁혀 글자가 겹친다. 없는 기계에서는 Cascadia Code(OFL, `ui/assets/`)로 물러선다.
아이콘은 두부가 되지만 글자는 멀쩡하고, Consolas 보다 글자를 더 갖고 있다(진행 막대 `▁▂`,
도는 표시 `⠋` 가 Consolas 에는 없다).

둥근 등폭(Sono · Comic Mono · Recursive Casual)은 재 보고 접었다 — 박스 문자(`─ │ ╭ ├`)가
아예 없어서 다른 폰트가 대신 그리고, 그 폰트의 자간이 달라 칸 격자에서 어긋난다. claude 의
프롬프트 상자가 부서진다는 뜻이다.

## 헤드리스 검증

GUI 를 사람 손 없이 확인하는 손잡이가 앱 안에 들어 있다. env 가 있을 때만 깨어난다.

```powershell
$env:CHIISPACE_ROOT      = "C:/path/to/repo"                  # 폴더를 연 채로 띄운다
$env:CHIISPACE_AUTOKEYS  = "C-S-d,C-S-t,C-="                  # 단축키를 순서대로 쏜다
$env:CHIISPACE_AUTOSEND  = "dir /w"                           # 이 문자열 + Enter 를 주입
$env:CHIISPACE_AUTOMOUSE = ".seam.vert@180,0"                 # 요소 중앙을 눌러 끌고 놓는다
$env:CHIISPACE_PROBE     = "document.querySelectorAll('.pane').length"
scripts\shot.ps1 -Exe src-tauri\target\release\chiispace.exe -Out shot.png
```

- `AUTOKEYS` 는 진짜 `KeyboardEvent` 를 쏜다. 단축키 핸들러부터 그 뒤(배치 트리 · 새 PTY ·
  리사이즈)까지 제품 경로를 그대로 탄다.
- `AUTOSEND` 는 `term.input()` 을 부른다. 사용자가 키를 친 것과 **같은 경로**
  (`onData` → `pty_write`)라 배선 전체가 검증된다.
- `AUTOMOUSE` 는 `sel@dx,dy` 로 끌고 놓는다(`0,0` 이면 클릭). 중간 지점을 한 번 거쳐
  mousemove 를 두 번 보내므로 드래그 도중에만 나는 버그도 잡힌다. 경계선·목록처럼 키보드로
  못 만드는 경로가 여기에 걸린다.
- `PROBE` 는 JS 표현식의 결과를 화면 아래 오버레이에 찍는다. 릴리스 웹뷰에는 콘솔이 없어서
  스크린샷에 남기는 것이 유일한 통로다. `window.__bind`(어느 칸이 어느 대화를 쥐었는지),
  `window.__restore`(복원할 때 무엇을 치기로 했는지)를 여기로 들여다본다.

**OS 로 키를 쏘는 방식(SendKeys 류)은 쓰지 않는다.** 포커스가 다른 창에 있으면 엉뚱한 앱에
타이핑된다. 실제로 한 번 새어 나갔다. 마우스도 같은 이유로 OS 커서를 움직이지 않는다.

`scripts/shot.ps1` 이 넘어가는 함정 셋(전부 실제로 밟았다):

- 디버그 빌드는 콘솔 서브시스템이라 창을 **둘** 만든다. `MainWindowHandle` 이 콘솔 쪽을
  집으므로 제목으로 골라야 한다.
- `EnumWindows` 콜백을 인라인 람다로 넘기면 열거 도중 GC 되어 결과가 0개로 나온다.
- `SetProcessDPIAware()` 를 안 부르면 125% 배율에서 `GetWindowRect` 가 가상화된 좌표를 줘
  창의 80%만 찍힌다. 멀쩡한 레이아웃을 깨진 것으로 오진하게 된다.

창을 거둘 때는 `CloseMainWindow()` 를 먼저 청한다. 곧바로 죽이면 PTY 가 한꺼번에 무너지며 그
부고가 웹뷰에 닿아 배치가 지워지고, 그 빈 배치가 세션 파일에 저장된다.

## 엔진을 같이 고칠 때

`src-tauri/Cargo.toml` 아래쪽 `[patch]` 블록의 주석을 풀면 git 대신 옆 폴더의 kasaterm 작업
트리를 쓴다. 엔진 rev 를 박아 둔 이유는 upstream `main` 이 활발히 움직이기 때문이다 — 말없이
바뀌어 깨지는 것보다 의도적으로 올리는 편이 낫다.

주의: 로컬 kasaterm 클론의 `main` 은 upstream 과 크게 갈라져 있다. 엔진 API·LFS·테마를
확인할 때 로컬 파일을 보면 **없는 것처럼 보인다**. `git show origin/main:<경로>` 로 봐야
한다(Git Bash 에서는 `MSYS_NO_PATHCONV=1` 을 붙인다).

## 아직 안 되는 것

- **칸 사이 에이전트 연결** — 이 레포의 본론이자 가장 큰 구멍. upstream 에
  `kasa-socket`(cmux 호환 소켓 서버)이 있으니 `kasa-pty` 처럼 당겨 쓰면 된다
- **캐릭터 그림** — 자리와 배정은 다 됐고 20명 중 12명이 들어왔다. 남은 묘사는
  `ui/assets/faces/PROMPTS.md` 에 그림 생성에 넣을 수 있게 정리돼 있다
- 창 분리(undock) · 설정 화면 · 테마 전환 · 터미널 내 검색
- 원본 그림이 1254px 이라 exe 가 22MB 다. 256px 로 줄이면 대부분이 빠진다

## 이름

`kasaterm` 의 엔진을 빌려 쓴다는 뜻으로 `chiispace` 였다가, 치이카와(ちいかわ) 쪽을 가져와
`chiispace` 가 됐다. `kasa` 는 傘(우산), `chii` 는 "なんか小さくてかわいいやつ"의 앞 두
글자다.

## 라이선스

코드는 MIT. `kasa-pty` 는 kasaterm 것(MIT). Quicksand · 주아는 OFL
(`ui/assets/OFL-Quicksand.txt`, `ui/assets/OFL-Jua.txt`).

`ui/assets/faces/` 의 그림은 치이카와 캐릭터를 본뜬 것이라 **원저작권은 나가노(ナガノ)에게
있다.** 개인적으로 쓰려고 만든 것이고 배포·상업적 사용을 염두에 두지 않았다. 이 레포를
공개로 돌릴 생각이면 그 폴더부터 정리해야 한다.
