use crate::{codex_session::valid_id, collab::Collab, pane_agent, Panes};
use kasa_pty::PtySession;
use serde::Serialize;
use std::{sync::Arc, time::{Duration, Instant}};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Conversation { session: String, cwd: String, unstarted: bool }

// 종료 요약은 TUI가 현재 보고 있는 대화의 ID다. 이전 전환 ID나 최근 rollout을 쓰면 /new 뒤 다른 대화를 연다.
fn exit_session(text: &str) -> Option<(String, bool)> {
    let (tail, unstarted) = if let Some((_, tail)) = text.rsplit_once("To continue this session, run:") {
        (tail.trim_start().strip_prefix("codex")?.trim_start().strip_prefix("resume")?.trim_start(), false)
    } else {
        if text.contains("Token usage:") { return None; }
        (text.rsplit_once("Session ID:")?.1.trim_start(), true)
    };
    let mut end = 0;
    let id: String = tail.char_indices().filter(|(_, c)| !c.is_ascii_whitespace()).take(36)
        .map(|(i, c)| { end = i + c.len_utf8(); c }).collect();
    (valid_id(&id) && !tail.as_bytes().get(end).is_some_and(|b| b.is_ascii_hexdigit() || *b == b'-'))
        .then_some((id, unstarted))
}

#[derive(Default)]
struct Output { escape: u8, text: String }
impl Output {
    fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        for &b in bytes {
            match (self.escape, b) {
                (0, 27) => self.escape = 1,
                (0, b'\r' | b'\n' | b' '..=b'~') => self.text.push(b as char),
                (1, b'[') => self.escape = 2,
                (1, b']' | b'P' | b'_' | b'^') => self.escape = 3,
                (1, _) => self.escape = 0,
                (2, 0x40..=0x7e) => self.escape = 0,
                (3, 7) | (4, b'\\') => self.escape = 0,
                (3, 27) => self.escape = 4,
                (4, _) => self.escape = 3,
                _ => {},
            }
        }
        if self.text.len() > 131072 { return Err("Codex 종료 출력을 확인하지 못했다".into()); }
        Ok(())
    }
}

fn idle(pane: &PtySession) -> bool {
    let snap = pane.full_snapshot();
    let row = snap.dirty.iter().find(|(y, _)| *y == snap.cursor_row);
    let Some((_, row)) = row else { return false };
    // 명령 목록·승인 창·편집 중인 초안을 종료 명령으로 덮지 않는다. Codex의 빈 입력 커서만 허용한다.
    snap.cursor_visible && snap.cursor_col == 2 && row.first().is_some_and(|c| c.ch == '›')
        && !pane.output_heartbeat() && !crate::pane_shows_working_spinner(pane)
}

fn transfer(app: &AppHandle, id: &str, begun: &mut bool) -> Result<Conversation, String> {
    let collab = app.state::<Collab>();
    let panes = app.state::<Panes>();
    let probe = panes.0.lock().unwrap().get(id).cloned().ok_or("터미널 칸이 닫혔다")?;
    // 완료 직후 박동의 여열이나 TUI의 숨김/표시 프레임 하나 때문에 정상 전환을 거절하지 않는다.
    let settle = Instant::now() + Duration::from_secs(3);
    while !idle(&probe) && Instant::now() < settle { std::thread::sleep(Duration::from_millis(80)); }
    let (pane, cwd, receiver) = {
        let mut q = collab.0.lock().unwrap();
        let map = panes.0.lock().unwrap();
        let pane = map.get(id).ok_or("터미널 칸이 닫혔다")?;
        if !Arc::ptr_eq(pane, &probe) { return Err("터미널 칸이 바뀌었다".into()); }
        if pane_agent::find(pane).map(|(a, _)| a.as_str()) != Some("codex") || !idle(pane) {
            return Err("Codex의 작업·승인·메뉴를 마치고 입력을 Ctrl+C로 비운 뒤 대화창으로 옮겨 줘".into());
        }
        let launch = q.codex.get(id).and_then(|b| b.launch.as_ref()).ok_or("Codex 실행 정보를 기다려 줘")?;
        launch.validate().map_err(|e| e.to_string())?;
        let home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(|p| std::path::PathBuf::from(p).join(".codex")));
        let home = home.and_then(|p| p.canonicalize().ok());
        if home.is_none() || home != std::path::Path::new(&launch.home).canonicalize().ok()
            || launch.args.iter().any(|s| s != "--no-alt-screen") {
            return Err("별도 상태 폴더나 실행 옵션을 준 Codex는 설정을 보존하기 위해 터미널에서 이어 써 줘".into());
        }
        let cwd = launch.cwd.clone();
        q.begin_switch(id).map_err(|e| e.to_string())?;
        *begun = true;
        let receiver = pane.tap_bytes();
        pane.send_bytes(b"/quit").map_err(|e| e.to_string())?;
        (Arc::clone(pane), cwd, receiver)
    };
    // TUI가 빠른 연속 입력을 붙여넣기로 묶지 않도록 Enter를 늦춘다. 사용자 입력은 같은 락으로 잠겨 있다.
    std::thread::sleep(Duration::from_millis(900));
    {
        let map = panes.0.lock().unwrap();
        if !map.get(id).is_some_and(|p| Arc::ptr_eq(p, &pane)) { return Err("터미널 칸이 바뀌었다".into()); }
        pane.send_bytes(b"\r").map_err(|e| e.to_string())?;
    }
    let mut output = Output::default();
    let until = Instant::now() + Duration::from_secs(12);
    while Instant::now() < until {
        while let Ok(bytes) = receiver.try_recv() { output.push(&bytes)?; }
        if pane_agent::find(&pane).is_none() {
            // 종료 직전의 마지막 read가 도착할 시간을 주고, 새로 받은 종료 요약만 읽는다.
            std::thread::sleep(Duration::from_millis(150));
            while let Ok(bytes) = receiver.try_recv() { output.push(&bytes)?; }
            let (session, unstarted) = exit_session(&output.text)
                .ok_or("Codex가 현재 대화 ID를 알려 주지 않았다. 터미널에서 다시 열어 줘")?;
            return Ok(Conversation { session: if unstarted { String::new() } else { session }, cwd, unstarted });
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    Err("Codex 종료를 확인하지 못했다. 터미널 화면을 확인해 줘".into())
}

#[tauri::command]
pub async fn codex_to_stream(app: AppHandle, id: String) -> Result<Conversation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut begun = false;
        let result = transfer(&app, &id, &mut begun);
        if begun && result.is_err() { app.state::<Collab>().0.lock().unwrap().finish_switch(&id); }
        result
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cli_exit_identity_is_used_even_after_new_or_wrapping() {
        let id = "01a19a6f-fc58-7750-ad88-b73bcf0ce458";
        let report = format!("old message codex resume 00000000-0000-0000-0000-000000000000\nTo continue this session, run:\n  codex resume {}\r\n{}\nOr run codex resume and select a name.", &id[..21], &id[21..]);
        let mut output = Output::default();
        for chunk in format!("\x1b]0;codex resume fake\x07\x1b[36m{report}\x1b[39m").as_bytes().chunks(3) { output.push(chunk).unwrap(); }
        assert_eq!(exit_session(&output.text), Some((id.into(), false)));
        assert_eq!(exit_session(&format!("To continue this session, run:\r\n codex resume {id}\r\nC:\\project>")), Some((id.into(), false)));
        assert_eq!(exit_session(&format!("Session ID: {id}")), Some((id.into(), true)));
        for bad in [format!("codex resume {id}"), format!("To continue this session, run: codex resume {id}0"), format!("Token usage: 2 total\nSession ID: {id}")] {
            assert_eq!(exit_session(&bad), None);
        }
    }
}
