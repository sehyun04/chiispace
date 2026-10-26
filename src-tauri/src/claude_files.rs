//! claude 대화 파일과 명부 — 칸이 어느 대화인지 묻고, 그 대화를 읽는다.
//!
//! claude 는 대화를 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects/<경로별 폴더>/<대화 id>.jsonl` 에 쌓고,
//! 떠 있는 동안 `sessions/<pid>.json` 명부에 자기 대화 id 를 적는다. 여기서 하는 일은 둘뿐이다 —
//! 명부에서 그 칸의 claude 가 직접 적은 id 를 읽고(`claude_session_of_pid`), 부른 쪽이 준 id 의
//! 대화 파일을 읽는다. **대화 파일을 뒤져 칸에 붙일 대화를 고르지 않는다**(CLAUDE.md
//! "대화 파일을 뒤져 ID를 추측하지 않는다"). 그렇게 고르던 명령들은 걷어 냈다.

use tauri::AppHandle;

/// 경로를 폴더 이름과 맞대 보기 위한 정규화. claude 가 쓰는 인코딩 규칙을
/// 그대로 흉내 내지 않는다 — 구분자와 대소문자 처리가 바뀌면 조용히 못 찾게 된다.
/// 영숫자만 남겨 비교하면 규칙을 몰라도 같은 폴더를 짚는다.
fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 그 pid 가 아직 그 프로세스인가. 명부 파일은 끝난 프로세스의 것도 지워지지 않고 남고 pid 는
/// 돌려 쓰이므로, `procStart`(생성 시각)까지 맞춰야 몇 주 전 대화를 칸에 붙이지 않는다.
///
/// 생성 시각을 못 재는 경우는 "살아 있다"로 답한다. 명부를 쓴 그 pid 가 열려 있다는 것까지는
/// 확인했고, 거기서 놓치면 칸이 제 대화 id 를 영영 못 얻어 `--continue` 로 떨어진다.
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

/// 대화 파일의 자리.
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

// ── 지난 대화 목록(`/resume`) ────────────────────────────────────
//
// **사람이 고르라고 보여 주는 목록이다. 앱은 이 목록에서 대화를 고르지 않는다**(CLAUDE.md "대화 파일을 뒤져
// ID를 추측하지 않는다"). 칸에 붙일 대화를 앱이 "가장 최근 것"으로 골라 사용자 대화를 뺏던 옛 길과 달리, 여기서는
// 사용자가 `/resume` 으로 목록을 열고 하나를 누를 때만 그 id 를 `--resume` 으로 연다. claude TUI 의 `/resume` 과 같다.

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Conversation {
    id: String,
    title: String,
    /// 마지막으로 쓰인 때(ms). 최근 것부터 늘어놓고 "3분 전"을 보인다.
    modified: u64,
}

/// 대화 파일 하나의 이름. 사용자가 `/rename` 으로 붙인 이름, claude 가 지은 이름, 마지막에 보낸 말 순으로 고른다.
/// 이 기록들은 파일 앞뒤에 붙으므로 수 MB 대화를 통째로 읽지 않고 앞·뒤만 본다.
fn conversation_title(path: &std::path::Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    const HEAD: u64 = 64 * 1024;
    const TAIL: u64 = 256 * 1024;
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0; HEAD.min(len) as usize];
    let _ = f.read_exact(&mut head);
    let mut tail = Vec::new();
    if len > HEAD {
        let _ = f.seek(SeekFrom::Start(len.saturating_sub(TAIL).max(HEAD)));
        let _ = f.read_to_end(&mut tail);
    }
    title_from(&String::from_utf8_lossy(&head), &String::from_utf8_lossy(&tail))
}

fn title_from(head: &str, tail: &str) -> String {
    // 자른 자리의 반 토막 줄은 파싱되지 않아 저절로 빠진다.
    let records = || head.lines().chain(tail.lines()).filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok());
    let last = |kind: &str, key: &str| {
        records()
            .filter(|v| v["type"] == kind)
            .filter_map(|v| v[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from))
            .last()
    };
    let first_prompt = || {
        records().filter(|v| v["type"] == "user" && v["isMeta"] != true).find_map(|v| {
            let text = v["message"]["content"].as_str()?.trim();
            // 명령·훅이 남긴 꼬리표 줄은 사용자가 친 말이 아니다.
            (!text.is_empty() && !text.starts_with('<')).then(|| text.to_string())
        })
    };
    let title = last("custom-title", "customTitle")
        .or_else(|| last("ai-title", "aiTitle"))
        .or_else(|| last("last-prompt", "lastPrompt"))
        .or_else(first_prompt)
        .unwrap_or_default();
    let line = title.lines().next().unwrap_or_default();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() > 60 { chars[..60].iter().collect::<String>() + "…" } else { line.to_string() }
}

/// 그 폴더의 대화들, 최근 것부터 30개. 빈 폴더(`cwd` 빈 값)는 홈이다 — 폴더 없이 연 대화창은 홈에서 돈다(claude_chat.rs).
#[tauri::command]
pub fn claude_conversations(app: AppHandle, root: String) -> Vec<Conversation> {
    let root = if root.trim().is_empty() { std::env::var("USERPROFILE").unwrap_or_default() } else { root };
    let want = squash(&root);
    let Some(dir) = claude_home(&app)
        .and_then(|h| std::fs::read_dir(h.join("projects")).ok())
        .and_then(|it| it.flatten().find(|d| squash(&d.file_name().to_string_lossy()) == want))
    else {
        return Vec::new();
    };
    let mut found: Vec<(u64, String, std::path::PathBuf)> = std::fs::read_dir(dir.path())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let id = path.file_stem()?.to_str()?.to_string();
            let meta = e.metadata().ok()?;
            let shaped = path.extension()? == "jsonl" && id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
            let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            (shaped && meta.is_file() && meta.len() > 0).then_some((modified, id, path))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.truncate(30);
    found.into_iter().map(|(modified, id, path)| Conversation { title: conversation_title(&path), id, modified }).collect()
}

/// 대화 원문 그대로. 말풍선은 이것을 직접 뜯는다.
///
/// 줄이지도 색을 입히지도 않는다. 화면이 뜯을 **데이터**라 도구 호출도 생각도 다 필요하고,
/// 한 줄이라도 깎으면 그만큼 화면에서 사라진다.
///
/// 앱이 고르는 것은 아무것도 없다 — 어느 대화를 줄지는 `id` 로 불러온 쪽이
/// 정한다. 파일을 뒤져 칸에 대화를 붙이던 길과는 무관하다.
#[tauri::command]
pub fn claude_transcript_raw(app: AppHandle, root: String, id: String) -> String {
    session_file(&app, &root, &id).map(|p| read_tail(&p)).unwrap_or_default()
}

/// 대화 파일의 끝부분을 줄 단위로. 본 대화와 서브에이전트 대화가 같이 쓴다.
fn read_tail(path: &std::path::Path) -> String {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
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

// ── 서브에이전트 대화 ────────────────────────────────────────────
//
// claude 는 서브에이전트의 대화를 본 대화 파일에 섞지 않고 그 옆
// `<대화 id>/subagents/agent-<에이전트 id>.jsonl` 에 따로 쓴다. 무엇을 맡았는지는 같은 이름의
// `.meta.json`(종류·설명·부른 호출 id)에 있다. 에이전트 id 는 프록시가 요청 헤더에서 보는
// `x-claude-code-agent-id` 와 같다. 대화창은 누른 줄이 가리키는 것만 연다 — 고르지 않는다.

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct SubagentInfo {
    agent: String,
    #[serde(rename = "agentType")]
    agent_type: Option<String>,
    description: Option<String>,
    /// 본 대화에서 이 서브에이전트를 부른 도구 호출의 id. "… 부름" 줄에서 여기로 건너온다.
    #[serde(rename = "toolUseId")]
    tool_use_id: Option<String>,
}

/// 파일 이름에 넣을 에이전트 id. 경로 조각이 섞인 값으로 다른 파일을 열지 않게 모양만 받는다.
fn agent_shaped(a: &str) -> bool {
    !a.is_empty() && a.len() <= 64 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn subagents_dir(app: &AppHandle, root: &str, id: &str) -> Option<std::path::PathBuf> {
    Some(session_file(app, root, id)?.with_extension("").join("subagents"))
}

fn subagents_at(dir: &std::path::Path) -> Vec<SubagentInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(agent) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".jsonl")) else { continue };
        if !agent_shaped(agent) {
            continue;
        }
        let meta = std::fs::read_to_string(dir.join(format!("agent-{agent}.meta.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let field = |k: &str| meta.as_ref().and_then(|m| m.get(k)?.as_str().map(str::to_owned));
        out.push(SubagentInfo {
            agent: agent.to_string(),
            agent_type: field("agentType"),
            description: field("description"),
            tool_use_id: field("toolUseId"),
        });
    }
    out.sort_by(|a, b| a.agent.cmp(&b.agent));
    out
}

/// 이 대화가 부른 서브에이전트들.
#[tauri::command]
pub fn claude_subagents(app: AppHandle, root: String, id: String) -> Vec<SubagentInfo> {
    subagents_dir(&app, &root, &id).map(|d| subagents_at(&d)).unwrap_or_default()
}

fn subagent_file(app: &AppHandle, root: &str, id: &str, agent: &str) -> Option<std::path::PathBuf> {
    if !agent_shaped(agent) {
        return None;
    }
    Some(subagents_dir(app, root, id)?.join(format!("agent-{agent}.jsonl")))
}

/// 서브에이전트 대화 원문. 본 대화와 같은 모양이라 같은 방식으로 뜯는다(레코드가 전부 사이드체인이다).
#[tauri::command]
pub fn claude_subagent_raw(app: AppHandle, root: String, id: String, agent: String) -> String {
    subagent_file(&app, &root, &id, &agent).map(|p| read_tail(&p)).unwrap_or_default()
}

/// 서브에이전트 대화 파일의 크기. 바뀔 때만 원문을 다시 받는다(본 대화와 같은 이유).
#[tauri::command]
pub fn claude_subagent_size(app: AppHandle, root: String, id: String, agent: String) -> u64 {
    subagent_file(&app, &root, &id, &agent)
        .and_then(|p| std::fs::metadata(p).ok())
        .map_or(0, |m| m.len())
}

#[cfg(test)]
mod subagent_tests {
    use super::{agent_shaped, read_tail, subagents_at, SubagentInfo};

    #[test]
    fn lists_subagents_with_what_they_were_asked() {
        let dir = std::env::temp_dir().join(format!("chiispace-subagents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-a7e7100f5fcb46100.jsonl"), "{}\n").unwrap();
        std::fs::write(
            dir.join("agent-a7e7100f5fcb46100.meta.json"),
            r#"{"agentType":"Explore","description":"proxy.rs 조사","toolUseId":"toolu_018k"}"#,
        )
        .unwrap();
        // meta 가 없어도 대화는 연다.
        std::fs::write(dir.join("agent-b1.jsonl"), "{}\n").unwrap();
        // 이름 모양이 다른 것은 서브에이전트가 아니다.
        std::fs::write(dir.join("agent-a7e7100f5fcb46100.meta.json.bak"), "x").unwrap();
        std::fs::write(dir.join("notes.jsonl"), "x").unwrap();
        let got = subagents_at(&dir);
        assert_eq!(
            got,
            vec![
                SubagentInfo {
                    agent: "a7e7100f5fcb46100".into(),
                    agent_type: Some("Explore".into()),
                    description: Some("proxy.rs 조사".into()),
                    tool_use_id: Some("toolu_018k".into()),
                },
                SubagentInfo { agent: "b1".into(), agent_type: None, description: None, tool_use_id: None },
            ]
        );
        // 없는 폴더는 빈 목록이다(서브에이전트를 한 번도 안 부른 대화).
        assert!(subagents_at(&dir.join("없음")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_ids_cannot_reach_other_files() {
        assert!(agent_shaped("a7e7100f5fcb46100"));
        assert!(!agent_shaped(""));
        assert!(!agent_shaped("../../secret"));
        assert!(!agent_shaped("a\\b"));
        assert!(!agent_shaped(&"a".repeat(65)));
    }

    #[test]
    fn reads_whole_lines_only() {
        let p = std::env::temp_dir().join(format!("chiispace-tail-{}.jsonl", std::process::id()));
        std::fs::write(&p, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        assert_eq!(read_tail(&p), "{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(read_tail(&p.with_extension("없음")), "");
        let _ = std::fs::remove_file(&p);
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

#[cfg(test)]
mod conversation_tests {
    use super::title_from;

    #[test]
    fn names_come_from_rename_then_claude_then_last_prompt() {
        let user = r#"{"type":"user","message":{"role":"user","content":"첫 말"}}"#;
        let meta = r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#;
        let ai = r#"{"type":"ai-title","aiTitle":"claude 가 지은 이름"}"#;
        let last = r#"{"type":"last-prompt","lastPrompt":"마지막 말"}"#;
        let custom = r#"{"type":"custom-title","customTitle":"내가 붙인 이름"}"#;
        assert_eq!(title_from(&[meta, user].join("\n"), ""), "첫 말", "꼬리표 줄은 사용자 말이 아니다");
        assert_eq!(title_from(user, last), "마지막 말");
        assert_eq!(title_from(&[user, ai].join("\n"), last), "claude 가 지은 이름");
        assert_eq!(title_from(&[user, ai].join("\n"), &[last, custom].join("\n")), "내가 붙인 이름");
        // 자른 자리의 반 토막 줄과 긴 이름.
        let long = format!(r#"{{"type":"custom-title","customTitle":"{}"}}"#, "가".repeat(80));
        assert_eq!(title_from("", &format!("le\":\"x\"}}\n{long}")), format!("{}…", "가".repeat(60)));
    }
}
