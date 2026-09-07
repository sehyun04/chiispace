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
    if injected {
        let registration = crate::rpc::collab("register", json!({"harness":name}))?;
        let token = registration["token"].as_str().context("연결 토큰 누락")?;
        std::env::set_var("CHIISPACE_AGENT_TOKEN", token);
        command.env("CHIISPACE_AGENT_TOKEN", token);
        command.args(config_args(
            name,
            &config.cli,
            &std::env::var("CHIISPACE_PANE_ID")?,
            &std::env::var("CHIISPACE_SOCKET_PATH")?,
            token,
        ));
    }
    command.args(args);
    let status = command.status().context("에이전트 시작 실패");
    if injected {
        let _ = crate::rpc::collab("unregister", json!({}));
    }
    Ok(status?.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(codex.len(), 8);
        assert!(codex
            .iter()
            .all(|s| !s.contains("approval") && !s.contains("developer_instructions")));
        let command: String = serde_json::from_str(codex[1].split_once('=').unwrap().1).unwrap();
        assert_eq!(command, path.to_str().unwrap());
    }
}
