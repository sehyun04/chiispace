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
    run_agent_with_resume(name, args, None)
}

pub fn run_agent_with_resume(name: &str, args: Vec<String>, resume: Option<crate::codex_session::Session>) -> Result<i32> {
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
        let registration = crate::rpc::collab("register", json!({"harness":name,"resume":resume}))?;
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
    let own_transport = name == "codex" && injected && codex_interactive(&args)
        && !args.iter().take_while(|s| *s != "--").any(|s| s == "--remote" || s.starts_with("--remote="));
    let options = crate::codex_session::restore_options(&args);
    let args = append_args(defaults, args);
    let status = if own_transport { crate::codex_transport::run(program, args, options) }
        else { command.args(args).status().context("에이전트 시작 실패").map(|s| s.code().unwrap_or(1)) };
    if injected {
        let _ = crate::rpc::collab("unregister", json!({"failed":status.as_ref().map_or(true, |code| *code != 0)}));
    }
    status
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
    fn only_interactive_codex_commands_use_the_session_transport() {
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
