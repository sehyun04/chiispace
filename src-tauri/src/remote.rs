//! 밖에서 폰으로 쓰는 길 — 이 PC 에 떠 있는 Claude 대화창을 폰 브라우저에 그대로 보인다.
//!
//! - 127.0.0.1 에만 연다. 밖에서 닿는 길은 사용자가 깐 Tailscale 의 `tailscale serve` 가 사설망 안에서만
//!   HTTPS 로 받아 여기로 넘기는 것이다. 앱이 인터넷에 포트를 열지 않는다.
//! - 그 위에 짝짓기를 한 겹 더 둔다. PC 에 뜬 여섯 자리를 폰이 넣으면 기기 토큰을 주고, 그 뒤로는 토큰만 받는다.
//!   번호는 5분이 지나거나 다섯 번 틀리면 버린다. 토큰은 해시만 적는다(세션 파일 옆 `remote.json`).
//! - 폰이 부를 수 있는 것은 `dispatch` 의 목록뿐이다. 대화창이 쓰는 읽기·보내기만 열고, 칸을 띄우거나 끄는 길·
//!   파일을 열거나 쓰는 길·설정을 바꾸는 길은 열지 않는다. 읽기도 PC 가 알려 준 칸의 대화로 좁힌다.
//! - 대화 내용이 지나가므로 어디에도 기록하지 않는다.
//!
//! 폰 화면(ui/mobile.tsx)은 PC 대화창 부품을 그대로 쓰고 `invoke`·`listen` 만 이 서버로 바꿔 끼운다
//! (ui/remote-shim.ts). 부품을 폰용으로 따로 짜면 같은 대화를 PC 와 폰이 다르게 그린다.

use std::convert::Infallible;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::broadcast;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = BoxBody<Bytes, BoxError>;

/// 기본 포트. `tailscale serve` 설정에 박히므로 켤 때마다 바뀌면 안 된다.
pub const DEFAULT_PORT: u16 = 47321;
const CODE_LIFE: Duration = Duration::from_secs(300);
const CODE_TRIES: u8 = 5;
/// 폰이 받는 대화 원문의 끝부분. 대화창은 파일이 자랄 때마다 원문을 통째로 다시 받는다 — 휴대폰 망에서는 짧게.
const PHONE_TAIL: u64 = 2 * 1024 * 1024;
/// 그림 몇 장이 실린 말까지. 입력바가 그림 한 장을 3.75MB 안으로 줄인다(ui/images.ts).
const BODY_LIMIT: usize = 32 * 1024 * 1024;
/// 폰으로 넘기는 이벤트. 대화창이 듣는 것뿐이다.
const EVENTS: &[&str] = &["claude:chat", "claude:chat-exit", "claude:chat-answered", "chat:live", "chat:sub"];
/// 폰이 보낼 수 있는 제어 요청. 하던 일 멈추기만 연다 — 모델·권한 모드 바꾸기는 PC 에서 한다.
const PHONE_CONTROLS: &[&str] = &["interrupt"];

#[derive(Serialize, Deserialize, Default, Clone)]
struct Saved {
    #[serde(default)]
    on: bool,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    devices: Vec<Device>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Device {
    id: String,
    name: String,
    /// 토큰의 SHA-256. 토큰 자체는 폰에만 있다.
    hash: String,
    added: u64,
}

/// PC 웹뷰가 알려 주는 Claude 대화창 칸. 폰은 이 칸들만 보고 이 칸들의 대화만 읽는다.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub session: String,
    pub slug: Option<String>,
    pub name: Option<String>,
}

struct Code {
    digits: String,
    until: Instant,
    tries: u8,
}

struct Running {
    port: u16,
    epoch: u64,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct Inner {
    saved: Saved,
    file: Option<PathBuf>,
    code: Option<Code>,
    panes: Vec<PaneInfo>,
    running: Option<Running>,
    error: Option<String>,
}

pub struct Remote {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Msg>,
    clients: AtomicUsize,
    epoch: AtomicU64,
}

#[derive(Clone)]
enum Msg {
    Frame(Arc<str>),
    /// 서버를 끄거나 기기를 잊었다. 붙어 있는 스트림은 제 자격을 다시 본다.
    Recheck,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    on: bool,
    port: u16,
    running: bool,
    error: Option<String>,
    code: Option<String>,
    code_left: u64,
    devices: Vec<DeviceView>,
    clients: usize,
}

#[derive(Serialize)]
struct DeviceView {
    id: String,
    name: String,
    added: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| format!("난수를 못 얻었다: {e}"))?;
    Ok(b)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

/// 길이가 같을 때 앞에서부터 다른 글자를 찾느라 걸리는 시간이 새지 않게 끝까지 본다.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 폰이 붙는 주소의 호스트. 이 PC 루프백이거나 Tailscale 이 준 이름(`*.ts.net`)만 받는다 —
/// 다른 이름으로 들어온 요청은 DNS 를 바꿔치기해 루프백으로 돌린 남의 웹 페이지일 수 있다.
fn allowed_host(host: &str, port: u16) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let name = host.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(host.as_str(), |(n, _)| n);
    if name == "127.0.0.1" || name == "localhost" {
        return host == format!("{name}:{port}");
    }
    let name = name.trim_end_matches('.');
    name.ends_with(".ts.net") && name.len() > ".ts.net".len()
}

/// 브라우저가 붙여 보내는 출처. 있으면 받는 호스트와 같은 범위여야 한다.
fn allowed_origin(origin: &str, port: u16) -> bool {
    let rest = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://"));
    rest.is_some_and(|h| !h.contains('/') && allowed_host(h, port))
}

/// 폰이 칸에 보낼 수 있는 줄인가. 말은 그대로, 권한 답은 그 칸이 지금 기다리는 요청에만, 제어는 멈추기만.
fn phone_line(line: &str, waiting: impl Fn(&str) -> bool) -> Result<(), &'static str> {
    let v: Value = serde_json::from_str(line).map_err(|_| "줄이 JSON 이 아니다")?;
    match v.get("type").and_then(Value::as_str) {
        Some("user") => Ok(()),
        Some("control_response") => {
            let id = v.pointer("/response/request_id").and_then(Value::as_str).ok_or("답할 요청이 없다")?;
            if waiting(id) { Ok(()) } else { Err("이미 답했거나 없는 요청이다") }
        }
        Some("control_request") => {
            let sub = v.pointer("/request/subtype").and_then(Value::as_str).unwrap_or("");
            if PHONE_CONTROLS.contains(&sub) { Ok(()) } else { Err("폰에서는 할 수 없는 요청이다") }
        }
        _ => Err("보낼 수 없는 줄"),
    }
}

/// 폰으로 넘길 이벤트 한 덩이(SSE). 알려 준 칸의 것만 넘긴다.
fn frame_for(name: &str, payload: &str, panes: &[PaneInfo]) -> Option<String> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let pane = || v.get("id").and_then(Value::as_str).is_some_and(|id| panes.iter().any(|p| p.id == id));
    let ok = match name {
        // 쓰이는 중인 답의 조각은 프록시(chat:live)가 더 가볍게 준다. 휴대폰 망에 두 번 싣지 않는다.
        "claude:chat" => pane() && !v.get("line").and_then(Value::as_str).unwrap_or("").starts_with(r#"{"type":"stream_event""#),
        "claude:chat-exit" | "claude:chat-answered" => pane(),
        "chat:live" | "chat:sub" => v
            .get("session")
            .and_then(Value::as_str)
            .is_some_and(|s| panes.iter().any(|p| p.session.eq_ignore_ascii_case(s))),
        _ => false,
    };
    ok.then(|| sse(name, payload))
}

fn sse(event: &str, payload: &str) -> String {
    format!("data: {{\"event\":{},\"payload\":{payload}}}\n\n", json!(event))
}

impl Remote {
    pub fn load(app: &AppHandle) -> Self {
        let file = crate::workspace::state_file(app).map(|p| p.with_file_name("remote.json"));
        let saved = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let (tx, _) = broadcast::channel(512);
        Self {
            inner: Mutex::new(Inner { saved, file, code: None, panes: Vec::new(), running: None, error: None }),
            tx,
            clients: AtomicUsize::new(0),
            epoch: AtomicU64::new(0),
        }
    }

    fn status(&self) -> Status {
        let inner = self.inner.lock().unwrap();
        let code = inner.code.as_ref().filter(|c| c.until > Instant::now());
        Status {
            on: inner.saved.on,
            port: inner.running.as_ref().map_or(inner.saved.port.unwrap_or(DEFAULT_PORT), |r| r.port),
            running: inner.running.is_some(),
            error: inner.error.clone(),
            code: code.map(|c| c.digits.clone()),
            code_left: code.map_or(0, |c| c.until.saturating_duration_since(Instant::now()).as_secs()),
            devices: inner
                .saved
                .devices
                .iter()
                .map(|d| DeviceView { id: d.id.clone(), name: d.name.clone(), added: d.added })
                .collect(),
            clients: self.clients.load(Ordering::Relaxed),
        }
    }

    fn save(inner: &Inner) {
        let Some(file) = &inner.file else { return };
        if let Ok(json) = serde_json::to_string_pretty(&inner.saved) {
            let _ = std::fs::write(file, json);
        }
    }

    /// 토큰이 가리키는 기기 id.
    fn device_of(&self, token: &str) -> Option<String> {
        let h = hash(token);
        let inner = self.inner.lock().unwrap();
        inner.saved.devices.iter().find(|d| same(&d.hash, &h)).map(|d| d.id.clone())
    }

    fn still(&self, device: &str, epoch: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.running.as_ref().is_some_and(|r| r.epoch == epoch) && inner.saved.devices.iter().any(|d| d.id == device)
    }

    fn panes(&self) -> Vec<PaneInfo> {
        self.inner.lock().unwrap().panes.clone()
    }

    fn pair(&self, code: &str, name: &str) -> Result<String, &'static str> {
        let mut inner = self.inner.lock().unwrap();
        let Some(c) = inner.code.as_mut() else { return Err("PC 에서 짝짓기 번호를 먼저 받아야 한다") };
        if c.until <= Instant::now() {
            inner.code = None;
            return Err("번호가 지났다 — PC 에서 새 번호를 받아라");
        }
        if !same(&c.digits, code.trim()) {
            c.tries += 1;
            if c.tries >= CODE_TRIES {
                inner.code = None;
                return Err("여러 번 틀려 번호를 버렸다 — PC 에서 새 번호를 받아라");
            }
            return Err("번호가 틀렸다");
        }
        inner.code = None;
        let token = hex(&random_bytes::<32>().map_err(|_| "토큰을 못 만들었다")?);
        let id = hex(&random_bytes::<6>().map_err(|_| "토큰을 못 만들었다")?);
        let name: String = name.chars().filter(|c| !c.is_control()).take(40).collect::<String>().trim().to_string();
        inner.saved.devices.push(Device {
            id,
            name: if name.is_empty() { "폰".into() } else { name },
            hash: hash(&token),
            added: now_secs(),
        });
        Self::save(&inner);
        Ok(token)
    }
}

/// 앱이 뜰 때. 이벤트를 넘길 귀를 달고, 켜 두었으면 서버를 띄운다.
pub fn boot(app: &AppHandle) {
    for name in EVENTS {
        let handle = app.clone();
        app.listen_any(*name, move |e| {
            let remote = handle.state::<Remote>();
            // 붙은 폰이 없으면 뜯어 보지도 않는다. 이 귀는 PC 대화창의 모든 줄마다 불린다.
            if remote.clients.load(Ordering::Relaxed) == 0 {
                return;
            }
            let frame = {
                let inner = remote.inner.lock().unwrap();
                frame_for(name, e.payload(), &inner.panes)
            };
            if let Some(f) = frame {
                let _ = remote.tx.send(Msg::Frame(f.into()));
            }
        });
    }
    let on = app.state::<Remote>().inner.lock().unwrap().saved.on;
    if on {
        start(app);
    }
}

fn start(app: &AppHandle) {
    let remote = app.state::<Remote>();
    let mut inner = remote.inner.lock().unwrap();
    if inner.running.is_some() {
        return;
    }
    let port = inner.saved.port.unwrap_or(DEFAULT_PORT);
    let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            inner.error = Some(format!("127.0.0.1:{port} 를 못 열었다 — {e}"));
            return;
        }
    };
    if let Err(e) = listener.set_nonblocking(true) {
        inner.error = Some(format!("서버를 못 띄웠다 — {e}"));
        return;
    }
    let epoch = remote.epoch.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(stream);
                let svc = hyper::service::service_fn(move |req| handle_request(req, app.clone(), epoch, port));
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
            });
        }
    });
    inner.error = None;
    inner.running = Some(Running { port, epoch, task });
}

fn stop(app: &AppHandle) {
    let remote = app.state::<Remote>();
    let running = remote.inner.lock().unwrap().running.take();
    if let Some(r) = running {
        r.task.abort();
    }
    let _ = remote.tx.send(Msg::Recheck);
}

#[tauri::command]
pub fn remote_status(app: AppHandle) -> Status {
    app.state::<Remote>().status()
}

/// 켜고 끄기. 다음에 앱을 켤 때도 그대로다.
#[tauri::command]
pub fn remote_switch(app: AppHandle, on: bool) -> Status {
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.inner.lock().unwrap();
        inner.saved.on = on;
        if !on {
            inner.code = None;
            inner.error = None;
        }
        Remote::save(&inner);
    }
    if on { start(&app) } else { stop(&app) }
    app.state::<Remote>().status()
}

/// 새 짝짓기 번호. 앞 번호는 버린다.
#[tauri::command]
pub fn remote_new_code(app: AppHandle) -> Result<Status, String> {
    let remote = app.state::<Remote>();
    {
        let mut inner = remote.inner.lock().unwrap();
        if inner.running.is_none() {
            return Err("폰 연결을 먼저 켜야 한다".into());
        }
        let n = u32::from_le_bytes(random_bytes::<4>()?) % 1_000_000;
        inner.code = Some(Code { digits: format!("{n:06}"), until: Instant::now() + CODE_LIFE, tries: 0 });
    }
    Ok(remote.status())
}

/// 짝지은 폰 잊기. 기기를 주지 않으면 모두. 붙어 있던 스트림도 끊긴다.
#[tauri::command]
pub fn remote_forget(app: AppHandle, device: Option<String>) -> Status {
    let remote = app.state::<Remote>();
    {
        let mut inner = remote.inner.lock().unwrap();
        match &device {
            Some(id) => inner.saved.devices.retain(|d| &d.id != id),
            None => inner.saved.devices.clear(),
        }
        Remote::save(&inner);
    }
    let _ = remote.tx.send(Msg::Recheck);
    remote.status()
}

/// PC 웹뷰가 지금 떠 있는 Claude 대화창 칸을 알려 준다. 바뀌면 폰 목록도 바뀐다.
#[tauri::command]
pub fn remote_publish(app: AppHandle, panes: Vec<PaneInfo>) {
    let remote = app.state::<Remote>();
    let changed = {
        let mut inner = remote.inner.lock().unwrap();
        let changed = inner.panes != panes;
        inner.panes = panes;
        changed
    };
    if changed && remote.clients.load(Ordering::Relaxed) > 0 {
        let _ = remote.tx.send(Msg::Frame(sse("remote:panes", "null").into()));
    }
}

// ── HTTP ────────────────────────────────────────────────────────

fn header<'a>(req: &'a Request<Incoming>, name: &str) -> &'a str {
    req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

fn respond(status: StatusCode, kind: &str, body: Vec<u8>, gzip: bool) -> Response<Body> {
    let mut b = Response::builder()
        .status(status)
        .header("content-type", kind)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer");
    // 원문(JSON)과 앱 묶음(JS)은 다섯 배쯤 준다. 휴대폰 망에서는 그만큼 빨리 뜬다.
    let body = if gzip && body.len() > 1024 {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        match enc.write_all(&body).and_then(|_| enc.finish()) {
            Ok(z) => {
                b = b.header("content-encoding", "gzip");
                z
            }
            Err(_) => body,
        }
    } else {
        body
    };
    b.body(Full::new(Bytes::from(body)).map_err(|e| match e {}).boxed()).unwrap()
}

fn json_reply(status: StatusCode, v: &Value, gzip: bool) -> Response<Body> {
    respond(status, "application/json; charset=utf-8", v.to_string().into_bytes(), gzip)
}

fn fail(status: StatusCode, msg: &str) -> Response<Body> {
    json_reply(status, &json!({ "error": msg }), false)
}

async fn read_json(req: Request<Incoming>) -> Option<Value> {
    let bytes = Limited::new(req.into_body(), BODY_LIMIT).collect().await.ok()?.to_bytes();
    serde_json::from_slice(&bytes).ok()
}

async fn handle_request(req: Request<Incoming>, app: AppHandle, epoch: u64, port: u16) -> Result<Response<Body>, Infallible> {
    let remote = app.state::<Remote>();
    // 끈 뒤에 남은 연결로 들어온 요청은 받지 않는다.
    if remote.inner.lock().unwrap().running.as_ref().is_none_or(|r| r.epoch != epoch) {
        return Ok(fail(StatusCode::SERVICE_UNAVAILABLE, "폰 연결이 꺼져 있다"));
    }
    let origin = header(&req, "origin");
    if !allowed_host(header(&req, "host"), port) || (!origin.is_empty() && !allowed_origin(origin, port)) {
        return Ok(fail(StatusCode::FORBIDDEN, "이 주소로는 받지 않는다"));
    }
    let gzip = header(&req, "accept-encoding").contains("gzip");
    let path = req.uri().path().to_string();
    let device = header(&req, "authorization").strip_prefix("Bearer ").and_then(|t| remote.device_of(t.trim()));
    Ok(match (req.method().clone(), path.as_str()) {
        (Method::POST, "/api/pair") => {
            let body = read_json(req).await.unwrap_or(Value::Null);
            let code = body.get("code").and_then(Value::as_str).unwrap_or("");
            let name = body.get("name").and_then(Value::as_str).unwrap_or("");
            match remote.pair(code, name) {
                Ok(token) => json_reply(StatusCode::OK, &json!({ "token": token }), false),
                Err(e) => fail(StatusCode::FORBIDDEN, e),
            }
        }
        (Method::POST, "/api/invoke") => {
            if device.is_none() {
                return Ok(fail(StatusCode::UNAUTHORIZED, "짝지은 폰이 아니다"));
            }
            let Some(body) = read_json(req).await else { return Ok(fail(StatusCode::BAD_REQUEST, "요청을 못 읽었다")) };
            let cmd = body.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
            let args = body.get("args").cloned().unwrap_or(Value::Null);
            let app2 = app.clone();
            let out = tauri::async_runtime::spawn_blocking(move || dispatch(&app2, &cmd, &args))
                .await
                .unwrap_or_else(|_| Err("처리하다 멈췄다".into()));
            match out {
                Ok(v) => json_reply(StatusCode::OK, &v, gzip),
                Err(e) => fail(StatusCode::BAD_REQUEST, &e),
            }
        }
        (Method::GET, "/api/events") => match device {
            Some(d) => events(&app, d, epoch),
            None => fail(StatusCode::UNAUTHORIZED, "짝지은 폰이 아니다"),
        },
        (Method::GET, p) => asset(&app, p, gzip),
        _ => fail(StatusCode::METHOD_NOT_ALLOWED, "받지 않는 요청"),
    })
}

/// 폰 화면 파일. 앱에 구워 넣은 화면 묶음(dist)에서 꺼낸다 — 데스크톱 첫 화면(index.html)은 내주지 않는다.
fn asset(app: &AppHandle, path: &str, gzip: bool) -> Response<Body> {
    let name = match path {
        "/" | "/index.html" => "mobile.html",
        p => p.trim_start_matches('/'),
    };
    let ok = name == "mobile.html"
        || name == "mobile.webmanifest"
        || name == "mobile-icon.png"
        || (name.starts_with("assets/") && !name.contains(".."));
    if !ok {
        return fail(StatusCode::NOT_FOUND, "없는 파일");
    }
    match app.asset_resolver().get(name.to_string()) {
        Some(a) => {
            let kind = if name.ends_with(".webmanifest") { "application/manifest+json".to_string() } else { a.mime_type().to_string() };
            let mut res = respond(StatusCode::OK, &kind, a.bytes().to_vec(), gzip);
            if name.starts_with("assets/") {
                // 묶음 파일 이름에 내용 해시가 들어 있다. 판이 바뀌면 이름도 바뀌므로 오래 둬도 된다.
                res.headers_mut().insert("cache-control", "public, max-age=31536000, immutable".parse().unwrap());
            }
            if name == "mobile.html" {
                res.headers_mut().insert(
                    "content-security-policy",
                    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
                        .parse()
                        .unwrap(),
                );
            }
            res
        }
        // 개발 판(vite)은 화면을 굽지 않는다. 폰 화면은 구운 판에서만 나온다.
        None => fail(StatusCode::NOT_FOUND, "화면 파일이 없다 — 구운 앱에서만 열린다"),
    }
}

/// 폰이 듣는 이벤트 스트림(SSE). 15초마다 숨 쉬는 줄을 보내 Tailscale·휴대폰 망이 연결을 끊지 않게 한다.
fn events(app: &AppHandle, device: String, epoch: u64) -> Response<Body> {
    struct Client {
        app: AppHandle,
        rx: broadcast::Receiver<Msg>,
        device: String,
        epoch: u64,
        hello: bool,
    }
    impl Drop for Client {
        fn drop(&mut self) {
            self.app.state::<Remote>().clients.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let remote = app.state::<Remote>();
    let rx = remote.tx.subscribe();
    remote.clients.fetch_add(1, Ordering::Relaxed);
    let client = Client { app: app.clone(), rx, device, epoch, hello: true };
    let stream = futures_util::stream::unfold(client, |mut c| async move {
        if c.hello {
            c.hello = false;
            return Some((Bytes::from_static(b": hello\n\n"), c));
        }
        loop {
            match tokio::time::timeout(Duration::from_secs(15), c.rx.recv()).await {
                Err(_) => {
                    if !c.app.state::<Remote>().still(&c.device, c.epoch) {
                        return None;
                    }
                    return Some((Bytes::from_static(b": ping\n\n"), c));
                }
                Ok(Ok(Msg::Frame(f))) => return Some((Bytes::from(f.as_bytes().to_vec()), c)),
                Ok(Ok(Msg::Recheck)) => {
                    if !c.app.state::<Remote>().still(&c.device, c.epoch) {
                        return None;
                    }
                }
                // 폰이 못 따라와 놓친 이벤트가 있다. 화면이 지금 상태를 다시 받아 가게 한다.
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => return Some((Bytes::from(sse("remote:resync", "null")), c)),
                Ok(Err(broadcast::error::RecvError::Closed)) => return None,
            }
        }
    });
    let body = StreamBody::new(stream.map(|b| Ok::<_, BoxError>(Frame::data(b))));
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .body(BoxBody::new(body))
        .unwrap()
}

// ── 폰이 부를 수 있는 명령 ───────────────────────────────────────

/// 폰 칸 목록 한 줄. PC 가 알려 준 것에 통로의 지금 상태를 얹는다.
#[derive(Serialize)]
struct PhonePane {
    #[serde(flatten)]
    info: PaneInfo,
    alive: bool,
    busy: bool,
    waiting: usize,
}

fn dispatch(app: &AppHandle, cmd: &str, args: &Value) -> Result<Value, String> {
    let panes = app.state::<Remote>().panes();
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let pane = |id: &str| panes.iter().find(|p| p.id == id).cloned().ok_or_else(|| "PC 에 없는 칸이다".to_string());
    // 대화 읽기는 알려 준 칸의 대화만. 폰 토큰으로 이 PC 의 다른 대화를 뒤지지 못하게 한다.
    let conversation = || {
        let (root, id) = (s("root"), s("id"));
        if panes.iter().any(|p| p.cwd == root && p.session.eq_ignore_ascii_case(&id)) {
            Ok((root, id))
        } else {
            Err("PC 칸의 대화가 아니다".to_string())
        }
    };
    match cmd {
        "remote_panes" => Ok(json!(panes
            .iter()
            .map(|p| {
                let snap = crate::claude_chat::snapshot(app, &p.id);
                PhonePane { info: p.clone(), alive: snap.alive, busy: snap.busy, waiting: snap.prompts.len() }
            })
            .collect::<Vec<_>>())),
        "claude_chat_snapshot" => {
            let p = pane(&s("id"))?;
            Ok(json!(crate::claude_chat::snapshot(app, &p.id)))
        }
        "claude_chat_send" => {
            let p = pane(&s("id"))?;
            let line = s("line");
            phone_line(&line, |r| crate::claude_chat::waiting_for(app, &p.id, r))?;
            crate::claude_chat::send_line(app, &p.id, &line).map(|_| Value::Null)
        }
        "claude_transcript_raw" => {
            let (root, id) = conversation()?;
            Ok(json!(crate::claude_files::transcript_tail(app, &root, &id, PHONE_TAIL)))
        }
        "claude_transcript_size" => {
            let (root, id) = conversation()?;
            Ok(json!(crate::claude_files::claude_transcript_size(app.clone(), root, id)))
        }
        "claude_subagents" => {
            let (root, id) = conversation()?;
            Ok(json!(crate::claude_files::claude_subagents(app.clone(), root, id)))
        }
        "claude_subagent_raw" => {
            let (root, id) = conversation()?;
            Ok(json!(crate::claude_files::claude_subagent_raw(app.clone(), root, id, s("agent"))))
        }
        "claude_subagent_size" => {
            let (root, id) = conversation()?;
            Ok(json!(crate::claude_files::claude_subagent_size(app.clone(), root, id, s("agent"))))
        }
        _ => Err(format!("폰에서는 부를 수 없는 명령이다: {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panes() -> Vec<PaneInfo> {
        vec![PaneInfo {
            id: "%3".into(),
            title: "t".into(),
            cwd: "C:/work".into(),
            session: "12345678-1234-4234-8234-123456789abc".into(),
            slug: None,
            name: None,
        }]
    }

    #[test]
    fn only_loopback_and_tailnet_names_are_served() {
        assert!(allowed_host("127.0.0.1:47321", 47321));
        assert!(allowed_host("localhost:47321", 47321));
        assert!(allowed_host("desk.tail1234.ts.net", 47321));
        assert!(allowed_host("Desk.Tail1234.TS.NET:443", 47321));
        // 다른 포트의 루프백은 이 서버가 아니다. 이름을 바꿔치기한 남의 페이지도 받지 않는다.
        assert!(!allowed_host("127.0.0.1:1420", 47321));
        assert!(!allowed_host("evil.example:47321", 47321));
        assert!(!allowed_host("ts.net", 47321));
        assert!(!allowed_host("evil.ts.net.example.com", 47321));
        assert!(!allowed_host("", 47321));
        assert!(allowed_origin("https://desk.tail1234.ts.net", 47321));
        assert!(allowed_origin("http://127.0.0.1:47321", 47321));
        assert!(!allowed_origin("https://evil.example", 47321));
        assert!(!allowed_origin("null", 47321));
        assert!(!allowed_origin("https://desk.tail1234.ts.net/x", 47321));
    }

    #[test]
    fn the_phone_sends_words_answers_to_open_prompts_and_stop_only() {
        let waiting = |id: &str| id == "r1";
        assert!(phone_line(r#"{"type":"user","message":{"role":"user","content":"hi"}}"#, waiting).is_ok());
        assert!(phone_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{}}}"#, waiting).is_ok());
        assert!(phone_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r9","response":{}}}"#, waiting).is_err());
        assert!(phone_line(r#"{"type":"control_request","request_id":"a","request":{"subtype":"interrupt"}}"#, waiting).is_ok());
        for sub in ["set_permission_mode", "set_model", "apply_flag_settings", "initialize", "mcp_message"] {
            let line = format!(r#"{{"type":"control_request","request_id":"a","request":{{"subtype":"{sub}"}}}}"#);
            assert!(phone_line(&line, waiting).is_err(), "{sub}");
        }
        assert!(phone_line(r#"{"type":"system"}"#, waiting).is_err());
        assert!(phone_line("hi", waiting).is_err());
    }

    #[test]
    fn only_the_published_panes_reach_the_phone() {
        let p = panes();
        let line = |id: &str, l: &str| json!({ "id": id, "line": l }).to_string();
        assert!(frame_for("claude:chat", &line("%3", r#"{"type":"assistant"}"#), &p).is_some_and(|f| f.starts_with("data: {\"event\":\"claude:chat\",\"payload\":{")));
        assert!(frame_for("claude:chat", &line("%9", r#"{"type":"assistant"}"#), &p).is_none());
        assert!(frame_for("claude:chat", &line("%3", r#"{"type":"stream_event","event":{}}"#), &p).is_none());
        assert!(frame_for("claude:chat-answered", &json!({"id":"%3","request_id":"r"}).to_string(), &p).is_some());
        assert!(frame_for("claude:chat-exit", &json!({"id":"%4","code":0,"error":""}).to_string(), &p).is_none());
        let live = |s: &str| json!({"session": s, "req": 1, "phase": "begin", "events": []}).to_string();
        assert!(frame_for("chat:live", &live("12345678-1234-4234-8234-123456789ABC"), &p).is_some());
        assert!(frame_for("chat:live", &live("00000000-0000-4000-8000-000000000000"), &p).is_none());
        assert!(frame_for("pty:data", &json!({"id":"%3"}).to_string(), &p).is_none());
        assert!(frame_for("claude:chat", "not json", &p).is_none());
    }

    #[test]
    fn tokens_are_kept_as_hashes_and_compared_whole() {
        let h = hash("abc");
        assert_eq!(h.len(), 64);
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(same(&h, &hash("abc")));
        assert!(!same(&h, &hash("abd")));
        assert!(!same("ab", "abc"));
    }

    #[test]
    fn a_pairing_code_dies_after_five_misses_or_one_use() {
        let (tx, _) = broadcast::channel(4);
        let remote = Remote {
            inner: Mutex::new(Inner { saved: Saved::default(), file: None, code: None, panes: Vec::new(), running: None, error: None }),
            tx,
            clients: AtomicUsize::new(0),
            epoch: AtomicU64::new(0),
        };
        assert!(remote.pair("123456", "폰").is_err());
        let set = |d: &str| remote.inner.lock().unwrap().code = Some(Code { digits: d.into(), until: Instant::now() + CODE_LIFE, tries: 0 });
        set("123456");
        for _ in 0..4 {
            assert_eq!(remote.pair("000000", "폰"), Err("번호가 틀렸다"));
        }
        assert!(remote.pair("000000", "폰").unwrap_err().contains("버렸다"));
        assert!(remote.pair("123456", "폰").is_err(), "버린 번호는 맞아도 안 된다");
        set("123456");
        let token = remote.pair(" 123456 ", "iPhone\u{7}").unwrap();
        assert_eq!(token.len(), 64);
        assert!(remote.pair("123456", "폰").is_err(), "한 번 쓴 번호는 끝이다");
        let saved = remote.inner.lock().unwrap().saved.clone();
        assert_eq!(saved.devices.len(), 1);
        assert_eq!(saved.devices[0].name, "iPhone");
        assert_ne!(saved.devices[0].hash, token, "토큰을 그대로 적지 않는다");
        assert!(remote.device_of(&token).is_some());
        assert!(remote.device_of("x").is_none());
        // 지난 번호.
        remote.inner.lock().unwrap().code = Some(Code { digits: "111111".into(), until: Instant::now(), tries: 0 });
        assert!(remote.pair("111111", "폰").unwrap_err().contains("지났다"));
    }
}
