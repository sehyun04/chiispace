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

#[cfg(windows)]
struct SessionLock(std::os::windows::io::OwnedHandle);
#[cfg(windows)]
impl SessionLock {
    fn acquire(home: &str, id: &str) -> Result<Self> {
        use std::{
            hash::{DefaultHasher, Hash, Hasher},
            os::windows::io::FromRawHandle,
        };
        use windows_sys::Win32::{
            Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0},
            System::Threading::{CreateMutexW, WaitForSingleObject},
        };
        if !crate::codex_session::valid_id(id) {
            bail!("Codex 대화 ID가 올바르지 않습니다");
        }
        let mut hash = DefaultHasher::new();
        std::fs::canonicalize(home)?
            .to_string_lossy()
            .to_lowercase()
            .hash(&mut hash);
        let name: Vec<u16> = format!(
            "Local\\chiispace-codex-{:016x}-{}",
            hash.finish(),
            id.to_ascii_lowercase()
        )
        .encode_utf16()
        .chain(Some(0))
        .collect();
        let raw = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let handle = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) };
        match unsafe { WaitForSingleObject(raw, 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            _ => bail!(
                "다른 치이스페 칸이 사용 중인 Codex 대화입니다. 그 실행을 종료한 뒤 다시 여세요"
            ),
        }
    }
}
#[cfg(windows)]
impl Drop for SessionLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.0.as_raw_handle());
        }
    }
}

#[derive(Default)]
struct SessionLocks {
    #[cfg(windows)]
    held: HashMap<String, SessionLock>,
}
impl SessionLocks {
    fn claim(&mut self, home: &str, id: &str) -> Result<()> {
        #[cfg(windows)]
        {
            let id = id.to_ascii_lowercase();
            if !self.held.contains_key(&id) {
                self.held
                    .insert(id.clone(), SessionLock::acquire(home, &id)?);
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (home, id);
            bail!("Codex 대화 복원 잠금은 Windows에서만 지원합니다");
        }
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
    let (args, server_args, permission_overrides) = permission_args(args)?;
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
            prepare_handshake(&stream)?;
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
                .args(&server_args)
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
            // Codex 버전별 중복 복원 허용 여부와 무관하게 칸 사이의 대화 소유권을 지킨다.
            let mut locks = SessionLocks::default();
            while !stopping.load(Ordering::Relaxed) {
                for line in rx.try_iter().take(64) {
                    if let Ok(value) = serde_json::from_str(&line) {
                        if let Some(mut session) = tracker.response(&value, &home) {
                            locks.claim(&home, &session.id)?;
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
                        let mut forwarded = text.to_string();
                        if let Ok(mut value) = serde_json::from_str::<Value>(&text) {
                            if value["method"] == "thread/resume" {
                                if let Some(id) = value["params"]["threadId"].as_str() {
                                    if let Err(error) = locks.claim(&home, id) {
                                        socket.send(Message::Text(
                                            json!({"id":value["id"], "error":{
                                                "code":-32000, "message":error.to_string()
                                            }})
                                            .to_string()
                                            .into(),
                                        ))?;
                                        continue;
                                    }
                                }
                            }
                            apply_permissions(&mut value, &permission_overrides);
                            tracker.request(&value);
                            forwarded = value.to_string();
                        }
                        input.write_all(forwarded.as_bytes())?;
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

fn prepare_handshake(stream: &std::net::TcpStream) -> Result<()> {
    // Windows의 accept 소켓은 리스너의 비차단 모드를 상속할 수 있다.
    // 첫 HTTP 바이트가 아직 없다는 이유로 정상 WebSocket 연결을 닫으면 안 된다.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    Ok(())
}

fn apply_permissions(value: &mut Value, permissions: &serde_json::Map<String, Value>) {
    if matches!(
        value["method"].as_str(),
        Some("thread/start" | "thread/resume" | "thread/fork")
    ) {
        if let Some(params) = value["params"].as_object_mut() {
            // TUI의 프로필·-c 값이 명시적인 --sandbox 제한보다 우선해 권한을 넓히면 안 된다.
            params.extend(permissions.clone());
        }
    }
}

fn permission_args(
    args: Vec<String>,
) -> Result<(Vec<String>, Vec<String>, serde_json::Map<String, Value>)> {
    let mut client = Vec::new();
    let mut server = Vec::new();
    let mut permissions = serde_json::Map::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--" {
            client.push(arg);
            client.extend(args);
            break;
        }
        let (flag, attached) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
        let key = match flag {
            "--sandbox" | "-s" => Some("sandbox_mode"),
            "--ask-for-approval" | "-a" => Some("approval_policy"),
            _ => None,
        };
        if let Some(key) = key {
            let value = attached
                .map(str::to_owned)
                .or_else(|| args.next())
                .ok_or_else(|| anyhow!("{flag} 옵션 값 누락"))?;
            let valid = if key == "sandbox_mode" {
                matches!(
                    value.as_str(),
                    "read-only" | "workspace-write" | "danger-full-access"
                )
            } else {
                matches!(
                    value.as_str(),
                    "untrusted" | "on-failure" | "on-request" | "never"
                )
            };
            if !valid {
                bail!("{flag} 옵션 값이 올바르지 않습니다: {value}");
            }
            let field = if key == "sandbox_mode" {
                "sandbox"
            } else {
                "approvalPolicy"
            };
            permissions.insert(field.into(), json!(value));
            // 0.154의 원격 TUI는 복원 시 권한 플래그를 거절하므로 같은 로컬 서버에 적용한다.
            server.extend(["-c".into(), format!("{key}={}", json!(value))]);
        } else {
            let takes_value = matches!(
                flag,
                "-c" | "--config"
                    | "-m"
                    | "--model"
                    | "-p"
                    | "--profile"
                    | "-C"
                    | "--cd"
                    | "--add-dir"
                    | "--local-provider"
                    | "--enable"
                    | "--disable"
                    | "--remote"
                    | "--remote-auth-token-env"
                    | "-i"
                    | "--image"
            );
            client.push(arg.clone());
            if takes_value && attached.is_none() {
                if let Some(value) = args.next() {
                    client.push(value);
                }
            }
        }
    }
    Ok((client, server, permissions))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepted_connections_wait_for_delayed_handshake_bytes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(true).unwrap();
        let sender = thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            client.write_all(b"G").unwrap();
        });
        prepare_handshake(&stream).unwrap();
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"G");
        sender.join().unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn a_live_session_is_exclusive_and_released_with_its_owner() {
        let home = std::env::temp_dir().to_string_lossy().into_owned();
        let id = "11111111-2222-4333-8444-555555555555";
        let lock = SessionLock::acquire(&home, id).unwrap();
        let other_home = home.clone();
        assert!(
            thread::spawn(move || SessionLock::acquire(&other_home, id).is_err())
                .join()
                .unwrap()
        );
        drop(lock);
        assert!(
            thread::spawn(move || SessionLock::acquire(&home, id).is_ok())
                .join()
                .unwrap()
        );
    }
    #[test]
    fn explicit_permissions_reach_the_local_server_without_changing_prompt_arguments() {
        let args = [
            "--sandbox=read-only",
            "-a",
            "on-request",
            "-m",
            "--sandbox",
            "resume",
            "id",
            "--",
            "-s",
            "prompt",
        ];
        let (client, server, permissions) =
            permission_args(args.into_iter().map(Into::into).collect()).unwrap();
        assert_eq!(
            client,
            ["-m", "--sandbox", "resume", "id", "--", "-s", "prompt"]
        );
        assert_eq!(
            server,
            [
                "-c",
                "sandbox_mode=\"read-only\"",
                "-c",
                "approval_policy=\"on-request\""
            ]
        );
        assert!(permission_args(vec!["--sandbox".into()]).is_err());
        assert!(permission_args(vec!["-s".into(), "invalid".into()]).is_err());
        for method in ["thread/start", "thread/resume", "thread/fork"] {
            let mut request = json!({"id":1,"method":method,"params":{"sandbox":"dangerFullAccess","config":{"model":"kept"}}});
            apply_permissions(&mut request, &permissions);
            assert_eq!(request["params"]["sandbox"], "read-only");
            assert_eq!(request["params"]["approvalPolicy"], "on-request");
            assert_eq!(request["params"]["config"]["model"], "kept");
        }
        let mut request =
            json!({"method":"turn/start","params":{"sandboxPolicy":{"type":"readOnly"}}});
        let unchanged = request.clone();
        apply_permissions(&mut request, &permissions);
        assert_eq!(request, unchanged);
    }
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
