# kasaspace

터미널을 한 칸으로 두는 작업환경.

**터미널은 만들지 않는다.** PTY 생성·VT 파싱·GPU 셀 렌더링은 전부
[2rami/kasaterm](https://github.com/2rami/kasaterm) 의 엔진 크레이트를 그대로 당겨 쓴다.
이 레포의 코드는 그 위에 올라가는 것 — 배치, 파일, git, 에이전트 배선 — 만 갖는다.

| 남의 것 (git 의존성) | 하는 일 |
|---|---|
| `kasa-pty` | `PtySession::start()` — 셸을 진짜 PTY 로 띄우고(Windows 는 ConPTY) 바이트를 VT 파서에 먹여 화면 스냅샷을 뱉는다 |
| `kasa-cells` | wgpu 셀 렌더러. 글리프를 아틀라스에 한 번 굽고 셀당 인스턴스 하나로 그린다 |
| `kasa-bridge` | `ScreenUpdate` / `Cell` / `Color` 공용 타입 |

| 우리 것 | 하는 일 |
|---|---|
| `src/main.rs` | 창 · 이벤트 루프 · PTY 와 렌더러 배선 |
| `src/render.rs` | wgpu 표면 + `Grid` 한 장을 인스턴스 배열로 펴기 |
| `src/grid.rs` | diff(`ScreenUpdate`)를 덮어써 "지금 화면"을 유지 + 256색 팔레트 |
| `src/keys.rs` | 키 -> PTY 바이트 |

## 실행

```
cargo run --release
```

폰트는 Windows 는 Consolas(+ 맑은 고딕·이모지 폴백), macOS 는 Menlo 를 기본으로 잡는다.
`KASASPACE_FONT` 로 주 폰트를 바꿀 수 있다. **등폭이어야 한다** — 셀 폭을 글자 하나로 재기 때문에
가변폭을 물리면 격자가 통째로 어긋난다.

## 헤드리스 검증

창에 포커스를 주지 않고 입력·종료까지 돌린다. OS 로 키를 쏘는 방식(SendKeys 류)은
**포커스가 다른 창에 있으면 엉뚱한 앱에 타이핑된다** — 그래서 앱 안에 손잡이를 뒀다.

```powershell
$env:KASASPACE_AUTOSEND    = "dir /w"   # 이 문자열 + Enter 를 PTY 에 주입
$env:KASASPACE_AUTOSEND_MS = "2500"     # 몇 ms 뒤에 (기본 2000)
$env:KASASPACE_AUTOQUIT_MS = "8000"     # 몇 ms 뒤에 스스로 종료
cargo run --release
```

## 엔진을 같이 고칠 때

`Cargo.toml` 아래쪽 `[patch]` 블록의 주석을 풀면 git 대신 옆 폴더의 kasaterm 작업 트리를 쓴다.
커밋·push 없이 즉시 반영된다.

엔진 rev 는 일부러 박아 뒀다. upstream `main` 은 활발히 움직이고, 엔진이 말없이 바뀌면
여기가 깨진다. 올릴 때는 의도적으로 올린다.

## 지금 되는 것

셸 한 장이 뜨고, 타이핑이 들어가고, 출력이 그려지고, 창 크기를 바꾸면 PTY 가 따라온다.
색(256색·truecolor·bold/dim/inverse), 커서 블록, 한글·이모지 폴백, OSC 타이틀.

## 아직 안 되는 것

- **pane 분할** — 다음 단계. `kasa_pty::layout` 에 split 트리가 이미 있다
- **스크롤백** — `PtySession::scroll()` 이 있는데 아직 휠에 안 물렸다
- **마우스** — 클릭·드래그 선택·복사 붙여넣기 전부 없음
- **한글 조합 중 표시** — IME preedit 을 화면에 안 그린다. 확정(commit)돼야 보인다
- **와이드 글자 간격** — 한글이 2칸 슬롯 안에서 살짝 성기게 보인다
- 파일트리 · git · 에이전트 배선 — 이 레포의 본론인데 아직 시작 안 함

## 라이선스

MIT. 엔진 크레이트는 kasaterm 것이고 각각 MIT / MIT OR Apache-2.0 이다.
