//! 터미널 없는 claude 대화 — 새 대화 목록에서 연 칸.
//!
//! 칸 셸에 TUI 를 띄우는 대신 `claude -p` 의 stream-json 통로로 주고받는다. 권한 묻기·선택지
//! 질문·중단·모델 바꾸기가 화면 글자가 아니라 데이터로 오므로 터미널을 보일 일이 없다.
//! 줄은 여기서 해석하지 않고 웹뷰로 넘긴다(ui/claude-stream.ts). 대화 내용이 지나가므로
//! 어디에도 기록하지 않는다.
//!
//! API 는 PTY 칸과 같은 루프백 프록시로 돈다. 쓰이는 중인 답(`chat:live`)과 서브에이전트
//! (`chat:sub`)가 TUI 칸과 같은 길로 오므로 대화창을 둘로 나눠 짤 필요가 없다.
//!
//! 칸의 지금 상태(일하는 중인지·답을 기다리는 권한 묻기)는 웹뷰가 줄을 받아 스스로 세우지만, 뒤늦게 붙는
//! 화면(폰, remote.rs)은 지나간 줄을 못 봤다. 그래서 여기서도 그것만 따로 들고 있다가 건넨다(`snapshot`).
//! 한쪽이 권한에 답하면 다른 쪽 카드도 걷히도록 답이 지나갈 때 `claude:chat-answered` 를 낸다.
use serde::Serialize;
use serde_json::Value;
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
    seen: Seen,
}

/// 통로에 지나간 줄에서 뒤늦게 붙는 화면이 알아야 할 것만. 대화 내용은 대화 파일에 있으니 들지 않는다.
#[derive(Default)]
struct Seen {
    busy: bool,
    /// 마지막 system init 줄 — 모델·권한 모드·대화 id 가 거기 있다.
    init: Option<String>,
    /// 아직 답하지 않은 권한 묻기·질문(`can_use_tool`) — 요청 id 와 줄 그대로.
    prompts: Vec<(String, String)>,
}

/// claude 가 보낸 줄. 판단은 ui/claude-stream.ts 의 `reduceStream` 과 같다 — 어긋나면 폰과 PC 가 다르게 보인다.
fn observe(seen: &mut Seen, line: &str) {
    // 쓰이는 중인 답의 조각이 줄 대부분이다. 매번 뜯지 않는다.
    if line.starts_with(r#"{"type":"stream_event""#) {
        seen.busy = true;
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => seen.init = Some(line.to_string()),
        Some("stream_event" | "assistant") => seen.busy = true,
        Some("result") => {
            seen.busy = false;
            seen.prompts.clear();
        }
        Some("control_request") => {
            let tool = v.pointer("/request/subtype").and_then(Value::as_str) == Some("can_use_tool");
            if let (true, Some(id)) = (tool, v.get("request_id").and_then(Value::as_str)) {
                seen.prompts.retain(|(p, _)| p != id);
                seen.prompts.push((id.to_string(), line.to_string()));
                seen.busy = true;
            }
        }
        Some("control_cancel_request") => {
            if let Some(id) = v.get("request_id").and_then(Value::as_str) {
                seen.prompts.retain(|(p, _)| p != id);
            }
        }
        _ => {}
    }
}

/// 웹뷰·폰이 보낸 줄. 답한 권한 묻기의 요청 id 를 돌려준다 — 다른 화면의 카드를 걷는 데 쓴다.
fn sent(seen: &mut Seen, v: &Value) -> Option<String> {
    match v.get("type").and_then(Value::as_str) {
        Some("user") => {
            seen.busy = true;
            None
        }
        Some("control_response") => {
            let id = v.pointer("/response/request_id").and_then(Value::as_str)?;
            let before = seen.prompts.len();
            seen.prompts.retain(|(p, _)| p != id);
            (seen.prompts.len() < before).then(|| id.to_string())
        }
        _ => None,
    }
}

/// 뒤늦게 붙는 화면에 건네는 지금 상태.
#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub alive: bool,
    pub busy: bool,
    pub init: Option<String>,
    pub prompts: Vec<String>,
}

pub fn snapshot(app: &AppHandle, id: &str) -> Snapshot {
    let chats = app.state::<ClaudeChats>();
    let map = chats.0.lock().unwrap();
    match map.get(id) {
        Some(p) => Snapshot {
            alive: true,
            busy: p.seen.busy,
            init: p.seen.init.clone(),
            prompts: p.seen.prompts.iter().map(|(_, l)| l.clone()).collect(),
        },
        None => Snapshot { alive: false, busy: false, init: None, prompts: Vec::new() },
    }
}

/// 이 칸이 지금 답을 기다리는 권한 묻기인가. 폰은 기다리는 요청에만 답할 수 있다.
pub fn waiting_for(app: &AppHandle, id: &str, request: &str) -> bool {
    let chats = app.state::<ClaudeChats>();
    let map = chats.0.lock().unwrap();
    map.get(id).is_some_and(|p| p.seen.prompts.iter().any(|(r, _)| r == request))
}

#[derive(Clone, Serialize)]
struct Answered {
    id: String,
    request_id: String,
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
fn protocol_line(line: &str) -> Option<Value> {
    if line.contains(['\n', '\r']) {
        return None;
    }
    serde_json::from_str::<Value>(line).ok().filter(|v| {
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
                        {
                            let chats = handle.state::<ClaudeChats>();
                            let mut map = chats.0.lock().unwrap();
                            if let Some(p) = map.get_mut(&pane).filter(|p| p.generation == generation) {
                                observe(&mut p.seen, &line);
                            }
                        }
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

    map.insert(id, Proc { stdin, child, generation, seen: Seen::default() });
    Ok(())
}

#[tauri::command]
pub fn claude_chat_send(app: AppHandle, id: String, line: String) -> Result<(), String> {
    send_line(&app, &id, &line)
}

/// 칸의 claude 에 한 줄. 웹뷰와 폰(remote.rs)이 같은 길로 보낸다.
pub fn send_line(app: &AppHandle, id: &str, line: &str) -> Result<(), String> {
    let v = protocol_line(line).ok_or("보낼 수 없는 줄")?;
    let answered = {
        let chats = app.state::<ClaudeChats>();
        let mut map = chats.0.lock().unwrap();
        let proc = map.get_mut(id).ok_or("이 칸의 claude 가 떠 있지 않다")?;
        proc.stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| proc.stdin.flush())
            .map_err(|e| format!("claude 에 못 보냈다: {e}"))?;
        sent(&mut proc.seen, &v)
    };
    if let Some(request_id) = answered {
        let _ = app.emit("claude:chat-answered", Answered { id: id.to_string(), request_id });
    }
    Ok(())
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
        assert!(protocol_line(r#"{"type":"user","message":{"role":"user","content":"hi"}}"#).is_some());
        assert!(protocol_line(r#"{"type":"control_request","request_id":"a","request":{"subtype":"interrupt"}}"#).is_some());
        assert!(protocol_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"a","response":{}}}"#).is_some());
        assert!(protocol_line(r#"{"type":"system"}"#).is_none());
        assert!(protocol_line("hi").is_none());
        assert!(protocol_line("{\"type\":\"user\"}\n{\"type\":\"user\"}").is_none());
    }

    #[test]
    fn late_screens_get_the_turn_and_open_prompts() {
        let mut s = Seen::default();
        observe(&mut s, r#"{"type":"system","subtype":"init","model":"m","session_id":"x"}"#);
        assert!(s.init.as_deref().is_some_and(|l| l.contains(r#""model":"m""#)));
        assert!(!s.busy);
        observe(&mut s, r#"{"type":"stream_event","event":{}}"#);
        assert!(s.busy);
        let ask = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#;
        observe(&mut s, ask);
        observe(&mut s, ask);
        observe(&mut s, r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Write"}}"#);
        // 앱이 보낸 조회의 답이나 다른 요청은 권한 묻기가 아니다.
        observe(&mut s, r#"{"type":"control_request","request_id":"r3","request":{"subtype":"hook_callback"}}"#);
        assert_eq!(s.prompts.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["r1", "r2"]);
        observe(&mut s, r#"{"type":"control_cancel_request","request_id":"r2"}"#);
        assert_eq!(s.prompts.len(), 1);
        observe(&mut s, r#"{"type":"result","subtype":"success"}"#);
        assert!(!s.busy && s.prompts.is_empty());
    }

    #[test]
    fn an_answer_from_either_screen_closes_the_prompt() {
        let mut s = Seen::default();
        observe(&mut s, r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#);
        let answer = |id: &str| serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":{}}});
        assert_eq!(sent(&mut s, &answer("other")), None);
        assert_eq!(sent(&mut s, &answer("r1")), Some("r1".to_string()));
        // 두 화면이 같은 카드에 거의 같이 답해도 걷으라는 신호는 한 번이다.
        assert_eq!(sent(&mut s, &answer("r1")), None);
        assert!(s.prompts.is_empty());
        let mut idle = Seen::default();
        sent(&mut idle, &serde_json::json!({"type":"user","message":{"role":"user","content":"hi"}}));
        assert!(idle.busy);
    }
}
