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
| `kasa-pty` (rev 고정) | `src-tauri/src/lib.rs` — PTY ↔ 웹뷰 다리 |
| | `ui/Term.tsx` — xterm.js 배선 |
| | `ui/App.tsx`, `ui/app.css`, `ui/theme.css` — 워크스페이스 껍데기 |

## 실행

```powershell
npm install
npm run tauri dev
```

## 테마

`ui/theme.css` 한 파일이 색의 전부다. 값은 upstream 의 `theme-src-chiikawa/roster.json`
에서 왔다 — 그건 색 테마가 아니라 **캐릭터 로스터**(21명, 페르소나 + `header_color`)이고,
`desc.txt` 가 말하는 외형("순백 서양배 모양 몸 · 두꺼운 따뜻한 갈색 테두리 · 분홍 볼터치")이
곧 UI 규칙이다. 그래서 이건 어두운 터미널이 아니라 **밝은 터미널**이다. 의도된 것이다.

UI 폰트는 Galmuri11(OFL, `ui/assets/`). 터미널 글자는 시스템 등폭.

## 헤드리스 검증

```powershell
$env:KASASPACE_AUTOSEND = "dir /w"      # 이 문자열 + Enter 를 터미널에 주입
$env:KASASPACE_AUTOSEND_MS = "4000"
scripts\shot.ps1 -Out shot.png
```

`KASASPACE_AUTOSEND` 는 웹뷰의 `term.input()` 을 부른다. 사용자가 키를 친 것과 **같은
경로**(`onData` → `pty_write`)를 타므로 배선 전체가 검증된다.

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

⚠️ 로컬 kasaterm 클론의 `main` 은 upstream 과 크게 갈라져 있다. 엔진 API·LFS·테마를 확인할
때 로컬 파일을 보면 **없는 것처럼 보인다**. `git show origin/main:<경로>` 로 봐야 한다.

## 지금 되는 것

셸 한 장이 뜨고, 타이핑이 들어가고, 출력이 그려지고, 한글이 정상으로 나온다.
사이드바에 로스터가 뜨고 색이 캐릭터별 `header_color` 를 따른다.

## 아직 안 되는 것

- **파일트리** — 사이드바에 자리만 잡혀 있다. 다음 차례
- **git 상태** — 파일트리에 붙을 뱃지
- **pane 분할** — `kasa_pty::layout` 에 BSP 트리(`split_leaf`/`leaf_rects`/`dividers`)가 이미 있다
- **pane 간 에이전트 연결** — 이 레포의 본론
- 캐릭터 스프라이트 — `desc.txt` 만 있고 이미지는 아직 없다

## 라이선스

MIT. `kasa-pty` 는 kasaterm 것(MIT). Galmuri11 은 OFL(`ui/assets/OFL-Galmuri.txt`).
