# 세션이사 다음 조각 — 설계 메모 (11월 22일 밤)

세션이사 1단계(Claude 대화창 칸)는 이미 있다 — 만든 경위와 검증은 [작업 정리 45절](WORKLOG.md#45-11월-19일20일-추가-세션이사--다른-pc-로-대화창-칸-옮기기),
기기 묶음은 [46절](WORKLOG.md#46-11월-22일-추가-기기-묶음--노트북데스크톱폰을-한-번에-잇기). 이 메모는 그 위에 남은 범위
(45절 끝 "Codex 칸 이사, 권한 모드·모델을 같이 옮기기는 남은 범위다", 옆칸 "Claude 대화창 칸만 옮긴다")를 어떻게 붙일지 정리한다.
코드는 아직 고치지 않았다. 아래 "물어볼 것"에 대장이 답하면 그 순서대로 조각을 낸다.

## 1. 지금의 길 (고칠 자리를 찾기 위한 지도)

| 단계 | 자리 | Claude 에 묶인 곳 |
|---|---|---|
| 놓을 수 있나 | `session-move.ts` `moveLock`·`setMovable`, 칸은 `ClaudeStreamPane.tsx` 만 적는다 | `setMovable` 을 부르는 칸이 하나뿐 → 나머지 칸은 `pcNote` 가 "Claude 대화창 칸만" |
| 꾸러미 | `session_move.rs` `session_move_pack` | `claude_files::session_file` 로 `<id>.jsonl`·`<id>/` 를 찾는다 |
| 보내기 | `MoveCard.tsx` → `remote_peer_key` → `callOnce(..."session_move_offer")` | `moveOffer` 가 `agent: "claude"` 를 박는다 |
| 받기 검사 | `session_move.rs` `offer` | `v == 1 && agent == "claude"` 아니면 거절, `safe_rel` 이 `<id>.jsonl`·`<id>/…` 만 받는다 |
| 파일 쓰기 | `write_files` | `claude_home/projects/<project_dir(cwd)>` 또는 이미 있는 같은 id 자리 |
| 새 칸 | `MoveOffer.tsx` `onOpen(MovedIn)` → App 이 새 탭의 Claude 대화창 | `MovedIn` 에 에이전트 종류가 없다 |

받는 쪽이 `agent != "claude"` 를 이미 "이 판이 모르는 꾸러미"로 거절하므로, 꾸러미 판(`v`)을 올리지 않고 `agent` 만 늘려도
옛 판 받는 PC 는 깔끔히 거절한다. 보내는 쪽은 그 글을 그대로 보이면 된다(`moveFailure` 의 일반 실패 길).

## 2. 남은 조각과 추천 순서

### 조각 A — 모델·추론 같이 옮기기 (작다, 먼저)

- 꾸러미에 `settings: { model?, effort? }` 를 덧붙인다(옛 받는 PC 는 모르는 키를 무시하므로 `v` 그대로).
- 받는 쪽 `MovedIn` 에 실어 새 대화창 칸의 첫 상태로 쓴다. 추론은 지금처럼 `apply_flag_settings`(이 세션에만 거는 층)로 건다 —
  사용자 설정 파일을 고치지 않는 규칙 그대로.
- 받는 PC 의 claude 가 그 모델을 모르면(판 차이) 조용히 기본으로 두고 한 줄 알린다. 실패로 이사를 막지 않는다.
- **권한 모드는 일부러 뺐다** — 아래 물어볼 것 1.

### 조각 B — Codex 대화창 칸 이사 (크다, 확인부터)

Claude 와 다른 점이 셋이고, 셋 다 격리 `CODEX_HOME` 으로 먼저 실험해 확인해야 한다(추측으로 짜지 않는다).

1. **파일 자리.** Codex 대화(rollout)는 폴더별이 아니라 날짜별(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<시각>-<id>.jsonl`)로 쌓인다.
   - 확인할 것: 받은 PC 의 `sessions/` 에 그 파일을 같은 상대 자리로 놓기만 하면 `thread/resume <id>` 가 찾는가.
     판에 따라 대화 목록을 따로 색인해 두는 파일(상태 DB)이 있으면 파일만 놓아서는 안 보일 수 있다. 그 색인을 앱이 고쳐 쓰는 것은
     "전역 설정·훅 신뢰 DB 를 고치지 않는다" 규칙과 부딪히므로, 안 보이면 이 조각은 멈추고 대장에게 다시 묻는다.
   - `safe_rel` 은 에이전트별로 나눈다. Codex 는 `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` 한 모양만 받는다(숫자·길이까지 맞춤).
2. **폴더.** 지금 Codex 칸은 "복원은 서버가 저장한 현재 폴더를 따른다"(`CodexStreamPane.tsx`). 두 PC 의 레포 경로가 다르면
   (데스크톱 `C:\chiiOS` · 노트북 `C:\Users\…\chiiOS`) 받는 PC 에서 없는 폴더로 열린다.
   - 확인할 것: app-server `thread/resume` 이 폴더 덮어쓰기 값을 받는가. 받으면 받는 PC 가 고른 폴더(`autoFolder`/[받기])를 그 값으로 준다.
     못 받으면 rollout 첫 줄(session_meta)의 폴더를 고쳐 써야 하는데, 이는 "안의 경로를 고쳐 쓰지 않는다"는 지금 원칙을 깨는 일이라
     따로 묻는다.
3. **자식 대화.** Codex 서브에이전트는 별도 rollout(별도 id)이다. 부모만 옮기면 받는 PC 에서 자식 전체 보기가 빈다.
   - 꾸러미에는 그 실행의 서버가 부모의 자식이라고 알려 준 id(`codex_stream.rs` `record_children` 의 `readable`)만 싣는다.
     파일을 뒤져 자식을 추측하지 않는다(대화 고르기 규칙과 같은 이유). 다시 켠 칸이라 `readable` 이 비었으면 부모만 보낸다.

나머지는 Claude 길을 그대로 쓴다.

- 잠금(`moveLock`): 턴 중(`busy`)·자식이 도는 중·`unstarted`(첫 전송 전, rollout 이 아직 없음)·승인 카드 대기 중.
- 덮지 않기: `relation` 을 그대로 쓴다(rollout 도 줄을 덧붙이기만 한다). 같은 id 가 이 PC 에 있으면 그 자리에 쓴다.
- 이름: Codex 칸 이름은 `paneTitles` 에만 있다(`thread/name/set` 을 안 보낸다). 꾸러미 `title` 로 넘기고 받는 쪽도 `paneTitles` 에 적는다.
- 받는 칸: `MovedIn` 에 `agent` 를 더해 App 이 Codex 대화창(`streams` 의 `agent: "codex"`, `session` = 받은 id, `unstarted: false`)으로 연다.
  받는 PC 의 app-server 가 그 id 를 `no rollout found` 로 거절하면 빈 대화로 덮지 않고 실패로 보인다(`missingUnstarted` 는 `unstarted` 가 거짓이라 이미 그렇게 된다).
- 보낸 칸: 받았다는 답 뒤에 `codex_stream_stop` 으로 거두고 닫는다. 두 PC 는 서로 다른 app-server 라 "active writer" 충돌은 없다.

### 조각 C — 터미널 칸 (보류 추천)

터미널 칸은 TUI 가 대화 파일을 쥔 채이고 "일하는 중"을 앱이 정확히 모른다. 그래서 바로 옮기지 않고, PC 에 놓으면
"머리줄 [대화창]으로 바꾼 뒤 옮긴다"고 `pcNote` 에 까닭만 보이는 것을 추천한다. 대화창을 메인으로 가는 방향과도 맞다.

### 조각 D — 실제 두 PC 확인 (대장 손이 필요)

자동 검증은 Node 흉내 받는 PC 까지다. 노트북 ↔ 데스크톱으로 한 번:
[PC 잇기] → 노트북 칸을 끌어 데스크톱에 놓기 → 데스크톱에서 묻지 않고 새 탭 → 한 마디 → 다시 노트북으로 되돌리기(`behind` 길) →
양쪽에서 한 마디씩 한 뒤 옮기기(`split` 길, `before-move-*` 파일 남는지).

## 3. 대장에게 물어볼 것

1. 권한 모드도 같이 옮길까? 묻지 않기(bypass)까지 넘기면 짝지은 PC 가 받는 PC 에 "묻지 않는 칸"을 여는 셈이다.
   추천: 모델·추론만 옮기고 권한은 받는 PC 의 기본을 따른다. 넘기고 싶으면 "받는 PC 기본보다 넓으면 [받기] 창에서 한 번 묻기".
2. Codex 이사가 rollout 첫 줄의 폴더를 고쳐 써야만 된다고 확인되면 그래도 할까, 아니면 "같은 경로의 레포일 때만" 옮길까?
3. 조각 순서 A → B(먼저 격리 실험만) → C 문구로 가도 될까?

## 4. 검증 계획

- A: `session-move.test.mjs` 에 `moveOffer` 의 `settings`, 실기 `session-move` 에 받은 칸의 모델 표시.
- B: Rust 단위(`safe_rel` Codex 모양·날짜 자리 거절), 격리 `CODEX_HOME` 두 개로 보내기·받기·`thread/resume` 실기.
  사용자 `~/.codex` 는 쓰지도 읽지도 않는다(검증 규칙 24번과 같은 이유).
