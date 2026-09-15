# chiispace

터미널을 **한 칸**으로 두는 작업환경. 여러 개를 나란히 띄워 놓고 각 칸에 에이전트를 하나씩
앉히는 것이 목적이다. 치이카와 테마.

Windows 전용. Tauri 2 + React + xterm.js.

초기 제작부터 구현·오류 수정·검증·배포·남은 작업까지는 [누적 작업 정리](docs/WORKLOG.md)에 모았다.
현재 인수인계와 회귀 방지 규칙은 [CLAUDE.md](CLAUDE.md)를 따른다.

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
| `src-tauri/src/pty_stream.rs` | 출력 지연 재연결과 실제 셸 종료 구분 |
| `src-tauri/src/codex_transport.rs` | 로컬 Codex 연결과 실제 대화 시작·복원 응답 |
| `src-tauri/src/codex_session.rs` | Codex 대화 ID·폴더·복원 옵션 검증 |
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
- **지난 대화가 스크롤백에 들어간다.** claude 는 `--resume` 할 때 대화를 처음부터 다시
  찍지 않아서(배너와 마지막 몇 개뿐이다) 되살린 칸은 위로 올려다봐도 비어 있었다.
  셸을 띄우기 전에 마지막 40개 주고받기를 우리가 먼저 찍는다. 그보다 앞은 claude 의
  `ctrl+o` 로 본다.
- **Codex는 일반 터미널 스크롤을 사용한다.** 치이스페의 Codex 실행 래퍼가
  `--no-alt-screen`을 붙여 대체 화면으로 전환하지 않게 한다. 새 대화와 `codex resume`
  모두 적용되며, 이미 같은 옵션을 붙인 명령에는 중복하지 않는다. 전역 설정은 바꾸지 않는다.
  OpenAI Docs의 [CLI 옵션](https://developers.openai.com/codex/cli/reference/) 기준이다.
  **이 옵션만으로는 Windows 10에서 부족하다.** OS 기본 ConPTY가 Codex의 영역 스크롤을
  화면 덮어쓰기로 바꿔 스크롤백이 0줄로 남는 것을 실제 Codex에서 재현했다.
  [Microsoft ConPTY 1.24.260710001](https://www.nuget.org/packages/microsoft.windows.console.conpty/)
  을 앱에 내장하고 앱 캐시에서 로드한다. 사용자가 DLL을 설치하거나 exe 위치를 바꿀 필요는 없다.
  PTY 엔진이 이미 답한 장치·커서·색 조회에는 xterm이 중복 응답하지 않아야 한다.
  그렇지 않으면 늦게 온 응답이 셸 명령이나 Codex 초안으로 들어간다.
  출력 전송이 밀려 구독이 끊겨도 칸을 닫지 않고 엔진의 화면·스크롤백으로 다시 연결한다.
  실제 셸 종료는 별도로 확인한다. 재연결은 엔진에 남아 있는 이력 범위이며 모든 원시 출력의 보관은 아니다.
  기존 앱에서 실행 중인 Codex에는 소급 적용되지 않는다.
- **Codex도 칸별로 자기 대화를 자동 복원한다.** 실행 래퍼가
  [App Server](https://learn.chatgpt.com/docs/app-server)의 실제 `thread/start`·`thread/resume`·`thread/fork`
  응답에서 ID를 받고, 상태 폴더(`CODEX_HOME`)·작업 폴더와 함께 저장한다. `/new`로 바꾸면 새 ID로 갱신한다.
  터미널 화면과 입력은 기존 Codex TUI를 그대로 사용한다. 로컬 서버는 실행별로 분리하고
  `127.0.0.1`·임의 포트·실행별 인증을 사용하며 브라우저의 Origin 요청은 거절한다.
  서버와 자식 프로세스는 Windows Job으로 묶어 실행 종료 때 남지 않게 한다.
  **메시지를 한 번도 보내지 않은 빈 대화는 Codex가 저장하지 않으므로 새 빈 대화로 연다.**
  실제 메시지를 받은 대화는 저장된 ID로만 연다. 다른 치이스페 칸이 사용 중이거나 없는 ID면
  다른 대화를 추측하지 않고 ID·복원 명령을 남긴 채 자동 실행을 멈춘다. 문제를 정리한 뒤 Enter로 재시도한다.
  명시적인 모델·프로필·샌드박스·승인 옵션과 허용된 모델·권한 `-c` 값은 보존한다.
  `--sandbox`·`--ask-for-approval`은 로컬 서버의 설정과 시작·복원 요청에 적용한다.
  Codex 0.154의 원격 TUI 복원 제한 때문에 옵션을 버리거나 권한을 넓히지 않는다.
  상태 폴더·대화 ID별 Windows 잠금으로 치이스페 실행끼리 중복 복원을 막는다. 잠금은 해당 실행이
  끝날 때 풀리며, 래퍼 밖에서 실행한 Codex까지 독점한다고 보장하지 않는다.
  권한 값이 든 `--profile`도 저장된 ID로 자동 복원한다. 내부 자동 복원에서만 TUI가 해석한
  첫 시작 요청을 같은 ID의 서버 복원 요청으로 전달한다. 프로필 파일·권한·설정 우선순위는
  바꾸지 않는다. 복원 응답의 ID가 다르거나 복원에 실패하면 새 대화로 대체하지 않는다.
  이는 Codex 자체의 `--remote ... resume` 제한을 수정하는 기능이 아니며 수동 명령은 그대로 전달한다.
  원문 프롬프트·첨부·MCP 인증 등 임의의 `-c` 값은 앱 세션에 복제하지 않는다.
  **이전 버전에서 ID 없이 저장된 Codex 칸은 첫 실행에 대화 선택 목록을 연다.** 원래 대화를
  한 번 선택하면 이후부터 자동 복원한다. `--last`로 대상을 추측하지 않는다.
  이 기능은 치이스페 실행 래퍼를 거친 로컬 대화형 Codex에 적용된다. 래퍼를 우회한 절대 경로·별칭,
  사용자가 직접 지정한 외부 `--remote`, 비대화형 명령은 대화 ID 자동 연결 대상이 아니다.
  최초 구현은 Codex `0.153.4`, 후속 호환 수정은 `0.154.0`을 기준으로 한다. 공식 WebSocket 연결은 실험적이므로
  Codex 버전을 바꿀 때는 아래 실제 복원 검증을 다시 수행한다.
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

**칸 사이 연결** — `kasa-socket`을 PTY와 같은 rev로 당겨 쓴다. 각 앱은 별도 Windows
named pipe를 열고, 칸의 셸에 `CHIISPACE_SOCKET_PATH`, `CHIISPACE_PANE_ID`,
`CHIISPACE_CLI`를 넘긴다. `KASATERM_SOCKET_PATH`와 `CMUX_SOCKET_PATH`도 같은 주소다.
에이전트는 CLI로 다른 칸의 목록·화면을 읽고, 텍스트·키를 보내거나 칸을 나누고 닫을 수 있다.
배치는 React가 계속 소유하며, 분할은 새 PTY가 준비된 뒤 응답한다. 기본 분할은 포커스를 옮기지 않는다.

```powershell
& $env:CHIISPACE_CLI list
& $env:CHIISPACE_CLI peek '%2' 30
& $env:CHIISPACE_CLI text '%2' '검토 결과를 알려줘'
& $env:CHIISPACE_CLI key '%2' Enter
& $env:CHIISPACE_CLI split right
```

`text`는 원시 텍스트 전송이며 Enter를 덧붙이지 않는다. 여러 줄이나 제어 문자가 들어 있으면
그것도 그대로 전달되므로, 터미널 입력과 같은 의미다. 긴 글은 `text-stdin <칸 ID>`로 넣는다.
`split`은 칸 안에서는 호출한 칸을 기준으로 하고, 밖에서는 기준 ID를 지정해야 한다.
`focus`, `close`, `board`, `ping`도 지원한다. 밖에서 호출하려면 `--socket <주소>`를 앞에 붙인다.
이는 터미널 입력을 통한 연결이며 Claude의 `SendMessage`·팀 인박스와는 별개다.
CLI는 앱 exe와 같은 폴더에 두어야 한다.

**에이전트끼리 작업 맡기기** — 새 버전에서 각 칸의 `claude` 또는 `codex`를 시작하면
협업 MCP 도구가 실행별로 붙는다. 예를 들어 오른쪽 칸에 에이전트를 켜 둔 뒤 왼쪽 칸에서
"오른쪽 칸에 테스트 맡기고 결과 알려줘"라고 요청한다. 상대가 여러 명이면 이름이나 방향을
지정한다. `chiispace_context`로 자기 ID·이웃·연결 상태를 확인할 수 있다.

- `chiispace_delegate`: ID, 방향(`left/right/up/down`), 중복되지 않는 칸 이름·캐릭터로 요청
- `chiispace_status`: 작업 ID로 대기·전달·수행·완료·실패와 실제 결과 조회, 최대 25초 대기
- `chiispace_claim` / `chiispace_complete`: 받은 에이전트의 작업 수락과 결과 보고
- `chiispace_cancel`: 아직 전달 전인 자기 작업 취소. 실행 중인 상대를 중단하지 않는다
- `chiispace_peek`: 포커스를 옮기지 않고 상대 화면 조회

상대가 작업 중이거나 입력 중이면 대기하고, 빈 에이전트 입력창을 확인한 뒤 작업 ID만 알린다.
본문과 결과는 MCP로 주고받는다. 완료는 상대가 결과를 보고해야 확정되며 화면 출력을 보고
추측하지 않는다. 요청한 에이전트는 상태 도구로 결과를 회수한다. 기존 raw `text`·`key` CLI는
이 대기열을 거치지 않으므로 작업 위임에는 MCP 도구를 쓴다.

Windows 앱의 PATH에 실행 래퍼를 우선 배치한다. 전역 PATH, Claude 설정, Codex `config.toml`,
프로젝트 지침은 바꾸지 않는다. 모델·권한 설정과 사용자가 넘긴 인자는 유지한다.
OpenAI Docs의 [실행별 MCP 설정](https://developers.openai.com/codex/mcp/)과
[Claude MCP 설정](https://code.claude.com/docs/en/mcp)을 사용하며 각 에이전트의 기존 도구 승인 절차를 따른다.
별칭이나 셸 프로필이 PATH를 덮으면 PowerShell에서 아래처럼 명시적으로 실행한다.

```powershell
& $env:CHIISPACE_CLI agent claude
& $env:CHIISPACE_CLI agent codex
```

이미 실행 중인 에이전트나 `claude attach`로 붙은 외부 백그라운드 세션에는 새 도구를 소급해
넣지 않는다. 해당 칸에서 새로 실행해야 한다. 대기열은 앱 메모리에만 있으며, 칸·에이전트가
종료/재시작되면 관련 미완료 작업을 실패로 닫는다. 대기는 15분, 미완료 작업은 64개까지다.
프롬프트 형태를 확인할 수 없거나 초안을 지운 뒤에도 대기하면 빈 입력창에서 Ctrl+C로
입력 상태를 정리한다. Claude 네이티브 팀 인박스나 `SendMessage` 연결은 아니다.

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
cd src-tauri; cargo build --release --features custom-protocol --bins
# -> src-tauri/target/release/chiispace.exe  (더블클릭으로 뜬다)
# -> src-tauri/target/release/chiispace-cli.exe  (칸 연결용)
```

Windows 첫 빌드에서는 `scripts/prepare-conpty.ps1`이 Microsoft NuGet에서 고정 버전의
ConPTY 패키지를 받아 SHA-256을 검사하고 `OUT_DIR`에 풀어 둔다. 이후 빌드는 검증한 캐시를
재사용한다. DLL·호스트·MIT 고지를 exe에 포함하므로 배포 파일은 여전히 앱과 CLI 두 개다.
실행할 때 앱 캐시의 버전·아키텍처별 디렉터리에 원자적으로 배치하고 바이트 일치를 확인한다.

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

세션 선택 회귀 테스트는 `npm test`, Rust 검증은
`cargo test --manifest-path src-tauri/Cargo.toml --release --features custom-protocol`로 돌린다.
실제 칸 연결은 아래처럼 별도 앱 두 개를 순차 기동하고 임시 세션으로 검증한다. 일반 `npm test`에서는
실제 앱 검증을 건너뛴다. 사용자 세션 파일은 실행 전후 SHA-256을 비교한다.

```powershell
$env:CHIISPACE_TEST_EXE = (Resolve-Path src-tauri/target/release/chiispace.exe).Path
node --test --test-concurrency=1 scripts/bridge.test.mjs scripts/collab.test.mjs
```

사용자 앱이 실행 중이면 빌드에 `--target-dir target/agent-bridge`를 붙여 별도 폴더에 만들고
`CHIISPACE_TEST_EXE`에도 그쪽 exe를 지정한다. CLI도 함께 빌드해야 한다.
이 경로는 임시 검증용이다. 사용자용 실행 경로는 `src-tauri/target/release/chiispace.exe`로
고정하고, 검증 후 앱·CLI를 그 위치에 함께 반영한다. 실행 중이면 사용자가 작업을 정리하고
종료한 뒤 반영하며, 임시 경로를 새 실행 위치로 안내하지 않는다.
협업 검증은 `rustc`로 테스트용 Claude/Codex 대역 exe를 임시 폴더에 만들고 실제 PTY와
MCP를 연결한다. 유료 모델은 호출하지 않으며 모델이 자연어 지침을 따르는지까지 검증하는
테스트는 아니다. 초안·작업 중 대기, 결과 회수, 실패·취소, 재시작·칸 종료와 전역 설정 해시를
확인한다. `CHIISPACE_TEST_SHELL`로 PowerShell 등 셸 경로를 지정할 수 있다.
`CHIISPACE_TEST_CODEX_JS`에 설치된 `@openai/codex/bin/codex.js` 경로를 주면 실제 Codex의
읽기 전용 `mcp get` 명령으로 주입한 설정 파싱도 검증한다.

Codex 스크롤은 대역 출력이나 `scrollToTop()`만으로 검증하지 않는다. 설치된 네이티브 Codex의
exe 경로를 `CHIISPACE_TEST_REAL_CODEX`에 넣고 `node --test scripts/codex-scroll.test.mjs`를 실행한다.
별도 `CODEX_HOME`·앱 세션·오프라인 제공자를 사용하며, 모델 요청 없이 `/status` 출력 6개가
누락·중복 없이 쌓이는지와 실제 DOM 휠 이벤트로 상단·하단 이동이 되는지를 확인한다.
사용자 대화·인증을 가져오지 않으며 OS 키보드나 마우스를 조작하지 않는다.
`CHIISPACE_TEST_CODEX_PATH=inherited`를 함께 주면 네이티브 경로를 앞세우지 않고 평소 PATH의
실행 래퍼(npm 설치에서는 Node)를 검증한다. PowerShell 테스트는 `/quit` 이후 종료 코드 0과
기존 셸이 남아 있는지도 확인한다. 격리에는 OpenAI Docs의
[CODEX_HOME 환경 변수](https://learn.chatgpt.com/docs/config-file/environment-variables)를 사용한다.

Codex 대화 복원은 같은 실행 파일 환경 변수로 `node --test scripts/codex-resume.test.mjs`를 실행한다.
별도 상태 폴더와 로컬 가짜 Responses 서버만 사용하며 유료·외부 모델을 호출하지 않는다.
두 칸의 ID·본문 일치, 빈 대화, 재시작, `/new`, 숨겨진 탭, 다른 창의 사용 중인 ID와 없는 ID를 검증한다.
권한 포함 프로필은 이전 본문·모델 입력과 실제 turn의 권한을 확인하고, CLI·프로젝트·프로필·기본 설정의
우선순위와 문법 오류 프로필의 실패 보호도 검증한다. 설정 병합은 OpenAI Docs의
[프로필 계층](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles)을 따라 Codex에 맡긴다.
`CHIISPACE_TEST_CODEX_PATH=inherited`로 npm/Node 경로도 검증한다. 정상 경로뿐 아니라
복원 실패 뒤에도 원래 ID·옆 칸·앱이 남는지 확인하고 사용자 세션·설정 해시를 비교한다.

Rust의 `pty_stream` 검증은 화면 소비를 일부러 지연시켜 64청크 구독 한도를 넘긴다.
이때 칸을 종료하지 않고 재연결하는지, 이후 입력과 실제 셸 종료도 처리하는지 확인한다.
`scripts/pty-stream.test.mjs`는 제품의 복구 바이트로 xterm의 끊긴 VT·UTF-8 상태를 복구하고
조회 응답 중복 차단이 유지되는지 검증한다.

GUI 를 사람 손 없이 확인하는 손잡이가 앱 안에 들어 있다. env 가 있을 때만 깨어난다.

```powershell
$env:CHIISPACE_ROOT      = "C:/path/to/repo"                  # 폴더를 연 채로 띄운다
$env:CHIISPACE_AUTOKEYS  = "C-S-d,C-S-t,C-="                  # 단축키를 순서대로 쏜다
$env:CHIISPACE_AUTOSEND  = "dir /w"                           # 이 문자열 + Enter 를 주입
$env:CHIISPACE_AUTOMOUSE = ".seam.vert@180,0"                 # 요소 중앙을 눌러 끌고 놓는다
$env:CHIISPACE_PROBE     = "document.querySelectorAll('.pane').length"
$env:CHIISPACE_STATE     = "$env:TEMP\probe-state.json"     # 세션을 이 파일로 읽고 쓴다
scripts\shot.ps1 -Exe src-tauri\target\release\chiispace.exe -Out shot.png
```

- `AUTOKEYS` 는 진짜 `KeyboardEvent` 를 쏜다. 단축키 핸들러부터 그 뒤(배치 트리 · 새 PTY ·
  리사이즈)까지 제품 경로를 그대로 탄다.
- `AUTOSEND` 는 `term.input()` 을 부른다. 사용자가 키를 친 것과 **같은 경로**
  (`onData` → `pty_write`)라 배선 전체가 검증된다.
- `AUTOMOUSE` 는 `sel@dx,dy` 로 끌고 놓는다(`0,0` 이면 클릭). 중간 지점을 한 번 거쳐
  mousemove 를 두 번 보내므로 드래그 도중에만 나는 버그도 잡힌다. 경계선·목록처럼 키보드로
  못 만드는 경로가 여기에 걸린다.
- `STATE` 는 탭·배치·복원 명령을 그 파일에서 읽고 그 파일에 쓴다. **복원을 검증할 때는
  반드시 준다** — 안 주면 꾸며 넣은 값이 사용자가 실제로 쓰는 세션 파일에 눌러앉는다.
  없는 대화 id 가 그렇게 들어가 그 칸이 켤 때마다 빈 새 대화로 뜬 적이 있다.
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

- **네이티브 팀 연동** — 실행별 MCP와 빈 입력창 전달 대기열은 연결됐다. 에이전트 자동 생성,
  Claude 팀 인박스·SendMessage 연결, 재시작을 넘는 작업 예약은 아직 없다
- **앱 동시 기동** — 두 프로세스를 정확히 동시에 띄우는 검증에서 한쪽 초기화 타임아웃이
  관찰됐다. 순차 기동한 두 앱의 연결 격리는 통과하며 동시 기동 문제의 원인은 미진단이다
- **캐릭터 그림** — 자리와 배정은 다 됐고 20명 중 12명이 들어왔다. 남은 묘사는
  `ui/assets/faces/PROMPTS.md` 에 있다. 최후순위이며 사용자가 요청할 때만 작업한다
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
