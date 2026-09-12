use crate::{codex_session::Session, launch_config::Program};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};
use tungstenite::{
    handshake::server::{Request, Response},
    Message,
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// 앱 강제 종료 때도 이 실행이 만든 서버와 손자 프로세스가 남지 않아야 한다.
#[cfg(windows)]
struct Job(std::os::windows::io::OwnedHandle);
#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::System::JobObjects::*;
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let job = Self(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) });
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
        };
        if ok == 0
            || unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(job)
    }
}

#[derive(Default)]
struct Tracker {
    pending: HashMap<String, (u64, String)>,
    current: Option<Session>,
    next: u64,
    accepted: u64,
}
impl Tracker {
    fn request(&mut self, value: &Value) {
        if let (
            Some(id),
            Some(method @ ("thread/start" | "thread/resume" | "thread/fork" | "turn/start")),
        ) = (value.get("id"), value["method"].as_str())
        {
            if self.pending.len() < 128 {
                let operation = if method == "turn/start" {
                    format!(
                        "turn:{}",
                        value["params"]["threadId"].as_str().unwrap_or("")
                    )
                } else {
                    method.into()
                };
                self.next += 1;
                self.pending.insert(id.to_string(), (self.next, operation));
            }
        }
    }
    fn response(&mut self, value: &Value, home: &str) -> Option<Session> {
        if value.get("method").is_some() {
            return None;
        }
        let id = value.get("id")?;
        let (sequence, operation) = self.pending.remove(&id.to_string())?;
        if let Some(thread) = operation.strip_prefix("turn:") {
            if !value["result"]["turn"].is_object() {
                return None;
            }
            let current = self.current.as_mut().filter(|s| s.id == thread)?;
            // 빈 스레드는 첫 turn을 받기 전까지 Codex 디스크 기록에 존재하지 않는다.
            current.resumable = true;
            return Some(current.clone());
        }
        if sequence < self.accepted {
            return None;
        }
        let data = &value["result"]["thread"];
        let session = Session {
            id: data["id"].as_str()?.into(),
            home: home.into(),
            cwd: data["cwd"].as_str()?.into(),
            args: vec![],
            resumable: operation != "thread/start",
        };
        session.validate().ok()?;
        self.accepted = sequence;
        self.current = Some(session.clone());
        Some(session)
    }
}

pub fn run(program: &Program, args: Vec<String>, options: Vec<String>) -> Result<i32> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    // 포트 번호를 알아도 다른 로컬 클라이언트가 붙지 못하도록 실행별 256비트 비밀을 쓴다.
    let secret = tungstenite::handshake::client::generate_key()
        + &tungstenite::handshake::client::generate_key();
    let mut command = Command::new(&program.exe);
    command
        .args(&program.args)
        .arg("--remote")
        .arg(format!("ws://{address}"))
        .arg("--remote-auth-token-env")
        .arg("CHIISPACE_CODEX_REMOTE_TOKEN")
        .env("CHIISPACE_CODEX_REMOTE_TOKEN", &secret)
        .args(args);
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|p| std::path::PathBuf::from(p).join(".codex"))
        })
        .ok_or_else(|| anyhow!("Codex 상태 폴더를 찾지 못했습니다"))?;
    let home = std::path::absolute(home)?.to_string_lossy().into_owned();
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let program = program.clone();
    let worker = thread::spawn(move || -> Result<()> {
        while !stopping.load(Ordering::Relaxed) {
            let (stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
            stream.set_write_timeout(Some(Duration::from_secs(2)))?;
            let bearer = format!("Bearer {secret}");
            let socket =
                tungstenite::accept_hdr(stream, |request: &Request, response: Response| {
                    if authenticated(request, &bearer) {
                        Ok(response)
                    } else {
                        Err(tungstenite::http::Response::builder()
                            .status(403)
                            .body(None)
                            .unwrap())
                    }
                });
            let Ok(mut socket) = socket else {
                continue;
            };
            socket
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(10)))?;
            let mut server_cmd = Command::new(&program.exe);
            server_cmd
                .args(&program.args)
                .args(["app-server", "--listen", "stdio://"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                server_cmd.creation_flags(0x0800_0000);
            }
            let mut server = Server(server_cmd.spawn().context("Codex 대화 서버 시작 실패")?);
            #[cfg(windows)]
            let _job = Job::attach(&server.0)?;
            let mut input = server.0.stdin.take().unwrap();
            let output = server.0.stdout.take().unwrap();
            let (tx, rx) = mpsc::sync_channel(64);
            thread::spawn(move || {
                let mut reader = BufReader::new(output);
                loop {
                    let mut line = String::new();
                    match reader
                        .by_ref()
                        .take(16 * 1024 * 1024 + 1)
                        .read_line(&mut line)
                    {
                        Ok(n) if n > 0 && n <= 16 * 1024 * 1024 => {
                            if tx.send(line).is_err() {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
            });
            let mut tracker = Tracker::default();
            while !stopping.load(Ordering::Relaxed) {
                for line in rx.try_iter().take(64) {
                    if let Ok(value) = serde_json::from_str(&line) {
                        if let Some(mut session) = tracker.response(&value, &home) {
                            session.args = options.clone();
                            // 본문을 복제하면 개인 대화·인증이 앱 세션 파일로 퍼질 수 있다.
                            if let Err(error) =
                                crate::rpc::collab("codex_session", json!({"session":session}))
                            {
                                eprintln!("Codex 복원 정보 저장 실패: {error}");
                            }
                        }
                    }
                    socket.send(Message::Text(line.into()))?;
                }
                if server.0.try_wait()?.is_some() {
                    bail!("Codex 대화 서버가 종료됐습니다");
                }
                match socket.read() {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str(&text) {
                            tracker.request(&value);
                        }
                        input.write_all(text.as_bytes())?;
                        input.write_all(b"\n")?;
                        input.flush()?;
                    }
                    Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => {
                        return Ok(())
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            return Ok(());
        }
        Ok(())
    });
    let result = command.status().context("Codex 터미널 시작 실패");
    stop.store(true, Ordering::Relaxed);
    if let Err(error) = worker
        .join()
        .map_err(|_| anyhow!("Codex 연결 스레드 종료"))?
    {
        eprintln!("{error:#}");
    }
    Ok(result?.code().unwrap_or(1))
}

fn authenticated(request: &Request, bearer: &str) -> bool {
    request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        == Some(bearer)
        && !request.headers().contains_key("origin")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_transport_rejects_missing_wrong_and_browser_credentials() {
        let request = |token: Option<&str>, origin: bool| {
            let mut builder = Request::builder().uri("/");
            if let Some(token) = token {
                builder = builder.header("authorization", token);
            }
            if origin {
                builder = builder.header("origin", "http://127.0.0.1");
            }
            builder.body(()).unwrap()
        };
        assert!(!authenticated(&request(None, false), "Bearer secret"));
        assert!(!authenticated(
            &request(Some("Bearer wrong"), false),
            "Bearer secret"
        ));
        assert!(!authenticated(
            &request(Some("Bearer secret"), true),
            "Bearer secret"
        ));
        assert!(authenticated(
            &request(Some("Bearer secret"), false),
            "Bearer secret"
        ));
    }

    #[test]
    fn only_the_current_threads_accepted_turn_makes_an_empty_session_resumable() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let sid = "12345678-1234-4234-8234-123456789abc";
        let mut t = Tracker::default();
        t.request(&json!({"id":1,"method":"thread/start"}));
        let s = t
            .response(
                &json!({"id":1,"result":{"thread":{"id":sid,"cwd":root}}}),
                &root,
            )
            .unwrap();
        assert!(!s.resumable);
        t.request(&json!({"id":2,"method":"turn/start","params":{"threadId":"other"}}));
        assert!(t
            .response(&json!({"id":2,"result":{"turn":{}}}), &root)
            .is_none());
        t.request(&json!({"id":3,"method":"turn/start","params":{"threadId":sid}}));
        assert!(t.response(&json!({"id":3,"error":{}}), &root).is_none());
        assert!(!t.current.as_ref().unwrap().resumable);
        t.request(&json!({"id":4,"method":"turn/start","params":{"threadId":sid}}));
        assert!(
            t.response(&json!({"id":4,"result":{"turn":{}}}), &root)
                .unwrap()
                .resumable
        );
    }
    #[test]
    fn only_matching_successful_start_resume_and_fork_responses_bind_a_session() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let mut t = Tracker::default();
        let data = json!({"id":7,"result":{"thread":{"id":"12345678-1234-4234-8234-123456789abc","cwd":root}}});
        assert!(t.response(&data, &root).is_none());
        t.request(&json!({"id":7,"method":"thread/read"}));
        assert!(t.response(&data, &root).is_none());
        for method in ["thread/start", "thread/resume", "thread/fork"] {
            t.request(&json!({"id":7,"method":method}));
            assert!(t
                .response(
                    &json!({"id":7,"method":"item/commandExecution/requestApproval"}),
                    &root
                )
                .is_none());
            assert!(t.response(&data, &root).is_some());
            assert!(t.response(&data, &root).is_none());
        }
        t.request(&json!({"id":7,"method":"thread/resume"}));
        assert!(t
            .response(&json!({"id":7,"error":{"message":"locked"}}), &root)
            .is_none());
        assert!(t.response(&data, &root).is_none());
    }

    #[test]
    fn late_start_response_does_not_replace_the_newer_selected_thread() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let mut t = Tracker::default();
        t.request(&json!({"id":"old","method":"thread/start"}));
        t.request(&json!({"id":"new","method":"thread/start"}));
        let reply = |id| json!({"id":id,"result":{"thread":{"id":"12345678-1234-4234-8234-123456789abc","cwd":root}}});
        assert!(t.response(&reply("new"), &root).is_some());
        assert!(t.response(&reply("old"), &root).is_none());
    }
}
