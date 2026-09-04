//! 파일트리와 git 상태. 층 ②("작업환경")의 첫 조각 — 터미널 옆에 "지금 연
//! 프로젝트"가 있어야 이게 터미널이 아니라 작업환경이 된다.

use std::collections::HashMap;
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 시작할 때 열어 둘 폴더. `chiispace <경로>` 또는 CHIISPACE_ROOT.
/// `code .` 과 같은 기대를 따른다 — 터미널에서 폴더를 지정해 여는 것이 기본 동선이다.
#[tauri::command]
pub fn initial_root() -> Option<String> {
    let arg = std::env::args().nth(1).filter(|a| !a.starts_with('-'));
    let raw = arg.or_else(|| std::env::var("CHIISPACE_ROOT").ok())?;
    let abs = std::fs::canonicalize(&raw).ok()?;
    let s = abs.to_string_lossy().replace('\\', "/");
    // canonicalize 는 Windows 에서 \?\C:\... 를 준다. 그대로 두면 화면에도
    // 그렇게 뜨고 git -C 에도 그 형태가 넘어간다.
    Some(s.trim_start_matches("//?/").to_string())
}

/// 폴더 고르기. 콜백 API + 채널로 받는다 — `blocking_pick_folder` 를 GUI
/// 스레드에서 부르면 그대로 멈춘다.
#[tauri::command]
pub async fn fs_pick(app: AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx.recv().ok().flatten()?;
    Some(picked.into_path().ok()?.to_string_lossy().replace('\\', "/"))
}

#[derive(serde::Serialize, Default)]
pub struct GitInfo {
    branch: String,
    ahead: u32,
    behind: u32,
    /// 레포 루트 기준 상대 경로 -> 한 글자 상태(M/A/D/R/?).
    files: HashMap<String, String>,
}

fn git(root: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    // 이게 없으면 창 없는 릴리스 빌드에서 git 을 부를 때마다 콘솔 창이 번쩍인다.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_status(root: String) -> GitInfo {
    let mut info = GitInfo::default();
    let Some(text) = git(&root, &["status", "-b", "--porcelain"]) else {
        return info; // git 레포가 아니면 조용히 빈 값 — 오류로 띄울 일이 아니다.
    };

    for line in text.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 2, behind 1]" 또는 "main"
            info.branch = head
                .split_once("...")
                .map(|(b, _)| b)
                .unwrap_or(head)
                .split(' ')
                .next()
                .unwrap_or("")
                .to_string();
            if let Some(rest) = head.split_once('[').map(|(_, r)| r) {
                info.ahead = pick_num(rest, "ahead ");
                info.behind = pick_num(rest, "behind ");
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let (code, path) = line.split_at(3);
        // 이름이 바뀐 항목은 "old -> new" 로 온다. 지금 있는 쪽만 표시한다.
        let path = path.rsplit(" -> ").next().unwrap_or(path);
        let path = path.trim().trim_matches('"').replace('\\', "/");
        let mark = if code.contains('?') {
            "?"
        } else if code.contains('A') {
            "A"
        } else if code.contains('D') {
            "D"
        } else if code.contains('R') {
            "R"
        } else {
            "M"
        };
        info.files.insert(path, mark.to_string());
    }
    info
}

fn pick_num(s: &str, key: &str) -> u32 {
    s.split_once(key)
        .and_then(|(_, r)| {
            r.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .ok()
        })
        .unwrap_or(0)
}

// ── claude 대화 ──────────────────────────────────────────────────
//
// claude 는 대화를 `~/.claude/projects/<경로별 폴더>/<세션 UUID>.jsonl` 에 쌓는다.
// 파일 이름이 곧 세션 ID 라, 그것을 알면 `claude --resume <id>` 로 그 대화를
// 정확히 다시 열 수 있다. `--continue` 로는 안 된다 — 그건 "그 폴더의 가장 최근"
// 이라서, pane 이 여럿이면 전부 같은 대화로 몰리고 다른 창에서 claude 를 돌리면
// 엉뚱한 것이 열린다.

#[derive(serde::Serialize)]
pub struct ClaudeSession {
    id: String,
    /// 마지막으로 쓰인 시각(ms). 어느 pane 의 대화인지는 이걸로 가린다.
    mtime: u64,
    /// 그 대화를 뭐라고 부를지. 사람이 붙인 이름이 있으면 그것, 없으면
    /// 마지막으로 시킨 일이다. pane 헤더에 이걸 걸어야 여러 개를 띄워 놓고도
    /// 어느 쪽이 무슨 대화였는지 안다.
    title: String,
}

/// 대화에서 주운 것: 사람이 붙인 이름과, 마지막 사용자 프롬프트.
#[derive(Default)]
struct Scan {
    name: String,
    prompt: String,
}

impl Scan {
    /// 이름이 있으면 이름, 없으면 마지막 프롬프트.
    fn pick(self) -> String {
        if self.name.is_empty() { self.prompt } else { self.name }
    }
}

/// 대화에서 이름과 마지막 프롬프트를 같이 줍는다.
///
/// jsonl 은 한 줄에 한 레코드라 줄 단위로 훑고, 찾는 표시가 든 줄만 파싱한다.
/// 대화가 수십 MB 로 자라므로 모든 줄을 JSON 으로 뜯으면 그 값을 치른다.
fn scan_title<R: std::io::BufRead>(r: R) -> Scan {
    let mut out = Scan::default();
    for line in r.lines().map_while(Result::ok) {
        let named = line.contains("\"agent-name\"");
        if !named && !line.contains("\"last-prompt\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if named {
            // `/rename` 이나 `--name` 으로 붙인 이름. 바꿀 때마다 새 레코드가
            // 쌓이므로 마지막 것이 지금 이름이다.
            if let Some(n) = v.get("agentName").and_then(|x| x.as_str()) {
                let one = n.trim();
                if !one.is_empty() {
                    out.name = one.chars().take(80).collect();
                }
            }
            continue;
        }
        // lastPrompt 가 빠진 레코드도 섞여 있다. 그건 건너뛰고 그 앞의 것을 남긴다.
        if let Some(p) = v.get("lastPrompt").and_then(|x| x.as_str()) {
            let one = p.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            if !one.is_empty() {
                out.prompt = one.chars().take(80).collect();
            }
        }
    }
    out
}

/// 그 대화를 화면에 뭐라고 걸지.
///
/// **이름이 있으면 이름이 이긴다.** 마지막 프롬프트는 물을 때마다 바뀌므로 칸
/// 이름으로 걸어 두면 조금 전까지 "카사스페"이던 칸이 방금 친 질문으로 바뀐다 —
/// 이름을 붙여 둔 뜻이 없어지고, 나중에 어느 칸이 무엇이었는지 헷갈린다.
/// 이름이 없는 대화에서만 마지막 프롬프트로 대신한다.
fn session_title(path: &std::path::Path) -> String {
    use std::io::{BufReader, Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // 이 값을 헤더에 걸어 두고 주기적으로 다시 읽는데, 대화는 수십 MB 까지 자란다.
    // 통째로 훑지 않고 양 끝만 본다.
    const EDGE: u64 = 512 * 1024;
    if len > EDGE && f.seek(SeekFrom::Start(len - EDGE)).is_ok() {
        let mut r = BufReader::new(&mut f);
        // 잘린 첫 줄은 JSON 이 아니므로 버린다.
        let mut cut = String::new();
        let _ = std::io::BufRead::read_line(&mut r, &mut cut);
        let tail = scan_title(r);
        if !tail.name.is_empty() {
            return tail.name;
        }
        // 이름은 대화 앞머리에서 한 번 붙고 마는 수가 있어 꼬리에는 없을 수 있다.
        // 그렇다고 수십 MB 를 다 훑을 수는 없으니 머리 쪽도 같은 크기만 본다.
        if let Ok(head) = std::fs::File::open(path) {
            let got = scan_title(BufReader::new(head.take(EDGE)));
            if !got.name.is_empty() {
                return got.name;
            }
        }
        if !tail.prompt.is_empty() {
            return tail.prompt;
        }
    }
    let Ok(whole) = std::fs::File::open(path) else {
        return String::new();
    };
    scan_title(BufReader::new(whole)).pick()
}

/// 경로를 폴더 이름과 맞대 보기 위한 정규화. claude 가 쓰는 인코딩 규칙을
/// 그대로 흉내 내지 않는다 — 구분자와 대소문자 처리가 바뀌면 조용히 못 찾게 된다.
/// 영숫자만 남겨 비교하면 규칙을 몰라도 같은 폴더를 짚는다.
fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 지금 백그라운드로 살아 있는 claude 대화들(짧은 id, 앞 8자).
///
/// 이걸 알아야 하는 이유는 복원이 깨지기 때문이다. claude 는 대화를 데몬에
/// 맡겨 백그라운드로 계속 돌릴 수 있고, 그렇게 살아 있는 대화를 `--resume`
/// 으로 또 열려고 하면 열어 주지 않는다 — 한 대화에 두 프로세스가 붙어 같은
/// 기록에 쓰게 되기 때문이다. 그때 칸에는 "That session is still running as a
/// background session" 만 남고 아무것도 복원되지 않는다. 사용자에게는 그냥
/// "복원이 안 됐다"로 보인다.
///
/// 판단 근거는 데몬이 들고 있는 명부다. **`jobs/` 폴더를 세면 안 된다** —
/// 거기는 끝난 대화의 자취도 그대로 남아 있어서(8월 것이 아직 있다) 이미 죽은
/// 대화까지 살아 있다고 답하게 된다. `daemon/roster.json` 의 `workers` 는
/// 살아 있는 것만 담고, 멈추면 그 자리에서 빠진다.
///
/// `workers` 는 짧은 id 를 키로 하고 값에 `sessionId` 를 담는다. 그 둘만 본다 —
/// **값을 통째로 훑어 16진수 8자리를 줍지 마라.** 워커에는 dispatch nonce 처럼
/// 생김새가 똑같은 값이 같이 들어 있어서, 세션도 아닌 것을 "살아 있다"고 답한다.
/// 실제로 `e71de23f`(nonce)를 세션으로 주워 왔다.
#[tauri::command]
pub fn claude_bg_sessions(app: AppHandle) -> Vec<String> {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".claude").join("daemon").join("roster.json"))
    else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(workers) = v.get("workers").and_then(|w| w.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for (key, val) in workers {
        let sid = val.get("sessionId").and_then(|s| s.as_str());
        // 키가 곧 짧은 id 다. 없으면 세션 id 의 앞 토막으로 만든다.
        let short = sid
            .map(|s| s.chars().take(8).collect::<String>())
            .filter(|_| key.len() != 8)
            .unwrap_or_else(|| key.clone())
            .to_lowercase();
        if !short.is_empty() && !out.contains(&short) {
            out.push(short);
        }
    }
    out
}

#[tauri::command]
pub fn claude_sessions(app: AppHandle, root: String) -> Vec<ClaudeSession> {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let want = squash(&root);
    let Ok(dirs) = std::fs::read_dir(home.join(".claude").join("projects")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for d in dirs.flatten() {
        if squash(&d.file_name().to_string_lossy()) != want {
            continue;
        }
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".jsonl") else { continue };
            let mtime = f
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(ClaudeSession {
                id: id.to_string(),
                mtime,
                title: session_title(&f.path()),
            });
        }
    }
    // 최근 것이 앞에. 방금 뜬 claude 의 대화를 찾는 일이라 그 순서가 곧 답이다.
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

// ── 세션 ─────────────────────────────────────────────────────────
//
// 배치와 연 폴더만 저장한다. PTY 는 되살리지 않는다 — 프로세스는 앱과 함께
// 죽었고, 죽은 셸을 흉내 낸 화면을 복원하면 사용자가 살아 있다고 믿는다.
// 복원되는 것은 "어떻게 나눠 놓고 어디서 일하고 있었나"까지다.

fn state_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("session.json"))
}

#[tauri::command]
pub fn state_save(app: AppHandle, json: String) {
    if let Some(p) = state_file(&app) {
        let _ = std::fs::write(p, json);
    }
}

/// 이름이 chiispace 가 되기 전에 쓰던 자리.
///
/// Tauri 는 설정 폴더를 `identifier` 로 잡는다. 그래서 이름을 바꾸는 순간 앱은 빈
/// 새 폴더를 보게 되고, 사용자에게는 **쓰던 탭과 배치가 통째로 사라진 것**으로 보인다.
/// 새 자리에 아무것도 없을 때만 옛 자리를 읽어 준다. 쓰기는 늘 새 자리로 하므로
/// 한 번 켜고 저장이 한 번 돌면 저절로 옮겨진다.
fn legacy_state_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.parent()?.join("com.sehyun.kasaspace").join("session.json"))
}

#[tauri::command]
pub fn state_load(app: AppHandle) -> Option<String> {
    if let Some(p) = state_file(&app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            return Some(s);
        }
    }
    std::fs::read_to_string(legacy_state_file(&app)?).ok()
}
