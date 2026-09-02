//! 파일트리와 git 상태. 층 ②("작업환경")의 첫 조각 — 터미널 옆에 "지금 연
//! 프로젝트"가 있어야 이게 터미널이 아니라 작업환경이 된다.

use std::collections::HashMap;
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 시작할 때 열어 둘 폴더. `kasaspace <경로>` 또는 KASASPACE_ROOT.
/// `code .` 과 같은 기대를 따른다 — 터미널에서 폴더를 지정해 여는 것이 기본 동선이다.
#[tauri::command]
pub fn initial_root() -> Option<String> {
    let arg = std::env::args().nth(1).filter(|a| !a.starts_with('-'));
    let raw = arg.or_else(|| std::env::var("KASASPACE_ROOT").ok())?;
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
    /// 그 대화에서 마지막으로 시킨 일. pane 헤더에 이걸 걸어야 여러 개를
    /// 띄워 놓고도 어느 쪽이 무슨 작업이었는지 안다.
    title: String,
}

/// 대화에서 마지막 사용자 프롬프트를 뽑는다.
///
/// jsonl 은 한 줄에 한 레코드라 줄 단위로 훑고, `last-prompt` 가 붙은 줄만
/// 파싱한다. 대화가 수 MB 로 자라므로 모든 줄을 JSON 으로 뜯으면 그 값을 치른다.
fn scan_title<R: std::io::BufRead>(r: R) -> String {
    let mut last = String::new();
    for line in r.lines().map_while(Result::ok) {
        if !line.contains("\"last-prompt\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        // lastPrompt 가 빠진 레코드도 섞여 있다. 그건 건너뛰고 그 앞의 것을 남긴다.
        if let Some(p) = v.get("lastPrompt").and_then(|x| x.as_str()) {
            let one = p.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            if !one.is_empty() {
                last = one.chars().take(80).collect();
            }
        }
    }
    last
}

fn session_title(path: &std::path::Path) -> String {
    use std::io::{BufReader, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // 이 값을 헤더에 걸어 두고 주기적으로 다시 읽는데, 대화는 수 MB 까지 자란다.
    // 최근 프롬프트는 뒤쪽에 있으므로 꼬리부터 본다. 거기서 못 찾을 때만 전부 훑는다.
    const TAIL: u64 = 512 * 1024;
    if len > TAIL && f.seek(SeekFrom::Start(len - TAIL)).is_ok() {
        let mut r = BufReader::new(&mut f);
        // 잘린 첫 줄은 JSON 이 아니므로 버린다.
        let mut cut = String::new();
        let _ = std::io::BufRead::read_line(&mut r, &mut cut);
        let t = scan_title(r);
        if !t.is_empty() {
            return t;
        }
    }
    let Ok(whole) = std::fs::File::open(path) else {
        return String::new();
    };
    scan_title(BufReader::new(whole))
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

#[tauri::command]
pub fn state_load(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(state_file(&app)?).ok()
}
