//! 밖에서 폰으로 쓰는 길 — 이 PC 에 떠 있는 대화창을 폰 화면(ui/Mobile.tsx)에 보인다.
//!
//! - 집 PC 는 아무 포트도 열지 않는다. PC 앱이 사용자의 Cloudflare 중계(relay/)에 먼저 웹소켓으로 붙고, 폰도 그 중계로 온다.
//!   중계 주소는 사용자가 [폰 연결]에 넣는다. 중계를 올리는 일(가입·로그인·배포)은 사용자가 한다 — 앱은 그 인증을 받지 않는다.
//! - 폰과 PC 는 짝지을 때 키를 바꾸고(remote_crypto.rs), 그 뒤 오가는 말은 그 키로 암호화한다. 중계는 암호문만 나른다.
//!   짝짓기는 PC 에서 [폰 짝짓기]를 누른 5분 동안만 받고, 두 화면의 여섯 자리가 같은지 사람이 보고 PC 에서 허락해야 끝난다.
//! - 폰이 부를 수 있는 것은 `dispatch` 의 목록뿐이다. 대화창이 쓰는 읽기·보내기만 열고, 칸을 띄우거나 끄는 길·
//!   파일을 열거나 쓰는 길·설정을 바꾸는 길은 열지 않는다. 읽기도 PC 가 알려 준 칸의 대화로 좁힌다.
//! - 폰 화면 파일도 이 앱이 구워 넣은 것(dist/m)을 중계로 내준다. 그래서 앱을 새로 구워도 중계는 다시 올리지 않는다.
//! - 대화 내용이 지나가므로 어디에도 기록하지 않는다.
//!
//! 기기 묶음(11월 22일 사용자 — "폰·데스크톱·노트북 셋을 하나로 묶어"): PC 둘이 [PC 잇기]로 한 번 이으면 서로의 방에 들어갈
//! 열쇠와 소개장 열쇠를 주고받는다(`group_link`). 폰은 붙은 PC 에서 묶음의 다른 PC 와 소개장을 받아(`group_pcs`·`group_invite`)
//! 그 PC 에 숫자 확인 없이 들어간다(`admit`). 묶인 PC 하나가 새 폰을 다른 PC 에 들일 수 있다는 뜻이라, 묶음 안 한 대가 털리면
//! 나머지도 열린다 — 사용자에게 알리고 묶었다. 소개로 들어온 폰은 누가 소개했는지(`via`)를 남겨 [폰 연결]에 보인다.
//!
//! 폰 화면은 PC 대화창 부품을 그대로 쓰고 `invoke`·`listen` 만 이 통로로 바꿔 끼운다(ui/remote-shim.ts). 부품을 폰용으로
//! 따로 짜면 같은 대화를 PC 와 폰이 다르게 그린다.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{mpsc as sync_mpsc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::remote_crypto as rc;

/// 짝짓기를 받는 시간. [폰 짝짓기]를 누른 뒤에만, 그동안만 받는다.
const PAIR_LIFE: Duration = Duration::from_secs(300);
/// 폰이 받는 대화 원문의 끝부분. 대화창은 파일이 자랄 때마다 원문을 통째로 다시 받는다 — 휴대폰 망에서는 짧게.
const PHONE_TAIL: u64 = 2 * 1024 * 1024;
/// 웹소켓 한 통에 싣는 암호문·파일 조각. Cloudflare 웹소켓 한 통의 한도(1MiB)보다 넉넉히 작다.
const CHUNK: usize = 240_000;
/// 조각을 모아 만드는 말 하나의 한도. 그림 몇 장이 실린 말까지다(입력바가 한 장을 3.75MB 안으로 줄인다, ui/images.ts).
const MAX_MESSAGE: usize = 48 * 1024 * 1024;
/// 이보다 긴 말은 암호화 전에 gzip 으로 줄인다. 원문 JSON 은 다섯 배쯤 준다.
const SQUEEZE: usize = 4096;
/// 중계에 숨 쉬는 줄을 보내는 간격과, 그 답조차 없으면 연결이 죽은 것으로 보는 시간.
const PING_EVERY: Duration = Duration::from_secs(20);
const SILENT_LIMIT: Duration = Duration::from_secs(45);
/// 폰으로 넘기는 이벤트. 대화창이 듣는 것뿐이다.
const EVENTS: &[&str] = &["claude:chat", "claude:chat-exit", "claude:chat-answered", "chat:live", "chat:sub"];
/// 폰이 보낼 수 있는 제어 요청. 하던 일 멈추기만 연다 — 모델·권한 모드 바꾸기는 PC 에서 한다.
const PHONE_CONTROLS: &[&str] = &["interrupt"];

#[derive(Serialize, Deserialize, Default, Clone)]
struct Saved {
    #[serde(default)]
    on: bool,
    /// 이 PC 의 이름. 묶인 PC·폰에 이 이름으로 보인다. 없으면 컴퓨터 이름.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// 사용자의 중계 주소(`https://chiispace-relay.<이름>.workers.dev`).
    #[serde(default)]
    relay: Option<String>,
    /// 중계 안의 방 이름(128비트 난수). 폰 주소에 들어간다.
    #[serde(default)]
    room: Option<String>,
    /// 중계가 이 PC 를 방 주인으로 알아보는 비밀. 중계에는 해시만 남는다.
    #[serde(default)]
    secret: Option<String>,
    /// PC 의 P-256 비밀키. 짝지은 폰이 이 공개키를 들고 있다.
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    devices: Vec<Device>,
    /// 이 PC 가 대화를 이사 보낼 다른 PC(그 PC 의 방에 폰처럼 짝지은 것). 받는 쪽은 `devices` 에 PC 로 남는다.
    #[serde(default)]
    peers: Vec<Peer>,
    /// 이사 받을 때 고른 폴더. 보낸 PC 의 git 주소(정리한 것) → 이 PC 의 폴더. 다음 이사에 먼저 권한다.
    #[serde(default)]
    move_folders: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Device {
    id: String,
    name: String,
    /// 폰의 공개키(base64url). 비밀키는 폰에만 있다.
    key: String,
    added: u64,
    /// "pc" 면 대화를 이사 보내 올 수 있는 다른 PC 다. 없으면 폰. 짝지을 때 받는 PC 에서 사람이 PC 인 것을 보고 허락한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    /// 묶인 PC 면, 그 PC 가 이 방에 새 기기를 들일 때 쓰는 소개장 열쇠(hex). 이 PC 가 만들어 그 PC 에 주었다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    invite: Option<String>,
    /// 묶인 PC 의 소개로 들어온 기기면 그 PC 의 이름.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    via: Option<String>,
}

/// 이사 보낼 다른 PC. 그 PC 의 방에 짝지은 키를 든다(폰이 브라우저에 드는 것과 같다).
#[derive(Serialize, Deserialize, Clone)]
struct Peer {
    id: String,
    name: String,
    /// 그 PC 의 폰 주소(`https://중계/r/<방>/`).
    page: String,
    /// 짝지은 결과(ui/phone-link.ts `Paired`) — 기기 id, 이 PC 쪽 비밀키(JWK), 그 PC 의 공개키.
    paired: Value,
    added: u64,
    /// 묶인 PC 면, 이 PC 가 그 PC 의 방에 새 기기를 들일 때 쓰는 소개장 열쇠(hex). 그 PC 가 만들어 주었다. 없으면 예전 판의
    /// 한쪽 잇기다(이사 보내기만 된다).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    invite: Option<String>,
    /// 그 PC 가 이 PC 의 방에 들어올 때 쓰는 기기 id(`devices` 의 것). 잊을 때 같이 지운다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device: Option<String>,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Agent {
    #[default]
    Claude,
    Codex,
}

/// PC 웹뷰가 알려 주는 대화창 칸. 폰은 이 칸들만 보고 이 칸들의 대화만 읽는다.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub session: String,
    pub slug: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    agent: Agent,
    #[serde(default, rename = "codexBusy", skip_serializing)]
    busy: bool,
}

/// 짝짓는 중인 폰 하나. 폰이 먼저 키를 약속하고(commit), PC 가 키와 난수를 낸 뒤에 폰이 키를 연다.
struct Pend {
    phone: String,
    name: String,
    kind: Option<String>,
    commit: [u8; 32],
    nb: [u8; 16],
    /// 폰이 키를 연 뒤 두 화면에 보일 여섯 자리와 그 키.
    sas: Option<(String, Vec<u8>)>,
}

struct Pairing {
    until: Instant,
    pend: Option<Pend>,
}

/// 붙어 있는 폰 화면 하나의 이번 연결.
struct Session {
    dev: String,
    /// 묶인 PC 의 연결이다. 칸 목록이 바뀐 것만 알리고 대화 줄은 넘기지 않는다 — 옆칸에 칸 목록만 보인다.
    pc: bool,
    keys: rc::Keys,
    /// 다음에 받을·보낼 순번. 순번이 IV 라 하나라도 어긋나면 풀리지 않는다.
    rx: u64,
    tx: u64,
    parts: Vec<String>,
}

struct Inner {
    saved: Saved,
    file: Option<PathBuf>,
    panes: Vec<PaneInfo>,
    codex_calls: HashMap<u64, sync_mpsc::Sender<Result<Value, String>>>,
    pairing: Option<Pairing>,
    sessions: HashMap<String, Session>,
    /// 중계로 나가는 줄. 붙어 있을 때만 있다.
    out: Option<mpsc::UnboundedSender<String>>,
    connected: bool,
    error: Option<String>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    epoch: u64,
}

pub struct Remote(Mutex<Inner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    on: bool,
    /// 이 PC 의 이름.
    name: String,
    relay: Option<String>,
    /// 폰에서 열 주소. 중계가 정해져 있을 때만.
    page: Option<String>,
    connected: bool,
    error: Option<String>,
    /// 지금 붙어 있는 짝지은 폰 화면 수.
    phones: usize,
    pairing: bool,
    pairing_left: u64,
    sas: Option<String>,
    sas_name: Option<String>,
    /// 짝지으려는 쪽이 PC 면 "pc". 허락하면 그 PC 가 이 PC 로 대화를 이사 보내 올 수 있다.
    sas_kind: Option<String>,
    devices: Vec<DeviceView>,
    peers: Vec<PeerView>,
}

#[derive(Serialize)]
struct DeviceView {
    id: String,
    name: String,
    added: u64,
    kind: Option<String>,
    via: Option<String>,
    /// 묶인 PC 라 이은 PC 목록에 같이 보인다.
    linked: bool,
}

#[derive(Serialize)]
struct PeerView {
    id: String,
    name: String,
    page: String,
    added: u64,
    /// 서로 이어 묶였다. 아니면 예전 판의 한쪽 잇기다.
    linked: bool,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 이 PC 의 이름. 사용자가 붙인 것이 없으면 컴퓨터 이름.
fn my_name(saved: &Saved) -> String {
    saved.name.clone().unwrap_or_else(crate::session_move::computer_name)
}

pub(crate) fn name_of(app: &AppHandle) -> String {
    my_name(&app.state::<Remote>().0.lock().unwrap().saved)
}

/// 사람이 붙인 이름 한 줄. 제어 문자를 빼고 40자까지.
fn clean_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(40).collect::<String>().trim().to_string()
}

/// 방 이름(32자리 hex). 폰 주소(`…/r/<방>/`)의 끝이다.
fn room_of(page: &str) -> Option<&str> {
    let room = page.trim_end_matches('/').rsplit_once("/r/")?.1;
    (room.len() == 32 && room.chars().all(|c| c.is_ascii_hexdigit())).then_some(room)
}

fn is_dev_id(id: &str) -> bool {
    id.len() == 16 && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| s.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok())).collect()
}

/// 소개장을 든 처음 보는 기기를 들일지. 소개한 쪽이 이 PC 와 묶인 PC 이고, 그 PC 에 준 열쇠로 만든 소개장이 이 방·이 기기·이
/// 공개키·이 이름에 맞아야 한다. 들이는 기기는 폰이다 — 소개로 PC 를 들이지 않는다(PC 는 사람이 숫자를 견주어 잇는다).
fn admit(saved: &Saved, dev: &str, invite: &Value) -> Option<Device> {
    let s = |k: &str| invite.get(k).and_then(Value::as_str);
    let (by, mac, public, name) = (s("by")?, rc::unb64u(s("mac")?)?, s("pub")?, s("name")?);
    let room = saved.room.as_deref()?;
    if !is_dev_id(dev) || saved.devices.iter().any(|d| d.id == dev) || name.is_empty() || name != clean_name(name) {
        return None;
    }
    rc::unb64u(public).and_then(|k| rc::parse_public(&k))?;
    let member = saved.devices.iter().find(|d| d.id == by && d.kind.as_deref() == Some("pc"))?;
    let key = unhex(member.invite.as_deref()?)?;
    rc::invite_ok(&key, room, dev, public, name, &mac).then(|| Device {
        id: dev.to_string(),
        name: name.to_string(),
        key: public.to_string(),
        added: now_secs(),
        kind: None,
        invite: None,
        via: Some(saved.peers.iter().find(|p| p.device.as_deref() == Some(by)).map_or_else(|| member.name.clone(), |p| p.name.clone())),
    })
}

/// 묶음이 바뀌었다. 옆칸의 다른 PC 목록이 다시 읽는다.
fn group_changed(app: &AppHandle) {
    let _ = app.emit("remote:peers", ());
}

/// 사용자가 넣은 중계 주소를 PC 가 붙을 웹소켓 주소로. https 만 받는다 — 이 PC 안의 검증용 중계(http://127.0.0.1)는 예외다.
fn relay_ws(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let (scheme, host) = if let Some(h) = url.strip_prefix("https://") {
        ("wss", h)
    } else if let Some(h) = url.strip_prefix("http://").filter(|h| h.starts_with("127.0.0.1:") || h.starts_with("localhost:")) {
        ("ws", h)
    } else {
        return None;
    };
    let ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    ok.then(|| format!("{scheme}://{host}"))
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

/// 폰으로 넘길 이벤트(암호화 전의 한 말). 알려 준 칸의 것만 넘긴다.
fn event_for(name: &str, payload: &str, panes: &[PaneInfo]) -> Option<String> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let pane = || v.get("id").and_then(Value::as_str).is_some_and(|id| panes.iter().any(|p| p.agent == Agent::Claude && p.id == id));
    let ok = match name {
        // 쓰이는 중인 답의 조각은 프록시(chat:live)가 더 가볍게 준다. 휴대폰 망에 두 번 싣지 않는다.
        "claude:chat" => pane() && !v.get("line").and_then(Value::as_str).unwrap_or("").starts_with(r#"{"type":"stream_event""#),
        "claude:chat-exit" | "claude:chat-answered" => pane(),
        "chat:live" | "chat:sub" => v
            .get("session")
            .and_then(Value::as_str)
            .is_some_and(|s| panes.iter().any(|p| p.agent == Agent::Claude && p.session.eq_ignore_ascii_case(s))),
        _ => false,
    };
    ok.then(|| format!(r#"{{"t":"ev","e":{},"p":{payload}}}"#, json!(name)))
}

/// 폰 화면 파일 이름. 앱에 구워 넣은 폰 묶음(dist/m) 안의 것만 — 데스크톱 화면 파일은 내주지 않는다.
fn asset_name(path: &str) -> Option<String> {
    if path.is_empty() {
        return Some("m/mobile.html".into());
    }
    let ok = !path.starts_with('/')
        && !path.split('/').any(|s| s.is_empty() || s == "." || s == "..")
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    ok.then(|| format!("m/{path}"))
}

/// 폰에 보낼 한 말을 암호 덩이들로. 길면 줄이고, 웹소켓 한 통에 안 들어가면 조각낸다.
fn frames(s: &mut Session, plain: &str) -> Vec<String> {
    let (bytes, z) = if plain.len() > SQUEEZE {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        match enc.write_all(plain.as_bytes()).and_then(|_| enc.finish()) {
            Ok(b) => (b, true),
            Err(_) => (plain.as_bytes().to_vec(), false),
        }
    } else {
        (plain.as_bytes().to_vec(), false)
    };
    let n = s.tx;
    s.tx += 1;
    let c = rc::seal(&s.keys.down, n, &bytes);
    if c.len() <= CHUNK {
        return vec![json!({ "k": "x", "n": n, "c": c, "z": z }).to_string()];
    }
    let parts: Vec<&str> = c.as_bytes().chunks(CHUNK).map(|p| std::str::from_utf8(p).unwrap_or("")).collect();
    let of = parts.len();
    parts.iter().enumerate().map(|(i, p)| json!({ "k": "x", "n": n, "c": p, "i": i, "of": of, "z": z }).to_string()).collect()
}

/// 폰에서 온 암호 덩이 하나. 말 하나가 다 모이면 풀어 준다. 순번이 어긋나거나 안 풀리면 Err — 그 연결은 끊는다.
fn take(s: &mut Session, v: &Value) -> Result<Option<String>, ()> {
    let n = v.get("n").and_then(Value::as_u64).ok_or(())?;
    let c = v.get("c").and_then(Value::as_str).ok_or(())?;
    if n != s.rx {
        return Err(());
    }
    let whole = match (v.get("i").and_then(Value::as_u64), v.get("of").and_then(Value::as_u64)) {
        (Some(i), Some(of)) => {
            if i as usize != s.parts.len() || i >= of {
                return Err(());
            }
            s.parts.push(c.to_string());
            if s.parts.iter().map(String::len).sum::<usize>() > MAX_MESSAGE {
                return Err(());
            }
            if i + 1 < of {
                return Ok(None);
            }
            std::mem::take(&mut s.parts).concat()
        }
        _ => c.to_string(),
    };
    let plain = rc::open(&s.keys.up, n, &whole).ok_or(())?;
    s.rx += 1;
    String::from_utf8(plain).map(Some).map_err(|_| ())
}

impl Remote {
    pub fn load(app: &AppHandle) -> Self {
        let file = crate::workspace::state_file(app).map(|p| p.with_file_name("remote.json"));
        let mut saved: Saved = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // 방·비밀·키는 처음 한 번 만든다. 바꾸면 폰 주소와 짝지은 폰이 다 못 쓰게 된다.
        let mut made = false;
        if saved.room.as_deref().is_none_or(|r| r.len() != 32) {
            saved.room = rc::random::<16>().ok().map(|b| hex(&b));
            made = true;
        }
        if saved.secret.as_deref().is_none_or(|s| s.len() != 64) {
            saved.secret = rc::random::<32>().ok().map(|b| hex(&b));
            made = true;
        }
        if saved.key.as_deref().and_then(rc::unb64u).and_then(|b| rc::secret_from(&b)).is_none() {
            saved.key = rc::new_secret().ok().map(|k| rc::b64u(&k.to_bytes()));
            saved.devices.clear();
            made = true;
        }
        let inner = Inner {
            saved,
            file,
            panes: Vec::new(),
            codex_calls: HashMap::new(),
            pairing: None,
            sessions: HashMap::new(),
            out: None,
            connected: false,
            error: None,
            task: None,
            epoch: 0,
        };
        if made {
            Self::save(&inner);
        }
        Self(Mutex::new(inner))
    }

    fn save(inner: &Inner) {
        let Some(file) = &inner.file else { return };
        if let Ok(json) = serde_json::to_string_pretty(&inner.saved) {
            let _ = std::fs::write(file, json);
        }
    }

    fn status(&self) -> Status {
        let inner = self.0.lock().unwrap();
        let pairing = inner.pairing.as_ref().filter(|p| p.until > Instant::now());
        let sas = pairing.and_then(|p| p.pend.as_ref()).and_then(|p| p.sas.as_ref().map(|s| (s.0.clone(), p.name.clone(), p.kind.clone())));
        let page = match (&inner.saved.relay, &inner.saved.room) {
            (Some(r), Some(room)) => Some(format!("{}/r/{room}/", r.trim_end_matches('/'))),
            _ => None,
        };
        Status {
            on: inner.saved.on,
            name: my_name(&inner.saved),
            relay: inner.saved.relay.clone(),
            page,
            connected: inner.connected,
            error: inner.error.clone(),
            phones: inner.sessions.values().filter(|s| !s.pc).count(),
            pairing: pairing.is_some(),
            pairing_left: pairing.map_or(0, |p| p.until.saturating_duration_since(Instant::now()).as_secs()),
            sas: sas.as_ref().map(|s| s.0.clone()),
            sas_name: sas.as_ref().map(|s| s.1.clone()),
            sas_kind: sas.and_then(|s| s.2),
            devices: inner
                .saved
                .devices
                .iter()
                .map(|d| DeviceView {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    added: d.added,
                    kind: d.kind.clone(),
                    via: d.via.clone(),
                    linked: inner.saved.peers.iter().any(|p| p.device.as_deref() == Some(&d.id)),
                })
                .collect(),
            peers: inner
                .saved
                .peers
                .iter()
                .map(|p| PeerView { id: p.id.clone(), name: p.name.clone(), page: p.page.clone(), added: p.added, linked: p.invite.is_some() })
                .collect(),
        }
    }

    fn pc_key(inner: &Inner) -> Option<p256::SecretKey> {
        inner.saved.key.as_deref().and_then(rc::unb64u).and_then(|b| rc::secret_from(&b))
    }
}

/// 중계로 한 줄. 붙어 있지 않으면 버린다.
fn push(inner: &Inner, text: String) {
    if let Some(out) = &inner.out {
        let _ = out.send(text);
    }
}

/// 폰에 평문(짝짓기·인사)을 보낸다. 키를 바꾸기 전의 말이라 비밀이 없다.
fn plain(inner: &Inner, phone: &str, v: Value) {
    push(inner, json!({ "t": "msg", "p": phone, "d": v.to_string() }).to_string());
}

/// 폰 화면 하나에 암호화한 한 말.
fn seal_to(inner: &mut Inner, phone: &str, text: &str) {
    let Some(s) = inner.sessions.get_mut(phone) else { return };
    let fs = frames(s, text);
    for f in fs {
        push(inner, json!({ "t": "msg", "p": phone, "d": f }).to_string());
    }
}

/// 붙어 있는 모든 화면에(묶인 PC 포함). 칸 목록이 바뀐 것처럼 가벼운 알림만.
fn seal_all(inner: &mut Inner, text: &str) {
    let phones: Vec<String> = inner.sessions.keys().cloned().collect();
    for p in phones {
        seal_to(inner, &p, text);
    }
}

/// 붙어 있는 폰 화면에만. 대화 줄은 묶인 PC 에 넘기지 않는다 — 그 PC 는 칸 목록만 보인다.
fn seal_phones(inner: &mut Inner, text: &str) {
    let phones: Vec<String> = inner.sessions.iter().filter(|(_, s)| !s.pc).map(|(p, _)| p.clone()).collect();
    for p in phones {
        seal_to(inner, &p, text);
    }
}

fn kick(inner: &mut Inner, phone: &str) {
    inner.sessions.remove(phone);
    push(inner, json!({ "t": "kick", "p": phone }).to_string());
}

/// 앱이 뜰 때. 이벤트를 넘길 귀를 달고, 켜 두었으면 중계에 붙는다.
pub fn boot(app: &AppHandle) {
    for name in EVENTS {
        let handle = app.clone();
        app.listen_any(*name, move |e| {
            let remote = handle.state::<Remote>();
            let mut inner = remote.0.lock().unwrap();
            // 붙은 폰이 없으면 뜯어 보지도 않는다. 이 귀는 PC 대화창의 모든 줄마다 불린다.
            if !inner.sessions.values().any(|s| !s.pc) {
                return;
            }
            if let Some(text) = event_for(name, e.payload(), &inner.panes) {
                seal_phones(&mut inner, &text);
            }
        });
    }
    start(app);
}

/// 켜져 있고 중계 주소가 있으면 붙는다. 이미 붙어 있거나 붙는 중이면 그대로 둔다.
fn start(app: &AppHandle) {
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    if inner.task.is_some() || !inner.saved.on || inner.saved.relay.is_none() {
        return;
    }
    inner.epoch += 1;
    let epoch = inner.epoch;
    let handle = app.clone();
    inner.task = Some(tauri::async_runtime::spawn(async move { run(handle, epoch).await }));
}

fn stop(app: &AppHandle) {
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    inner.epoch += 1;
    if let Some(t) = inner.task.take() {
        t.abort();
    }
    inner.out = None;
    inner.connected = false;
    inner.sessions.clear();
    inner.pairing = None;
}

/// 중계에 붙어 있기. 끊기면 1초부터 1분까지 늘려 가며 다시 붙는다.
async fn run(app: AppHandle, epoch: u64) {
    let mut wait = Duration::from_secs(1);
    loop {
        let target = {
            let remote = app.state::<Remote>();
            let inner = remote.0.lock().unwrap();
            if inner.epoch != epoch {
                return;
            }
            let ws = inner.saved.relay.as_deref().and_then(relay_ws);
            match (ws, &inner.saved.room, &inner.saved.secret) {
                (Some(ws), Some(room), Some(secret)) => Some((format!("{ws}/pc/{room}"), secret.clone())),
                _ => None,
            }
        };
        let Some((url, secret)) = target else { return };
        match connect(&url, &secret).await {
            Ok(ws) => {
                wait = Duration::from_secs(1);
                serve(&app, ws, epoch).await;
            }
            Err(e) => {
                let remote = app.state::<Remote>();
                let mut inner = remote.0.lock().unwrap();
                if inner.epoch == epoch {
                    inner.error = Some(e);
                }
            }
        }
        {
            let remote = app.state::<Remote>();
            let mut inner = remote.0.lock().unwrap();
            if inner.epoch != epoch {
                return;
            }
            inner.out = None;
            inner.connected = false;
            inner.sessions.clear();
            if let Some(p) = inner.pairing.as_mut() {
                p.pend = None;
            }
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(60));
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str, secret: &str) -> Result<Ws, String> {
    let mut req = url.into_client_request().map_err(|e| format!("중계 주소가 잘못됐다 — {e}"))?;
    req.headers_mut().insert("Authorization", format!("Bearer {secret}").parse().map_err(|_| "비밀이 잘못됐다".to_string())?);
    match tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(req)).await {
        Ok(Ok((ws, _))) => Ok(ws),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(res))) if res.status() == 403 => {
            Err("중계가 이 PC 를 방 주인으로 받지 않는다 — 다른 PC 가 이 방을 쓰고 있거나 중계를 새로 올렸다".into())
        }
        Ok(Err(e)) => Err(format!("중계에 못 붙었다 — {e}")),
        Err(_) => Err("중계가 답하지 않는다".into()),
    }
}

async fn serve(app: &AppHandle, ws: Ws, epoch: u64) {
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        if inner.epoch != epoch {
            return;
        }
        inner.out = Some(tx.clone());
        inner.connected = true;
        inner.error = None;
    }
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    // 중계·회선이 조용한 연결을 끊지 않게 숨 쉬는 줄을 보낸다. 중계는 이 줄에 잠에서 깨지 않고 바로 답한다(pong).
    let pinger = tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PING_EVERY).await;
            if tx.send("ping".into()).is_err() {
                break;
            }
        }
    });
    // [끄기]는 이 함수를 도중에 버린다(`stop` 의 abort). 그때도 두 일을 거둬야 한다 — 쓰기 쪽이 소켓 반쪽을 쥔 채 숨을
    // 계속 쉬면 중계는 PC 가 아직 있다고 보고, 폰의 화면 요청을 답 없는 PC 에 넘겨 20초씩 붙잡았다.
    let _tasks = AbortOnDrop(vec![writer, pinger]);
    loop {
        // 숨 쉬는 줄의 답조차 한참 없으면 반쯤 끊긴 연결이다. 휴대폰 망(테더링)은 조용한 연결을 소리 없이 버리는데, 그때
        // 쓰기는 OS 버퍼에 쌓이기만 해 몇 분씩 오류가 안 난다. 그동안 앱은 붙은 줄 알고 중계는 죽은 연결에 폰 요청을 넘겨
        // 폰에는 504 만 보였다(11월 18일 사용자). 기다리지 않고 끊고 다시 붙는다.
        let msg = match tokio::time::timeout(SILENT_LIMIT, stream.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let Message::Text(text) = msg else { continue };
        if text.as_str() == "pong" {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        on_relay(app, &v);
    }
}

struct AbortOnDrop(Vec<tauri::async_runtime::JoinHandle<()>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        for t in &self.0 {
            t.abort();
        }
    }
}

/// 중계가 준 한 줄.
fn on_relay(app: &AppHandle, v: &Value) {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match v.get("t").and_then(Value::as_str) {
        Some("gone") => {
            let remote = app.state::<Remote>();
            let mut inner = remote.0.lock().unwrap();
            let p = s("p");
            inner.sessions.remove(&p);
            if let Some(pair) = inner.pairing.as_mut() {
                if pair.pend.as_ref().is_some_and(|x| x.phone == p) {
                    pair.pend = None;
                }
            }
        }
        Some("get") => {
            let app = app.clone();
            let (q, path) = (s("q"), s("path"));
            tauri::async_runtime::spawn_blocking(move || {
                let out = asset_frames(&app, &q, &path);
                let remote = app.state::<Remote>();
                let inner = remote.0.lock().unwrap();
                for f in out {
                    push(&inner, f);
                }
            });
        }
        Some("msg") => {
            let (p, d) = (s("p"), s("d"));
            if let Ok(m) = serde_json::from_str::<Value>(&d) {
                on_phone(app, &p, &m);
            }
        }
        _ => {}
    }
}

/// 앱에 구워 넣은 폰 묶음 파일 이름들. Tauri 의 자산 조회는 없는 파일을 물으면 데스크톱 `index.html` 로 대신 답하므로
/// (manager `get_asset` 의 마지막 대체), 정확히 있는 이름인지 먼저 이 목록으로 본다.
/// 폰 묶음의 시작 파일 이름(`assets/mobile-<해시>.js`). 판이 바뀌면 이름도 바뀐다. 인사(`hi`)에 실어 보내면 폰이 제가 도는 판과
/// 견줘 다르면 새로 불러온다 — 홈 화면 앱은 뒤로 보냈다 다시 열면 옛 판이 그대로 남는다.
fn entry_of(html: &str) -> Option<String> {
    let at = html.find("src=\"./assets/")? + "src=\"./".len();
    let end = html[at..].find('"')? + at;
    let name = &html[at..end];
    (name.ends_with(".js") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))).then(|| name.to_string())
}

fn phone_build(app: &AppHandle) -> &'static str {
    static BUILD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        app.asset_resolver()
            .get("m/mobile.html".into())
            .and_then(|a| entry_of(&String::from_utf8_lossy(a.bytes())))
            .unwrap_or_default()
    })
}

fn phone_files(app: &AppHandle) -> &'static std::collections::HashSet<String> {
    static FILES: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    FILES.get_or_init(|| {
        app.asset_resolver()
            .iter()
            .map(|(k, _)| k.replace('\\', "/").trim_start_matches('/').to_string())
            .filter(|k| k.starts_with("m/"))
            .collect()
    })
}

fn asset_frames(app: &AppHandle, q: &str, path: &str) -> Vec<String> {
    let found = asset_name(path)
        .filter(|name| phone_files(app).contains(name))
        .and_then(|name| app.asset_resolver().get(name.clone()).map(|a| (name, a)));
    let Some((name, a)) = found else {
        return vec![json!({ "t": "res", "q": q, "status": 404, "type": "text/plain; charset=utf-8", "b": B64.encode("없는 파일") }).to_string()];
    };
    let kind = if name.ends_with(".webmanifest") { "application/manifest+json".to_string() } else { a.mime_type().to_string() };
    // 묶음 파일 이름에 내용 해시가 들어 있다. 판이 바뀌면 이름도 바뀌므로 오래 둬도 된다.
    let cache = if name.starts_with("m/assets/") { "public, max-age=31536000, immutable" } else { "no-store" };
    let b = B64.encode(a.bytes());
    let parts: Vec<&str> = if b.is_empty() { vec![""] } else { b.as_bytes().chunks(CHUNK).map(|p| std::str::from_utf8(p).unwrap_or("")).collect() };
    let last = parts.len() - 1;
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| json!({ "t": "res", "q": q, "status": 200, "type": kind, "cache": cache, "b": p, "more": i < last }).to_string())
        .collect()
}

/// 폰 화면이 보낸 한 말. 짝짓기·인사는 평문, 그 밖은 이번 연결의 키로 연 것만 받는다.
fn on_phone(app: &AppHandle, phone: &str, m: &Value) {
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let bytes = |k: &str| m.get(k).and_then(Value::as_str).and_then(rc::unb64u);
    match m.get("k").and_then(Value::as_str) {
        Some("pair1") => {
            let open = inner.pairing.as_ref().is_some_and(|p| p.until > Instant::now());
            let busy = inner.pairing.as_ref().and_then(|p| p.pend.as_ref()).is_some_and(|x| x.phone != phone);
            let commit = bytes("c").and_then(|c| <[u8; 32]>::try_from(c).ok());
            let (Some(pc), Some(commit), Ok(nb)) = (Remote::pc_key(&inner), commit, rc::random::<16>()) else { return };
            if !open {
                return plain(&inner, phone, json!({ "k": "no", "why": "PC 의 [폰 연결]에서 [폰 짝짓기]를 먼저 눌러 줘" }));
            }
            if busy {
                return plain(&inner, phone, json!({ "k": "no", "why": "다른 폰이 짝짓는 중이다" }));
            }
            let name: String = s("name").chars().filter(|c| !c.is_control()).take(40).collect::<String>().trim().to_string();
            // 스스로 PC 라고 밝힌 것이다. 받는 PC 의 숫자 확인 화면이 PC 라고 보여 주고, 사람이 그것을 보고 허락한다.
            let kind = (s("kind") == "pc").then(|| "pc".to_string());
            let name = if !name.is_empty() { name } else if kind.is_some() { "PC".into() } else { "폰".into() };
            if let Some(p) = inner.pairing.as_mut() {
                p.pend = Some(Pend { phone: phone.into(), name, kind, commit, nb, sas: None });
            }
            plain(&inner, phone, json!({ "k": "pair2", "pc": rc::b64u(&rc::public_of(&pc)), "nb": rc::b64u(&nb) }));
        }
        Some("pair3") => {
            let Some(pc) = Remote::pc_key(&inner) else { return };
            let (Some(pubk), Some(na)) = (bytes("pub"), bytes("na")) else { return };
            let Some(pair) = inner.pairing.as_mut().filter(|p| p.until > Instant::now()) else { return };
            let Some(pend) = pair.pend.as_mut().filter(|x| x.phone == phone && x.sas.is_none()) else { return };
            // 약속한 키와 다른 키를 열면 중계가 끼어든 것이다.
            if rc::commit_of(&pubk, &na) != pend.commit || rc::parse_public(&pubk).is_none() || na.len() != 16 {
                pair.pend = None;
                return plain(&inner, phone, json!({ "k": "no", "why": "짝짓기 말이 맞지 않는다" }));
            }
            pend.sas = Some((rc::sas_of(&pubk, &rc::public_of(&pc), &na, &pend.nb), pubk));
            plain(&inner, phone, json!({ "k": "sas" }));
        }
        Some("hello") => {
            let Some(pc) = Remote::pc_key(&inner) else { return };
            let dev = s("dev");
            // 처음 보는 기기가 묶인 PC 의 소개장을 들고 왔으면 들인다.
            if let Some(device) = m.get("invite").and_then(|inv| admit(&inner.saved, &dev, inv)) {
                inner.saved.devices.push(device);
                Remote::save(&inner);
            }
            let found = inner.saved.devices.iter().find(|d| d.id == dev).and_then(|d| rc::unb64u(&d.key)).and_then(|k| rc::parse_public(&k));
            let (Some(phone_pub), Some(na)) = (found, bytes("na").filter(|n| n.len() == 16)) else {
                return plain(&inner, phone, json!({ "k": "no", "why": "unknown" }));
            };
            let Ok(nb) = rc::random::<16>() else { return };
            let keys = rc::session_keys(&pc, &phone_pub, &na, &nb, &dev);
            let is_pc = inner.saved.devices.iter().any(|d| d.id == dev && d.kind.as_deref() == Some("pc"));
            inner.sessions.insert(phone.to_string(), Session { dev, pc: is_pc, keys, rx: 0, tx: 0, parts: Vec::new() });
            plain(&inner, phone, json!({ "k": "hi", "nb": rc::b64u(&nb), "v": phone_build(app) }));
        }
        Some("x") => {
            let Some(session) = inner.sessions.get_mut(phone) else { return };
            match take(session, m) {
                Ok(None) => {}
                Ok(Some(text)) => {
                    drop(inner);
                    on_message(app, phone, &text);
                }
                Err(()) => kick(&mut inner, phone),
            }
        }
        _ => {}
    }
}

/// 이번 연결의 키로 연 한 말. 지금은 명령 부르기뿐이다.
fn on_message(app: &AppHandle, phone: &str, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    if v.get("t").and_then(Value::as_str) != Some("invoke") {
        return;
    }
    let id = v.get("i").cloned().unwrap_or(Value::Null);
    let cmd = v.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
    let args = v.get("args").cloned().unwrap_or(Value::Null);
    let (app, phone) = (app.clone(), phone.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let from = {
            let remote = app.state::<Remote>();
            let inner = remote.0.lock().unwrap();
            let Some(s) = inner.sessions.get(&phone) else { return };
            inner.saved.devices.iter().find(|d| d.id == s.dev).map(|d| (d.id.clone(), d.kind.clone(), d.name.clone()))
        };
        let Some((dev, kind, name)) = from else { return };
        // PC 로 짝지은 기기는 이사 보내기·묶기·칸 목록 보기만 부른다. 폰은 이사 명령을 못 부른다 — 받는 PC 에 칸을 새로 여는
        // 길이라 폰에 열지 않은 권한이다. 묶인 PC 라도 이 PC 의 대화를 읽거나 칸에 말을 보내지 못한다(옆칸에 칸 목록만 보인다).
        let out = if kind.as_deref() == Some("pc") {
            match cmd.as_str() {
                "session_move_offer" => crate::session_move::offer(&app, &name, &args),
                "group_link" => group_link(&app, &dev, &args),
                "remote_panes" => dispatch(&app, &cmd, &args, &name),
                _ => Err(format!("PC 짝은 이사 보내기·묶기·칸 목록만 부른다: {cmd}")),
            }
        } else {
            dispatch(&app, &cmd, &args, &name)
        };
        let reply = match out {
            Ok(v) => json!({ "t": "ret", "i": id, "ok": true, "v": v }),
            Err(e) => json!({ "t": "ret", "i": id, "ok": false, "e": e }),
        };
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        seal_to(&mut inner, &phone, &reply.to_string());
    });
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
        let mut inner = remote.0.lock().unwrap();
        inner.saved.on = on;
        inner.error = None;
        Remote::save(&inner);
    }
    if on { start(&app) } else { stop(&app) }
    app.state::<Remote>().status()
}

/// 중계 주소. 바꾸면 새 주소로 다시 붙는다. 방·키는 그대로라 짝지은 폰은 새 주소를 열기만 하면 된다.
#[tauri::command]
pub fn remote_set_relay(app: AppHandle, url: String) -> Result<Status, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if relay_ws(&url).is_none() {
        return Err("https:// 로 시작하는 중계 주소여야 한다 (예: https://chiispace-relay.이름.workers.dev)".into());
    }
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        inner.saved.relay = Some(url);
        Remote::save(&inner);
    }
    stop(&app);
    start(&app);
    Ok(app.state::<Remote>().status())
}

/// 짝짓기 받기를 열고 닫는다. 연 뒤 5분 동안만 받는다.
#[tauri::command]
pub fn remote_pairing(app: AppHandle, on: bool) -> Status {
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        inner.pairing = on.then(|| Pairing { until: Instant::now() + PAIR_LIFE, pend: None });
    }
    app.state::<Remote>().status()
}

/// 두 화면의 여섯 자리가 같은지 사람이 보고 누른 답.
#[tauri::command]
pub fn remote_confirm(app: AppHandle, ok: bool) -> Status {
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        let pend = inner.pairing.as_mut().and_then(|p| p.pend.take());
        if let Some(Pend { phone, name, kind, sas: Some((_, key)), .. }) = pend {
            if ok {
                let id = rc::random::<8>().map(|b| hex(&b)).unwrap_or_default();
                inner.saved.devices.push(Device { id: id.clone(), name, key: rc::b64u(&key), added: now_secs(), kind, invite: None, via: None });
                Remote::save(&inner);
                inner.pairing = None;
                // 이 PC 의 이름도 준다. 이사 보낼 PC 목록에 그 이름으로 남는다(폰은 쓰지 않는다).
                plain(&inner, &phone, json!({ "k": "paired", "dev": id, "name": my_name(&inner.saved) }));
            } else {
                plain(&inner, &phone, json!({ "k": "no", "why": "PC 에서 숫자가 다르다고 했다" }));
            }
        }
    }
    app.state::<Remote>().status()
}

/// 짝지은 폰 잊기. 붙어 있던 화면도 바로 끊긴다.
#[tauri::command]
pub fn remote_forget(app: AppHandle, device: String) -> Status {
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        forget_device(&mut inner, &device);
        // 묶인 PC 를 잊으면 그 PC 로 보내는 길도 같이 잊는다. 한쪽만 남으면 목록에 반쪽짜리 PC 가 남는다.
        inner.saved.peers.retain(|p| p.device.as_deref() != Some(&device));
        Remote::save(&inner);
    }
    group_changed(&app);
    app.state::<Remote>().status()
}

/// 기기를 지우고 붙어 있던 화면도 끊는다.
fn forget_device(inner: &mut Inner, device: &str) {
    inner.saved.devices.retain(|d| d.id != device);
    let gone: Vec<String> = inner.sessions.iter().filter(|(_, s)| s.dev == device).map(|(p, _)| p.clone()).collect();
    for p in gone {
        kick(inner, &p);
    }
}

/// 이사 보낼 PC 의 폰 주소(`https://중계/r/<방>/`). 중계 주소 규칙(`relay_ws`)과 같고 뒤에 방 이름이 붙는다.
fn peer_page(page: &str) -> Option<String> {
    let (base, room) = page.trim().trim_end_matches('/').rsplit_once("/r/")?;
    let ok = relay_ws(base).is_some() && room.len() == 32 && room.chars().all(|c| c.is_ascii_hexdigit());
    ok.then(|| format!("{}/r/{room}/", base.trim_end_matches('/')))
}

/// 다른 PC 의 방에 짝지은 것을 적어 둔다(ui/session-move.ts 가 짝지은 뒤 부른다). 같은 PC 를 다시 이으면 앞 짝은 버린다.
#[tauri::command]
pub fn remote_peer_add(app: AppHandle, name: String, page: String, paired: Value, invite: Option<String>, device: Option<String>) -> Result<Status, String> {
    let page = peer_page(&page).ok_or("그 PC 의 [폰 연결]에 보이는 폰 주소(https://…/r/…/)여야 한다")?;
    let shaped = paired["dev"].as_str().is_some_and(|d| d.len() == 16 && d.chars().all(|c| c.is_ascii_hexdigit()))
        && paired["jwk"].is_object()
        && paired["pc"].as_str().and_then(rc::unb64u).and_then(|k| rc::parse_public(&k)).is_some();
    if !shaped || invite.as_deref().is_some_and(|k| k.len() != 64 || unhex(k).is_none()) {
        return Err("짝지은 값이 잘못됐다".into());
    }
    let name = clean_name(&name);
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        // 묶을 때 이 PC 의 방에 그 PC 몫으로 만든 기기다. 없는 기기면 묶지 않은 것으로 둔다.
        let device = device.filter(|d| inner.saved.devices.iter().any(|x| &x.id == d && x.kind.as_deref() == Some("pc")));
        // 같은 PC 를 다시 이으면 앞 짝이 그 PC 몫으로 만든 기기도 버린다.
        let old: Vec<String> = inner.saved.peers.iter().filter(|p| p.page == page).filter_map(|p| p.device.clone()).filter(|d| device.as_ref() != Some(d)).collect();
        for d in old {
            forget_device(&mut inner, &d);
        }
        inner.saved.peers.retain(|p| p.page != page);
        let id = rc::random::<8>().map(|b| hex(&b)).map_err(|_| "난수를 못 만들었다".to_string())?;
        let invite = invite.filter(|_| device.is_some());
        inner.saved.peers.push(Peer { id, name: if name.is_empty() { "PC".into() } else { name }, page, paired, added: now_secs(), invite, device });
        Remote::save(&inner);
    }
    group_changed(&app);
    Ok(app.state::<Remote>().status())
}

/// 다른 PC 와 묶기 — 이 PC 쪽 준비. 그 PC 가 이 PC 의 방에 들어올 기기와 소개장 열쇠를 만든다. 열쇠쌍은 웹뷰가 만들어
/// 공개키만 준다(비밀키는 웹뷰가 그 PC 에 암호 통로로 넘긴다 — 이 방에만 쓰는 키라 이 PC 가 알아도 잃는 것이 없다).
/// 이 PC 의 웹뷰만 부른다(폰·PC 짝 명령 목록에 없다).
#[tauri::command]
pub fn remote_link_prepare(app: AppHandle, name: String, public: String) -> Result<Value, String> {
    rc::unb64u(&public).and_then(|k| rc::parse_public(&k)).ok_or("공개키가 잘못됐다")?;
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    let (Some(relay), Some(room), Some(pc)) = (inner.saved.relay.clone(), inner.saved.room.clone(), Remote::pc_key(&inner)) else {
        return Err("이 PC 의 중계 주소가 없다 — [폰 연결]에 중계 주소를 넣어 줘".into());
    };
    let dev = rc::random::<8>().map(|b| hex(&b))?;
    let invite = rc::random::<32>().map(|b| hex(&b))?;
    let name = clean_name(&name);
    inner.saved.devices.push(Device {
        id: dev.clone(),
        name: if name.is_empty() { "PC".into() } else { name },
        key: public,
        added: now_secs(),
        kind: Some("pc".into()),
        invite: Some(invite.clone()),
        via: None,
    });
    Remote::save(&inner);
    Ok(json!({
        "dev": dev,
        "page": format!("{}/r/{room}/", relay.trim_end_matches('/')),
        "pc": rc::b64u(&rc::public_of(&pc)),
        "invite": invite,
        "name": my_name(&inner.saved),
    }))
}

/// 다른 PC 와 묶기 — 그 PC 가 짝지은 통로로 부른다(PC 짝만). 그 PC 로 가는 길(그 PC 가 만든 기기 키)과 그 PC 방의 소개장
/// 열쇠를 받아 적고, 이 PC 방의 소개장 열쇠를 만들어 돌려준다.
fn group_link(app: &AppHandle, dev: &str, args: &Value) -> Result<Value, String> {
    let page = args["page"].as_str().and_then(peer_page).ok_or("그 PC 의 폰 주소가 잘못됐다")?;
    let paired = args["paired"].clone();
    let shaped = paired["dev"].as_str().is_some_and(is_dev_id)
        && paired["jwk"].is_object()
        && paired["pc"].as_str().and_then(rc::unb64u).and_then(|k| rc::parse_public(&k)).is_some();
    let theirs = args["invite"].as_str().filter(|k| k.len() == 64 && unhex(k).is_some()).ok_or("소개장 열쇠가 잘못됐다")?;
    if !shaped {
        return Err("짝지은 값이 잘못됐다".into());
    }
    let mine = rc::random::<32>().map(|b| hex(&b))?;
    let me = {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        if room_of(&page) == inner.saved.room.as_deref() {
            return Err("이 PC 자신과는 묶지 않는다".into());
        }
        let device = inner.saved.devices.iter_mut().find(|d| d.id == dev).ok_or("짝지은 PC 가 아니다")?;
        device.invite = Some(mine.clone());
        let name = device.name.clone();
        let old: Vec<String> = inner.saved.peers.iter().filter(|p| p.page == page).filter_map(|p| p.device.clone()).filter(|d| d != dev).collect();
        for d in old {
            forget_device(&mut inner, &d);
        }
        inner.saved.peers.retain(|p| p.page != page && p.device.as_deref() != Some(dev));
        let id = rc::random::<8>().map(|b| hex(&b))?;
        inner.saved.peers.push(Peer { id, name, page, paired, added: now_secs(), invite: Some(theirs.to_string()), device: Some(dev.to_string()) });
        Remote::save(&inner);
        my_name(&inner.saved)
    };
    group_changed(app);
    Ok(json!({ "invite": mine, "name": me }))
}

/// 이 PC 의 이름을 바꾼다. 묶인 PC·폰에 보이는 이름이다(다음에 이을 때·폰이 다시 붙을 때부터).
#[tauri::command]
pub fn remote_set_name(app: AppHandle, name: String) -> Result<Status, String> {
    let name = clean_name(&name);
    if name.is_empty() {
        return Err("이름을 넣어 줘".into());
    }
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        inner.saved.name = Some(name);
        Remote::save(&inner);
    }
    Ok(app.state::<Remote>().status())
}

#[tauri::command]
pub fn remote_peer_forget(app: AppHandle, peer: String) -> Status {
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        let device = inner.saved.peers.iter().find(|p| p.id == peer).and_then(|p| p.device.clone());
        inner.saved.peers.retain(|p| p.id != peer);
        // 묶인 PC 면 그 PC 가 이 PC 로 들어오는 길도 같이 잊는다.
        if let Some(d) = device {
            forget_device(&mut inner, &d);
        }
        Remote::save(&inner);
    }
    group_changed(&app);
    app.state::<Remote>().status()
}

/// 이사 보낼 PC 의 이름을 바꾼다. 짝지을 때 받은 컴퓨터 이름(`DESKTOP-…`)으로는 어느 PC 인지 알아보기 어렵다.
#[tauri::command]
pub fn remote_peer_rename(app: AppHandle, peer: String, name: String) -> Result<Status, String> {
    let name: String = name.chars().filter(|c| !c.is_control()).take(40).collect::<String>().trim().to_string();
    if name.is_empty() {
        return Err("이름을 넣어 줘".into());
    }
    {
        let remote = app.state::<Remote>();
        let mut inner = remote.0.lock().unwrap();
        let p = inner.saved.peers.iter_mut().find(|p| p.id == peer).ok_or("짝지은 PC 가 아니다")?;
        p.name = name;
        Remote::save(&inner);
    }
    group_changed(&app);
    Ok(app.state::<Remote>().status())
}

/// 이사 보낼 때 그 PC 에 붙을 값. 이 PC 의 웹뷰만 부른다(폰 명령 목록에 없다).
#[tauri::command]
pub fn remote_peer_key(app: AppHandle, peer: String) -> Result<Value, String> {
    let remote = app.state::<Remote>();
    let inner = remote.0.lock().unwrap();
    let p = inner.saved.peers.iter().find(|p| p.id == peer).ok_or("짝지은 PC 가 아니다")?;
    Ok(json!({ "name": p.name, "page": p.page, "paired": p.paired }))
}

pub(crate) fn remembered_folder(app: &AppHandle, origin: &str) -> Option<String> {
    app.state::<Remote>().0.lock().unwrap().saved.move_folders.get(origin).cloned()
}

pub(crate) fn remember_folder(app: &AppHandle, origin: &str, cwd: &str) {
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    if inner.saved.move_folders.get(origin).map(String::as_str) != Some(cwd) {
        inner.saved.move_folders.insert(origin.to_string(), cwd.to_string());
        Remote::save(&inner);
    }
}

/// PC 웹뷰가 지금 떠 있는 Claude 대화창 칸을 알려 준다. 바뀌면 폰 목록도 바뀐다.
#[tauri::command]
pub fn remote_publish(app: AppHandle, panes: Vec<PaneInfo>) {
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    if inner.panes == panes {
        return;
    }
    inner.panes = panes;
    seal_all(&mut inner, r#"{"t":"ev","e":"remote:panes","p":null}"#);
}

pub(crate) fn codex_event(app: &AppHandle, id: &str, session: &str, run: &str, seq: u64, message: &Value) {
    let remote = app.state::<Remote>();
    let mut inner = remote.0.lock().unwrap();
    if !inner.sessions.values().any(|s| !s.pc) || !inner.panes.iter().any(|p| p.agent == Agent::Codex && p.id == id && p.session == session) {
        return;
    }
    let exit = json!({ "method": "chiispace/exit" });
    let message = if message["method"] == "chiispace/exit" { &exit } else { message };
    let text = json!({ "t": "ev", "e": "remote:codex", "p": { "id": id, "session": session, "run": run, "seq": seq, "message": message } }).to_string();
    if text.len() <= MAX_MESSAGE / 2 {
        seal_phones(&mut inner, &text);
    }
}

// ── 폰이 부를 수 있는 명령 ───────────────────────────────────────

/// 폰 칸 목록 한 줄. PC 가 알려 준 것에 통로의 지금 상태를 얹는다.
#[derive(Serialize)]
struct PhonePane {
    #[serde(flatten)]
    info: PaneInfo,
    alive: bool,
    busy: bool,
    /// 지금 도는 서브에이전트 수. 본 대화의 턴이 끝나도 이것이 있으면 일하는 중이다.
    tasks: usize,
    waiting: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum CodexAction {
    Snapshot,
    Send { run: String, turn: Option<String>, text: String, images: Vec<String> },
    Answer { run: String, request_id: Value, thread_id: String, result: Value },
    Interrupt { run: String, turn: String },
    Child { run: String, thread_id: String },
}

impl CodexAction {
    fn check(&self, current_run: &str) -> Result<(), String> {
        let run = match self {
            Self::Snapshot => return Ok(()),
            Self::Send { run, text, images, .. } => {
                if text.len() > 1024 * 1024 || (text.trim().is_empty() && images.is_empty())
                    || images.len() > 8 || !images.iter().all(|url| valid_codex_image(url))
                {
                    return Err("Codex에 보낼 글이나 그림을 확인해 줘".into());
                }
                run
            }
            Self::Answer { run, request_id, thread_id, result } => {
                if !(request_id.is_i64() || request_id.as_str().is_some_and(|id| id.len() <= 128))
                    || thread_id.len() > 128 || !result.is_object() || result.to_string().len() > 1024 * 1024
                {
                    return Err("답할 Codex 요청을 확인해 줘".into());
                }
                run
            }
            Self::Interrupt { run, .. } | Self::Child { run, .. } => run,
        };
        if run != current_run {
            return Err("PC의 Codex 실행이 바뀌었다".into());
        }
        Ok(())
    }
}

fn valid_codex_image(url: &str) -> bool {
    url.split_once(',').is_some_and(|(format, data)| {
        matches!(format, "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/gif;base64" | "data:image/webp;base64")
            && !data.is_empty() && data.len() <= 5_242_880
            && data.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    })
}

fn codex_call(app: &AppHandle, pane: &PaneInfo, args: &Value) -> Result<Value, String> {
    if args["session"].as_str() != Some(pane.session.as_str()) {
        return Err("PC 칸의 대화가 바뀌었다".into());
    }
    let (run, _) = crate::codex_stream::phone_connection(app, &pane.id, &pane.session).ok_or("PC의 Codex 대화창이 준비되지 않았다")?;
    let action: CodexAction = serde_json::from_value(args["action"].clone()).map_err(|_| "폰에서는 할 수 없는 Codex 요청이다")?;
    action.check(&run)?;

    static NEXT: AtomicU64 = AtomicU64::new(1);
    let call = NEXT.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = sync_mpsc::channel();
    let remote = app.state::<Remote>();
    {
        let mut inner = remote.0.lock().unwrap();
        if inner.codex_calls.len() >= 16 {
            return Err("PC가 Codex 요청을 처리하는 중이다".into());
        }
        inner.codex_calls.insert(call, sender);
    }
    // PC 입력바와 같은 경로를 써야 현재 모델·권한과 전송 순서를 어느 화면에서 보내도 공유한다.
    let sent = app.emit_to("main", "remote:codex-call", json!({ "call": call, "id": pane.id, "session": pane.session, "run": run, "action": action }));
    let result = sent.map_err(|e| e.to_string()).and_then(|_| {
        receiver.recv_timeout(Duration::from_secs(65)).map_err(|_| "PC의 Codex 대화창이 답하지 않았다".to_string())?
    });
    remote.0.lock().unwrap().codex_calls.remove(&call);
    result
}

#[tauri::command]
pub fn remote_codex_reply(app: AppHandle, call: u64, value: Option<Value>, error: Option<String>) {
    if let Some(sender) = app.state::<Remote>().0.lock().unwrap().codex_calls.remove(&call) {
        let _ = sender.send(error.map_or_else(|| Ok(value.unwrap_or(Value::Null)), Err));
    }
}

/// `from` 은 부른 기기의 이름이다(소개장에 그 이름을 적는다).
fn dispatch(app: &AppHandle, cmd: &str, args: &Value, from: &str) -> Result<Value, String> {
    let panes = app.state::<Remote>().0.lock().unwrap().panes.clone();
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let pane = |id: &str, agent| panes.iter().find(|p| p.id == id && p.agent == agent).ok_or_else(|| "PC 에 없는 칸이다".to_string());
    // 대화 읽기는 알려 준 칸의 대화만. 짝지은 폰이라도 이 PC 의 다른 대화를 뒤지지 못하게 한다.
    let conversation = || {
        let (root, id) = (s("root"), s("id"));
        if panes.iter().any(|p| p.agent == Agent::Claude && p.cwd == root && p.session.eq_ignore_ascii_case(&id)) {
            Ok((root, id))
        } else {
            Err("PC 칸의 대화가 아니다".to_string())
        }
    };
    match cmd {
        "remote_panes" => Ok(json!(panes
            .iter()
            .map(|p| {
                if p.agent == Agent::Codex {
                    let conn = crate::codex_stream::phone_connection(app, &p.id, &p.session);
                    return PhonePane { info: p.clone(), alive: conn.is_some(), busy: p.busy, tasks: 0, waiting: conn.map_or(0, |(_, n)| n) };
                }
                let snap = crate::claude_chat::snapshot(app, &p.id);
                PhonePane { info: p.clone(), alive: snap.alive, busy: snap.busy, tasks: snap.agents, waiting: snap.prompts.len() }
            })
            .collect::<Vec<_>>())),
        // 묶음의 다른 PC. 폰이 이 목록으로 그 PC 들에 들어갈 소개장을 받는다.
        "group_pcs" => {
            let remote = app.state::<Remote>();
            let inner = remote.0.lock().unwrap();
            let pcs: Vec<Value> = inner
                .saved
                .peers
                .iter()
                .filter(|p| p.invite.is_some())
                .map(|p| json!({ "id": p.id, "name": p.name, "page": p.page, "pc": p.paired["pc"] }))
                .collect();
            // `named` 면 이 PC 에서 사람이 붙인 이름이다 — 폰은 다른 PC 가 부르는 이름보다 이것을 먼저 쓴다.
            Ok(json!({ "me": my_name(&inner.saved), "named": inner.saved.name.is_some(), "pcs": pcs }))
        }
        // 묶인 PC 에 들어갈 소개장. 폰이 그 PC 몫으로 만든 공개키에 붙인다 — 비밀키는 폰에만 있다.
        "group_invite" => {
            let public = s("pub");
            rc::unb64u(&public).and_then(|k| rc::parse_public(&k)).ok_or("공개키가 잘못됐다")?;
            let remote = app.state::<Remote>();
            let inner = remote.0.lock().unwrap();
            let p = inner.saved.peers.iter().find(|p| p.id == s("peer")).ok_or("묶인 PC 가 아니다")?;
            let key = p.invite.as_deref().and_then(unhex).ok_or("묶인 PC 가 아니다")?;
            let room = room_of(&p.page).ok_or("그 PC 의 주소가 잘못됐다")?;
            let by = p.paired["dev"].as_str().unwrap_or_default();
            let dev = rc::random::<8>().map(|b| hex(&b))?;
            let name = clean_name(from);
            let mac = rc::invite_mac(&key, room, &dev, &public, &name);
            Ok(json!({ "dev": dev, "pc": p.paired["pc"], "page": p.page, "pcName": p.name, "invite": { "by": by, "mac": rc::b64u(&mac), "pub": public, "name": name } }))
        }
        "claude_chat_snapshot" => {
            let p = pane(&s("id"), Agent::Claude)?;
            Ok(json!(crate::claude_chat::snapshot(app, &p.id)))
        }
        "claude_chat_send" => {
            let p = pane(&s("id"), Agent::Claude)?;
            let line = s("line");
            phone_line(&line, |r| crate::claude_chat::waiting_for(app, &p.id, r))?;
            crate::claude_chat::send_line(app, &p.id, &line).map(|_| Value::Null)
        }
        "codex_phone" => codex_call(app, pane(&s("id"), Agent::Codex)?, args),
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
    use std::io::Read as _;

    fn panes() -> Vec<PaneInfo> {
        vec![PaneInfo {
            id: "%3".into(),
            title: "t".into(),
            cwd: "C:/work".into(),
            session: "12345678-1234-4234-8234-123456789abc".into(),
            slug: None,
            name: None,
            agent: Agent::Claude,
            busy: false,
        }]
    }

    #[test]
    fn phone_codex_actions_match_the_run_and_accept_only_user_input() {
        let parse = |value| serde_json::from_value::<CodexAction>(value);
        let send = parse(json!({ "kind":"send", "run":"current", "turn":null, "text":"", "images":["data:image/png;base64,YQ=="] })).unwrap();
        assert!(send.check("current").is_ok());
        assert!(send.check("previous").is_err());
        assert!(parse(json!({ "kind":"send", "run":"current", "turn":null, "text":"hi", "images":[], "approvalPolicy":"never" })).is_err());
        assert!(parse(json!({ "kind":"thread/start" })).is_err());
        let external = parse(json!({ "kind":"send", "run":"current", "turn":null, "text":"", "images":["https://example.com/test.png"] })).unwrap();
        assert!(external.check("current").is_err());
    }

    #[test]
    fn a_peer_is_known_by_its_phone_page() {
        let room = "1b0016dbe43537733003e79293f26bd9";
        assert_eq!(peer_page(&format!(" https://relay.me.workers.dev/r/{room}")).as_deref(), Some(format!("https://relay.me.workers.dev/r/{room}/").as_str()));
        assert!(peer_page(&format!("http://127.0.0.1:8787/r/{room}/")).is_some());
        for bad in [format!("http://relay.example/r/{room}/"), "https://relay.me.workers.dev/r/short/".into(), format!("https://relay.me.workers.dev/x/{room}/"), format!("https://a b/r/{room}/")] {
            assert!(peer_page(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_relay_must_be_https_except_a_local_test_relay() {
        assert_eq!(relay_ws("https://chiispace-relay.me.workers.dev/").as_deref(), Some("wss://chiispace-relay.me.workers.dev"));
        assert_eq!(relay_ws(" http://127.0.0.1:8787 ").as_deref(), Some("ws://127.0.0.1:8787"));
        for bad in ["http://relay.example", "ftp://x", "https://", "https://a.workers.dev/path", "https://a b", "relay.workers.dev", "http://127.0.0.1.evil.com:80"] {
            assert!(relay_ws(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_build_name_is_the_entry_script_of_the_phone_page() {
        let html = r#"<head><link rel="manifest" href="./mobile.webmanifest" /><script type="module" crossorigin src="./assets/mobile-C94PaQpb.js"></script>"#;
        assert_eq!(entry_of(html).as_deref(), Some("assets/mobile-C94PaQpb.js"));
        assert_eq!(entry_of("<html></html>"), None);
        assert_eq!(entry_of(r#"src="./assets/x.css""#), None);
        assert_eq!(entry_of(r#"src="./assets/a b.js""#), None);
    }

    #[test]
    fn the_phone_gets_only_the_phone_build() {
        assert_eq!(asset_name("").as_deref(), Some("m/mobile.html"));
        assert_eq!(asset_name("assets/mobile-abc.js").as_deref(), Some("m/assets/mobile-abc.js"));
        assert_eq!(asset_name("mobile.webmanifest").as_deref(), Some("m/mobile.webmanifest"));
        for bad in ["../index.html", "assets/../../index.html", "/etc", "a//b", "./x", "x?y", "x%2e"] {
            assert!(asset_name(bad).is_none(), "{bad}");
        }
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
        let ev = event_for("claude:chat", &line("%3", r#"{"type":"assistant"}"#), &p).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&ev).unwrap()["e"], "claude:chat");
        assert!(event_for("claude:chat", &line("%9", r#"{"type":"assistant"}"#), &p).is_none());
        assert!(event_for("claude:chat", &line("%3", r#"{"type":"stream_event","event":{}}"#), &p).is_none());
        assert!(event_for("claude:chat-answered", &json!({"id":"%3","request_id":"r"}).to_string(), &p).is_some());
        assert!(event_for("claude:chat-exit", &json!({"id":"%4","code":0,"error":""}).to_string(), &p).is_none());
        let live = |s: &str| json!({"session": s, "req": 1, "phase": "begin", "events": []}).to_string();
        assert!(event_for("chat:live", &live("12345678-1234-4234-8234-123456789ABC"), &p).is_some());
        assert!(event_for("chat:live", &live("00000000-0000-4000-8000-000000000000"), &p).is_none());
        assert!(event_for("pty:data", &json!({"id":"%3"}).to_string(), &p).is_none());
        assert!(event_for("claude:chat", "not json", &p).is_none());
    }

    #[test]
    fn a_phone_gets_in_only_with_an_invite_from_a_linked_pc() {
        let room = "1b0016dbe43537733003e79293f26bd9";
        let key = [7u8; 32];
        let member = Device { id: "aaaaaaaaaaaaaaaa".into(), name: "노트북".into(), key: String::new(), added: 0, kind: Some("pc".into()), invite: Some(hex(&key)), via: None };
        let saved = Saved { room: Some(room.into()), devices: vec![member.clone()], ..Default::default() };
        let public = rc::b64u(&rc::public_of(&rc::new_secret().unwrap()));
        let dev = "0123456789abcdef";
        let inv = |room: &str, dev: &str, name: &str, by: &str| {
            json!({ "by": by, "mac": rc::b64u(&rc::invite_mac(&key, room, dev, &public, name)), "pub": public, "name": name }).as_object().unwrap().clone()
        };
        let ok = admit(&saved, dev, &Value::Object(inv(room, dev, "iPhone", "aaaaaaaaaaaaaaaa"))).expect("묶인 PC 의 소개장");
        assert_eq!((ok.name.as_str(), ok.kind.as_deref(), ok.via.as_deref()), ("iPhone", None, Some("노트북")));
        // 다른 방·다른 기기 id 로 만든 소개장, 이름을 바꾼 소개장은 안 맞는다.
        assert!(admit(&saved, dev, &Value::Object(inv("ffffffffffffffffffffffffffffffff", dev, "iPhone", "aaaaaaaaaaaaaaaa"))).is_none());
        assert!(admit(&saved, "fedcba9876543210", &Value::Object(inv(room, dev, "iPhone", "aaaaaaaaaaaaaaaa"))).is_none());
        let mut renamed = inv(room, dev, "iPhone", "aaaaaaaaaaaaaaaa");
        renamed.insert("name".into(), json!("iPad"));
        assert!(admit(&saved, dev, &Value::Object(renamed)).is_none());
        // 묶이지 않은 기기(폰, 소개장 열쇠 없는 PC)가 만든 소개장은 받지 않는다. 이미 있는 기기 id 도 다시 들이지 않는다.
        assert!(admit(&saved, dev, &Value::Object(inv(room, dev, "iPhone", "bbbbbbbbbbbbbbbb"))).is_none());
        let phone = Saved { devices: vec![Device { kind: None, ..member.clone() }], ..saved.clone() };
        assert!(admit(&phone, dev, &Value::Object(inv(room, dev, "iPhone", "aaaaaaaaaaaaaaaa"))).is_none());
        let unlinked = Saved { devices: vec![Device { invite: None, ..member.clone() }], ..saved.clone() };
        assert!(admit(&unlinked, dev, &Value::Object(inv(room, dev, "iPhone", "aaaaaaaaaaaaaaaa"))).is_none());
        assert!(admit(&saved, "aaaaaaaaaaaaaaaa", &Value::Object(inv(room, "aaaaaaaaaaaaaaaa", "iPhone", "aaaaaaaaaaaaaaaa"))).is_none());
    }

    #[test]
    fn rooms_and_keys_are_read_strictly() {
        assert_eq!(room_of("https://relay.me.workers.dev/r/1b0016dbe43537733003e79293f26bd9/"), Some("1b0016dbe43537733003e79293f26bd9"));
        assert_eq!(room_of("https://relay.me.workers.dev/r/short/"), None);
        assert_eq!(unhex("0aff"), Some(vec![0x0a, 0xff]));
        assert_eq!(unhex("0af"), None);
        assert_eq!(unhex("zz"), None);
        assert!(is_dev_id("0123456789abcdef") && !is_dev_id("0123456789abcde") && !is_dev_id("0123456789abcdeg"));
    }

    fn pair_of_sessions() -> (Session, Session) {
        let pc = rc::new_secret().unwrap();
        let phone = rc::new_secret().unwrap();
        let mk = || Session { dev: "d".into(), pc: false, keys: rc::session_keys(&pc, &phone.public_key(), &[1; 16], &[2; 16], "d"), rx: 0, tx: 0, parts: Vec::new() };
        (mk(), mk())
    }

    #[test]
    fn long_messages_are_squeezed_and_split_and_come_back_whole() {
        let (mut pc, _) = pair_of_sessions();
        let short = frames(&mut pc, r#"{"t":"ret"}"#);
        assert_eq!(short.len(), 1);
        let f: Value = serde_json::from_str(&short[0]).unwrap();
        assert_eq!((f["n"].as_u64(), f["z"].as_bool()), (Some(0), Some(false)));
        // 줄어드는 원문은 한 통에 들어간다.
        let raw = format!(r#"{{"t":"ret","v":"{}"}}"#, "가".repeat(400_000));
        let squeezed = frames(&mut pc, &raw);
        assert_eq!(squeezed.len(), 1, "gzip 으로 줄어야 한다");
        let f: Value = serde_json::from_str(&squeezed[0]).unwrap();
        assert_eq!(f["z"], true);
        let gz = rc::open(&pc.keys.down, 1, f["c"].as_str().unwrap()).unwrap();
        let mut back = String::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_string(&mut back).unwrap();
        assert_eq!(back, raw);
        // 안 줄어드는 것(그림)은 조각난다.
        let noise: String = (0..1000).map(|_| rc::b64u(&rc::random::<512>().unwrap())).collect();
        let split = frames(&mut pc, &noise);
        assert!(split.len() >= 2);
        for (i, f) in split.iter().enumerate() {
            let f: Value = serde_json::from_str(f).unwrap();
            assert_eq!((f["n"].as_u64(), f["i"].as_u64(), f["of"].as_u64()), (Some(2), Some(i as u64), Some(split.len() as u64)));
            assert!(f.to_string().len() < 300_000, "한 통이 중계 한도 안이다");
        }
    }

    #[test]
    fn phone_frames_must_come_in_order_and_open_with_the_key() {
        let (mut pc, phone) = pair_of_sessions();
        let up = |n: u64, text: &str| json!({ "k": "x", "n": n, "c": rc::seal(&phone.keys.up, n, text.as_bytes()) });
        assert_eq!(take(&mut pc, &up(0, "a")), Ok(Some("a".into())));
        assert_eq!(take(&mut pc, &up(1, "b")), Ok(Some("b".into())));
        // 되풀이·건너뛰기·다른 방향 키는 끊는다.
        assert_eq!(take(&mut pc, &up(1, "b")), Err(()));
        assert_eq!(take(&mut pc, &up(3, "d")), Err(()));
        let wrong = json!({ "k": "x", "n": 2, "c": rc::seal(&phone.keys.down, 2, b"c") });
        assert_eq!(take(&mut pc, &wrong), Err(()));
        // 조각은 차례대로 모여야 풀린다.
        let c = rc::seal(&phone.keys.up, 2, b"chunked");
        let (a, b) = c.split_at(10);
        assert_eq!(take(&mut pc, &json!({ "k": "x", "n": 2, "c": a, "i": 0, "of": 2 })), Ok(None));
        assert_eq!(take(&mut pc, &json!({ "k": "x", "n": 2, "c": b, "i": 1, "of": 2 })), Ok(Some("chunked".into())));
        assert_eq!(take(&mut pc, &json!({ "k": "x", "n": 3, "c": "x", "i": 1, "of": 2 })), Err(()), "앞 조각 없이 온 조각");
    }
}
