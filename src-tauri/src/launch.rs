use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::path::Path;
use std::process::Command;

use crate::launch_config::Config;

pub fn config_args(name: &str, cli: &Path, pane: &str, socket: &str, token: &str) -> Vec<String> {
    let env = json!({"CHIISPACE_PANE_ID":pane,"CHIISPACE_SOCKET_PATH":socket,"CHIISPACE_AGENT_TOKEN":token});
    if name == "claude" {
        return vec![
            "--mcp-config".into(),
            json!({"mcpServers":{"chiispace":{
                "type":"stdio", "command":cli, "args":["mcp"], "env":env
            }}})
            .to_string(),
        ];
    }
    let env = env
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    vec![
        "-c".into(),
        format!("mcp_servers.chiispace.command={}", json!(cli)),
        "-c".into(),
        "mcp_servers.chiispace.args=[\"mcp\"]".into(),
        "-c".into(),
        format!("mcp_servers.chiispace.env={{{env}}}"),
        "-c".into(),
        "mcp_servers.chiispace.enabled=true".into(),
        // 대체 화면에는 xterm 스크롤백이 없어서 Codex의 지난 출력이 휠로 보이지 않는다.
        "--no-alt-screen".into(),
    ]
}

fn interactive(args: &[String]) -> bool {
    !args.first().is_some_and(|a| {
        matches!(
            a.as_str(),
            "--help"
                | "-h"
                | "--version"
                | "-V"
                | "help"
                | "auth"
                | "login"
                | "logout"
                | "mcp"
                | "plugin"
                | "plugins"
                | "doctor"
                | "update"
                | "upgrade"
                | "install"
                | "completion"
                | "agents"
                | "attach"
                | "logs"
                | "stop"
                | "kill"
                | "rm"
                | "queue"
                | "app"
                | "app-server"
                | "mcp-server"
        )
    })
}

fn append_args(mut defaults: Vec<String>, args: Vec<String>) -> Vec<String> {
    // 사용자가 이미 우회 옵션을 붙여 실행하던 명령도 중복 플래그 오류 없이 유지한다.
    if args
        .iter()
        .take_while(|arg| *arg != "--")
        .any(|arg| arg == "--no-alt-screen")
    {
        defaults.retain(|arg| arg != "--no-alt-screen");
    }
    defaults.extend(args);
    defaults
}

pub fn run_agent(name: &str, args: Vec<String>) -> Result<i32> {
    let own = std::env::current_exe()?;
    let config: Config =
        serde_json::from_slice(&std::fs::read(own.with_file_name("launch.json"))?)?;
    let program = config
        .programs
        .get(name)
        .ok_or_else(|| anyhow!("설치된 {name}를 찾지 못했습니다"))?;
    let mut command = Command::new(&program.exe);
    command.args(&program.args);
    // 에이전트가 내부 작업용 CLI를 다시 부르면 부모 칸의 연결을 빼앗으면 안 된다.
    let nested = std::env::var("CHIISPACE_AGENT_TOKEN").is_ok_and(|t| !t.is_empty());
    let injected = interactive(&args) && !nested;
    let mut defaults = Vec::new();
    if injected {
        let launch = if name == "codex" && codex_interactive(&args)
            && !args.iter().take_while(|s| *s != "--").any(|s| s == "--remote" || s.starts_with("--remote=")) {
            Some(crate::codex_session::Launch::capture(&args)?)
        } else { None };
        let registration = crate::rpc::collab("register", json!({"harness":name,"launch":launch}))?;
        let token = registration["token"].as_str().context("연결 토큰 누락")?;
        std::env::set_var("CHIISPACE_AGENT_TOKEN", token);
        command.env("CHIISPACE_AGENT_TOKEN", token);
        defaults = config_args(
            name,
            &config.cli,
            &std::env::var("CHIISPACE_PANE_ID")?,
            &std::env::var("CHIISPACE_SOCKET_PATH")?,
            token,
        );
    }
    let args = append_args(defaults, args);
    // 대화 선택과 권한 적용은 설치된 CLI에 맡긴다. 로컬 실행을 원격 TUI로 바꾸지 않는다.
    let status = command.args(args).status().context("에이전트 시작 실패").map(|s| s.code().unwrap_or(1));
    #[cfg(windows)]
    settle_cursor();
    if injected {
        let _ = crate::rpc::collab("unregister", json!({"failed":status.as_ref().map_or(true, |code| *code != 0)}));
    }
    status
}

/// 에이전트가 끝난 뒤 커서 아래에 그린 것이 남아 있으면 그 아래 빈 줄로 내린다.
///
/// claude 는 그리는 동안 커서를 입력 자리(고르기 창에서는 고른 줄)에 세워 둔다. 보통의 끝내기는 커서를
/// 그린 것 아래로 내리고 나가지만 `--resume` 고르기 창을 Esc 로 닫으면 그대로 나간다. 그러면 셸 프롬프트가
/// 남은 목록 한가운데에 찍히고, 다음에 띄운 claude 는 아래가 빈 줄인 줄 알고 남은 글자 위에 겹쳐 그린다.
/// 앱이 스크롤백을 살리려고 claude 를 대체 화면 없이 돌려서 드러나는 일이다(대체 화면이면 나갈 때 통째로 걷힌다).
/// 웹뷰에서 xterm 커서만 옮기면 안 된다 — ConPTY 가 아는 커서와 어긋나 PowerShell 이 절대 좌표로 그리는
/// 입력줄이 엉뚱한 줄에 찍힌다. 그래서 같은 콘솔에 붙어 있는 래퍼가 콘솔 API 로 옮긴다.
#[cfg(windows)]
fn settle_cursor() {
    use windows_sys::Win32::System::Console::*;
    unsafe {
        let out = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        // 출력이 파이프면(`claude -p ... | ...`) 콘솔이 아니라 여기서 끝난다.
        if GetConsoleScreenBufferInfo(out, &mut info) == 0 {
            return;
        }
        let width = info.dwSize.X.max(0) as usize;
        let mut row = vec![0u16; width];
        let last = (info.dwCursorPosition.Y + 1..=info.srWindow.Bottom).rev().find(|&y| {
            let mut read = 0;
            ReadConsoleOutputCharacterW(out, row.as_mut_ptr(), width as u32, COORD { X: 0, Y: y }, &mut read) != 0
                && row[..read as usize].iter().any(|&c| c != b' ' as u16 && c != 0)
        });
        if let Some(y) = last {
            SetConsoleCursorPosition(out, COORD { X: 0, Y: y });
            let mut written = 0;
            WriteConsoleW(out, [b'\r' as u16, b'\n' as u16].as_ptr(), 2, &mut written, std::ptr::null());
        }
    }
}

fn codex_interactive(args: &[String]) -> bool {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" { return true; }
        if matches!(arg, "--help" | "-h" | "--version" | "-V") { return false; }
        if matches!(arg, "-c" | "--config" | "-m" | "--model" | "-p" | "--profile" |
            "-s" | "--sandbox" | "-a" | "--ask-for-approval" | "-C" | "--cd" |
            "--add-dir" | "--local-provider" | "--enable" | "--disable" | "--remote" |
            "--remote-auth-token-env" | "-i" | "--image") { i += 2; continue; }
        if !arg.starts_with('-') {
            // 옵션의 값이 exec·review 같은 단어여도 하위 명령으로 오인하지 않는다.
            return !matches!(arg, "exec" | "e" | "review" | "sandbox" | "debug" | "features" |
                "apply" | "archive" | "delete" | "unarchive" | "migrate-rollouts" | "cloud" |
                "exec-server" | "mcp" | "login" | "logout" | "plugin" | "app-server" | "mcp-server" |
                "agents" | "queue" | "app" | "completion" | "update" | "doctor" | "remote-control" | "help");
        }
        i += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_interactive_codex_commands_capture_continuation_options() {
        for args in [vec![], vec!["resume", "id"], vec!["-m", "review"], vec!["--", "exec"]] {
            assert!(codex_interactive(&args.into_iter().map(Into::into).collect::<Vec<_>>()));
        }
        for args in [vec!["exec", "prompt"], vec!["-c", "model='x'", "mcp", "list"], vec!["--version"]] {
            assert!(!codex_interactive(&args.into_iter().map(Into::into).collect::<Vec<_>>()));
        }
    }

    #[test]
    fn setup_and_background_attach_do_not_replace_agent_connection() {
        for arg in ["--help", "--version", "auth", "login", "mcp", "attach"] {
            assert!(!interactive(&[arg.into()]));
        }
        assert!(interactive(&[]));
        assert!(interactive(&["--resume".into(), "id".into()]));
    }

    #[test]
    fn per_launch_config_preserves_paths_without_changing_approval() {
        let path = Path::new(r"C:\한글 경로\chiispace-cli.exe");
        let claude = config_args("claude", path, "%7", r"\\.\pipe\chiispace-1", "lease");
        let config: serde_json::Value = serde_json::from_str(&claude[1]).unwrap();
        assert_eq!(config["mcpServers"]["chiispace"]["command"], json!(path));
        assert_eq!(
            config["mcpServers"]["chiispace"]["env"]["CHIISPACE_PANE_ID"],
            "%7"
        );
        let codex = config_args("codex", path, "%7", r"\\.\pipe\chiispace-1", "lease");
        assert_eq!(codex.len(), 9);
        assert_eq!(codex.last().unwrap(), "--no-alt-screen");
        assert!(codex
            .iter()
            .all(|s| !s.contains("approval") && !s.contains("developer_instructions")));
        let command: String = serde_json::from_str(codex[1].split_once('=').unwrap().1).unwrap();
        assert_eq!(command, path.to_str().unwrap());
    }

    #[test]
    fn codex_resume_keeps_scrollback_and_original_session_argument() {
        let args = append_args(
            config_args("codex", Path::new("cli.exe"), "%7", "pipe", "lease"),
            vec![
                "resume".into(),
                "01234567-89ab-cdef-0123-456789abcdef".into(),
            ],
        );
        assert_eq!(
            args.iter().filter(|arg| *arg == "--no-alt-screen").count(),
            1
        );
        assert_eq!(
            &args[9..],
            ["resume", "01234567-89ab-cdef-0123-456789abcdef"]
        );
        assert!(
            !config_args("claude", Path::new("cli.exe"), "%7", "pipe", "lease")
                .iter()
                .any(|arg| arg == "--no-alt-screen")
        );
    }

    #[test]
    fn explicit_scrollback_flag_is_not_duplicated_or_confused_with_a_prompt() {
        let defaults = vec!["--no-alt-screen".into()];
        assert_eq!(
            append_args(
                defaults.clone(),
                vec!["--no-alt-screen".into(), "resume".into()]
            ),
            vec!["--no-alt-screen", "resume"]
        );
        assert_eq!(
            append_args(defaults, vec!["--".into(), "--no-alt-screen".into()]),
            vec!["--no-alt-screen", "--", "--no-alt-screen"]
        );
    }
}
