//! PTY 를 웹뷰로 잇는 다리.
//!
//! 화면을 그리는 건 프론트의 xterm.js 다. 여기서는 셸의 **원시 바이트**를 그대로
//! 흘려보내기만 한다 — `kasa_pty` 가 이미 파싱한 셀 그리드가 아니라. 그래야 받는
//! 쪽이 우리 내부 구조에 묶이지 않고, 엔진도 이 용도를 상정하고 만들어져 있다
//! (`tap_bytes_with_snapshot` 주석 참고).

mod shells;
mod workspace;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use kasa_pty::{PtyOptions, PtySession};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct Panes(Mutex<HashMap<String, Arc<PtySession>>>);

#[derive(Clone, serde::Serialize)]
struct PtyChunk {
    id: String,
    /// base64 로 싣는다. 청크 경계에 부분 UTF-8 시퀀스가 걸려도 바이트가 상하지 않는다.
    b64: String,
}

fn chunk(id: &str, bytes: &[u8]) -> PtyChunk {
    PtyChunk {
        id: id.to_string(),
        b64: B64.encode(bytes),
    }
}

#[tauri::command]
fn pty_open(
    app: AppHandle,
    panes: State<Panes>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    // 없으면 엔진 기본(%ComSpec%). 목록에 있던 셸이 지워졌거나 다른 컴퓨터에서
    // 만든 세션을 열면 여기 없는 경로가 들어오는데, 그때는 엔진이 실패를 돌려
    // 주고 프론트가 그 칸에 빨간 줄로 적는다 — 조용히 다른 셸로 바꾸지 않는다.
    shell: Option<String>,
) -> Result<(), String> {
    if panes.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    let session = PtySession::start(PtyOptions {
        cols,
        rows,
        cwd,
        shell,
        pane_id: id.clone(),
        ..Default::default()
    })
    .map_err(|e| e.to_string())?;
    let session = Arc::new(session);

    // 구독 등록과 현재 화면 채취가 한 번에 끝난다. 둘로 나누면 그 사이 출력이
    // 유실되거나 두 번 그려진다 — 엔진이 그래서 이 함수를 따로 두고 있다.
    let (rx, seed) = session.tap_bytes_with_snapshot();
    app.emit("pty:data", chunk(&id, &seed)).ok();

    let sink = app.clone();
    let pane = id.clone();
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if sink.emit("pty:data", chunk(&pane, &bytes)).is_err() {
                break; // 웹뷰가 사라졌다.
            }
        }
        // 셸이 끝났다고 알린다. 이것을 "배치에서 지워라"로 받을지는 웹뷰가
        // 정한다 — 한꺼번에 여럿이 끝나는 것은 사용자가 닫은 것이 아니라
        // 함께 무너지는 중이므로, 그쪽에서 세어 보고 거른다.
        sink.emit("pty:exit", pane).ok();
    });

    panes.0.lock().unwrap().insert(id, session);
    Ok(())
}

#[tauri::command]
fn pty_write(panes: State<Panes>, id: String, data: String) -> Result<(), String> {
    let map = panes.0.lock().unwrap();
    let Some(s) = map.get(&id) else {
        return Err(format!("없는 pane: {id}"));
    };
    s.send_bytes(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(panes: State<Panes>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = panes.0.lock().unwrap();
    let Some(s) = map.get(&id) else {
        return Err(format!("없는 pane: {id}"));
    };
    s.resize(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_close(panes: State<Panes>, id: String) {
    // Arc 를 떨구면 PTY 도 닫힌다. 리더 스레드는 채널이 끊기며 스스로 끝난다.
    panes.0.lock().unwrap().remove(&id);
}

/// "C-S-d" -> ((ctrl, shift, alt), "d")
fn parse_chord(tok: &str) -> ((bool, bool, bool), &str) {
    let (mut ctrl, mut shift, mut alt) = (false, false, false);
    let mut key = tok;
    loop {
        if let Some(r) = key.strip_prefix("C-") {
            ctrl = true;
            key = r;
        } else if let Some(r) = key.strip_prefix("S-") {
            shift = true;
            key = r;
        } else if let Some(r) = key.strip_prefix("A-") {
            alt = true;
            key = r;
        } else {
            return ((ctrl, shift, alt), key);
        }
    }
}

/// 헤드리스 검증 손잡이. env 가 있을 때만 깨어난다.
///   KASASPACE_AUTOKEYS="C-S-d,C-=" KASASPACE_AUTOSEND="dir"
///
/// 웹뷰의 이벤트/`__term.input()` 을 부른다 — 사용자가 키를 친 것과 같은
/// 경로(onData -> pty_write)를 타므로 배선 전체가 검증된다. OS 로 키를 쏘는
/// 방식(SendKeys)은 포커스가 다른 창에 있으면 **엉뚱한 앱에 타이핑된다**. 한 번 겪었다.
fn arm_autosend(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let ms = |k: &str, d: u64| {
        std::env::var(k)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(d)
    };

    // KASASPACE_AUTOKEYS="C-S-d,C-S-e,C-=" — 단축키를 순서대로 쏜다.
    // 진짜 KeyboardEvent 라 단축키 핸들러부터 그 뒤(배치 트리·새 PTY·리사이즈)까지
    // 제품 경로를 그대로 탄다. 기능마다 env 를 새로 만들지 않으려고 하나로 뒀다.
    if let Ok(spec) = std::env::var("KASASPACE_AUTOKEYS") {
        let start = ms("KASASPACE_AUTOKEYS_MS", 2500);
        let gap = ms("KASASPACE_AUTOKEYS_GAP", 800);
        let w = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(start));
            for tok in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                let (mods, key) = parse_chord(tok);
                let (ctrl, shift, alt) = mods;
                let Ok(k) = serde_json::to_string(key) else { continue };
                let _ = w.eval(&format!(
                    "window.dispatchEvent(new KeyboardEvent('keydown',\
                     {{key:{k},ctrlKey:{ctrl},shiftKey:{shift},altKey:{alt},bubbles:true}}))"
                ));
                std::thread::sleep(std::time::Duration::from_millis(gap));
            }
        });
    }

    // KASASPACE_AUTOMOUSE="sel@dx,dy; sel2@0,0" — 셀렉터가 가리키는 요소의
    // 중앙을 눌러 (dx,dy) 만큼 끌고 놓는다. dx=dy=0 이면 그냥 클릭이다.
    //
    // 마우스는 사용자에게 떠넘길 수밖에 없던 마지막 구멍이었다. 좌표 기반 드래그를
    // 여기서 만들어 두면 경계선·파일트리처럼 키보드로 못 만드는 경로도 제품 코드를
    // 그대로 타면서 검증된다. OS 마우스를 움직이지 않으므로 사용자 창을 건드리지 않는다.
    if let Ok(spec) = std::env::var("KASASPACE_AUTOMOUSE") {
        let start = ms("KASASPACE_AUTOMOUSE_MS", 3000);
        let gap = ms("KASASPACE_AUTOMOUSE_GAP", 700);
        let w = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(start));
            for step in spec.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                let (sel, delta) = step.split_once('@').unwrap_or((step, "0,0"));
                let (dx, dy) = delta.split_once(',').unwrap_or(("0", "0"));
                let Ok(sel) = serde_json::to_string(sel.trim()) else { continue };
                let (dx, dy) = (dx.trim(), dy.trim());
                // 중간 지점을 하나 거쳐야 실제 드래그와 같아진다 — 한 번에 목적지로
                // 뛰면 mousemove 를 한 번만 보게 되어 중간 상태 버그가 안 잡힌다.
                let _ = w.eval(&format!(
                    "(()=>{{const el=document.querySelector({sel});if(!el)return;\
                     const r=el.getBoundingClientRect();\
                     const x=r.left+r.width/2,y=r.top+r.height/2;\
                     const mk=(t,cx,cy)=>new MouseEvent(t,\
                       {{clientX:cx,clientY:cy,bubbles:true,cancelable:true,buttons:1}});\
                     el.dispatchEvent(mk('mousedown',x,y));\
                     window.dispatchEvent(mk('mousemove',x+({dx})/2,y+({dy})/2));\
                     window.dispatchEvent(mk('mousemove',x+({dx}),y+({dy})));\
                     window.dispatchEvent(mk('mouseup',x+({dx}),y+({dy})));                     if(({dx})===0&&({dy})===0)el.dispatchEvent(mk('click',x,y));}})()"
                ));
                std::thread::sleep(std::time::Duration::from_millis(gap));
            }
        });
    }

    // KASASPACE_PROBE="<js 표현식>" — 결과를 화면 위 오버레이에 찍는다.
    // 콘솔은 릴리스 웹뷰에서 볼 수 없으니 스크린샷에 남기는 것이 유일한 통로다.
    if let Ok(expr) = std::env::var("KASASPACE_PROBE") {
        let delay = ms("KASASPACE_PROBE_MS", 5000);
        let w = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let Ok(src) = serde_json::to_string(&expr) else { return };
            let _ = w.eval(&format!(
                "(()=>{{let out;try{{out=eval({src});}}catch(e){{out='ERR '+e;}}\
                 const d=document.createElement('pre');\
                 d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:9999;\
                   margin:0;padding:8px;max-height:45%;overflow:auto;background:#1c1c1c;\
                   color:#d8f0c0;font:11px Consolas,monospace;white-space:pre-wrap';\
                 d.textContent=typeof out==='string'?out:JSON.stringify(out,null,1);\
                 document.body.appendChild(d);}})()"
            ));
        });
    }

    if let Ok(text) = std::env::var("KASASPACE_AUTOSEND") {
        let delay = ms("KASASPACE_AUTOSEND_MS", 3500);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let payload = serde_json::to_string(&format!("{text}\r")).unwrap_or_default();
            let _ = win.eval(&format!("window.__term && window.__term.input({payload})"));
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 이 앱이 claude code 안에서 실행되면 자식 세션 표시를 물려받는데,
            // 그러면 pane 에서 띄운 claude 가 "Transcript saving is off" 로 뜬다.
            // 대화가 저장되지 않으니 다음에 --continue 로 이어 열 것도 없다.
            // 여기서 끊어 두면 pane 의 셸은 독립 세션으로 시작한다.
            std::env::remove_var("CLAUDE_CODE_CHILD_SESSION");

            app.manage(Panes::default());
            arm_autosend(app.handle());
            Ok(())
        })
        // 복사·붙여넣기는 웹뷰가 아니라 OS 클립보드로 간다. navigator.clipboard 는
        // 창이 포커스를 갖고 있어야 하고 읽기에는 권한이 따로 걸려서, WebView2
        // 에서 조용히 NotAllowedError 로 거부되는 때가 있다.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pane_status,
            shells::shells,
            workspace::initial_root,
            workspace::fs_pick,
            workspace::git_status,
            workspace::claude_sessions,
            workspace::claude_bg_sessions,
            workspace::state_save,
            workspace::state_load,
        ])
        .run(tauri::generate_context!())
        .expect("tauri 앱 기동 실패");
}

/// pane 이 지금 무엇을 돌리고 있는지. 카사텀이 헤더에 그리는 그것 —
/// 프로세스 이름과 "일하는 중" 표시다.
///
/// 이 판정은 전부 엔진이 이미 한다. `active_process_name` 은 셸의 프로세스
/// 트리를 걸어 전경 명령을 찾고(ps 호출은 500ms 캐시), `active_agent` 는 그게
/// claude 류인지 argv 로 가려낸다. 우리가 다시 짤 이유가 없다.
#[derive(serde::Serialize)]
struct PaneStatus {
    id: String,
    proc: Option<String>,
    agent: Option<String>,
    busy: bool,
    working: bool,
    cwd: Option<String>,
}

// 박동은 작업을 확정하는 보조 신호라 화면에 남아 있는 라이브 스피너도 함께 본다.
fn pane_shows_working_spinner(session: &PtySession) -> bool {
    let visible = session.visible_text(40);
    text_shows_working_spinner(&visible)
}

fn text_shows_working_spinner(visible: &str) -> bool {
    let lines: Vec<&str> = visible.lines().collect();
    for (row, line) in lines.iter().enumerate().rev() {
        let indent = line.chars().take_while(|c| c.is_whitespace()).count();
        if indent >= 8 {
            continue;
        }
        let trimmed = line.trim_start();
        let Some(first) = trimmed.chars().next() else {
            continue;
        };
        let code = first as u32;
        let rest = &trimmed[first.len_utf8()..];
        let braille = (0x2800..=0x28ff).contains(&code);
        let star_or_dot = (0x2720..=0x274f).contains(&code) || code == 0x00b7;
        let timed = rest.split_once('\u{2026}').is_some_and(|(_, tail)| {
            tail.split_once('(').is_some_and(|(_, inside)| {
                inside.starts_with(|c: char| c.is_ascii_digit()) && inside.contains('s')
            })
        });
        let candidate = rest.contains("esc to interrupt")
            || braille
            || (star_or_dot && (rest.contains("ompacting") || timed));
        if !candidate {
            continue;
        }
        let stale = lines[row + 1..].iter().any(|below| {
            below
                .trim_start()
                .chars()
                .next()
                .is_some_and(|c| matches!(c as u32, 0x23fa | 0x23bf))
        });
        if !stale {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod pane_status_tests {
    use super::text_shows_working_spinner;

    #[test]
    fn live_agent_spinner_is_working() {
        let text = format!("output\n{} Working{} (3s)", '\u{2733}', '\u{2026}');
        assert!(text_shows_working_spinner(&text));
    }

    #[test]
    fn idle_prompt_is_not_working() {
        assert!(!text_shows_working_spinner("Claude Code\n>"));
    }

    #[test]
    fn spinner_above_completed_output_is_stale() {
        let text = format!(
            "{} Working{} (3s)\n{} completed",
            '\u{2733}', '\u{2026}', '\u{23fa}'
        );
        assert!(!text_shows_working_spinner(&text));
    }
}

#[tauri::command]
fn pane_status(panes: State<Panes>) -> Vec<PaneStatus> {
    let map = panes.0.lock().unwrap();
    map.iter()
        .map(|(id, s)| PaneStatus {
            id: id.clone(),
            proc: s.active_process_name(),
            agent: s.active_agent().map(|a| a.as_str().to_string()),
            busy: s.has_active_job(),
            working: s.output_heartbeat() || pane_shows_working_spinner(s),
            cwd: s
                .reported_cwd()
                .map(|p| p.to_string_lossy().replace('\\', "/")),
        })
        .collect()
}
