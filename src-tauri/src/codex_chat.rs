use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::{codex_chat_hook::Notice, collab::Collab};

#[derive(Clone, Debug, Serialize)]
pub struct Chat {
    pub id: String,
    pub busy: bool,
    pub waiting: bool,
    pub revision: u64,
    #[serde(skip)]
    pub transcript: Option<String>,
}

pub fn update(current: &mut Option<Chat>, notice: Notice) {
    if notice.hook_event_name == "SessionEnd" {
        if current.as_ref().is_some_and(|c| c.id == notice.session_id) { *current = None; }
        return;
    }
    // 지난 대화의 늦은 Stop이 /new로 연 대화를 다시 덮지 않는다.
    if notice.hook_event_name != "SessionStart" && current.as_ref().is_some_and(|c| c.id != notice.session_id) { return; }
    let revision = current.as_ref().map_or(1, |c| c.revision + 1);
    let same = current.as_ref().filter(|c| c.id == notice.session_id);
    let transcript = notice.transcript_path.or_else(|| same.and_then(|c| c.transcript.clone()));
    *current = Some(Chat {
        id: notice.session_id,
        busy: matches!(notice.hook_event_name.as_str(), "UserPromptSubmit" | "PostToolUse"),
        waiting: notice.hook_event_name == "PermissionRequest",
        revision,
        transcript,
    });
}

fn in_store(path: &Path, home: &Path, id: &str) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(&format!("-{id}.jsonl")) { return None; }
    let home = home.canonicalize().ok()?;
    if !["sessions", "archived_sessions"].iter().any(|s| path.starts_with(home.join(s))) { return None; }
    let mut first = String::new();
    BufReader::new(std::fs::File::open(&path).ok()?).take(1024 * 1024).read_line(&mut first).ok()?;
    let record: serde_json::Value = serde_json::from_str(&first).ok()?;
    if record["type"] != "session_meta" || record["payload"]["id"].as_str() != Some(id) { return None; }
    Some(path)
}

fn find_exact(home: &Path, id: &str) -> Option<PathBuf> {
    let root = home.join("sessions");
    let mut dirs = vec![root];
    for _ in 0..4 {
        let mut next = Vec::new();
        for dir in dirs {
            for entry in std::fs::read_dir(dir).ok()?.flatten() {
                let kind = entry.file_type().ok()?;
                if kind.is_dir() && entry.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()) {
                    next.push(entry.path());
                } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(&format!("-{id}.jsonl")) {
                    return in_store(&entry.path(), home, id);
                }
            }
        }
        dirs = next;
    }
    None
}

fn file(collab: &Collab, pane_id: &str, run: &str, id: &str) -> Result<Option<PathBuf>, String> {
    let q = collab.0.lock().unwrap();
    let binding = q.codex.get(pane_id).filter(|b| b.run == run && !b.failed).ok_or("Codex 실행이 종료되었습니다")?;
    let chat = binding.chat.as_ref().filter(|c| c.id == id).ok_or("Codex 대화가 바뀌었습니다")?;
    let home = PathBuf::from(&binding.launch.as_ref().ok_or("로컬 Codex 실행이 아닙니다")?.home);
    let path = chat.transcript.clone();
    drop(q);
    let found = path.and_then(|p| in_store(Path::new(&p), &home, id)).or_else(|| find_exact(&home, id));
    if let Some(path) = &found {
        let mut q = collab.0.lock().unwrap();
        if let Some(chat) = q.codex.get_mut(pane_id).filter(|b| b.run == run)
            .and_then(|b| b.chat.as_mut()).filter(|c| c.id == id) {
            chat.transcript = Some(path.to_string_lossy().into_owned());
        }
    }
    Ok(found)
}

#[tauri::command]
pub fn codex_transcript_size(collab: State<Collab>, pane_id: String, run: String, id: String) -> Result<u64, String> {
    Ok(file(&collab, &pane_id, &run, &id)?.and_then(|p| std::fs::metadata(p).ok()).map_or(0, |m| m.len()))
}

#[tauri::command]
pub fn codex_transcript_raw(collab: State<Collab>, pane_id: String, run: String, id: String) -> Result<String, String> {
    let Some(path) = file(&collab, &pane_id, &run, &id)? else { return Ok(String::new()); };
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    const MAX: u64 = 8 * 1024 * 1024;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let cut = len > MAX;
    if cut { file.seek(SeekFrom::Start(len - MAX)).map_err(|e| e.to_string())?; }
    let mut reader = BufReader::new(file).take(MAX);
    if cut { let mut half = String::new(); let _ = reader.read_line(&mut half); }
    let mut raw = String::new();
    reader.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notice(id: &str, event: &str) -> Notice {
        Notice { session_id: id.into(), hook_event_name: event.into(), cwd: String::new(), transcript_path: None }
    }
    #[test]
    fn old_turn_cannot_replace_new_session() {
        let mut chat = None;
        update(&mut chat, notice("a", "SessionStart"));
        update(&mut chat, notice("a", "PermissionRequest"));
        assert!(chat.as_ref().unwrap().waiting);
        update(&mut chat, notice("b", "SessionStart"));
        update(&mut chat, notice("a", "Stop"));
        update(&mut chat, notice("a", "SessionEnd"));
        assert_eq!(chat.as_ref().unwrap().id, "b");
        update(&mut chat, notice("b", "SessionEnd"));
        assert!(chat.is_none());
    }

    #[test]
    fn transcript_requires_matching_header_and_codex_store() {
        let root = std::env::temp_dir().join(format!("chiispace-chat-path-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let day = root.join("sessions/2026/09/27");
        std::fs::create_dir_all(&day).unwrap();
        let id = "12345678-1234-4234-8234-123456789abc";
        let file = day.join(format!("rollout-2026-09-27-{id}.jsonl"));
        let record = serde_json::json!({"type":"session_meta","payload":{"id":id}}).to_string() + "\n";
        std::fs::write(&file, &record).unwrap();
        assert_eq!(find_exact(&root, id), file.canonicalize().ok());
        let outside = root.join(format!("outside-{id}.jsonl"));
        std::fs::write(&outside, &record).unwrap();
        assert!(in_store(&outside, &root, id).is_none());
        std::fs::write(&file, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong\"}}\n").unwrap();
        assert!(in_store(&file, &root, id).is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
