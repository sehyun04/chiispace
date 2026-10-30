# Codex 대화창 따라잡기 — 남은 인계

2026-10-30, 설치된 Codex CLI 0.164.0 기준. 완료한 구현은 WORKLOG 31~34절에 기록했다.
배포 상태는 docs/DEPLOYS.md를 따른다. 이번 작업에서는 사용자용 exe를 교체하지 않는다.
최종 격리 빌드의 전체 JS 154개·Rust 46개가 모두 통과했다. 실제 앱 검증 건너뜀은 없다.

## 완료한 것

- 대화창 → 터미널: `3744b17`. 전송한 대화는 서버 ID로 이어 열고 미전송 대화는 새 CLI로 연다.
  작업 중에는 잠그며 되돌린 칸은 재시작 뒤에도 터미널로 남는다.
- 터미널 현재 ID 조사: `e1c0d82`. 아래 두 전환은 근거 부족으로 보류했다.
- 서브에이전트 진행 줄·대화 보기: `c6c499f`. 부모와 자식 수명·내용을 나눠 표시하고 공용 행·상세 틀을 쓴다.
  서버가 이 칸의 자식으로 알려 준 ID만 읽는다. 실제 이벤트 fixture와 격리 실앱 검증이 있다.
- 조회 명령과 일반 턴 명령: `/mcp`, `/skills`, `/diff`, `/pwd`(`/cwd`), `/usage`, `/warnings`,
  `/agents`(`/subagents`), `/copy`, `/init`, `/recap`. 대조표와 검증은 WORKLOG 34절을 본다.
  모델·추론·권한·상태·새 대화는 계속 공용 `barCommands`에서 만든다.

## 남은 일 1 — 터미널 → 대화창, 켤 때 자동 전환

0.164.0에서 칸의 현재 ID와 대화 변경을 함께 계속 알려 주는 경로를 찾지 못했다(WORKLOG 32절).
역방향 단추는 풀이와 함께 잠겨 있고, Codex 터미널 칸을 켤 때 자동 대화창으로 옮기지 않는다.

조사한 경로:

- MCP `tools/call`의 `_meta.threadId`는 현재 ID지만 도구 호출 없는 `/new`·`/resume`·`/fork` 뒤에는 갱신이 오지 않는다.
- `CODEX_THREAD_ID`는 도구 실행 자식 환경에 넣는 값으로, TUI 자체의 PID별 명부가 아니다.
- legacy `notify`는 답이 끝난 뒤에만 온다. 기존 사용자 notify를 덮지 않았으며 입력·답 원문도 기록하지 않았다.
- OSC 상태는 ID를 주지 않고, 터미널 제목의 session-id는 32자로 잘려 전체 UUID가 아니다.
- 대화창에서 옮길 때 앱이 알았던 ID도 TUI에서 대화가 바뀌면 낡는다.

재개 조건은 그 칸의 Codex가 현재 ID를 스스로 알려 주고, 대화가 바뀔 때 따라 갱신되는 경로를 찾는 것이다.
`thread/list`·최근 rollout·`resume --last` 결과로 ID를 추측하지 않는다. 훅·원격 TUI 중계도 되살리지 않는다.
이 조건이 충족된 뒤에만 `usePaneAgents`·`saved`·`session`을 넓히고 켤 때 자동 전환을 구현한다.

## 남은 일 2 — 별도 실행·대화 생성 명령

`/review` → `review/start`, `/fork` → `thread/fork`는 기존 허용 목록에 없고 실행·대화 생성을 한다.
10월 30일 사용자에게 두 명령을 추가할지 선택을 요청했다. 답이 없으면 승인으로 간주하지 않는다.
현재 두 메서드는 계속 차단돼 있으며 명령 목록에도 없다.

추가 허용을 받으면 설치된 스키마로 요청·결과를 확인하고, 생성·검토 결과가 현재 대화를 임의로 덮지 않게 구현한다.
검증은 별도 `CODEX_HOME`·합성 대화·로컬 Responses 서버로만 한다.

## 남은 경계

- 설정 쓰기·권한 확대·훅 신뢰·전역 config 변경은 하지 않는다. TUI 명령별 판단은 WORKLOG 34절 표에 있다.
- `/recap`은 현재 대화에 일반 요약 요청을 보내는 구현이다. TUI의 별도 내부 recap 실행과 구별한다.
- 자식의 모든 승인·질문 변형 처리, 이미지 입력, 칸 사이 협업, 옵션창, 앱 안 로그인은 이번에 완료한 범위가 아니다.
- 자동 검증은 합성 대화와 가짜 서버다. 사용자 실사용·유료 실모델 확인을 대신하지 않는다.

## 재개할 때

CLAUDE.md 전체와 README의 헤드리스 검증·엔진 절을 먼저 읽고 `git status --short`를 확인한다.
검증은 `node scripts/test.mjs --build`로 격리 빌드와 실제 앱까지 실행한다. Rust는 별도 검증한다.
검증용 target/test-build는 사용자 실행 위치가 아니다. 배포는 사용자가 말할 때 `scripts/deploy.mjs`만 쓴다.

파일 영역:

- 터미널 ID·전환: `launch.rs`·`collab.rs`·`codex_session.rs`·`usePaneAgents.ts`·`useStreams.ts`·`saved.ts`·`session.ts`.
- Codex 대화창·명령: `CodexStreamPane.tsx`·`codex-stream.ts`·`codex-commands.ts`·`codex_stream.rs`.
- 자식 상세: `CodexSubagents.tsx`, 공용 `SubAgents.tsx`·`SubagentView.tsx`·`Chat.tsx`.
- `App.tsx`는 조립만 추가한다. 옵션창·`SplitPicker.tsx`·배포 기록은 건드리지 않는다.
- 일마다 따로 커밋·푸시하며 `git add -A`는 쓰지 않는다. 남의 변경은 보존한다.
