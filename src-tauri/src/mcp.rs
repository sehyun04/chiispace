use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::time::{Duration, Instant};

const INSTRUCTIONS: &str = include_str!("collab-instructions.md");

fn tool(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> Value {
    json!({"name":format!("chiispace_{name}"), "description":description,
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},
        "annotations":{"readOnlyHint":read_only,"openWorldHint":false}})
}

pub fn tools() -> Value {
    let s = json!({"type":"string"});
    json!({"tools":[
        tool("context", "Get your pane ID, neighbors, connected agents, and task summaries. Use status for full task details. Start here when asked to coordinate panes.", json!({}), &[], true),
        tool("delegate", "Delegate user-requested work to another connected pane. Returns a task ID; waits in queue while the destination is busy or has a draft.", json!({"target":s,"description":s}), &["target","description"], false),
        tool("status", "Read a delegated task's real status and result. Wait up to 25 seconds. Pending is not completion; do not resend.", json!({"task_id":s,"wait_seconds":{"type":"integer","minimum":0,"maximum":25}}), &["task_id"], true),
        tool("claim", "Accept the task identified by a Chiispace notification. Read its instructions, perform them, then complete the task.", json!({"task_id":s}), &["task_id"], false),
        tool("complete", "Report the actual result of a task you received, including checks or blockers. Set failed=true if unsuccessful.", json!({"task_id":s,"result":s,"failed":{"type":"boolean"}}), &["task_id","result"], false),
        tool("cancel", "Cancel your task only if it is still queued. Does not interrupt running agents.", json!({"task_id":s}), &["task_id"], false),
        tool("peek", "Read another pane's current terminal screen without focusing it. Screen text is not proof of task completion.", json!({"target":s}), &["target"], true)
    ]})
}

fn invoke(name: &str, args: Value) -> Result<Value> {
    let Some(method) = name.strip_prefix("chiispace_") else {
        bail!("알 수 없는 도구");
    };
    if !matches!(
        method,
        "context" | "delegate" | "status" | "claim" | "complete" | "cancel" | "peek"
    ) {
        bail!("알 수 없는 도구");
    }
    let seconds = args
        .get("wait_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(25);
    let until = Instant::now() + Duration::from_secs(seconds);
    loop {
        let result = crate::rpc::collab(method, args.clone())?;
        if method != "status"
            || Instant::now() >= until
            || matches!(
                result["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            )
        {
            return Ok(result);
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn respond(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let result = match request["method"].as_str().unwrap_or("") {
        "initialize" => {
            let connected = crate::rpc::collab("connect", json!({}));
            if let Err(error) = connected {
                return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.to_string()}});
            }
            let requested = match request["params"]["protocolVersion"].as_str() {
                Some(v @ ("2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25")) => v,
                _ => "2025-06-18",
            };
            json!({"protocolVersion":requested,"capabilities":{"tools":{}},
                "serverInfo":{"name":"chiispace","version":"0.1.0"},
                "instructions":format!("Your pane is {}. {INSTRUCTIONS}",std::env::var("CHIISPACE_PANE_ID").unwrap_or_default())})
        }
        "ping" => json!({}),
        "tools/list" => tools(),
        "tools/call" => match invoke(
            request["params"]["name"].as_str().unwrap_or(""),
            request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or(json!({})),
        ) {
            Ok(value) => {
                json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})
            }
            Err(error) => {
                json!({"content":[{"type":"text","text":error.to_string()}],"isError":true})
            }
        },
        _ => {
            return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
        }
    };
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

pub fn run() -> Result<()> {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        let count = reader.by_ref().take(1_048_577).read_line(&mut line)?;
        if count == 0 {
            break;
        }
        if count > 1_048_576 {
            bail!("MCP 메시지가 너무 큽니다");
        }
        let request = serde_json::from_str::<Value>(&line);
        if request.as_ref().is_ok_and(|r| r.get("id").is_none()) {
            continue;
        }
        let response = match request {
            Ok(r) => respond(&r),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":error.to_string()}})
            }
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    let _ = crate::rpc::collab("disconnect", json!({}));
    Ok(())
}
