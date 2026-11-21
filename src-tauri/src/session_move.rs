//! 다른 PC 로 대화 이사 — 한 PC 의 Claude 대화창 칸을 다른 PC 의 chiispace 로 옮겨 그 PC 에서 이어 쓴다.
//!
//! - 옮기는 것은 대화 파일(`<id>.jsonl`)과 그 옆 폴더(`<id>/`, 서브에이전트 대화)뿐이다. 인증·설정은 옮기지 않는다.
//!   claude 는 `--resume <id>` 에 모든 프로젝트 폴더에서 그 id 를 찾아 이어 열고, 이어 쓴 줄에는 새 폴더를 적는다
//!   (11월 19일 2.1.328 로 확인). 그래서 대화 안의 경로를 고쳐 쓰지 않는다.
//! - 보내는 쪽(ui/session-move.ts)은 폰과 같은 길(짝짓기·암호 통로)로 받는 PC 의 방에 붙어 `session_move_offer` 를 부른다.
//!   이 명령은 PC 로 짝지은 기기만 부를 수 있고(remote.rs `on_message`), 받는 PC 에서 사람이 폴더를 고르고 [받기]를
//!   눌러야 파일을 쓴다.
//! - 같은 대화를 두 PC 에서 이어 쓰면 둘로 갈라져 합칠 수 없다. 보낸 쪽은 받았다는 답을 받은 뒤에 칸을 닫는다.
//!   받는 쪽은 이 PC 에 이미 있는 같은 대화보다 짧은 것으로 덮지 않는다.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// 받는 PC 에서 사람이 답하기를 기다리는 시간. 넘기면 보낸 쪽에 거절로 돌려준다.
const WAIT: Duration = Duration::from_secs(300);
/// 대화 하나의 파일 수·풀어 놓은 크기 한도. 그림이 많이 실린 긴 대화도 들어가게 넉넉히 둔다.
const MAX_FILES: usize = 4000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Git {
    /// 정리한 원격 주소(`github.com/owner/repo`). 두 PC 의 같은 레포를 이것으로 알아본다.
    pub origin: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// 커밋하지 않은 변경 수. 대화만 가고 이 변경은 안 간다.
    pub dirty: usize,
}

#[derive(Serialize, Deserialize)]
pub struct PackFile {
    /// `<id>.jsonl` 이거나 `<id>/…`.
    pub rel: String,
    /// gzip 한 내용의 base64.
    pub gz: String,
}

#[derive(Serialize)]
pub struct Pack {
    session: String,
    cwd: String,
    git: Git,
    files: Vec<PackFile>,
    bytes: u64,
}

fn uuid_shaped(s: &str) -> bool {
    s.len() == 36 && s.chars().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// 꾸러미 안의 파일 자리. 대화 파일 하나와 그 옆 폴더 안만 받는다 — 경로 조각으로 다른 곳에 쓰지 못하게.
fn safe_rel(rel: &str, session: &str) -> bool {
    if rel == format!("{session}.jsonl") {
        return true;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    parts.len() >= 2
        && parts.len() <= 6
        && parts[0] == session
        && parts[1..].iter().all(|p| {
            !p.is_empty() && *p != "." && *p != ".." && p.len() <= 128 && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

/// 두 PC 의 같은 레포를 알아볼 원격 주소. https·ssh·끝의 `.git`·대소문자 차이를 걷는다.
pub fn origin_key(url: &str) -> Option<String> {
    let mut u = url.trim().to_ascii_lowercase();
    for p in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = u.strip_prefix(p) {
            u = rest.to_string();
        }
    }
    if let Some((user, rest)) = u.split_once('@') {
        if !user.contains('/') {
            u = rest.to_string();
        }
    }
    // git@github.com:owner/repo 의 쌍점은 경로 구분이다.
    if let Some((host, rest)) = u.split_once(':') {
        if !host.contains('/') && !rest.starts_with(|c: char| c.is_ascii_digit()) {
            u = format!("{host}/{rest}");
        }
    }
    let u = u.trim_end_matches('/').trim_end_matches(".git").trim_end_matches('/').to_string();
    (u.contains('/') && !u.is_empty()).then_some(u)
}

/// 설정에 걸린 외부 프로그램(fsmonitor)을 끄고 묻는다(git_diff.rs 와 같다).
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.fsmonitor=false"]).arg("-C").arg(root).args(args).env("GIT_OPTIONAL_LOCKS", "0").stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn git_info(root: &Path) -> Git {
    if !root.is_dir() || git(root, &["rev-parse", "--git-dir"]).is_none() {
        return Git::default();
    }
    Git {
        origin: git(root, &["config", "--get", "remote.origin.url"]).as_deref().and_then(origin_key),
        branch: git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| !b.is_empty()),
        head: git(root, &["rev-parse", "HEAD"]).filter(|h| !h.is_empty()),
        dirty: git(root, &["status", "--porcelain"]).map_or(0, |s| s.lines().filter(|l| !l.trim().is_empty()).count()),
    }
}

fn gz(bytes: &[u8]) -> Result<String, String> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(B64.encode(enc.finish().map_err(|e| e.to_string())?))
}

fn ungz(b64: &str, budget: u64) -> Result<Vec<u8>, String> {
    let raw = B64.decode(b64).map_err(|_| "꾸러미 파일이 base64 가 아니다")?;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(raw.as_slice())
        .take(budget + 1)
        .read_to_end(&mut out)
        .map_err(|_| "꾸러미 파일을 못 풀었다")?;
    if out.len() as u64 > budget {
        return Err("대화가 너무 크다".into());
    }
    Ok(out)
}

/// 보낼 꾸러미. 그 칸의 대화 파일과 옆 폴더, 칸 폴더의 git 상태.
#[tauri::command]
pub fn session_move_pack(app: AppHandle, root: String, id: String) -> Result<Pack, String> {
    if !uuid_shaped(&id) {
        return Err("대화 id 모양이 아니다".into());
    }
    let file = crate::claude_files::session_file(&app, &root, &id).ok_or("옮길 대화가 아직 없다 — 한 마디라도 주고받은 뒤에 옮긴다")?;
    let mut files = Vec::new();
    let mut bytes = 0u64;
    let mut add = |path: &Path, rel: String| -> Result<(), String> {
        if !safe_rel(&rel, &id) {
            return Ok(());
        }
        if files.len() >= MAX_FILES {
            return Err("대화에 딸린 파일이 너무 많다".into());
        }
        let data = std::fs::read(path).map_err(|e| format!("대화 파일을 못 읽었다 — {e}"))?;
        bytes += data.len() as u64;
        if bytes > MAX_BYTES {
            return Err("대화가 너무 크다".into());
        }
        files.push(PackFile { rel, gz: gz(&data)? });
        Ok(())
    };
    add(&file, format!("{id}.jsonl"))?;
    // 서브에이전트 대화 등 대화 옆 폴더. 링크는 따라가지 않는다.
    let side = file.with_extension("");
    let mut stack = vec![(side.clone(), id.clone(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let Ok(kind) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            let sub = format!("{rel}/{name}");
            if kind.is_dir() && depth < 4 {
                stack.push((e.path(), sub, depth + 1));
            } else if kind.is_file() {
                add(&e.path(), sub)?;
            }
        }
    }
    Ok(Pack { session: id, cwd: root.clone(), git: git_info(Path::new(&root)), files, bytes })
}

/// 받은 대화가 이 PC 에 이미 있는 같은 대화와 어떤 사이인가. 대화 파일은 줄을 덧붙이기만 한다.
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    /// 이 PC 에 없다.
    New,
    /// 이 PC 의 것이 받은 것의 앞부분이다(전에 이 PC 에서 보냈다가 저쪽에서 이어 쓴 것). 받은 것으로 바꾼다.
    Behind,
    Same,
    /// 이 PC 의 것이 더 길다. 덮으면 이 PC 에서 이어 쓴 말을 잃으므로 그대로 둔다.
    Ahead,
    /// 둘이 갈라졌다. 이 PC 의 것을 옆에 남겨 두고 받은 것으로 바꾼다.
    Split,
}

pub fn relation(here: Option<&[u8]>, incoming: &[u8]) -> Relation {
    match here {
        None => Relation::New,
        Some(h) if h == incoming => Relation::Same,
        Some(h) if incoming.starts_with(h) => Relation::Behind,
        Some(h) if h.starts_with(incoming) => Relation::Ahead,
        Some(_) => Relation::Split,
    }
}

struct Offer {
    session: String,
    git: Git,
    files: Vec<(String, Vec<u8>)>,
    reply: mpsc::Sender<Result<Value, String>>,
}

#[derive(Default)]
pub struct Moves(Mutex<HashMap<u64, Offer>>);

/// 짝지은 PC 가 대화를 보내 왔다(remote.rs 가 부른다, 그 PC 의 기기 이름과 함께). 이 PC 화면에 [받기] 창을 띄우고
/// 사람이 답할 때까지 기다린다. 받으면 연 대화 id·폴더를, 거절·시간 넘김이면 까닭을 보낸 쪽에 돌려준다.
pub fn offer(app: &AppHandle, from: &str, args: &Value) -> Result<Value, String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if args["v"].as_u64() != Some(1) || s("agent") != "claude" {
        return Err("이 판의 chiispace 가 모르는 이사 꾸러미다 — 두 PC 의 판을 맞춰 줘".into());
    }
    let session = s("session");
    if !uuid_shaped(&session) {
        return Err("대화 id 모양이 아니다".into());
    }
    let list = args["files"].as_array().ok_or("꾸러미에 파일이 없다")?;
    if list.is_empty() || list.len() > MAX_FILES {
        return Err("꾸러미 파일 수가 맞지 않는다".into());
    }
    let mut files = Vec::new();
    let mut left = MAX_BYTES;
    for f in list {
        let rel = f["rel"].as_str().unwrap_or("");
        if !safe_rel(rel, &session) {
            return Err(format!("받을 수 없는 파일 자리다: {rel}"));
        }
        let data = ungz(f["gz"].as_str().unwrap_or(""), left)?;
        left -= data.len() as u64;
        files.push((rel.to_string(), data));
    }
    let main = format!("{session}.jsonl");
    let incoming = files.iter().find(|(r, _)| *r == main).map(|(_, d)| d.clone()).ok_or("꾸러미에 대화 파일이 없다")?;
    let here = crate::claude_files::session_file(app, "", &session).and_then(|p| std::fs::read(p).ok());
    let rel = relation(here.as_deref(), &incoming);
    let git: Git = serde_json::from_value(args["git"].clone()).unwrap_or_default();
    let clip = |k: &str, n: usize| s(k).chars().filter(|c| !c.is_control()).take(n).collect::<String>();
    let cwd = clip("cwd", 400);

    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (reply, wait) = mpsc::channel();
    {
        let moves = app.state::<Moves>();
        let mut map = moves.0.lock().unwrap();
        if map.len() >= 4 {
            return Err("받는 PC 에 답하지 않은 이사가 쌓여 있다".into());
        }
        map.insert(id, Offer { session: session.clone(), git: git.clone(), files, reply });
    }
    let folder = cwd.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("").to_string();
    let shown = app.emit_to(
        "main",
        "remote:move-offer",
        json!({
            "offer": id, "from": from, "session": session, "cwd": cwd, "folder": folder,
            "title": clip("title", 80), "slug": clip("slug", 40), "name": clip("name", 40),
            "git": git, "bytes": incoming.len(), "relation": rel,
        }),
    );
    let out = shown.map_err(|e| e.to_string()).and_then(|_| wait.recv_timeout(WAIT).unwrap_or_else(|_| Err("받는 PC 에서 5분 안에 답하지 않았다".into())));
    // 답했으면 이미 빠졌다. 시간이 넘었으면 여기서 빼고 화면의 창도 걷는다.
    if app.state::<Moves>().0.lock().unwrap().remove(&id).is_some() {
        let _ = app.emit_to("main", "remote:move-gone", json!({ "offer": id }));
    }
    out
}

/// claude 가 대화를 쌓는 폴더 이름(경로의 글자·숫자 말고는 `-`).
fn project_dir(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// 받은 파일을 claude 의 자리에 쓴다. 이 PC 에 같은 대화가 있으면 그 자리에(같은 id 가 두 곳에 있으면 claude 가 어느 것을
/// 열지 모른다), 없으면 고른 폴더의 자리에 쓴다.
fn write_files(app: &AppHandle, offer: &Offer, cwd: &str) -> Result<Relation, String> {
    let main = format!("{}.jsonl", offer.session);
    let incoming = offer.files.iter().find(|(r, _)| *r == main).map(|(_, d)| d.as_slice()).unwrap_or_default();
    let existing = crate::claude_files::session_file(app, "", &offer.session);
    let here = existing.as_ref().and_then(|p| std::fs::read(p).ok());
    let rel = relation(here.as_deref(), incoming);
    let base: PathBuf = match &existing {
        Some(p) => p.parent().map(Path::to_path_buf).ok_or("대화 자리를 모르겠다")?,
        None => crate::claude_files::claude_home(app).ok_or("claude 폴더를 모르겠다")?.join("projects").join(project_dir(cwd)),
    };
    match rel {
        Relation::Same | Relation::Ahead => return Ok(rel),
        Relation::Split => {
            if let Some(p) = &existing {
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                std::fs::copy(p, p.with_extension(format!("jsonl.before-move-{stamp}"))).map_err(|e| format!("이 PC 의 대화를 남겨 두지 못했다 — {e}"))?;
            }
        }
        Relation::New | Relation::Behind => {}
    }
    for (r, data) in &offer.files {
        let to = base.join(r.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("대화 자리를 못 만들었다 — {e}"))?;
        }
        // 다 쓴 뒤에 이름을 바꾼다. 쓰다 끊기면 반쪽 대화를 claude 가 연다.
        let tmp = to.with_extension("chiispace-move");
        std::fs::write(&tmp, data).map_err(|e| format!("대화를 못 썼다 — {e}"))?;
        std::fs::rename(&tmp, &to).map_err(|e| format!("대화를 못 썼다 — {e}"))?;
    }
    Ok(rel)
}

/// [받기]·[거절]. 받으면 고른 폴더(`cwd`)로 파일을 쓰고 보낸 PC 에 알린다. 웹뷰는 돌려받은 대화를 새 탭에서 연다.
#[tauri::command]
pub fn session_move_answer(app: AppHandle, offer: u64, cwd: Option<String>) -> Result<Value, String> {
    let Some(o) = app.state::<Moves>().0.lock().unwrap().remove(&offer) else {
        return Err("이 이사는 이미 끝났다 — 보낸 PC 가 기다리다 그만뒀다".into());
    };
    let Some(cwd) = cwd else {
        let _ = o.reply.send(Err("받는 PC 에서 거절했다".into()));
        return Ok(Value::Null);
    };
    if !Path::new(&cwd).is_dir() {
        // 고른 폴더가 없으면 다시 고르게 둔다.
        let msg = format!("폴더가 없다: {cwd}");
        app.state::<Moves>().0.lock().unwrap().insert(offer, o);
        return Err(msg);
    }
    match write_files(&app, &o, &cwd) {
        Ok(rel) => {
            if let Some(origin) = &o.git.origin {
                crate::remote::remember_folder(&app, origin, &cwd);
            }
            let out = json!({ "session": o.session, "cwd": cwd, "relation": rel });
            let _ = o.reply.send(Ok(out.clone()));
            Ok(out)
        }
        Err(e) => {
            let _ = o.reply.send(Err(format!("받는 PC 에서 대화를 못 썼다 — {e}")));
            Err(e)
        }
    }
}

#[derive(Serialize, Debug)]
pub struct FolderGuess {
    path: String,
    git: Git,
    /// 전에 같은 레포를 받을 때 고른 폴더다.
    remembered: bool,
}

/// 받을 폴더 후보. 사람이 직접 고른 폴더(`chosen`), 전에 고른 폴더, 그다음 이 PC 의 앱이 아는 폴더(탭·칸) 가운데 원격 주소가
/// 같은 것. 원격이 없으면 이름이 같은 것. 앱은 이 목록에서 고르지 않는다 — 첫 줄을 권할 뿐 [받기]는 사람이 누른다.
#[tauri::command]
pub fn session_move_folders(app: AppHandle, origin: Option<String>, folder: String, known: Vec<String>, chosen: Option<String>) -> Vec<FolderGuess> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    if let Some(path) = chosen.filter(|p| Path::new(p).is_dir()) {
        seen.insert(path.trim_end_matches(['\\', '/']).to_lowercase());
        out.push(FolderGuess { git: git_info(Path::new(&path)), path, remembered: false });
    }
    let remembered = origin.as_deref().and_then(|o| crate::remote::remembered_folder(&app, o));
    for (path, mine) in remembered.into_iter().map(|p| (p, true)).chain(known.into_iter().take(64).map(|p| (p, false))) {
        let key = path.trim_end_matches(['\\', '/']).to_lowercase();
        if path.trim().is_empty() || !seen.insert(key) || !Path::new(&path).is_dir() {
            continue;
        }
        let git = git_info(Path::new(&path));
        let name = path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        let hit = match &origin {
            Some(o) => git.origin.as_deref() == Some(o.as_str()),
            None => !folder.is_empty() && name == folder.to_lowercase(),
        };
        if mine || hit {
            out.push(FolderGuess { path, git, remembered: mine });
        }
    }
    out
}

/// 짝지을 때 받는 PC 에 보일 이 PC 의 이름. [폰 연결]에서 붙인 이름이 있으면 그것.
#[tauri::command]
pub fn this_pc_name(app: tauri::AppHandle) -> String {
    crate::remote::name_of(&app)
}

pub(crate) fn computer_name() -> String {
    std::env::var("COMPUTERNAME").ok().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "PC".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11e45568-3427-46ff-98bf-0091d3cf7edd";

    #[test]
    fn only_the_conversation_and_its_side_folder_are_written() {
        assert!(safe_rel(&format!("{ID}.jsonl"), ID));
        assert!(safe_rel(&format!("{ID}/subagents/agent-a7c9ae52f4cfba48c.jsonl"), ID));
        assert!(safe_rel(&format!("{ID}/subagents/agent-a7c9ae52f4cfba48c.meta.json"), ID));
        for bad in [
            "other.jsonl".to_string(),
            format!("{ID}/../x.jsonl"),
            format!("{ID}/./x"),
            format!("{ID}//x"),
            format!("../{ID}.jsonl"),
            format!("{ID}/a/b/c/d/e/f"),
            format!("{ID}\\x"),
            format!("{ID}/C:x"),
            "00000000-0000-0000-0000-000000000000/x".to_string(),
        ] {
            assert!(!safe_rel(&bad, ID), "{bad}");
        }
    }

    #[test]
    fn the_same_repo_is_known_by_its_remote_on_both_pcs() {
        let want = Some("github.com/sehyun04/chiios".to_string());
        for url in ["https://github.com/sehyun04/chiiOS.git", "git@github.com:sehyun04/chiiOS.git", "https://github.com/sehyun04/chiiOS/", "ssh://git@github.com/sehyun04/chiiOS", "https://user@github.com/sehyun04/chiiOS"] {
            assert_eq!(origin_key(url), want, "{url}");
        }
        assert_eq!(origin_key("ssh://git@host:2222/a/b.git").as_deref(), Some("host:2222/a/b"));
        assert_eq!(origin_key(""), None);
        assert_eq!(origin_key("localrepo"), None);
    }

    #[test]
    fn a_longer_conversation_here_is_not_overwritten() {
        assert_eq!(relation(None, b"a\nb\n"), Relation::New);
        assert_eq!(relation(Some(b"a\n"), b"a\nb\n"), Relation::Behind);
        assert_eq!(relation(Some(b"a\nb\n"), b"a\nb\n"), Relation::Same);
        assert_eq!(relation(Some(b"a\nb\nc\n"), b"a\nb\n"), Relation::Ahead);
        assert_eq!(relation(Some(b"a\nx\n"), b"a\nb\n"), Relation::Split);
    }

    #[test]
    fn packed_files_unpack_within_the_budget() {
        let data = "줄\n".repeat(1000).into_bytes();
        let b = gz(&data).unwrap();
        assert_eq!(ungz(&b, 1_000_000).unwrap(), data);
        assert!(ungz(&b, 100).is_err(), "한도를 넘는 것을 풀었다");
        assert!(ungz("not base64!", 100).is_err());
    }

    #[test]
    fn project_dirs_follow_claude() {
        assert_eq!(project_dir(r"C:\Users\gagu1\chiiOS"), "C--Users-gagu1-chiiOS");
        assert_eq!(project_dir("C:/chiiOS"), "C--chiiOS");
    }
}
