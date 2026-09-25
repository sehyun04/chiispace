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

/// 지금 다른 창이 전경으로 붙들고 있는 claude 대화들.
///
/// `claude_bg_sessions` 와 짝이지만 **대처가 다르다.** 백그라운드로 넘긴 대화는
/// `attach` 로 이 칸에 데려올 수 있는 반면, 다른 터미널 창이 열어 둔 대화는 데려올
/// 길이 없다. 그런 대화에 `--resume` 을 걸면 claude 가 "another Claude Code on this
/// machine already has ... for this conversation" 만 남기고 죽어서 그 칸은 셸 프롬프트
/// 앞에 멈춘다. 그러니 **후보에서 빼는 것**이 유일한 대처다.
///
/// 이게 없으면 사용자가 실제로 겪은 고리가 돈다: 사용자가 이 레포에서 claude 를
/// 켜 두고 일을 시키는 동안 그 대화 파일이 계속 갱신되니 **그 폴더의 가장 최근**이
/// 늘 그것이고, `--continue` 를 대신할 대화를 고르면 매번 그 대화가 뽑힌다. 켤 때마다
/// 자기가 쓰고 있는 대화를 칸이 뺏으려 들다 실패하는 것이라, 앱을 켤 때마다 재현된다.
///
/// 명부는 `~/.claude/sessions/<pid>.json` 이고 claude 가 뜰 때 하나씩 쓴다. 끝난
/// 프로세스의 것이 지워지지 않고 남으므로 pid 가 살아 있는지 봐야 하고, pid 는 돌려
/// 쓰이니 `procStart`(프로세스 생성 시각)까지 맞춘다 — 그러지 않으면 몇 주 전에 죽은
/// 대화가 "지금 열려 있다"가 되어 되살릴 수 있는 대화를 영영 안 되살린다.
#[tauri::command]
pub fn claude_live_sessions(app: AppHandle) -> Vec<String> {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    live_sessions_at(&home.join(".claude").join("sessions"))
}

fn live_sessions_at(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        // 같은 폴더에 `<pid>.<해시>.key` 도 같이 쌓인다.
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let (Some(sid), Some(pid)) = (
            v.get("sessionId").and_then(|s| s.as_str()),
            v.get("pid").and_then(|p| p.as_u64()),
        ) else {
            continue;
        };
        let start = v
            .get("procStart")
            .and_then(|s| s.as_str())
            .and_then(|s| s.parse::<u64>().ok());
        if !alive(pid as u32, start) {
            continue;
        }
        let sid = sid.to_lowercase();
        if !out.contains(&sid) {
            out.push(sid);
        }
    }
    out
}

/// 그 pid 가 아직 그 프로세스인가.
///
/// 못 재는 경우는 "살아 있다"로 답한다. 틀리는 두 방향의 값이 다르기 때문이다 —
/// 죽은 것을 살아 있다고 하면 그 대화를 안 이어 여는 것으로 끝나지만(칸은 새 대화로
/// 뜬다), 살아 있는 것을 죽었다고 하면 다른 창이 쓰는 대화를 뺏으려다 칸이 죽는다.
#[cfg(windows)]
fn alive(pid: u32, start: Option<u64>) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut exit, mut kernel, mut user) = (created, created, created);
        let ok = GetProcessTimes(h, &mut created, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(h);
        let Some(want) = start else {
            return true;
        };
        if !ok {
            return true;
        }
        ((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) == want
    }
}

/// 이 앱은 Windows 전용이지만(ConPTY) 다른 곳에서도 컴파일은 되게 둔다.
/// 확인할 길이 없으면 "살아 있다"로 답한다 — 위의 이유와 같다.
#[cfg(not(windows))]
fn alive(_pid: u32, _start: Option<u64>) -> bool {
    true
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


/// 복원한 칸에 붙일 "지난 대화".
///
/// claude 는 `--resume` 할 때 대화를 처음부터 다시 찍지 않는다. 배너와 마지막
/// 몇 개만 그리고 만다(대화가 압축돼 있으면 그것마저 한 줄로 줄어든다). 그런데
/// 터미널은 자기가 받은 바이트만 스크롤할 수 있으므로, 그 칸은 위로 올려다봐도
/// 아무것도 없다 — 세션을 되살려 놓고도 무슨 얘기를 하던 칸인지 알 수가 없다.
/// 실측으로 9MB 짜리 대화를 되살렸을 때 스크롤백은 0줄이었다.
///
/// 그래서 셸을 띄우기 전에 우리가 먼저 찍어 준다. 지난 대화가 스크롤백에 들어가
/// 있으면 위로 올리는 것만으로 되짚을 수 있다.
///
/// 파일이 수십 MB 라 통째로 읽지 않는다. 꼬리만 잘라 뒤에서부터 세고, 잘린 첫
/// 줄은 JSON 이 아니므로 버린다.
#[tauri::command]
pub fn claude_transcript(app: AppHandle, root: String, id: String, turns: usize) -> String {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return String::new();
    };
    let want = squash(&root);
    let Ok(dirs) = std::fs::read_dir(home.join(".claude").join("projects")) else {
        return String::new();
    };
    let mut path = None;
    for d in dirs.flatten() {
        if squash(&d.file_name().to_string_lossy()) == want {
            let p = d.path().join(format!("{id}.jsonl"));
            if p.is_file() {
                path = Some(p);
            }
            break;
        }
    }
    let Some(path) = path else { return String::new() };
    let Ok(mut f) = std::fs::File::open(&path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // 주고받기 40개가 이 안에 들어오고도 남는다. 더 읽어 봐야 버릴 줄만 는다.
    const TAIL: u64 = 4 * 1024 * 1024;
    let cut = len > TAIL;
    if cut {
        let _ = f.seek(SeekFrom::Start(len - TAIL));
    }
    let mut r = BufReader::new(f);
    if cut {
        let mut drop_first = String::new();
        let _ = r.read_line(&mut drop_first);
    }

    let mut rows: Vec<(bool, String)> = Vec::new();
    for line in r.lines().map_while(Result::ok) {
        // 대부분의 줄은 도구 호출과 그 결과다. 사람이 되짚어 볼 것은 주고받은
        // 말이므로, 그 표시가 없는 줄은 JSON 으로 뜯지도 않는다.
        if !line.contains("\"type\":\"user\"") && !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let user = v.get("type").and_then(|t| t.as_str()) == Some("user");
        // 사이드체인은 서브에이전트가 따로 나눈 얘기다. 본 대화에 섞으면 누가
        // 무슨 말을 했는지 알 수 없게 된다.
        if v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
            continue;
        }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else { continue };
        let text = match content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        let text = text.trim();
        // 도구 결과만 든 사용자 레코드는 위 필터에서 빈 문자열이 된다. 명령
        // 태그(<command-name> 따위)로 시작하는 것도 사람이 친 말이 아니다.
        if text.is_empty() || text.starts_with('<') {
            continue;
        }
        rows.push((user, text.to_string()));
    }
    if rows.is_empty() {
        return String::new();
    }
    let start = rows.len().saturating_sub(turns);
    let name = session_title(&path);

    // 터미널에 그대로 쓰는 글이라 줄바꿈은 CRLF 다. LF 만 주면 커서가 열로
    // 돌아오지 않아 계단처럼 밀린다.
    // 색은 256 팔레트가 아니라 테마 잉크색을 트루컬러로 준다. 256 회색 계단은
    // 어두운 배경 기준이라 크림 바탕 위에서는 대비 1.75 로 날아간다.
    let mut out = String::new();
    let head = if name.is_empty() { "지난 대화".to_string() } else { format!("지난 대화 · {name}") };
    out.push_str(&format!("\r\n\x1b[38;2;138;109;38m──── {head} ────\x1b[0m\r\n"));
    if start > 0 || cut {
        out.push_str("\x1b[38;2;143;119;92m  (앞부분은 줄였다. 전체는 claude 에서 ctrl+o)\x1b[0m\r\n");
    }
    for (user, text) in &rows[start..] {
        out.push_str("\r\n");
        for (i, line) in text.lines().enumerate() {
            // 한 마디가 수백 줄인 것도 있다. 되짚어 보는 데 필요한 만큼만 남긴다.
            if i >= 40 {
                out.push_str("\x1b[38;2;143;119;92m    …\x1b[0m\r\n");
                break;
            }
            let body = line.replace('\t', "  ");
            if *user {
                out.push_str(&format!("\x1b[38;2;195;71;65m> \x1b[0m{body}\r\n"));
            } else {
                out.push_str(&format!("  \x1b[38;2;131;109;90m{body}\x1b[0m\r\n"));
            }
        }
    }
    out.push_str("\r\n\x1b[38;2;138;109;38m──── 여기부터 이어서 ────\x1b[0m\r\n\r\n");
    out
}

/// 대화 파일의 자리. `claude_transcript` 가 같은 탐색을 품고 있지만 그쪽은
/// 터미널에 쓸 글까지 한 함수에서 만든다. 원문을 쓰는 쪽은 글자를 깎지
/// 않으므로 자리 찾기만 따로 둔다.
///
/// 폴더가 맞는 곳을 먼저 보고, 없으면 모든 폴더에서 그 id 의 파일을 찾는다.
/// 칸의 셸이 `cd` 로 옮겨 간 뒤에 claude 를 띄우면 대화는 그 폴더 밑에 쌓여
/// 폴더 이름으로는 빗나간다. id 는 부른 쪽이 준 것이고 uuid 라 겹치지 않으므로,
/// 폴더를 넓혀 찾는 것은 추측이 아니다 — 고르는 것은 여전히 id 다.
fn session_file(app: &AppHandle, root: &str, id: &str) -> Option<std::path::PathBuf> {
    // 경로 조각이 섞인 id 로 다른 파일을 열지 않게 uuid 모양만 받는다.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    // id 를 준 명부(`claude_session_of_pid`)와 같은 자리를 본다. `CLAUDE_CONFIG_DIR` 을
    // 쓰는 사람에게 명부는 찾고 대화 파일은 못 찾는 어긋남이 생기지 않게.
    let want = squash(root);
    let name = format!("{id}.jsonl");
    let dirs: Vec<_> = std::fs::read_dir(claude_home(app)?.join("projects")).ok()?.flatten().collect();
    if let Some(d) = dirs.iter().find(|d| squash(&d.file_name().to_string_lossy()) == want) {
        let p = d.path().join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    dirs.iter().map(|d| d.path().join(&name)).find(|p| p.is_file())
}

/// 대화 파일의 크기. 없으면 0.
///
/// 대화창은 이것이 바뀔 때만 원문을 다시 받는다. 긴 대화는 원문이 수 MB 라 매번 통째로
/// 넘기면 칸이 여럿일 때 앱이 무거워진다. 메뉴 명령이 끝났는지도 이것으로 안다 — claude 는
/// 메뉴를 열 때는 아무것도 안 적고 닫힐 때 명령과 결과를 적는다.
#[tauri::command]
pub fn claude_transcript_size(app: AppHandle, root: String, id: String) -> u64 {
    session_file(&app, &root, &id)
        .and_then(|p| std::fs::metadata(p).ok())
        .map_or(0, |m| m.len())
}

/// 대화 원문 그대로. 말풍선은 이것을 직접 뜯는다.
///
/// `claude_transcript` 와 달리 줄이지도 색을 입히지도 않는다. 그쪽은 터미널에
/// **써 넣을 글**이라 사람이 읽을 만큼만 남기지만, 이쪽은 화면이 뜯을
/// **데이터**다. 도구 호출도 생각도 다 필요하고, 한 줄이라도 깎으면 그만큼
/// 화면에서 사라진다.
///
/// 앱이 고르는 것은 아무것도 없다 — 어느 대화를 줄지는 `id` 로 불러온 쪽이
/// 정한다. 파일을 뒤져 칸에 대화를 붙이던 길과는 무관하다.
#[tauri::command]
pub fn claude_transcript_raw(app: AppHandle, root: String, id: String) -> String {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let Some(path) = session_file(&app, &root, &id) else { return String::new() };
    let Ok(mut f) = std::fs::File::open(&path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // 긴 대화는 수십 MB 까지 간다. 통째로 웹뷰에 넘기면 그리기 전에 멎는다.
    const TAIL: u64 = 8 * 1024 * 1024;
    let cut = len > TAIL;
    if cut {
        let _ = f.seek(SeekFrom::Start(len - TAIL));
    }
    let mut r = BufReader::new(f);
    if cut {
        // 자른 자리의 첫 줄은 반 토막이라 파싱되지 않는다.
        let mut half = String::new();
        let _ = r.read_line(&mut half);
    }
    let mut out = String::new();
    for line in r.lines().map_while(Result::ok) {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

// ── 세션 ─────────────────────────────────────────────────────────
//
// 배치와 연 폴더만 저장한다. PTY 는 되살리지 않는다 — 프로세스는 앱과 함께
// 죽었고, 죽은 셸을 흉내 낸 화면을 복원하면 사용자가 살아 있다고 믿는다.
// 복원되는 것은 "어떻게 나눠 놓고 어디서 일하고 있었나"까지다.

/// 검증이 쓸 다른 자리. `CHIISPACE_STATE` 가 있으면 그 파일을 세션으로 삼는다.
///
/// 복원을 확인하려면 "이 칸이 무엇을 돌리고 있었나"를 꾸며 넣어야 하는데, 그 자리가
/// 사용자가 실제로 쓰는 파일 하나뿐이면 **검증이 곧 덮어쓰기**가 된다. 실제로 없는
/// 대화 id 하나가 그렇게 들어가 눌러앉았고, 그 칸은 켤 때마다 빈 새 대화로 떴다 —
/// 저장이 그 값을 그대로 다시 쓰므로 사용자 손으로는 빠져나올 길이 없다. 검증은
/// 임시 파일을 주고 돌리면 사용자 상태에 닿지 않는다.
fn probe_state_file() -> Option<std::path::PathBuf> {
    let p = std::path::PathBuf::from(std::env::var("CHIISPACE_STATE").ok()?);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    Some(p)
}

fn state_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Some(p) = probe_state_file() {
        return Some(p);
    }
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
    // 검증용 자리를 줬으면 옛 자리도 보지 않는다. 꾸며 넣은 파일이 비어 있을 때
    // 사용자 것을 읽어 오면 그 상태로 저장까지 돌아 검증이 다시 사용자에게 샌다.
    if probe_state_file().is_some() {
        return None;
    }
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

#[cfg(test)]
mod live_session_tests {
    use super::live_sessions_at;

    /// 죽은 pid 와 pid 만 같고 다른 프로세스인 것은 "열려 있다"가 아니다.
    /// 명부 파일이 지워지지 않고 쌓이므로 이 둘을 못 거르면 몇 주 전 대화까지
    /// 살아 있다고 답하고, 되살릴 수 있는 대화를 영영 안 되살린다.
    #[test]
    fn only_running_processes_count_as_live() {
        let dir = std::env::temp_dir().join(format!("chiispace-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let me = std::process::id();
        let write = |name: &str, body: String| std::fs::write(dir.join(name), body).unwrap();
        write(
            "mine.json",
            format!(r#"{{"pid":{me},"sessionId":"AAAA1111-0000-0000-0000-000000000000"}}"#),
        );
        write(
            "dead.json",
            r#"{"pid":4294967291,"sessionId":"bbbb2222-0000-0000-0000-000000000000"}"#.into(),
        );
        write(
            "reused.json",
            format!(r#"{{"pid":{me},"procStart":"1","sessionId":"cccc3333-0000-0000-0000-000000000000"}}"#),
        );
        // 키 파일은 같은 폴더에 있지만 대화 명부가 아니다.
        write("mine.abc.key", "not json".into());

        let live = live_sessions_at(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        // 대소문자는 우리가 맞춰 준다 — 저장된 명령의 id 와 그대로 비교하기 때문이다.
        assert_eq!(live, vec!["aaaa1111-0000-0000-0000-000000000000".to_string()]);
    }
}

/// 이 pid 가 돌리는 claude 대화의 id. **추측하지 않는다.**
///
/// 과거에 칸마다 대화를 되살리려다 사고를 낸 방식은 `~/.claude/projects/<폴더>` 의 대화
/// 파일을 뒤져 "가장 최근 것"을 골랐다. 그래서 사용자가 지금 쓰고 있는 대화를 칸이 뺏어
/// 갔고, 한 대화에 두 프로세스가 붙지 못해 그 칸이 죽었다. 여기서 읽는 것은 그게 아니라
/// **그 프로세스가 자기 pid 로 직접 써 둔 명부**(`~/.claude/sessions/<pid>.json`)다.
/// 어느 칸이 어느 대화인지는 claude 자신이 답하므로 고를 일이 없다.
///
/// pid 는 돌려 쓰이므로 `procStart` 까지 맞추고(`alive`), 폴더를 받으면 그것도 본다 —
/// 칸이 옮겨 다녔을 때 엉뚱한 대화를 붙이지 않기 위해서다. 하나라도 어긋나면 `None` 을
/// 주고, 부르는 쪽은 그때 지금처럼 `--continue` 로 남겨 둔다(나빠지지 않는다).
#[tauri::command]
pub fn claude_session_of_pid(app: AppHandle, pid: u32, cwd: Option<String>) -> Option<String> {
    let dir = claude_home(&app)?.join("sessions");
    let table = kasa_pty::process_table_shared();
    roster_pids(&table, pid)
        .into_iter()
        .find_map(|p| session_of_pid_at(&dir, p, cwd.as_deref()))
}

/// 명부를 쓴 claude 가 칸이 본 claude 가 아닐 수 있다.
///
/// 칸 셸 바로 아래의 `claude.exe` 는 실행기일 때가 있고, 실제 claude 는 그 자식으로 떠서
/// **자기 pid 로** 명부를 쓴다(실행기가 옛 판이고 새 판이 따로 깔려 있을 때 그랬다).
/// 칸이 본 pid 만 보면 명부가 멀쩡히 있는데도 영영 못 찾아, 대화창이 안 뜨고 복원도
/// `--continue` 로 떨어진다. 실사용에서 그렇게 됐다. 그래서 그 아래 claude 자손까지 본다 —
/// 자손은 칸의 프로세스 트리 안이라 다른 칸의 대화를 집을 일이 없다.
/// MCP 서버·셸 같은 다른 자식은 이름으로 거른다.
fn roster_pids(table: &[(u32, u32, String)], pid: u32) -> Vec<u32> {
    let mut out = vec![pid];
    let mut i = 0;
    while i < out.len() && out.len() < 16 {
        let parent = out[i];
        for (child, ppid, name) in table {
            if *ppid == parent && !out.contains(child) && name.to_lowercase().contains("claude") {
                out.push(*child);
            }
        }
        i += 1;
    }
    out
}

/// claude 의 상태 폴더. `CLAUDE_CONFIG_DIR` 이 있으면 그쪽이다 — 그 변수를 준 채 띄운 claude 는
/// 명부도 거기에 쓰므로, 홈만 보면 그 칸이 어느 대화인지 영영 못 읽는다. 앱이 띄운 claude 는
/// 앱의 환경을 물려받으니 앱에서 읽은 값이 곧 그 칸이 쓰는 자리다.
fn claude_home(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(std::path::PathBuf::from(dir));
        }
    }
    app.path().home_dir().ok().map(|h| h.join(".claude"))
}

fn session_of_pid_at(dir: &std::path::Path, pid: u32, cwd: Option<&str>) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(format!("{pid}.json"))).ok()?;
    let v = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    if v.get("pid").and_then(|p| p.as_u64()) != Some(pid as u64) {
        return None;
    }
    let start = v
        .get("procStart")
        .and_then(|s| s.as_str())
        .and_then(|s| s.parse::<u64>().ok());
    if !alive(pid, start) {
        return None;
    }
    if let Some(want) = cwd {
        let same = v
            .get("cwd")
            .and_then(|c| c.as_str())
            .is_some_and(|got| squash(got) == squash(want));
        if !same {
            return None;
        }
    }
    let sid = v.get("sessionId").and_then(|s| s.as_str())?;
    // 대화 id 는 uuid 다. 모양이 다르면 명령줄에 그대로 넣지 않는다.
    let shaped = sid.len() == 36
        && sid
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-');
    shaped.then(|| sid.to_lowercase())
}

#[cfg(test)]
mod session_of_pid_tests {
    use super::{roster_pids, session_of_pid_at};

    #[test]
    fn looks_past_the_launcher_to_the_claude_that_wrote_the_roster() {
        // 셸(10) → 실행기 claude(20) → 실제 claude(30). 실제 claude 는 MCP 서버(node)와
        // 도구용 셸을 거느린다. 명부는 30 이 쓴다.
        let t = |p: u32, pp: u32, n: &str| (p, pp, n.to_string());
        let table = vec![
            t(10, 1, "powershell.exe"),
            t(20, 10, "claude.exe"),
            t(30, 20, "claude.exe"),
            t(40, 30, "node.exe"),
            t(41, 30, "bash.exe"),
            t(50, 10, "claude.exe"), // 같은 셸의 다른 자식이지 20 의 자손이 아니다
        ];
        assert_eq!(roster_pids(&table, 20), vec![20, 30]);
        // 실행기 없이 바로 뜬 claude 는 제 pid 하나다.
        assert_eq!(roster_pids(&table, 30), vec![30]);
        // 표가 꼬여 제자리를 가리켜도 멈춘다.
        assert_eq!(roster_pids(&[t(7, 7, "claude.exe")], 7), vec![7]);
    }

    fn write(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn reads_only_the_named_pid_and_checks_shape() {
        let dir = std::env::temp_dir().join(format!("chiispace-sess-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let me = std::process::id();
        let sid = "68e52d82-b9f5-40d5-b36f-14ec237927aa";
        // procStart 가 없으면 살아 있는 pid 는 그대로 통과한다.
        write(&dir, &format!("{me}.json"), &format!(r#"{{"pid":{me},"sessionId":"{sid}","cwd":"C:/Repo"}}"#));
        assert_eq!(session_of_pid_at(&dir, me, None).as_deref(), Some(sid));
        assert_eq!(session_of_pid_at(&dir, me, Some("C:/REPO")).as_deref(), Some(sid));
        // 폴더가 다르면 붙이지 않는다.
        assert_eq!(session_of_pid_at(&dir, me, Some("C:/Other")), None);
        // 파일 안의 pid 가 다르면 무시한다.
        write(&dir, &format!("{me}.json"), &format!(r#"{{"pid":{},"sessionId":"{sid}"}}"#, me + 1));
        assert_eq!(session_of_pid_at(&dir, me, None), None);
        // uuid 모양이 아니면 명령줄에 넣지 않는다.
        write(&dir, &format!("{me}.json"), &format!(r#"{{"pid":{me},"sessionId":"not-a-uuid"}}"#));
        assert_eq!(session_of_pid_at(&dir, me, None), None);
        // 없는 pid 는 조용히 없음.
        assert_eq!(session_of_pid_at(&dir, me + 12345, None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
