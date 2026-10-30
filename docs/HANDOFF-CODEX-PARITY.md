# Codex 대화창 따라잡기 — 인계

2026-10-30, 기준 커밋 `f8f0bd3`(마지막 배포 `fddecb5`, 10월 27일 19:07). 설치된 CLI 는 `codex-cli 0.164.0`.
이 문서는 Codex 에이전트가 받아 바로 일할 수 있게 쓴 작업 지시다. 옛 [Codex 인계](HANDOFF-CODEX-CHAT.md)는 9월 이력이고
거기 적힌 "다음 할 것"은 지난 일이다 — 이 문서가 우선한다.

10월 30일 진행: 일 1은 구현·격리 검증 후 `3744b17`로 푸시했다. 일 2 조사에서는 대화 변경을 계속 따라가는 ID 근거를
찾지 못해 일 2·3을 보류했다. 자세한 근거는 WORKLOG 32절을 따른다. 아래 일 2·3은 재조사 조건이며 지금 구현 지시가 아니다.

## 먼저 읽을 것

1. [CLAUDE.md](../CLAUDE.md) 전체. 이름이 CLAUDE 지만 이 레포에서 일하는 모든 에이전트의 규칙이다. 특히 "다시 깨뜨리지 않을 핵심"과
   "여러 세션이 같이 돈다".
2. [README](../README.md)의 "헤드리스 검증"과 "엔진을 같이 고칠 때".
3. [작업 정리](WORKLOG.md) 19절(Codex 대화창), 21절(켤 때 Claude 칸 옮기기), 25절(머리줄 [터미널][대화창]), 27절(한 마디도 없는 대화의 옮기기),
   28절(`/resume`·`/login`).

## 왜 하는가

사용자는 TUI 에만 있는 기능을 대화창으로 다 옮기면 대화창을 메인으로 쓸 생각이다. Codex 대화창(`CodexStreamPane`)의 기본기 —
주고받기, 실시간 답, 승인·질문 카드, 모델·추론·승인 줄, 폴더 칩, `/resume`·`/login`·`/compact`·`/rename`, 껐다 켜기 복원 — 는
Claude 대화창과 이미 같다. 비어 있는 것은 바깥쪽이다.

| 항목 | Claude | Codex | 이 문서 |
|---|---|---|---|
| 대화창 → 터미널(같은 대화를 TUI 로) | 됨 | 없음 | 일 1 |
| 터미널 → 대화창 | 됨(명부 id) | 없음 — 앱이 칸의 대화 id 를 모른다 | 일 2 |
| 켤 때 터미널 칸을 대화창으로 옮기기 | 됨 | 없음 | 일 3 |
| 서브에이전트 진행 줄·대화 보기 | 됨(프록시 `chat:sub`) | 없음 | 일 4 |
| `/` 명령 | claude 가 준 50여 개 | 10개 남짓, 나머지는 "지원하지 않아" | 일 5 |

이미지 입력·칸 사이 협업은 둘 다 없으니 이번 범위가 아니다.

## 이 일에서 특히 밟기 쉬운 규칙

CLAUDE.md 에 다 있지만 이 일에서 실제로 걸리는 것만 다시 적는다.

- **대화 id 를 추측하지 않는다.** 칸에 붙이는 id 는 그 칸의 에이전트가 스스로 알려 준 값이어야 한다. rollout 파일 중 최근 것,
  `thread/list` 결과, `resume --last` 가 고른 것을 칸에 붙이는 근거로 쓰지 마라. `thread/list` 는 사람이 고르는 `/resume` 목록에만 쓴다.
  옛날에 "가장 최근 대화"를 고르다가 사용자가 쓰던 대화를 칸이 뺏었다.
- **app-server 로는 허용한 메서드만 보낸다**(`src-tauri/src/codex_stream.rs` 의 `permitted`, 지금은 initialize · thread/start ·
  thread/resume · thread/read · thread/list · thread/compact/start · turn/start · turn/steer · turn/interrupt · model/list · account/read ·
  account/rateLimits/read). 늘릴 때는 읽기만 하는지부터 본다. 실행·설정 쓰기·로그인·`thread/name/set` 은 막아 둔 것이다.
  읽기만 하는 메서드는 이유를 커밋 본문에 적고 넣는다. 그 밖의 것은 넣기 전에 사용자에게 묻는다.
- **사용자의 `~/.codex/config.toml`·훅·신뢰 DB 를 고치지 않는다.** 사용자 config 에는 이미 `notify`(computer-use 런타임)가 걸려 있다.
  `-c notify=...` 로 덮으면 그것이 조용히 끊긴다.
- **걷어낸 길을 되살리지 않는다.** 원격 TUI 중계(`--remote`, 옛 `codex_transport.rs`)와 훅 주입은 9~10월에 걷었다(작업 정리 22절).
- **검증은 격리해서 한다.** 별도 `CHIISPACE_STATE`·`CODEX_HOME`, 로컬 가짜 Responses 서버를 쓴다(`scripts/codex-stream-view.test.mjs` 가
  이미 그렇게 한다). 사용자 인증·대화를 복사하지 않고, OS 키보드·마우스로 입력하지 않는다.
- **exe 를 굽거나 바꾸지 않는다.** 배포(`scripts/deploy.mjs`)는 사용자가 말할 때만 한다. 검증 빌드는
  `node scripts/test.mjs --build`(`target/test-build`)로 한다. `target/release` 에 손으로 굽지 않는다. 떠 있는 사용자 앱을 끄지 않는다.
- **git.** `git add -A` 금지, 만진 파일만 이름으로 add 하고 커밋 전에 `git status --short` 를 본다. 같은 레포에서 Claude 세션도 돈다.
  `ui/App.tsx` 는 여러 일이 만나는 곳이라 조립 한두 줄만 더한다.
- **스타일.** 이모지 금지(아이콘은 인라인 SVG), 주석은 why 만, 커밋 제목은 명사형·접두사 없음, 본문은 평서형으로 왜를 적는다.
  사용자에게 하는 말은 한국어로, 칸은 `%3` 같은 id 가 아니라 캐릭터 이름으로 부른다(화면에 id 가 안 보인다).

## 일 1 — 대화창 → 터미널 (먼저 한다)

Claude 는 이렇게 한다. `ui/Pane.tsx` 의 `ModeSwitch` 가 Claude 칸에만 그려지고(99줄 조건), [터미널]을 누르면
`ui/useStreams.ts` 의 `toTerminal` 이 돈다.

- 대화 파일에 한 마디라도 있으면 `claude --resume <id>`, 없으면 그 폴더의 새 `claude` 를 복원 명령(`seed`)으로 건다.
  한 마디도 없는 대화를 `--resume` 하면 "No conversation found" 로 끝나 빈 셸만 남았다(작업 정리 27절).
- 통로는 대화창 칸이 내려가며 거두고, `streams` 에서 빼고 `keepTerm` 을 켠다. 되돌린 칸은 다음에 켜도 터미널로 둔다.

Codex 에서 할 일은 다음과 같다.

- `ModeSwitch` 를 Codex 대화창 칸에도 그린다. 터미널 쪽 [대화창] 단추는 일 2 가 될 때까지 잠그고, 까닭을 단추 풀이에 둔다
  (`toChat` 에 문자열을 주면 잠긴다).
- `toTerminal` 에 Codex 갈래를 더한다.
  - 서버가 준 thread id(`c.session`)가 있고 보낸 적이 있는 대화(`unstarted` 가 아님)면 `codex resume <id>` 를 건다.
  - 그 밖에는 그 폴더의 새 `codex` 를 건다.
  - id 는 명령줄에 들어가므로 uuid 모양(`isSessionId`)만 받는다.
  - 폴더 없이 연 Codex 대화창은 `USERPROFILE` 에서 돈다(`codex_stream_start`). 터미널도 거기서 연다.
- 일하는 중(`streamBusy`)이면 Claude 와 같이 잠근다. 하던 답이 끊긴다.

알아 둘 것이 있다. 셸에서 친 `codex resume <id>` 는 PATH 의 래퍼(`chiispace-cli` 사본)가 받아 실행 옵션만 잡는다
(`launch.rs` `run_agent` → `codex_session.rs` `Launch::capture`). 그래서 앱을 다시 켜면 이 칸은 지금의 모든 Codex 터미널 칸처럼
`resume --last` 로 이어 열린다. 같은 폴더에서 다른 Codex 대화를 더 나중에 했으면 다른 대화가 열릴 수 있다. 이것은 지금도 그런
동작이라 이번에 바꾸지 않는다. 바꾸려면 일 2 의 id 근거가 먼저 있어야 한다.

다 됐는지는 이것으로 본다. 격리 Codex 로 대화창에서 한 턴을 주고받고 [터미널]을 누르면 PTY 화면에 그 대화가 이어 열린다.
한 마디도 없는 칸은 새 `codex` 로 열린다. 앱을 다시 켜도 그 칸은 터미널로 남는다. 새 검증 파일(예: `scripts/codex-switch.test.mjs`)로
남긴다. Claude 쪽 `scripts/stream-restore.test.mjs` 가 같은 흐름을 Claude 로 검증하니 모양을 참고한다.

## 일 2 — 터미널 → 대화창 (조사 먼저, 근거가 없으면 멈추고 보고)

Claude 는 claude 가 자기 pid 로 명부에 대화 id 를 써 두고, 앱이 그것을 읽는다(`claude_files.rs` `claude_session_of_pid`,
`ui/usePaneAgents.ts` 의 `chatIds`). `/clear` 로 대화가 바뀌면 명부도 바뀐다. 그래서 칸이 지금 보고 있는 대화를 정확히 안다.

Codex 터미널 칸은 앱이 대화 id 를 모른다. 래퍼는 실행 옵션(`Launch`)만 잡고, 복원은 `resume --last` 다.
`collab.rs` 의 `chiispace.codex_session` RPC 는 부르는 곳이 없다. 걷어낸 훅 시절의 잔해다.

id 근거가 될 수 있는 것을 순서대로 조사한다.

1. codex 0.164 가 칸·프로세스 단위로 지금 thread id 를 알려 주는 길이 있는가. Claude 의 명부 같은 것을 찾는다.
2. 래퍼가 주입하는 chiispace MCP 연결로 codex 가 thread id 를 넘기는가. 9월 조사 때는 없었다. 버전이 올랐으니 다시 볼 만하다.
3. `notify` 는 격리 검증에서 신뢰 확인 없이 `thread-id` 를 줬다(옛 인계 참고). 다만 셋이 걸린다.
   - 첫 답이 끝나야 온다.
   - 사용자의 기존 `notify` 를 덮게 된다. 쓰려면 원래 notify 로 그대로 넘겨 주는 중계가 필요하다.
   - 알림 JSON 에 입력·답 원문이 들어 있어 기록하면 안 된다.
4. 일 1 로 연 칸은 앱이 연 id 를 안다. 그러나 TUI 안에서 `/new`·`/resume`·`/fork` 로 넘어가면 그 id 는 낡는다.
   넘어간 것을 알 길이 없으면 이것만으로 [대화창]을 열지 않는다. 열면 지난 대화를 다시 띄우고, 지금 하던 대화를 칸에서 떼어 낸다.

쓰면 안 되는 것은 rollout 파일 중 최근 것, `thread/list`, `--last` 가 고른 것, `--remote` 중계, 훅이다.

구현은 칸에 붙일 id 가 "그 칸의 codex 가 스스로 말한 값"이고 대화가 바뀔 때 따라 바뀌는 것일 때만 한다.
그런 근거를 못 찾으면 [대화창] 단추를 잠근 채 두고, 무엇을 봤고 왜 안 되는지를 작업 정리에 새 절로 남기고 사용자에게 보고한다.
억지로 열지 마라.

## 일 3 — 켤 때 터미널 칸을 대화창으로 (일 2 가 된 뒤에만)

Claude 는 `ui/saved.ts` 의 `bootStreams` 와 `ui/session.ts` 의 `streamCandidates` 로 한다. 명부가 준 id 와 실제 대화 파일이
둘 다 있을 때만 옮긴다. `--continue` 칸은 어느 대화인지 모르니 옮기지 않는다. 사용자가 터미널로 되돌려 둔 칸(`keepTerm`)도 옮기지 않는다.

Codex 도 같은 원칙이다. 일 2 의 근거로 얻은 id 가 저장돼 있고, 그 대화가 실제로 있을 때만 옮긴다. 있는지는 허용된 `thread/read` 로
확인할 수 있다. `resume --last` 로 도는 칸은 옮기지 않는다. 일 2 가 안 되면 이 일도 하지 않는다.
`scripts/saved.test.mjs` 에 Codex 경우를 더한다.

## 일 4 — 서브에이전트 진행 줄과 대화 보기

Claude 는 앱 프록시(`proxy.rs`)가 서브에이전트 스트림을 `chat:sub` 로 따로 흘린다. 진행 줄은 `ui/SubAgents.tsx`,
전체 보기는 `ui/SubagentView.tsx` 이고 `ui/Chat.tsx` 284줄에서 Claude 에만 붙는다.

Codex 는 프록시를 안 거친다. 대신 app-server 가 알려 준다. 0.164 의 프로토콜 스키마
(`codex app-server generate-json-schema --out <임시 폴더>`)에 다음이 있다.

- `collabAgentToolCall` 대화 항목: 도구 종류는 spawnAgent · sendInput · resumeAgent · wait · closeAgent · sendMessage ·
  followupTask · interruptAgent · listAgents.
- 에이전트 상태: pendingInit · running · interrupted · completed · errored · shutdown · notFound.
- `subAgentActivity`.
- thread 출처 `subAgentThreadSpawn`.

할 일은 다음과 같다.

- 이 알림을 `ui/codex-stream.ts` 에서 해석해 입력바 위에 에이전트마다 한 줄씩 지금 하는 일을 그린다.
  본 대화 말풍선과 섞지 않는다. 섞이면 서브에이전트의 생각이 본 대화의 답처럼 보인다(CLAUDE.md 의 `chat:sub` 항목과 같은 까닭).
- 줄 모양은 `SubAgents.tsx` 의 행을 재사용한다. 같은 자리가 칸마다 다른 모양이 되지 않게 하려는 것이다.
- 줄을 걷는 때는 Claude 쪽 규칙을 따른다. 본 대화가 다시 말한다고 걷지 말고, 서브에이전트가 끝났다는 신호로 걷는다.
- 전체 보기는 서브에이전트 thread id 가 오면 허용된 `thread/read` 로 읽는다. 보기 화면의 Esc 는 화면만 닫는다
  (window 캡처에서 막는다). 새면 아래 입력바로 가 본 대화가 멈춘다.
- 해석은 단위 검증으로 남긴다. 실제 이벤트 모양을 격리 환경에서 한 번 채취해 `scripts/fixtures/` 에 두고 쓴다.
  가짜 Responses 서버가 spawn 도구 호출을 돌려주게 해서 실앱 검증까지 한다. 이 기능에 config 의 feature 가 필요하면
  격리 `CODEX_HOME` 에서만 켠다. 제품이 사용자 config 를 켜지 않는다.

## 일 5 — `/` 명령 넓히기

지금은 `ui/CodexStreamPane.tsx` 129~139줄과 `CODEX_COMMANDS` 가 전부다. /model · /status · /permissions · /new · /clear ·
/compact · /rename 에 /resume · /login · /logout 이 더해지고, 나머지는 "이 명령은 지원하지 않아" 오류가 난다.

Codex TUI 의 명령 목록과 app-server 메서드를 대조해 표를 먼저 만들고, 그 표를 커밋 본문이나 작업 정리에 남긴다. 판단 기준은 이렇다.

- **읽기만 하는 것은 넣는다.** 예: `/mcp` → `mcpServerStatus/list`, 스킬 목록 → `skills/list`.
  `/diff` 는 TUI 에서 작업 폴더의 git 변경을 보인다. 서버가 보내는 `turn/diff/updated` 는 그 턴의 변경뿐이라 같은 것이 아니다 —
  읽기만으로 같은 것을 낼 수 있는지 보고 정한다.
- **턴을 하나 여는 것으로 갈음되는 것은 넣는다.** `turn/start` 로 되면 허용 목록을 늘리지 않는다.
- **실행·대화 만들기는 사용자에게 먼저 묻는다.** 예: `/review`(`review/start`), `/fork`(`thread/fork`).
- **설정 쓰기는 하지 않는다.** 예: `config/value/write`, `config/batchWrite`.

명령 목록은 `ui/palette.ts` 의 `barCommands`·`mergeCommands` 를 거친다. 모델·추론·권한처럼 줄에 있는 항목은 줄에서 만든다 —
따로 적으면 줄과 명령이 어긋난다(CLAUDE.md `StreamBar` 항목). 실제로 동작하는 것만 목록에 띄운다.

## 손대지 말 것

- **옵션창(설정창).** 사용자가 다음 방향으로 생각 중인 별도 작업이다. `ui/SplitPicker.tsx` 를 공용 고르기 창으로 넓히는 일과
  부딪히니 건드리지 않는다.
- **이미지 입력, 칸 사이 협업, 앱 안 로그인.** 로그인은 앱 안에 만들지 않는다는 결정이 있다.
- **Claude 동작.** 공용 부품(`Pane.tsx` 의 `ModeSwitch`, `useStreams.ts`, `StreamBar.tsx`, `palette.ts`)을 Codex 까지 넓히는 데까지만
  만진다. Claude 쪽이 그대로인지 `stream-restore`·`chat-stream`·`claude-stream`·`chat-sub`·`palette` 검증으로 같이 확인한다.
- **배포와 `docs/DEPLOYS.md`.**

## 만질 파일

겹침 판단용이다. 시작할 때 사용자에게 이 목록을 먼저 말한다.

- 일 1: `ui/Pane.tsx`, `ui/useStreams.ts`, `ui/App.tsx`(`onToTerminal` 배선 한두 줄), 새 `scripts/codex-switch.test.mjs`.
- 일 2·3: 조사 결과에 따라 `src-tauri/src/launch.rs`·`collab.rs`·`codex_session.rs`·`lib.rs`, `ui/usePaneAgents.ts`,
  `ui/saved.ts`·`ui/session.ts`, `scripts/saved.test.mjs`·`session.test.mjs`.
- 일 4: `ui/codex-stream.ts`, `ui/CodexStreamPane.tsx`, `ui/SubAgents.tsx`·`SubagentView.tsx`(재사용할 만큼만), `ui/chat.css`,
  `scripts/codex-stream.test.mjs`, `scripts/fixtures/`.
- 일 5: `ui/CodexStreamPane.tsx`, `ui/palette.ts`, `src-tauri/src/codex_stream.rs`(`permitted` 와 그 테스트), `scripts/palette.test.mjs`.

## 끝낼 때

- `node scripts/test.mjs --build` 전체를 돌린다. 지금 기준은 JS 145개·Rust 44개 전부 통과다. 새 검증을 더한 수치를 보고한다.
  실제 앱 검증이 건너뛰어졌으면 통과로 세지 않는다.
- 일마다 따로 커밋하고 `origin master` 로 푸시한다. 배포는 사용자가 이 푸시분까지 포함해 굽는다.
- [작업 정리](WORKLOG.md)에 새 절을 쓰고, CLAUDE.md 의 현재 상태·남은 범위·코드 맵과 README(단축키·검증 표)를 필요한 만큼 고친다.
  이 문서에서 끝난 일은 지운다. 다 끝나면 문서를 지우고 CLAUDE.md 남은 범위의 이 문서 링크도 걷는다.
- 사용자에게 한국어로 보고한다. 된 것, 못 한 것(특히 일 2 의 결론), 사용자가 실제로 써 보고 확인할 것을 나눈다.
  자동 검증 통과를 실사용 해결로 쓰지 않는다.
