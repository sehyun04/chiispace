# Codex 대화창 다음 핸드오프

## 현재 인계 — 2026-09-29, 터미널 없는 새 Codex 칸

사용자는 `916fd15`(새 대화 상대 목록)·`ded7b19`(터미널 없는 Claude 칸)를 확인하고 Codex도 같은 흐름으로
구현하라고 했다. 구현 착수 때 HEAD는 `ded7b19`였고, 그 뒤 Claude 배포 기록 `068f18e` 위에서 이 변경을 합쳤다.
사용자가 요청해 9월 29일 20:16에 고정 경로 앱·CLI를 교체했다. 실사용 중 새 대화의 첫 턴에서
빈 rollout에 제목을 쓰려다 `failed to set thread name` 오류가 난다는 신고가 들어왔다.
22:51에 수정판 앱·CLI를 같은 경로에 교체했다. 실행 중인 사용자 창은 그대로 두었으므로 다음 실행부터 적용된다.
23:01에는 미반영 원격 변경이 없는 것을 확인하고 통합 HEAD(`e01dcc4`)로 앱·CLI를 다시 빌드·교체했다.
고정 경로에서 Codex 실제 앱 검증을 통과했고, 실행 중인 창은 계속 그대로 두었다.
그 뒤의 교체도 사용자 요청 때 진행한다.

### 구현과 복원 경계

- `App.tsx`의 새 대화 → Codex는 셸·xterm 없이 `CodexStreamPane`으로 열린다. 기존 Claude stream 기록은
  `agent`가 없으면 Claude로 읽는다. 기존 PTY의 훅·`codex resume --last`·ConPTY 경로는 그대로다.
- `src-tauri/src/codex_stream.rs`: 설치된 Codex의 `app-server --listen stdio://`를 칸마다 띄운다.
  요청은 허용 목록과 칸·실행 세대·대화 ID로 제한한다. 승인 답은 서버가 발급한 미해결 요청에만 보낸다.
  앱이 종료되면 Windows Job Object가 npm 실행기의 자식까지 거둔다. 새로운 훅 주입·신뢰 우회·인증 복제는 없다.
- `ui/codex-stream.ts`: 서버의 이력과 실시간 알림을 같은 항목으로 합쳐 답변 중복을 막는다.
  다른 대화·턴의 메시지는 섞지 않고 완료된 턴의 늦은 시작 응답으로 busy가 다시 켜지지 않게 한다.
  도구 결과·중단·공개 생각 요약만 그리며 암호화된 추론 원문은 표시하지 않는다.
- `ui/CodexStreamPane.tsx`: 승인·선택지/직접 입력 카드, 중단, 모델·추론·승인 선택, 상태 표시.
  `/model`, `/status`, `/permissions`, `/new`, `/clear`, `/rename`, `/compact`를 연결했다.
  지원하지 않는 명령이나 전송 실패는 오류를 보이고 초안을 되살린다. 모델·상태 메뉴가 터미널로 전환하지 않는다.
  첫 턴의 `turn/start` 응답 직후에는 rollout이 아직 비어 있을 수 있어 자동 이름·`/rename` 모두
  `thread/name/set`을 호출하지 않는다. 이름은 앱의 `paneTitles`에 저장하고 수동 이름을 우선한다.
  서버 요청 허용 목록에서도 `thread/name/set`을 뺐다.
- `ui/stream-session.ts`: 서버 발급 ID로 `thread/resume`한다. 첫 말을 보내지 않은 대화는 CLI가 이력을
  만들지 않는 경계를 실제 앱에서 발견했다. `unstarted`가 참이어도 먼저 기존 ID 복원을 시도하고, 그 ID에 대해
  정확히 `no rollout found`가 왔을 때만 새 빈 대화를 연다. 첫 전송 전에 표시를 끈다.
  인증·설정 오류, 시간 초과, 이미 전송한 대화의 복원 실패를 새 대화로 덮지 않는다.
- 기존 설정에서 받은 샌드박스·승인 정책을 유지한다. 선택한 모델·추론·승인은 그 칸의 다음 요청에 반영하며
  전역 config 파일을 고치지 않는다. 칸 사이 협업은 Claude의 새 칸과 마찬가지로 아직 연결하지 않았다.

### 검증 완료

- `npm test`: 108 통과, 실제 앱 조건부 검증 19개 건너뜀, 실패 0.
- TypeScript·Vite, 내부 release 앱·CLI 빌드, Rust lib 37개 + CLI 11개 통과.
- 설치된 Codex 0.157.1 + 격리 `CODEX_HOME` + 로컬 Responses 서버로
  `scripts/codex-stream-view.test.mjs` 통과. 네이티브 exe와 기본 PATH의 npm/Node 경로를 각각 검증했다.
  두 칸 격리·한글 여러 줄·실시간 답·실제 승인 실행/취소 미실행·질문 답변·중단·모델 변경 후 `/status`와 후속
  응답·모델/이름/ID 재시작 복원·`/new`·빈 칸 재시작·실패 초안 복구·칸/앱 종료의 프로세스 회수를 확인했다.
- 같은 최종 내부 빌드의 `chat-view`, `chat-live`, `chat-sub`, `chat-stream`, `contacts` 5개 통과.
  사용자 세션·Codex 설정/훅 파일 해시 유지. 유료 모델·사용자 인증·대화 파일을 가져오지 않았다.
- 승인·상태·복원 화면 캡처 확인. 증거: 임시 폴더 `chiispace-codex-stream-A4svp0`(네이티브, 캡처 포함),
  `chiispace-codex-stream-xpDuSu`(기본 PATH), 부모는 `C:/Users/kshkj/AppData/Local/Temp`.
  임시 파일보다 커밋할 회귀 테스트를 기준으로 삼는다.
- 고정 경로로 교체한 뒤 같은 Codex 실제 앱 검증이 다시 통과했다(`chiispace-codex-stream-MuHCsO`).
  앱·CLI 해시는 WORKLOG 4절과 내부 빌드가 일치한다. 교체 전 앱·CLI와 세션 두 곳은
  `src-tauri/target/release/backups/before-codex-stream-20260929-201543/`에 보관했다.
- 제목 오류 수정 뒤 `npm test` 108 통과·19 건너뜀, TypeScript·Vite, Rust release 앱·CLI 빌드와
  lib 37개·CLI 11개 테스트를 통과했다. 새 대화·`/new`·빈 대화 복원의 첫 턴에서 오류가 없는지,
  `/rename`한 빈 칸을 다시 켜도 이름이 유지되는지 실제 Codex 회귀로 확인했다.
  고정 경로 수정판으로도 같은 테스트를 통과했다(`chiispace-codex-stream-kteU4J`).
  교체 전 파일과 세션 두 곳은 `src-tauri/target/release/backups/before-codex-title-20260929-225124/`에 보관했다.
  사용자 창은 종료하지 않았고 기존 앱 파일은 고정 경로의 `chiispace.exe.old-20260929-225124`로 보존했다.
- 통합 HEAD 재빌드에서도 `npm test` 108 통과·19 건너뜀, Rust lib 37개·CLI 11개 통과했다.
  Codex 실제 앱 회귀는 내부 빌드(`chiispace-codex-stream-uN47PK`)와 고정 경로 교체본
  (`chiispace-codex-stream-hGUKMp`)에서 각각 통과했다. 최신 백업은
  `src-tauri/target/release/backups/before-codex-head-20260929-230132/`이며 실행 중이던 앱 파일은
  `src-tauri/target/release/chiispace.exe.old-20260929-230132`로 보존했다.

### 다음 작업과 미검증

- 현재 사용자용 파일은 `src-tauri/target/release/chiispace.exe`와 `chiispace-cli.exe`다.
  현재 열린 사용자 창에는 교체 전 코드가 남아 있다. 사용자가 다음에 앱을 켤 때 수정판이 적용된다.
  다음 교체 때도 최신 변경·실행 여부·백업을 확인한다. 검증용 경로를 새 실행 위치로 안내하지 않는다.
- 칸 사이 협업, Codex 서브에이전트 상세 화면, 이미지 입력·로그인 UI, TUI 전용 메뉴는 이번 범위 밖이다.
- 선택지 검증은 격리 config에서 `default_mode_request_user_input`을 켰다. 제품은 이 개발 중 기능을 강제로 켜지 않고,
  CLI가 실제로 요청을 보내면 처리한다. 모든 버전·모드에서 모델이 질문 도구를 쓸 수 있다고 보장하지 않는다.
- 유료 실모델·사용자 실사용, 모든 승인 변형·추가 권한 요청·`/compact`의 실제 서버 동작은 별도 검증 범위다.
- 기존 PTY Codex의 훅·메뉴 문제는 아래 과거 인계 범위로 남는다. 새 칸 검증 성공을 기존 PTY 해결로 확대하지 않는다.
- 캐릭터 보강은 요청 전까지 착수하지 않는다.

## 아래는 이전 훅 기반 배포판의 기록

아래의 “현재”와 “다음”은 9월 28일 훅 기반 판을 가리킨다. 새 대화 칸의 구현 지시는 위 9월 29일 인계가 우선한다.

기준: 2026-09-28. Claude의 `473de39` 위에 Codex 소스를 별도 보존했고, 사용자 요청으로 `a10454a` 기준 앱·CLI를
02:22:33에 고정 경로에 반영했다. 이 문서는 훅 기반 구현의 검증 범위와 남은 작업을 인계한다.
Codex 대화창의 기본 흐름은 실제 앱에서 회귀 검증했지만, 실제 모델 변경·`/status` 후 연속 대화는 아직 미검증이다.

## 사용자 최신 결정

- Claude처럼 Codex도 메신저식 대화창을 쓰는 방향이다.
- `/hooks`에서 처음 한 번 신뢰하는 방식을 제안했으나, 사용자는 **추가 신뢰 확인 없는 방식부터 검토**하라고 했다.
  훅 신뢰 우회 플래그, 신뢰 DB 자동 변경, 관리 정책으로 위장하는 방식은 쓰지 않는다.
- **exe 빌드·교체는 사용자가 다시 말할 때만 한다.** 이번에는 사용자가 다시 요청해 빌드·교체했다.
  기존 앱·CLI는 `src-tauri/target/release/backups/before-codex-chat-20260928-022233`에 보관했다.
- 사용자는 `/model`·`/status`를 본 뒤에도 안 깨지는지 물었다. 답변은 “아직 전체 검증 전”이었다.
- 핸드오프 작성 후 사용자가 Codex 작업의 커밋·푸시와 결과 보고, 이어서 exe 빌드를 요청했다.
- 캐릭터 보강은 사용자가 요청할 때만 한다.

## 현재 코드와 대안의 차이

**소스에는 아직 훅 기반 실험 코드가 남아 있다. `notify` 전환은 구현하지 않았다.**
`launch.rs`는 대화형 로컬 Codex에 7개 lifecycle hook을 주입한다. 이 상태를 그대로 빌드·배포하면
신뢰 검토가 필요한 훅 경고가 생길 수 있다. `notify` 검증 성공을 이 코드의 성공으로 취급하지 않는다.

현재 구현은 로컬 Codex CLI를 PTY에서 그대로 돌리고, 정확히 확인한 대화 파일을 읽어 터미널 위에
`ChatPane`을 얹는다. 터미널 제거·원격 TUI 중계·헤드리스 CLI 전환은 하지 않았다.
복원은 **`codex resume --last`** 그대로다. 채팅 표시용 ID를 복원 ID로 저장하거나 최근 파일을 추측하지 않는다.

### 훅 기반 실험에서 만든 부분

- `codex_chat_hook.rs`: SessionStart·UserPromptSubmit·Stop·PermissionRequest·PostToolUse·Interrupt·SessionEnd.
  훅 본문의 대화 ID·경로·작업 폴더·이벤트 이름만 읽는다. 프롬프트·답변 원문을 IPC에 복제하지 않는다.
- CLI `codex-chat-hook` → 실행별 토큰으로 인증하는 `chiispace.codex_chat` → 메모리의 `CodexBinding.chat`.
- `codex_chat.rs`: 현재 pane/run/id를 확인한 뒤 해당 `CODEX_HOME`의 정확한 파일만 읽는다.
  경로 canonicalize·저장소 내부 여부·파일명 UUID·첫 session_meta ID를 확인한다. 마지막 8MiB만 읽는다.
  ID를 이미 받은 뒤 파일을 찾는 것이며, 최신 파일로 대화를 고르는 기능은 아니다.
- `codex-transcript.ts`: 사용자/답변 중복 제거, 환경 지침 제외, 공개 생각 요약, 도구 호출·결과 짝,
  토큰·시간·중단·되돌리기. 암호화된 추론은 표시하지 않는다. 알 수 없거나 아직 덜 쓰인 줄은 건너뛴다.
- 완료된 메시지 단위로 갱신한다. **Claude와 같은 글자 단위 스트리밍은 아직 아니다.**
- `pane_agent.rs`: `chiispace-cli → node → codex` 같은 알려진 실행기 사슬을 인식한다.
  기존 엔진은 continue 실행기 아래의 Codex를 놓쳐, 복원된 대화 정보가 있어도 대화창을 숨기고 있었다.
- `pty_submit`: 기대한 에이전트·실행 토큰·대화 ID와 승인 대기 상태를 확인한다.
  전송 판단에는 캐시 대신 새 프로세스 조회를 쓴다. 이 마지막 보강은 실제 앱 재검증이 남았다.
- Claude의 스트림과 서브에이전트 진행 표시는 유지한다. Codex는 Claude의 `chat:live`·`chat:sub`에 연결하지 않는다.

### 신뢰 확인 없는 `notify` 후보: 격리 검증 통과

공식 `notify`는 `agent-turn-complete` 때 외부 프로그램에 JSON을 전달하며 `thread-id`를 포함한다.
[공식 알림 문서](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications),
[훅 신뢰 규칙](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)을 확인했다.

설치된 Codex **0.154.0**과 기존 배포 exe로 검증했다. 별도 `CODEX_HOME`·앱 상태·프로젝트·로컬 가짜 Responses
서버를 썼다. `/hooks` 조작이나 신뢰 우회 없이 다음 3개 턴의 알림을 받았다.

1. 새 대화 첫 답변 뒤 정확한 대화 ID 수신.
2. `/new` 뒤 답변에서 다른 대화 ID 수신.
3. 앱 재시작의 네이티브 이어가기 뒤 답변에서 2번과 같은 ID 수신.

증거는 로컬 임시 파일이다. 지워질 수 있으므로 제품 회귀 테스트로 옮겨야 한다.

- 스크립트: `C:/Users/kshkj/AppData/Local/Temp/chiispace-notify-check.mjs`
- 결과: `C:/Users/kshkj/AppData/Local/Temp/chiispace-notify-check-F1kmwk/notices.jsonl`
- 알림 기록에는 이벤트 종류·대화 ID·폴더·필드 이름만 저장했다. 사용자 대화나 인증을 가져오지 않았다.

제약과 미검증:

- 시작·재시작 직후에는 알림이 없다. **첫 답변이 끝나야 연결할 ID가 온다.**
- 승인 요청·작업 시작·중단 이벤트를 주는 방식이 아니다. 기존 훅의 busy/waiting을 그대로 대신할 수 없다.
- 기존 사용자 `notify`와 CLI/프로필 설정을 보존하는 제품 연결 방식은 아직 구현·검증하지 않았다.
  알림 JSON에는 입력·답변도 들어오므로 원문 로그나 추가 영구 저장을 만들지 않는다.
- 이 실험은 ID 수신 가능성 검증이다. `notify`로 실제 대화창 표시·전송·메뉴 복귀까지 된 것은 아니다.
- 앞서 MCP 초기 연결과 TUI 기록 파일도 조사했지만, 설치된 버전에서 신뢰할 만한 시작 ID 전달 경로를
  확보하지 못했다. 이를 확인된 대안으로 안내하지 않는다.

## `/model`·`/status` 상태를 정확히 구분

현재 Codex 분기는 메뉴 명령을 PTY에 보낸 뒤 터미널로 전환한다. `/model`·`/status`는
**사용자가 머리줄의 ‘대화로’를 눌러 돌아오는 방식**이다. Claude의 파일 크기 변화 기반 자동 복귀를
Codex에 그대로 적용하지 않았다. `/new`·`/clear`는 새 대화 ID 도착을 이용하는 별도 흐름이다.

| 항목 | 확인 상태 |
|---|---|
| `/model` 열기 → Esc 취소 → ‘대화로’ → 입력바 포커스 | 훅 기반 격리 앱에서 확인 |
| 모델을 실제로 바꾼 뒤 후속 질문·응답·선택 모델 유지 | 미검증 |
| `/status` 표시 뒤 복귀·후속 입력·응답 | 대화창과 합친 흐름은 미검증 |
| 메뉴가 열린 상태에서 조기 복귀·승인 질문·연속 메뉴 | 미검증 |
| `notify` 전환 뒤 위 흐름 전체 | 전환 자체가 미구현 |

예전 Codex 스크롤 검증의 `/status` 6회 통과는 대화창 복귀 검증을 대신하지 않는다.

## 테스트 기록과 남은 실패

- `a10454a` 기준으로 `npm test` **91 통과·16 건너뜀·실패 0**, `npm run build`, 내부 Rust release 빌드를 통과했다.
  Rust는 lib 33개·CLI 11개가 통과했고, 내부 Codex 실제 앱 검증과 고정 경로 재검증도 완료했다.
- 9월 28일 중간 스냅샷 `npm test`: **91 통과, 16 건너뜀, 실패 0**.
  Codex 파서 4개와 도구 요약 검증을 포함한다. 뒤에 들어온 모든 Claude 수정까지 검증한 수치는 아니다.
- 중간 스냅샷 Rust: **lib 33개 + CLI 11개 통과**. 일부 Claude 서브에이전트 테스트 포함.
  이후 추가한 전송 시 새 프로세스 조회·대화 ID/승인 상태 가드까지 재검증한 수치는 아니다.
- TypeScript·Vite와 내부 release 앱·CLI 빌드는 사용자 빌드 보류 지시 전에 통과했다.
  마지막 내부 파일 시각은 앱 9/28 01:29:41, CLI 01:29:42. 이후 수정과 일치한다고 가정하지 않는다.
- `scripts/codex-chat.test.mjs`는 내부·고정 경로 exe에서 모두 통과했다.
  두 칸 대화 격리, 한글 여러 줄 전송, `/new`, `/model` 취소·복귀, 재시작 후 기존 대화 표시와 종료 직후 전송 거부를 확인했다.
- 초기 실패 자료는 `C:/Users/kshkj/AppData/Local/Temp/chiispace-codex-chat-8zMD8v/`에 남아 있다.
  `failure.json`의 `latest`에 셸로 흘러간 입력, `codex-chat.png`에 두 칸 대화창이 있다.
  같은 실행에서 사용자 세션 해시 차이도 검출돼 finally의 검사가 원래 오류를 가렸다.
  사용자 앱 정상 저장 등 외부 변경과 테스트 쓰기를 구분해야 하며, 데이터 보호 검사 자체를 빼지 않는다.
- `codex-resume.test.mjs`에는 칸마다 다른 옵션의 복원 명령을 같다고 비교하는 기존 실패가 관찰됐다.
  테스트 기대와 각 칸의 설정을 대조해야 한다. 통과를 위해 권한 옵션이나 continue 정책을 바꾸지 않는다.

## 동시 작업과 파일 소유

앞선 인계 때 섞여 있던 Claude의 서브에이전트 상세 대화창 변경은 **`473de39`로 커밋됐다**.
`Chat.tsx`, `lib.rs`, `CLAUDE.md`, `WORKLOG.md`에 남은 diff가 Codex 것뿐인 것을 확인했다.
이번에는 아래 Codex 파일을 경로별로 스테이징한다. 재개할 때는 새 변경이 없는지 다시 확인한다.

- Codex 신규: `src-tauri/src/codex_chat.rs`, `codex_chat_hook.rs`, `pane_agent.rs`,
  `ui/codex-transcript.ts`, `scripts/codex-chat.test.mjs`, `scripts/codex-transcript.test.mjs`.
- Codex 변경: `src-tauri/src/bin/chiispace-cli.rs`, `bridge.rs`, `collab.rs`, `launch.rs`,
  `ui/App.tsx`, `ui/session.ts`, `ui/tools.ts`, `scripts/tools.test.mjs`.
- Codex 변경이 남은 공유 파일: `ui/Chat.tsx`, `src-tauri/src/lib.rs`, `CLAUDE.md`, `docs/WORKLOG.md`.
  Claude의 SubagentView 연결과 `claude_subagents`·`claude_subagent_raw/size` 등록은 이미 HEAD에 있다.
- `473de39`에 포함된 별도 Claude 작업: `ui/SubagentView.tsx`, `ui/SubAgents.tsx`, `ui/chat.css`, `ui/transcript.ts`,
  `src-tauri/src/workspace.rs`, `scripts/chat-sub.test.mjs`, `scripts/chat-view.test.mjs`, `scripts/transcript.test.mjs`.
  이미 커밋된 내용을 Codex 변경으로 다시 세지 않는다. 커밋됐다는 사실을 exe 배포로 확대하지 않는다.
- 이 Codex 대화창 작업은 `01c806a`에 보존됐고 고정 경로 배포까지 완료됐다. 실제 모델 변경·`/status` 연속 대화와
  `notify` 전환은 후속 범위다. `72c6749`는 앞선 배포 문서 커밋이다.

## 후속 구현 요청 때의 순서

1. `git status`와 공유 파일 diff를 확인하고 Claude의 작업 상태를 다시 맞춘다.
2. `notify`의 첫 답변 완료 후 연결이라는 제약을 유지할지 확인한다. 기존 알림·권한·프로필·continue를
   보존할 설계를 정한 뒤 훅 의존을 교체한다. 신뢰 없이 쓸 수 있다고 해 놓고 훅 주입을 남기지 않는다.
3. 승인/질문/메뉴 동안 입력이 잘못 전달되지 않게 하고, 실패한 제출은 초안을 보존한다.
4. 모델 실제 변경, `/status`, 메뉴 취소·반복·한글 입력, 다음 응답, `/new`, 재시작, 다른 칸 격리,
   종료 직후 전송 거부를 **선택한 최종 연결 방식으로** 검증한다. 모델 요청은 로컬 대역을 쓴다.
5. Claude `chat-view`·`chat-live`·`chat-sub`, 입력·잔상·칸 이름·협업 회귀도 합쳐 확인한다.
   빌드가 필요한 시점에는 사용자 보류 지시를 먼저 확인한다. 테스트 중 같은 exe를 덮어쓰지 않는다.
6. 사용자가 배포를 다시 요청한 뒤에만 앱·CLI·세션 메타데이터를 백업하고, 앱이 닫힌 것을 확인해
   고정 경로 `src-tauri/target/release/chiispace.exe`와 `chiispace-cli.exe`를 함께 교체한다.
   내부 `target/input-render/release`를 사용자 실행 경로로 안내하지 않는다. 사용자 앱을 임의 종료하지 않는다.

읽을 순서: 이 문서 → [CLAUDE.md](../CLAUDE.md)의 회귀 방지 규칙 →
[README](../README.md#헤드리스-검증)의 격리 검증법. 과거 구현 이력은 [WORKLOG](WORKLOG.md)에 있다.
