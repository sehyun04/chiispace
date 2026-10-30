//! 새 대화 칸은 로컬 app-server의 stdio만 쓴다. 기존 PTY·훅 연결과 실행 수명을 공유하지 않는다.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>;
/// 떠 있는 app-server 와, 칸마다 마지막으로 거두는 중인 app-server.
#[derive(Default)]
pub struct CodexStreams(Mutex<HashMap<String, Proc>>, Mutex<HashMap<String, Arc<Leaving>>>);

#[derive(Default)]
struct Leaving { gone: Mutex<bool>, signal: Condvar }
impl Leaving {
    fn done(&self) {
        *self.gone.lock().unwrap() = true;
        self.signal.notify_all();
    }
    fn wait(&self, limit: Duration) {
        let gone = self.gone.lock().unwrap();
        let _ = self.signal.wait_timeout_while(gone, limit, |g| !*g);
    }
}
struct Proc {
    run: String,
    stdin: ChildStdin,
    child: Child,
    pending: Pending,
    questions: Arc<Mutex<HashMap<String, Value>>>,
    thread: Arc<Mutex<Option<String>>>,
    readable: Arc<Mutex<HashMap<String, String>>>,
    _job: Job,
}
static NEXT: AtomicU64 = AtomicU64::new(1);

// npm 실행기 밑의 네이티브 프로세스도 앱 종료와 함께 내려가야 한다.
struct Job(#[cfg(windows)] windows_sys::Win32::Foundation::HANDLE);
unsafe impl Send for Job {}
impl Job {
    fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)] unsafe {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err("Codex 실행 수명을 준비하지 못했다".into()); }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0 {
                CloseHandle(handle);
                return Err(format!("Codex 실행 수명 연결 실패: {}", std::io::Error::last_os_error()));
            }
            Ok(Self(handle))
        }
        #[cfg(not(windows))] { let _ = child; Ok(Self()) }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        #[cfg(windows)] unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); }
    }
}
#[derive(Clone, Serialize)]
struct Event { id: String, run: String, message: Value }

fn write(proc: &mut Proc, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    proc.stdin.write_all(&bytes).and_then(|_| proc.stdin.flush()).map_err(|e| format!("Codex에 보내지 못했다: {e}"))
}
// 목록 조회는 이 칸의 연결·스킬을 보여 주기만 한다. 설정·인증을 바꾸는 메서드는 열지 않는다.
fn permitted(method: &str) -> bool {
    matches!(method, "initialize" | "thread/start" | "thread/resume" | "thread/read" | "thread/list"
        | "thread/compact/start" | "turn/start" | "turn/steer" | "turn/interrupt"
        | "model/list" | "account/read" | "account/rateLimits/read" | "mcpServerStatus/list" | "skills/list")
}
fn current<'a>(map: &'a mut HashMap<String, Proc>, id: &str, run: &str) -> Result<&'a mut Proc, String> {
    map.get_mut(id).filter(|p| p.run == run).ok_or_else(|| "Codex 실행이 바뀌었거나 종료됐다".into())
}

fn record_children(message: &Value, root: Option<&str>, readable: &mut HashMap<String, String>) {
    let Some(root) = root else { return };
    let p = &message["params"];
    let thread = &p["thread"];
    let parent = thread["parentThreadId"].as_str()
        .or_else(|| thread["source"]["subAgent"]["thread_spawn"]["parent_thread_id"].as_str())
        .or_else(|| p["threadId"].as_str());
    if !parent.is_some_and(|p| p == root || readable.get(p).is_some_and(|r| r == root)) { return }
    let item = &p["item"];
    let ids: Vec<&str> = if message["method"] == "thread/started" {
        thread["id"].as_str().into_iter().collect()
    } else if matches!(message["method"].as_str(), Some("item/started" | "item/completed")) {
        match item["type"].as_str() {
            Some("collabAgentToolCall") => item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str).collect(),
            Some("subAgentActivity") => item["agentThreadId"].as_str().into_iter().collect(),
            _ => vec![],
        }
    } else { vec![] };
    for child in ids { if child != root { readable.insert(child.into(), root.into()); } }
}

fn can_target(method: &str, target: &str, root: Option<&str>, readable: &HashMap<String, String>) -> bool {
    root == Some(target) || (method == "thread/read" && root.is_some_and(|r| readable.get(target).is_some_and(|v| v == r)))
}

/// 같은 칸을 다른 대화로 다시 열면(`/resume`) 앞 app-server 가 아직 내려가는 중일 수 있다. 그것이 대화를 쥔 채면
/// 새 app-server 의 `thread/resume` 이 "already has an active writer" 로 거절된다 — `/new` 뒤 바로 전 대화로 돌아갈 때가
/// 그렇다. 그래서 앞 것이 다 내려간 뒤에 띄운다. 기다리는 동안 웹뷰가 멈추지 않게 이 명령은 비동기다.
#[tauri::command]
pub async fn codex_stream_start(app: AppHandle, id: String, cwd: String) -> Result<String, String> {
    let leaving = app.state::<CodexStreams>().1.lock().unwrap().get(&id).cloned();
    if let Some(prev) = leaving {
        let wait = prev.clone();
        tauri::async_runtime::spawn_blocking(move || wait.wait(Duration::from_secs(5))).await.map_err(|e| e.to_string())?;
        let state = app.state::<CodexStreams>();
        let mut left = state.1.lock().unwrap();
        if left.get(&id).is_some_and(|p| Arc::ptr_eq(p, &prev)) { left.remove(&id); }
    }
    start(app, id, cwd)
}

fn start(app: AppHandle, id: String, cwd: String) -> Result<String, String> {
    let streams = app.state::<CodexStreams>();
    let mut map = streams.0.lock().unwrap();
    if map.contains_key(&id) { return Err("이 칸의 Codex가 이미 실행 중이다".into()); }
    let dir = if cwd.is_empty() { std::env::var("USERPROFILE").map_err(|e| e.to_string())? } else { cwd };
    if !std::path::Path::new(&dir).is_dir() { return Err("작업 폴더가 없다".into()); }
    let program = crate::launchers::program("codex").ok_or("설치된 Codex를 찾지 못했다")?;
    let mut cmd = Command::new(&program.exe);
    cmd.args(&program.args).args(["app-server", "--listen", "stdio://"])
        .current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let job = match Job::attach(&child) { Ok(j) => j, Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e); } };
    let stdin = child.stdin.take().ok_or("Codex 입력이 없다")?;
    let stdout = child.stdout.take().ok_or("Codex 출력이 없다")?;
    let stderr = child.stderr.take().ok_or("Codex 오류 출력이 없다")?;
    let run = format!("codex-stream-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let pending: Pending = Arc::default();
    let questions = Arc::new(Mutex::new(HashMap::new()));
    let thread = Arc::new(Mutex::new(None));
    let readable = Arc::new(Mutex::new(HashMap::new()));
    let errors = Arc::new(Mutex::new(String::new()));
    let sink = errors.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            let mut tail = sink.lock().unwrap();
            tail.push_str(&String::from_utf8_lossy(&buf[..n]));
            *tail = tail.chars().rev().take(2000).collect::<String>().chars().rev().collect();
        }
    });
    map.insert(id.clone(), Proc { run: run.clone(), stdin, child, pending: pending.clone(), questions: questions.clone(), thread: thread.clone(), readable: readable.clone(), _job: job });
    let token = run.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) { Ok(0) | Err(_) => break, Ok(_) => {} }
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message.get("method").is_none() {
                if let Some(key) = message.get("id").and_then(Value::as_str) {
                    if let Some(tx) = pending.lock().unwrap().remove(key) {
                        let answer = if let Some(e) = message.get("error") { Err(e["message"].as_str().unwrap_or("Codex 요청 실패").to_string()) }
                            else { Ok(message["result"].clone()) };
                        let _ = tx.send(answer);
                    }
                }
                continue;
            }
            if let Some(request_id) = message.get("id") {
                questions.lock().unwrap().insert(request_id.to_string(), message["params"]["threadId"].clone());
            }
            if message["method"] == "serverRequest/resolved" {
                questions.lock().unwrap().remove(&message["params"]["requestId"].to_string());
            }
            record_children(&message, thread.lock().unwrap().as_deref(), &mut readable.lock().unwrap());
            let _ = app.emit("codex:stream", Event { id: id.clone(), run: token.clone(), message });
        }
        for (_, tx) in pending.lock().unwrap().drain() { let _ = tx.send(Err("Codex 연결이 종료됐다".into())); }
        let own = {
            let state = app.state::<CodexStreams>();
            let mut map = state.0.lock().unwrap();
            if map.get(&id).is_some_and(|p| p.run == token) { map.remove(&id) } else { None }
        };
        if let Some(mut proc) = own {
            let _ = proc.child.kill();
            let code = proc.child.wait().ok().and_then(|s| s.code());
            let _ = app.emit("codex:stream", Event { id, run: token, message: json!({"method":"chiispace/exit", "params":{"code":code,"error":errors.lock().unwrap().clone()}}) });
        }
    });
    Ok(run)
}

#[tauri::command]
pub async fn codex_stream_request(app: AppHandle, id: String, run: String, method: String, params: Value) -> Result<Value, String> {
    if !permitted(&method) { return Err("지원하지 않는 Codex 요청".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let key = format!("request-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        let state = app.state::<CodexStreams>();
        let (pending, thread, readable) = {
            let mut map = state.0.lock().unwrap();
            let proc = current(&mut map, &id, &run)?;
            if method != "thread/resume" {
                if let Some(t) = params.get("threadId").and_then(Value::as_str) {
                    if !can_target(&method, t, proc.thread.lock().unwrap().as_deref(), &proc.readable.lock().unwrap()) {
                        return Err("다른 칸의 대화에는 보낼 수 없다".into());
                    }
                }
            }
            proc.pending.lock().unwrap().insert(key.clone(), tx);
            if let Err(e) = write(proc, &json!({"id":key,"method":method,"params":params})) {
                proc.pending.lock().unwrap().remove(&key);
                return Err(e);
            }
            (proc.pending.clone(), proc.thread.clone(), proc.readable.clone())
        };
        let result = rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "Codex 응답을 기다리다 연결이 끝났다".to_string());
        pending.lock().unwrap().remove(&key);
        let value = result??;
        if matches!(method.as_str(), "thread/start" | "thread/resume") {
            *thread.lock().unwrap() = value["thread"]["id"].as_str().map(String::from);
            readable.lock().unwrap().clear();
        }
        if matches!(method.as_str(), "thread/resume" | "thread/read") {
            let root = thread.lock().unwrap().clone();
            let mut scope = readable.lock().unwrap();
            for turn in value["thread"]["turns"].as_array().into_iter().flatten() {
                for item in turn["items"].as_array().into_iter().flatten() {
                    record_children(&json!({"method":"item/completed","params":{"threadId":value["thread"]["id"],"item":item}}), root.as_deref(), &mut scope);
                }
            }
        }
        if method == "initialize" {
            let mut map = state.0.lock().unwrap();
            write(current(&mut map, &id, &run)?, &json!({"method":"initialized"}))?;
        }
        Ok(value)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn codex_stream_answer(streams: State<CodexStreams>, id: String, run: String, request_id: Value, result: Option<Value>, error: Option<String>) -> Result<(), String> {
    let mut map = streams.0.lock().unwrap();
    let proc = current(&mut map, &id, &run)?;
    let key = request_id.to_string();
    let bound = proc.questions.lock().unwrap().get(&key).cloned().ok_or("이미 끝난 Codex 질문이다")?;
    if bound.as_str().is_some_and(|t| proc.thread.lock().unwrap().as_deref() != Some(t)) { return Err("대화가 바뀐 질문이다".into()); }
    let msg = if let Some(error) = error { json!({"id": request_id, "error":{"code":-32601,"message":error}}) }
        else { json!({"id":request_id,"result":result.unwrap_or(Value::Null)}) };
    write(proc, &msg)?;
    proc.questions.lock().unwrap().remove(&key);
    Ok(())
}

#[tauri::command]
pub fn codex_stream_stop(streams: State<CodexStreams>, id: String, run: String) {
    let own = {
        let mut map = streams.0.lock().unwrap();
        if map.get(&id).is_some_and(|p| p.run == run) { map.remove(&id) } else { None }
    };
    if let Some(Proc { stdin, mut child, pending, _job, .. }) = own {
        let leaving = Arc::new(Leaving::default());
        streams.1.lock().unwrap().insert(id, leaving.clone());
        drop(stdin);
        for (_, tx) in pending.lock().unwrap().drain() { let _ = tx.send(Err("Codex 칸이 닫혔다".into())); }
        std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until && matches!(child.try_wait(), Ok(None)) { std::thread::sleep(Duration::from_millis(50)); }
            let _ = child.kill();
            let _ = child.wait();
            drop(_job);
            leaving.done();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_transport_cannot_execute_arbitrary_processes_or_write_config() {
        for method in ["process/spawn", "command/exec", "config/value/write", "config/batchWrite", "skills/config/write", "mcpServer/oauth/login", "account/login/start", "thread/name/set", "review/start", "thread/fork"] { assert!(!permitted(method)); }
        for method in ["thread/start", "thread/resume", "thread/list", "turn/start", "turn/interrupt", "model/list", "mcpServerStatus/list", "skills/list"] { assert!(permitted(method)); }
    }
    #[test]
    fn reopening_waits_until_the_previous_server_is_gone() {
        let leaving = Arc::new(Leaving::default());
        let signal = leaving.clone();
        let started = Instant::now();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(150)); signal.done(); });
        leaving.wait(Duration::from_secs(5));
        assert!(started.elapsed() >= Duration::from_millis(150) && started.elapsed() < Duration::from_secs(2));
        let stuck = Leaving::default();
        let started = Instant::now();
        stuck.wait(Duration::from_millis(100));
        assert!(started.elapsed() >= Duration::from_millis(100));
    }
    #[test]
    fn only_announced_children_of_the_current_thread_can_be_read() {
        let mut readable = HashMap::new();
        let notice = json!({"method":"item/completed","params":{"threadId":"main","item":{"type":"collabAgentToolCall","receiverThreadIds":["child"]}}});
        record_children(&notice, Some("main"), &mut readable);
        assert!(can_target("thread/read", "child", Some("main"), &readable));
        for method in ["turn/start", "turn/interrupt", "thread/compact/start"] { assert!(!can_target(method, "child", Some("main"), &readable)); }
        assert!(!can_target("thread/read", "other", Some("main"), &readable));
        assert!(!can_target("thread/read", "child", Some("new-main"), &readable));
        record_children(&json!({"method":"item/completed","params":{"threadId":"other","item":{"type":"subAgentActivity","agentThreadId":"foreign"}}}), Some("main"), &mut readable);
        assert!(!readable.contains_key("foreign"));
    }
}
