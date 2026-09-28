//! 터미널 없는 claude 대화 — 새 대화 목록에서 연 칸.
//!
//! 칸 셸에 TUI 를 띄우는 대신 `claude -p` 의 stream-json 통로로 주고받는다. 권한 묻기·선택지
//! 질문·중단·모델 바꾸기가 화면 글자가 아니라 데이터로 오므로 터미널을 보일 일이 없다.
//! 줄은 여기서 해석하지 않고 웹뷰로 넘긴다(ui/claude-stream.ts). 대화 내용이 지나가므로
//! 어디에도 기록하지 않는다.
//!
//! API 는 PTY 칸과 같은 루프백 프록시로 돈다. 쓰이는 중인 답(`chat:live`)과 서브에이전트
//! (`chat:sub`)가 TUI 칸과 같은 길로 오므로 대화창을 둘로 나눠 짤 필요가 없다.
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct ClaudeChats(Mutex<HashMap<String, Proc>>);

struct Proc {
    stdin: ChildStdin,
    child: Child,
    /// 같은 칸을 다시 띄웠을 때 먼저 것의 종료가 새 것을 지우지 않게 가른다.
    generation: u64,
}

static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct Line {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
    code: Option<i32>,
    /// 켜지지 못했거나 죽었을 때 왜인지. 대화 내용이 아니라 claude 의 오류 출력 끝부분이다.
    error: String,
}

fn uuid_shaped(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() }
        })
}

/// 새 대화는 앱이 id 를 정해 `--session-id` 로 준다. 그래야 첫 답부터 이 칸의 대화로 그리고,
/// 다시 켤 때 어느 대화인지 추측하지 않는다. 이어 열 때는 그 id 를 `--resume` 으로 준다.
fn args(session: &str, resume: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // 권한 묻기를 화면 대신 control_request 로 받는다(Agent SDK 와 같은 통로).
        "--permission-prompt-tool",
        "stdio",
    ]
    .map(String::from)
    .to_vec();
    a.push(if resume { "--resume" } else { "--session-id" }.into());
    a.push(session.into());
    a
}

/// 웹뷰가 보낼 수 있는 줄. 통로의 세 가지 말 말고는 claude 의 표준 입력에 넣지 않는다.
fn protocol_line(line: &str) -> bool {
    if line.contains(['\n', '\r']) {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(line).is_ok_and(|v| {
        matches!(
            v.get("type").and_then(|t| t.as_str()),
            Some("user" | "control_request" | "control_response")
        )
    })
}

fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(n)..].iter().collect()
}

#[tauri::command]
pub fn claude_chat_start(
    app: AppHandle,
    chats: State<ClaudeChats>,
    id: String,
    cwd: String,
    session: String,
    resume: bool,
) -> Result<(), String> {
    if !uuid_shaped(&session) {
        return Err("대화 id 모양이 아니다".into());
    }
    let mut map = chats.0.lock().unwrap();
    if let Some(p) = map.get_mut(&id) {
        // 웹뷰가 다시 그려져 또 부르는 것은 흔하다. 살아 있으면 그대로 둔다.
        if matches!(p.child.try_wait(), Ok(None)) {
            return Ok(());
        }
        map.remove(&id);
    }
    let dir = if cwd.trim().is_empty() {
        std::env::var_os("USERPROFILE").map(PathBuf::from).ok_or("폴더가 정해지지 않았다")?
    } else {
        PathBuf::from(&cwd)
    };
    if !dir.is_dir() {
        return Err(format!("폴더가 없다: {cwd}"));
    }
    let program = crate::launchers::program("claude").ok_or("설치된 claude 를 찾지 못했다")?;
    let mut cmd = Command::new(&program.exe);
    cmd.args(&program.args)
        .args(args(&session, resume))
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(app.state::<crate::proxy::Proxy>().env.clone());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 콘솔 창을 띄우지 않는다. 이 칸은 터미널을 보이지 않으려고 만든 것이다.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("claude 를 못 띄웠다: {e}"))?;
    let stdin = child.stdin.take().ok_or("claude 입력을 못 잡았다")?;
    let stdout = child.stdout.take().ok_or("claude 출력을 못 잡았다")?;
    let stderr = child.stderr.take().ok_or("claude 오류 출력을 못 잡았다")?;
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);

    let errors = Arc::new(Mutex::new(String::new()));
    let sink = errors.clone();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf);
        *sink.lock().unwrap() = tail(&buf, 2000);
    });

    let pane = id.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&raw).trim_end().to_string();
                    if !line.is_empty() {
                        let _ = handle.emit("claude:chat", Line { id: pane.clone(), line });
                    }
                }
            }
        }
        // 출력이 닫혔다. 이 칸의 그 프로세스가 아직 명부에 있으면 여기서 거둔다.
        let own = {
            let chats = handle.state::<ClaudeChats>();
            let mut map = chats.0.lock().unwrap();
            if map.get(&pane).is_some_and(|p| p.generation == generation) { map.remove(&pane) } else { None }
        };
        let Some(mut proc) = own else { return };
        let code = proc.child.wait().ok().and_then(|s| s.code());
        // 오류 출력은 따로 읽으므로 조금 기다려 끝부분을 받는다.
        std::thread::sleep(Duration::from_millis(100));
        let error = errors.lock().unwrap().clone();
        let _ = handle.emit("claude:chat-exit", Exit { id: pane, code, error });
    });

    map.insert(id, Proc { stdin, child, generation });
    Ok(())
}

#[tauri::command]
pub fn claude_chat_send(chats: State<ClaudeChats>, id: String, line: String) -> Result<(), String> {
    if !protocol_line(&line) {
        return Err("보낼 수 없는 줄".into());
    }
    let mut map = chats.0.lock().unwrap();
    let proc = map.get_mut(&id).ok_or("이 칸의 claude 가 떠 있지 않다")?;
    proc.stdin
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| format!("claude 에 못 보냈다: {e}"))
}

/// 칸을 닫는다. 입력을 닫으면 claude 는 하던 턴을 적고 스스로 끝낸다. 오래 걸리면 끊는다.
#[tauri::command]
pub fn claude_chat_stop(chats: State<ClaudeChats>, id: String) {
    let Some(Proc { stdin, mut child, .. }) = chats.0.lock().unwrap().remove(&id) else { return };
    drop(stdin);
    std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_chats_name_their_session_and_restores_resume_it() {
        let id = "12345678-1234-4234-8234-123456789abc";
        let fresh = args(id, false);
        assert!(fresh.windows(2).any(|w| w == ["--session-id", id]));
        assert!(!fresh.contains(&"--resume".to_string()));
        let again = args(id, true);
        assert!(again.windows(2).any(|w| w == ["--resume", id]));
        assert!(fresh.windows(2).any(|w| w == ["--permission-prompt-tool", "stdio"]));
    }

    #[test]
    fn only_session_ids_reach_the_command_line() {
        assert!(uuid_shaped("12345678-1234-4234-8234-123456789abc"));
        for bad in ["", "12345678-1234-4234-8234-123456789ab", "12345678-1234-4234-8234-123456789abz", "--resume x"] {
            assert!(!uuid_shaped(bad), "{bad}");
        }
    }

    #[test]
    fn only_protocol_lines_reach_claude() {
        assert!(protocol_line(r#"{"type":"user","message":{"role":"user","content":"hi"}}"#));
        assert!(protocol_line(r#"{"type":"control_request","request_id":"a","request":{"subtype":"interrupt"}}"#));
        assert!(protocol_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"a","response":{}}}"#));
        assert!(!protocol_line(r#"{"type":"system"}"#));
        assert!(!protocol_line("hi"));
        assert!(!protocol_line("{\"type\":\"user\"}\n{\"type\":\"user\"}"));
    }
}
