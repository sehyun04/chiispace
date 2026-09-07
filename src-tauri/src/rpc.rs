use anyhow::{anyhow, Context, Result};
use kasa_socket::{transport::LocalStream, Request, Response};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

pub fn call(path: PathBuf, req: Request) -> Result<Response> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<Response> {
            // named pipe의 다음 accept 인스턴스가 생기기 전 잠깐 BUSY가 날 수 있다.
            // 바이트 전송 후에는 중복 실행 위험 때문에 재시도하지 않는다.
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut socket = loop {
                match LocalStream::connect(&path) {
                    Ok(stream) => break stream,
                    Err(error)
                        if matches!(error.raw_os_error(), Some(2 | 231))
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(30));
                    }
                    Err(error) => return Err(error).context("치이스페 연결 실패"),
                }
            };
            let mut frame = serde_json::to_vec(&req)?;
            frame.push(b'\n');
            socket.write_all(&frame)?;
            let mut line = String::new();
            BufReader::new(socket)
                .take(4 * 1024 * 1024)
                .read_line(&mut line)?;
            Ok(serde_json::from_str(&line)?)
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(15))
        .context("치이스페 응답 시간 초과")?
}

pub fn collab(method: &str, mut params: Value) -> Result<Value> {
    if !params.is_object() {
        anyhow::bail!("협업 인자는 객체여야 합니다");
    }
    params["pane"] = json!(std::env::var("CHIISPACE_PANE_ID")?);
    if let Ok(token) = std::env::var("CHIISPACE_AGENT_TOKEN") {
        params["token"] = json!(token);
    }
    let response = call(
        std::env::var("CHIISPACE_SOCKET_PATH")?.into(),
        Request {
            id: json!(1),
            method: format!("chiispace.{method}"),
            params,
        },
    )?;
    if !response.ok {
        return Err(anyhow!(serde_json::to_string(&response.error)?));
    }
    Ok(response.result.unwrap_or(Value::Null))
}
