//! 파일트리와 git 상태. 층 ②("작업환경")의 첫 조각 — 터미널 옆에 "지금 연
//! 프로젝트"가 있어야 이게 터미널이 아니라 작업환경이 된다.

use std::collections::HashMap;
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
}

/// 열어도 볼 일이 없고 열면 수천 개가 쏟아지는 것들. 트리에서 아예 뺀다.
const SKIP: &[&str] = &["node_modules", "target", ".git", "dist", ".next", "__pycache__"];

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().to_string();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry {
            name,
            path: e.path().to_string_lossy().replace('\\', "/"),
            dir,
        });
    }
    // 디렉터리 먼저, 그다음 이름순. 파일 탐색기가 다 그렇게 하고, 그 기대를 깨면
    // 눈이 목록을 훑지 못한다.
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

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
