use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use kasa_pty::PtySession;
use kasa_socket::{
    backend::{PaneActivity, SurfaceInfo, WorkspaceInfo},
    transport::{LocalListener, LocalStream},
    Backend, Request, Response, SplitDirection,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AgentTurns, Panes};

#[derive(Default, Deserialize)]
pub struct Snapshot {
    workspaces: Vec<WorkspaceInfo>,
    pub surfaces: Vec<SurfaceInfo>,
    current: Option<String>,
    focused: Option<String>,
    #[serde(default)]
    pub neighbors: HashMap<String, HashMap<String, String>>,
}

pub struct Bridge {
    pub path: String,
    pub snapshot: Mutex<Snapshot>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    next: AtomicU64,
    // 분할 응답 전에 다음 분할을 받으면 웹뷰가 아직 이전 배치를 보고 있을 수 있다.
    changes: Mutex<()>,
}

#[derive(Clone, Serialize)]
struct Action {
    request: u64,
    expires: u64,
    action: String,
    surface: String,
    direction: Option<SplitDirection>,
    focus: bool,
    lines: usize,
}

pub fn start(app: &AppHandle) -> Result<()> {
    // 부모 터미널의 소켓 주소를 상속하면 다른 창으로 명령이 샌다. 인스턴스마다 분리한다.
    let path = if cfg!(windows) {
        format!(r"\\.\pipe\chiispace-{}", std::process::id())
    } else {
        std::env::temp_dir()
            .join(format!("chiispace-{}.sock", std::process::id()))
            .to_string_lossy()
            .into_owned()
    };
    let listener = LocalListener::bind(std::path::Path::new(&path))?;
    app.manage(Bridge {
        path,
        snapshot: Mutex::default(),
        pending: Mutex::default(),
        next: AtomicU64::new(1),
        changes: Mutex::new(()),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || client(app, stream));
        }
    });
    Ok(())
}

fn client(app: AppHandle, stream: LocalStream) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        let Ok(size) = reader.by_ref().take(1_048_577).read_line(&mut line) else {
            return;
        };
        if size == 0 || size > 1_048_576 {
            return;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) if req.method.starts_with("chiispace.") => {
                match crate::collab::dispatch(&app, &req.method, &req.params) {
                    Ok(result) => Response::success(req.id, result),
                    Err(error) => Response::error(req.id, -32000, error.to_string()),
                }
            }
            Ok(req) => kasa_socket::methods::dispatch(&Host(app.clone()), req),
            Err(error) => Response::error(Value::Null, -32700, error.to_string()),
        };
        let Ok(mut json) = serde_json::to_vec(&response) else {
            return;
        };
        json.push(b'\n');
        if writer.write_all(&json).is_err() {
            return;
        }
    }
}

#[tauri::command]
pub fn bridge_sync(bridge: State<Bridge>, snapshot: Snapshot) {
    *bridge.snapshot.lock().unwrap() = snapshot;
}

#[tauri::command]
pub fn bridge_reply(
    bridge: State<Bridge>,
    request: u64,
    result: Option<Value>,
    error: Option<String>,
) {
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&request) {
        let _ = tx.send(match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
}

pub struct Host(pub AppHandle);

impl Host {
    fn target(&self, id: Option<&str>) -> Result<String> {
        let bridge = self.0.state::<Bridge>();
        let snapshot = bridge.snapshot.lock().unwrap();
        let id = id
            .or(snapshot.focused.as_deref())
            .ok_or_else(|| anyhow!("선택된 칸이 없습니다"))?;
        if !snapshot.surfaces.iter().any(|s| s.id == id) {
            bail!("없는 칸: {id}");
        }
        Ok(id.to_owned())
    }

    fn pane(&self, id: &str) -> Result<Arc<PtySession>> {
        self.0
            .state::<Panes>()
            .0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("칸이 준비되지 않았습니다: {id}"))
    }

    fn change(
        &self,
        action: &str,
        surface: &str,
        direction: Option<SplitDirection>,
        focus: bool,
        lines: usize,
    ) -> Result<Value> {
        let bridge = self.0.state::<Bridge>();
        let _serial = bridge.changes.lock().unwrap();
        let request = bridge.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        bridge.pending.lock().unwrap().insert(request, tx);
        let expires = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64 + 10_000;
        if let Err(e) = self.0.emit(
            "bridge:action",
            Action {
                request,
                expires,
                action: action.into(),
                surface: surface.into(),
                direction,
                focus,
                lines,
            },
        ) {
            bridge.pending.lock().unwrap().remove(&request);
            return Err(e.into());
        }
        let reply = rx.recv_timeout(Duration::from_secs(10));
        bridge.pending.lock().unwrap().remove(&request);
        reply
            .map_err(|_| anyhow!("웹뷰 응답 시간 초과; 칸 목록을 확인하세요"))?
            .map_err(|e| anyhow!(e))
    }
}

impl Backend for Host {
    fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        Ok(self
            .0
            .state::<Bridge>()
            .snapshot
            .lock()
            .unwrap()
            .workspaces
            .clone())
    }

    fn current_workspace(&self) -> Result<Option<WorkspaceInfo>> {
        let bridge = self.0.state::<Bridge>();
        let snapshot = bridge.snapshot.lock().unwrap();
        Ok(snapshot
            .workspaces
            .iter()
            .find(|w| Some(&w.id) == snapshot.current.as_ref())
            .cloned())
    }

    fn list_surfaces(&self) -> Result<Vec<SurfaceInfo>> {
        let mut surfaces = self
            .0
            .state::<Bridge>()
            .snapshot
            .lock()
            .unwrap()
            .surfaces
            .clone();
        for s in &mut surfaces {
            if let Ok(pane) = self.pane(&s.id) {
                s.cwd = pane
                    .reported_cwd()
                    .map(|p| p.to_string_lossy().into_owned())
                    .or(s.cwd.take());
            }
        }
        Ok(surfaces)
    }

    fn focus_surface(&self, id: &str) -> Result<()> {
        self.change("focus", &self.target(Some(id))?, None, true, 0)?;
        Ok(())
    }

    fn split_surface(
        &self,
        direction: SplitDirection,
        focus: bool,
        from: Option<&str>,
    ) -> Result<SurfaceInfo> {
        let result = self.change("split", &self.target(from)?, Some(direction), focus, 0)?;
        Ok(serde_json::from_value(result)?)
    }

    fn close_surface(&self, id: &str) -> Result<()> {
        self.change("close", &self.target(Some(id))?, None, false, 0)?;
        Ok(())
    }

    fn send_text(&self, target: Option<&str>, text: &str) -> Result<()> {
        self.send_raw(target, text.as_bytes())
    }

    fn send_key(&self, target: Option<&str>, key: &str) -> Result<()> {
        self.send_raw(target, &key_bytes(key)?)
    }

    fn send_raw(&self, target: Option<&str>, bytes: &[u8]) -> Result<()> {
        let id = self.target(target)?;
        let collab = self.0.state::<crate::collab::Collab>();
        let mut queue = collab.0.lock().unwrap();
        let pane = self.pane(&id)?;
        queue.input(&id, bytes);
        if bytes.iter().any(|b| matches!(b, b'\r' | b'\n')) && pane.active_agent().is_some() {
            self.0
                .state::<AgentTurns>()
                .0
                .lock()
                .unwrap()
                .insert(id, false);
        }
        pane.send_bytes(bytes)
    }

    fn peek(&self, id: &str, lines: usize) -> Result<String> {
        let result = self.change(
            "peek",
            &self.target(Some(id))?,
            None,
            false,
            lines.min(1000),
        )?;
        result
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("화면 읽기 응답이 올바르지 않습니다"))
    }

    fn collab_board(&self) -> Result<Vec<PaneActivity>> {
        self.list_surfaces()?
            .into_iter()
            .map(|s| {
                let pane = self.pane(&s.id)?;
                Ok(PaneActivity {
                    surface_id: s.id,
                    title: s.title.unwrap_or_default(),
                    cwd: s.cwd.unwrap_or_default(),
                    character: s.character,
                    harness: pane.active_agent().map(|a| a.as_str().to_owned()),
                    status: if pane.has_active_job() {
                        "working"
                    } else {
                        "idle"
                    }
                    .into(),
                    reach: "tell".into(),
                    ..Default::default()
                })
            })
            .collect()
    }
}

fn key_bytes(key: &str) -> Result<Vec<u8>> {
    let bytes: &[u8] = match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => b"\r",
        "tab" => b"\t",
        "escape" | "esc" => b"\x1b",
        "backspace" | "bspace" => b"\x7f",
        "delete" => b"\x1b[3~",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pageup" => b"\x1b[5~",
        "pagedown" => b"\x1b[6~",
        "space" => b" ",
        _ => {
            let lower = key.to_ascii_lowercase();
            if let Some(letter) = lower
                .strip_prefix("ctrl+")
                .or_else(|| lower.strip_prefix("c-"))
            {
                if letter.len() == 1 && letter.as_bytes()[0].is_ascii_lowercase() {
                    return Ok(vec![letter.as_bytes()[0] - b'a' + 1]);
                }
            }
            bail!("지원하지 않는 키: {key}");
        }
    };
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_do_not_silently_type_unknown_names() {
        assert_eq!(key_bytes("Enter").unwrap(), b"\r");
        assert_eq!(key_bytes("Ctrl+C").unwrap(), b"\x03");
        assert_eq!(key_bytes("C-z").unwrap(), b"\x1a");
        assert!(key_bytes("Ctrl+Enter").is_err());
    }
}
