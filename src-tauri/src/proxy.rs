//! 대화창 실시간 표시를 위한 루프백 프록시.
//!
//! 칸의 claude 는 `ANTHROPIC_BASE_URL` 로 이 프록시를 부르고, 프록시는 받은 요청을
//! **그대로** 원래 가던 곳(사용자가 따로 정해 둔 주소, 없으면 공식 API)으로 넘긴다.
//! 돌아오는 SSE 도 한 바이트도 바꾸지 않고 돌려주면서, 본 대화의 스트림일 때만 옆에서
//! 줄을 읽어 웹뷰에 흘린다(`chat:live`). 대화 파일(jsonl)은 답이 끝나야 적히므로,
//! 글자가 쳐지는 동안을 보려면 이 길밖에 없다.
//!
//! - 인증 헤더는 넘기기만 하고 어디에도 남기지 않는다. 로그도 없다.
//! - 127.0.0.1 에만 연다. 자격 증명을 채워 주지 않으므로 다른 프로그램이 이 주소를
//!   써도 제 자격으로 제 요청을 보내는 것 이상은 못 한다.
//! - 이 스트림이 어느 대화 것인지는 요청 본문의 `metadata.user_id` 에 든 `session_id`
//!   가 말한다. 칸의 대화창은 명부에서 받은 대화 id 와 이것을 맞춘다 — 추측하지 않는다.
//! - `CHIISPACE_PROXY=0` 이면 띄우지 않는다. 그때 칸의 claude 는 예전처럼 직접 나간다.

use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = BoxBody<Bytes, BoxError>;

const OFFICIAL: &str = "https://api.anthropic.com";

/// 칸마다 넘기지 않고 한 칸 안에서 끝나는 헤더들. 그대로 넘기면 연결 관리가 꼬인다.
const HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
];

/// 칸의 셸에 얹을 환경 변수. 프록시를 못 띄웠거나 꺼 두었으면 비어 있다.
pub struct Proxy {
    pub env: Vec<(String, String)>,
}

struct Ctx {
    app: AppHandle,
    upstream: String,
    client: reqwest::Client,
    seq: AtomicU64,
}

/// 원래 가던 곳. 앱이 뜰 때 받은 `ANTHROPIC_BASE_URL` 이 있으면 그것이다 — 회사
/// 게이트웨이를 쓰는 사람의 요청을 공식 API 로 틀어 버리면 안 된다.
fn upstream_from(base: Option<String>) -> String {
    let base = base.unwrap_or_default();
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        OFFICIAL.to_string()
    } else {
        base.to_string()
    }
}

pub fn start(app: &AppHandle) -> Proxy {
    let off = Proxy { env: Vec::new() };
    if std::env::var("CHIISPACE_PROXY").is_ok_and(|v| v.trim() == "0") {
        return off;
    }
    // 포트를 먼저 받아 두어야 첫 칸이 뜨기 전에 주소를 넘길 수 있다.
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) else {
        return off;
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return off;
    };
    if listener.set_nonblocking(true).is_err() {
        return off;
    }
    // 긴 답은 몇 분씩 흐르므로 전체 시한은 두지 않는다. 연결만 제때 맺히면 된다.
    let Ok(client) = reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).build() else {
        return off;
    };
    let ctx = Arc::new(Ctx {
        app: app.clone(),
        upstream: upstream_from(std::env::var("ANTHROPIC_BASE_URL").ok()),
        client,
        seq: AtomicU64::new(1),
    });
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => {
                    // 파일 핸들이 바닥나는 식의 일시 오류다. 쉬지 않고 돌면 CPU 를 태운다.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let ctx = ctx.clone();
            tauri::async_runtime::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(stream);
                let svc = hyper::service::service_fn(move |req| handle(req, ctx.clone()));
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
            });
        }
    });

    let mut env = vec![("ANTHROPIC_BASE_URL".to_string(), format!("http://127.0.0.1:{port}"))];
    // claude 는 주소가 공식 API 가 아니면 도구 미뤄 싣기(ToolSearch)를 끈다. 그러면 MCP
    // 도구가 처음부터 통째로 실려 칸마다 컨텍스트를 훨씬 많이 먹는다 — 요청을 들여다보니
    // 도구 77개(MCP 43개)였던 것이 이걸 켜면 평소대로 14개로 돌아왔다. 사용자가 이 값을
    // 직접 정해 두었으면 그 뜻을 따른다.
    if std::env::var_os("ENABLE_TOOL_SEARCH").is_none() {
        env.push(("ENABLE_TOOL_SEARCH".to_string(), "true".to_string()));
    }
    Proxy { env }
}

async fn handle(req: Request<Incoming>, ctx: Arc<Ctx>) -> Result<Response<Body>, Infallible> {
    Ok(match forward(req, &ctx).await {
        Ok(r) => r,
        Err(e) => api_error(StatusCode::BAD_GATEWAY, &format!("chiispace 프록시가 상류에 닿지 못했다: {e}")),
    })
}

/// claude 가 알아보는 API 오류 모양. 맨 글자로 주면 원인 대신 파싱 실패가 보인다.
fn api_error(status: StatusCode, message: &str) -> Response<Body> {
    let body = serde_json::json!({"type":"error","error":{"type":"api_error","message":message}}).to_string();
    let mut r = Response::new(Full::new(Bytes::from(body)).map_err(|e| match e {}).boxed());
    *r.status_mut() = status;
    r.headers_mut()
        .insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    r
}

async fn forward(req: Request<Incoming>, ctx: &Arc<Ctx>) -> Result<Response<Body>, BoxError> {
    let (parts, body) = req.into_parts();
    let body = body.collect().await?.to_bytes();
    let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();
    let watched = watch(&parts.method, &path, &body);

    let mut headers = parts.headers;
    for h in HOP {
        headers.remove(*h);
    }
    headers.remove(hyper::header::CONTENT_LENGTH);
    // 압축된 SSE 는 옆에서 읽을 수 없다. 압축을 청하지 않으면 상류가 평문으로 준다.
    headers.remove(hyper::header::ACCEPT_ENCODING);

    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())?;
    let mut up = ctx.client.request(method, format!("{}{}", ctx.upstream, path)).headers(headers);
    if !body.is_empty() {
        up = up.body(body);
    }
    let resp = up.send().await?;

    let status = resp.status();
    let mut out_headers = resp.headers().clone();
    for h in HOP {
        out_headers.remove(*h);
    }
    let stream = resp.bytes_stream();
    let body: Body = match watched {
        Some(session) if status.is_success() => {
            let req_id = ctx.seq.fetch_add(1, Ordering::Relaxed);
            let mut tap = Tap::new(ctx.app.clone(), session, req_id);
            BoxBody::new(StreamBody::new(stream.map(move |r| match r {
                Ok(b) => {
                    tap.feed(&b);
                    Ok(Frame::data(b))
                }
                Err(e) => Err(Box::new(e) as BoxError),
            })))
        }
        _ => BoxBody::new(StreamBody::new(
            stream.map(|r| r.map(Frame::data).map_err(|e| Box::new(e) as BoxError)),
        )),
    };
    let mut out = Response::new(body);
    *out.status_mut() = status;
    *out.headers_mut() = out_headers;
    Ok(out)
}

/// 옆에서 읽을 요청인가. 본 대화의 스트리밍 요청이면 그 대화 id 를 준다.
fn watch(method: &Method, path: &str, body: &[u8]) -> Option<String> {
    if method != Method::POST {
        return None;
    }
    let p = path.split('?').next().unwrap_or(path);
    if !p.ends_with("/v1/messages") {
        return None;
    }
    let v: Value = serde_json::from_slice(body).ok()?;
    if v.get("stream").and_then(Value::as_bool) != Some(true) || !is_main(&v) {
        return None;
    }
    session_of(&v)
}

/// 이 스트림이 속한 대화. claude 는 `metadata.user_id` 에 JSON 문자열로
/// `{"device_id":…,"account_uuid":…,"session_id":…}` 를 싣는다. 예전 판은
/// `user_<해시>_account_<uuid>_session_<uuid>` 한 줄이었다.
fn session_of(v: &Value) -> Option<String> {
    let uid = v.pointer("/metadata/user_id")?.as_str()?;
    let sid = serde_json::from_str::<Value>(uid)
        .ok()
        .and_then(|j| j.get("session_id")?.as_str().map(str::to_owned))
        .or_else(|| uid.rsplit_once("_session_").map(|(_, s)| s.to_owned()))?;
    let shaped = sid.len() == 36 && sid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    shaped.then(|| sid.to_lowercase())
}

fn system_text(v: &Value) -> String {
    match v.get("system") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().filter_map(|b| b.get("text")?.as_str()).collect(),
        _ => String::new(),
    }
}

/// 본 대화의 요청인가. 서브에이전트·팀원·제목 짓기 같은 보조 요청도 같은 대화 id 를
/// 달고 오므로, 이걸 가르지 않으면 서브에이전트의 생각이 본 대화 말풍선에 섞인다.
/// cc-viewer 의 `isMainAgentRequest` 를 옮겼다(그쪽이 판마다 밟아 가며 다듬은 판별이다).
fn is_main(v: &Value) -> bool {
    let Some(tools) = v.get("tools").and_then(Value::as_array) else {
        return false;
    };
    let sys = system_text(v);
    if sys.is_empty() {
        return false;
    }
    let lower = sys.to_lowercase();
    if lower.contains("running as an agent in a team") || lower.contains("agent teammate communication") {
        return false;
    }
    // 2.1.181 부터 서브에이전트는 청구 머리에 이 표시를 단다. `=truex` 같은 것에 걸리지 않게 뒤를 본다.
    if let Some(i) = sys.find("cc_is_subagent=true") {
        let next = sys[i + "cc_is_subagent=true".len()..].chars().next();
        if !next.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            return false;
        }
    }
    if !sys.contains("You are Claude Code") && !sys.contains("built on Anthropic's Claude Agent SDK") {
        return false;
    }
    const SUB: &[&str] = &[
        "command execution specialist",
        "file search specialist",
        "planning specialist",
        "general-purpose agent",
        "security monitor",
        "performing a web search",
    ];
    if SUB.iter().any(|s| lower.contains(s)) {
        return false;
    }
    let has = |n: &str| tools.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(n));
    if v.get("system").is_some_and(Value::is_array) && has("ToolSearch") {
        let first = v.pointer("/messages/0/content");
        let text = match first {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a.iter().filter_map(|b| b.get("text")?.as_str()).collect(),
            _ => String::new(),
        };
        if text.contains("<available-deferred-tools>") {
            return true;
        }
    }
    tools.len() > 5 && has("Edit") && (has("Bash") || has("PowerShell")) && (has("Task") || has("Agent"))
}

/// SSE 를 줄로 자른다. 네트워크 조각은 줄 한가운데서 끊겨 오므로 남은 반 줄을 들고 있는다.
#[derive(Default)]
struct Lines {
    buf: Vec<u8>,
}

impl Lines {
    /// 이번 조각으로 완성된 `data:` 줄의 내용들.
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            // 줄이 다 모인 뒤에 글자로 바꾼다. 조각 경계에서 바꾸면 한글이 반으로 쪼개진다.
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(d) = line.strip_prefix("data:") {
                let d = d.trim_start();
                if !d.is_empty() {
                    out.push(d.to_string());
                }
            }
        }
        out
    }
}

#[derive(Serialize, Clone)]
struct Live {
    session: String,
    req: u64,
    phase: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    events: Vec<String>,
}

/// 흘러가는 스트림 하나를 옆에서 읽는 자리. 떨어질 때(다 받았든, claude 가 끊었든)
/// 끝났다고 알린다 — 그래야 말풍선의 "쓰는 중"이 걸린 채로 남지 않는다.
struct Tap {
    app: AppHandle,
    session: String,
    req: u64,
    lines: Lines,
}

impl Tap {
    fn new(app: AppHandle, session: String, req: u64) -> Self {
        let tap = Self { app, session, req, lines: Lines::default() };
        tap.emit("begin", Vec::new());
        tap
    }

    fn emit(&self, phase: &'static str, events: Vec<String>) {
        let _ = self.app.emit(
            "chat:live",
            Live { session: self.session.clone(), req: self.req, phase, events },
        );
    }

    fn feed(&mut self, chunk: &[u8]) {
        let events = self.lines.push(chunk);
        if !events.is_empty() {
            self.emit("data", events);
        }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.emit("end", Vec::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tools(names: &[&str]) -> Value {
        Value::Array(names.iter().map(|n| json!({"name": n})).collect())
    }

    fn main_body() -> Value {
        json!({
            "stream": true,
            "system": [{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280"},{"type":"text","text":"You are Claude Code, Anthropic's official CLI"}],
            "tools": tools(&["Agent","Bash","Edit","Glob","Grep","Read","Write","ToolSearch"]),
            "metadata": {"user_id": "{\"device_id\":\"d\",\"account_uuid\":\"a\",\"session_id\":\"C12278F4-E932-4BA5-B3CC-00AAAC5B495E\"}"},
            "messages": [{"role":"user","content":"hi"}],
        })
    }

    #[test]
    fn keeps_the_users_gateway() {
        assert_eq!(upstream_from(None), OFFICIAL);
        assert_eq!(upstream_from(Some("  ".into())), OFFICIAL);
        assert_eq!(upstream_from(Some("https://gw.example/anthropic/".into())), "https://gw.example/anthropic");
    }

    #[test]
    fn reads_the_session_from_both_shapes() {
        assert_eq!(session_of(&main_body()).as_deref(), Some("c12278f4-e932-4ba5-b3cc-00aaac5b495e"));
        let old = json!({"metadata":{"user_id":"user_abc_account_x_session_c12278f4-e932-4ba5-b3cc-00aaac5b495e"}});
        assert_eq!(session_of(&old).as_deref(), Some("c12278f4-e932-4ba5-b3cc-00aaac5b495e"));
        // 모양이 다르면 대화 id 로 쓰지 않는다.
        let bad = json!({"metadata":{"user_id":"{\"session_id\":\"../../x\"}"}});
        assert_eq!(session_of(&bad), None);
    }

    #[test]
    fn only_the_main_conversation_is_watched() {
        let body = main_body();
        assert!(is_main(&body));
        let path = "/v1/messages?beta=true";
        assert!(watch(&Method::POST, path, body.to_string().as_bytes()).is_some());
        // 스트림이 아니거나 다른 경로면 읽지 않는다.
        let mut quiet = body.clone();
        quiet["stream"] = json!(false);
        assert!(watch(&Method::POST, path, quiet.to_string().as_bytes()).is_none());
        assert!(watch(&Method::POST, "/v1/messages/count_tokens", body.to_string().as_bytes()).is_none());
        assert!(watch(&Method::GET, path, body.to_string().as_bytes()).is_none());
    }

    #[test]
    fn subagents_and_helpers_are_not_the_main_conversation() {
        let mut sub = main_body();
        sub["system"][0]["text"] = json!("x-anthropic-billing-header: cc_version=2.1.280; cc_is_subagent=true;");
        assert!(!is_main(&sub));
        let mut spec = main_body();
        spec["system"][1]["text"] = json!("You are Claude Code. You are a file search specialist.");
        assert!(!is_main(&spec));
        let mut team = main_body();
        team["system"][1]["text"] = json!("You are Claude Code. You are running as an agent in a team.");
        assert!(!is_main(&team));
        // 도구 없이 한 번 묻는 제목 짓기 같은 것.
        let mut helper = main_body();
        helper["tools"] = tools(&[]);
        assert!(!is_main(&helper));
        // 표시 뒤에 글자가 더 붙은 것은 서브에이전트 표시가 아니다.
        let mut near = main_body();
        near["system"][0]["text"] = json!("cc_is_subagent=truex");
        assert!(is_main(&near));
    }

    #[test]
    fn lines_survive_any_chunk_boundary() {
        let whole = "event: content_block_delta\r\ndata: {\"t\":\"한글\"}\r\n\r\ndata: {\"t\":2}\n\n: ping\n";
        let bytes = whole.as_bytes();
        for cut in 0..=bytes.len() {
            let mut l = Lines::default();
            let mut got = l.push(&bytes[..cut]);
            got.extend(l.push(&bytes[cut..]));
            assert_eq!(got, vec!["{\"t\":\"한글\"}".to_string(), "{\"t\":2}".to_string()], "cut at {cut}");
        }
    }
}
