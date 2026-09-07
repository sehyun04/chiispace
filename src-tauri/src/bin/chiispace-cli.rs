use std::io::Read;

#[path = "../launch.rs"]
mod launch;
#[path = "../launch_config.rs"]
mod launch_config;
#[path = "../mcp.rs"]
mod mcp;
#[path = "../rpc.rs"]
mod rpc;

use anyhow::{anyhow, bail, Context, Result};
use kasa_socket::Request;
use serde_json::{json, Value};

fn request(args: &[String], own: Option<&str>) -> Result<(&'static str, Value)> {
    let at = |i: usize| {
        args.get(i)
            .map(String::as_str)
            .ok_or_else(|| anyhow!("인자가 부족합니다; --help 참고"))
    };
    let target = || at(1);
    Ok(match at(0)? {
        "ping" => ("system.ping", json!({})),
        "list" => ("surface.list", json!({})),
        "board" => ("collab.board", json!({})),
        "peek" => (
            "surface.peek",
            json!({"surface_id": target()?, "lines": args.get(2).map(|s| s.parse::<usize>()).transpose()?.unwrap_or(30)}),
        ),
        "text" => (
            "surface.send_text",
            json!({"surface_id": target()?, "text": at(2)?}),
        ),
        "text-stdin" => {
            let mut text = String::new();
            std::io::stdin().take(1_048_577).read_to_string(&mut text)?;
            if text.len() > 1_048_576 {
                bail!("텍스트는 1 MiB 이하여야 합니다");
            }
            (
                "surface.send_text",
                json!({"surface_id": target()?, "text": text}),
            )
        }
        "key" => (
            "surface.send_key",
            json!({"surface_id": target()?, "key": at(2)?}),
        ),
        "focus" => ("surface.focus", json!({"surface_id": target()?})),
        "close" => ("surface.close", json!({"surface_id": target()?})),
        "split" => {
            let from = args
                .get(2)
                .map(String::as_str)
                .or(own)
                .ok_or_else(|| anyhow!("칸 밖에서는 분할할 ID를 지정해야 합니다"))?;
            (
                "surface.split",
                json!({"from": from, "direction": args.get(1).map(String::as_str).unwrap_or("auto"), "focus": false}),
            )
        }
        other => bail!("알 수 없는 명령: {other}"),
    })
}

fn run() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let exe = std::env::current_exe()?;
    let name = exe.file_stem().and_then(|n| n.to_str()).unwrap_or_default();
    if matches!(name, "claude" | "codex") {
        std::process::exit(launch::run_agent(name, args)?);
    }
    if args.first().map(String::as_str) == Some("agent") {
        let name = args
            .get(1)
            .context("agent 뒤에 claude 또는 codex를 지정하세요")?
            .clone();
        if !matches!(name.as_str(), "claude" | "codex") {
            bail!("지원하지 않는 에이전트: {name}");
        }
        std::process::exit(launch::run_agent(
            &name,
            args.into_iter().skip(2).collect(),
        )?);
    }
    if args.first().map(String::as_str) == Some("mcp") {
        return mcp::run();
    }
    if args.is_empty() || args.first().is_some_and(|s| s == "--help" || s == "-h") {
        println!("chiispace-cli [--socket 주소] 명령\n\nlist | board | ping\npeek <칸 ID> [줄 수]\ntext <칸 ID> <텍스트>\ntext-stdin <칸 ID>\nkey <칸 ID> <Enter|Ctrl+C|Up|...>\nsplit [left|right|up|down|auto] [기준 칸 ID]\nfocus <칸 ID>\nclose <칸 ID>\nagent <claude|codex> [에이전트 인자...]\n\n칸 안에서는 CHIISPACE_SOCKET_PATH와 CHIISPACE_PANE_ID를 사용합니다.\ntext는 원시 텍스트 전송입니다. Enter 제출은 key로 별도 전송합니다.\nagent는 CHIISPACE_CLI 환경 변수의 실행 파일로 호출하세요.");
        return Ok(());
    }
    let socket = if args.first().map(String::as_str) == Some("--socket") {
        if args.len() < 3 {
            bail!("--socket 뒤에 주소와 명령이 필요합니다");
        }
        let path = args.remove(1);
        args.remove(0);
        path
    } else {
        std::env::var("CHIISPACE_SOCKET_PATH")
            .context("치이스페 칸 안에서 실행하거나 --socket 주소를 지정하세요")?
    };
    let own = std::env::var("CHIISPACE_PANE_ID").ok();
    let (method, params) = request(&args, own.as_deref())?;
    let response = rpc::call(
        socket.into(),
        Request {
            id: json!(1),
            method: method.into(),
            params,
        },
    )?;
    if !response.ok {
        bail!("{}", serde_json::to_string(&response.error)?);
    }
    let result = response.result.unwrap_or(Value::Null);
    if method == "surface.peek" {
        println!("{}", result["text"].as_str().unwrap_or_default());
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn split_uses_calling_pane_and_keeps_focus() {
        let (_, p) = request(&args(&["split", "left"]), Some("%7")).unwrap();
        assert_eq!(p["from"], "%7");
        assert_eq!(p["focus"], false);
        assert!(request(&args(&["split"]), None).is_err());
    }

    #[test]
    fn text_preserves_unicode_and_requires_explicit_target() {
        let (_, p) = request(&args(&["text", "%2", "한글 '따옴표' "]), Some("%1")).unwrap();
        assert_eq!(p["surface_id"], "%2");
        assert_eq!(p["text"], "한글 '따옴표' ");
        assert!(request(&args(&["key", "%2"]), None).is_err());
    }
}
