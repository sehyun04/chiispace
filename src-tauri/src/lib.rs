//! PTY 를 웹뷰로 잇는 다리.
//!
//! 화면을 그리는 건 프론트의 xterm.js 다. 여기서는 셸의 **원시 바이트**를 그대로
//! 흘려보내기만 한다 — `kasa_pty` 가 이미 파싱한 셀 그리드가 아니라. 그래야 받는
//! 쪽이 우리 내부 구조에 묶이지 않고, 엔진도 이 용도를 상정하고 만들어져 있다
//! (`tap_bytes_with_snapshot` 주석 참고).

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
) -> Result<(), String> {
    if panes.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    let session = PtySession::start(PtyOptions {
        cols,
        rows,
        cwd,
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

/// 헤드리스 검증 손잡이. env 가 있을 때만 깨어난다.
///   KASASPACE_AUTOSEND="dir" KASASPACE_AUTOSEND_MS=3500
///
/// 웹뷰의 `__term.input()` 을 부른다 — 사용자가 키를 친 것과 같은 경로(onData ->
/// pty_write)를 타므로 배선 전체가 검증된다. OS 로 키를 쏘는 방식(SendKeys)은
/// 포커스가 다른 창에 있으면 **엉뚱한 앱에 타이핑된다**. 한 번 겪었다.
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
            app.manage(Panes::default());
            arm_autosend(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            workspace::initial_root,
            workspace::fs_list,
            workspace::fs_pick,
            workspace::git_status,
            workspace::state_save,
            workspace::state_load,
        ])
        .run(tauri::generate_context!())
        .expect("tauri 앱 기동 실패");
}
