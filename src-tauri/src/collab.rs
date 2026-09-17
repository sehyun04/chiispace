use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    bridge::{Host, Snapshot},
    AgentTurns, Panes,
};

#[derive(Clone)]
struct Agent {
    token: String,
    harness: String,
    connected: bool,
}

#[derive(Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub from: String,
    pub to: String,
    pub description: String,
    pub status: String,
    pub result: Option<String>,
    #[serde(skip)]
    sender: String,
    #[serde(skip)]
    receiver: String,
    #[serde(skip)]
    created: Option<Instant>,
}

impl Task {
    fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

struct Input {
    revision: u64,
    draft: bool,
    touched: Instant,
}

#[derive(Default)]
pub struct Queue {
    serial: u64,
    agents: HashMap<String, Agent>,
    tasks: VecDeque<Task>,
    inputs: HashMap<String, Input>,
    pub codex: HashMap<String, CodexBinding>,
}

#[derive(Clone, Serialize)]
pub struct CodexBinding {
    pub run: String,
    pub session: Option<crate::codex_session::Session>,
    pub launch: Option<crate::codex_session::Launch>,
    pub failed: bool,
}

#[derive(Default)]
pub struct Collab(pub Mutex<Queue>);

fn terminal_reply(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    if matches!(text, "\x1b[I" | "\x1b[O") {
        return true;
    }
    let numbers = |value: &str| {
        !value.is_empty()
            && value
                .split(';')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    if let Some(csi) = text.strip_prefix("\x1b[") {
        if let Some(params) = csi.strip_suffix('R') {
            let params = params.strip_prefix('?').unwrap_or(params);
            return numbers(params) && params.split(';').count() == 2;
        }
        if let Some(params) = csi.strip_suffix('c') {
            return params.strip_prefix(['?', '>']).is_some_and(numbers);
        }
        if let Some(params) = csi.strip_suffix("$y") {
            let params = params.strip_prefix('?').unwrap_or(params);
            return numbers(params) && params.split(';').count() == 2;
        }
        if let Some(params) = csi.strip_suffix('t') {
            return numbers(params)
                && params.split(';').count() == 3
                && matches!(params.split(';').next(), Some("4" | "6" | "8"));
        }
        return csi == "0n";
    }
    let Some(osc) = text
        .strip_prefix("\x1b]")
        .and_then(|s| s.strip_suffix("\x1b\\").or_else(|| s.strip_suffix('\x07')))
    else {
        return false;
    };
    let Some((index, rgb)) = osc.split_once(";rgb:") else {
        return false;
    };
    (matches!(index, "10" | "11" | "12")
        || index
            .strip_prefix("4;")
            .is_some_and(|n| n.parse::<u8>().is_ok()))
        && rgb.split('/').count() == 3
        && rgb
            .split('/')
            .all(|c| (1..=4).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_hexdigit()))
}

impl Queue {
    fn next(&mut self, prefix: &str) -> String {
        self.serial += 1;
        format!("{prefix}-{}-{}", std::process::id(), self.serial)
    }

    pub fn input(&mut self, pane: &str, bytes: &[u8]) {
        // xterm의 조회 응답도 onData로 돌아오지만 사용자 초안이나 입력 시각을 바꾸지는 않는다.
        if bytes.is_empty() || terminal_reply(bytes) {
            return;
        }
        let input = self.inputs.entry(pane.into()).or_insert(Input {
            revision: 0,
            draft: false,
            touched: Instant::now(),
        });
        input.revision += 1;
        input.touched = Instant::now();
        // 화면만으로는 Home 키로 커서를 옮긴 초안을 빈 입력칸과 구별할 수 없다.
        input.draft = !matches!(bytes.last(), Some(b'\r' | b'\n' | 3));
    }

    pub fn closed(&mut self, pane: &str) {
        self.codex.remove(pane);
        self.agents.remove(pane);
        self.inputs.remove(pane);
        for task in &mut self.tasks {
            if !task.terminal() && (task.to == pane || task.from == pane) {
                task.status = "failed".into();
                task.result = Some("연결된 칸 또는 에이전트가 종료됐습니다".into());
            }
        }
    }

    fn authenticate(&self, pane: &str, token: &str) -> Result<&Agent> {
        self.agents
            .get(pane)
            .filter(|a| a.token == token)
            .ok_or_else(|| anyhow!("에이전트 연결이 만료됐습니다. 해당 칸에서 다시 실행하세요"))
    }

    fn submit(&mut self, from: &str, to: &str, token: &str, description: &str) -> Result<Task> {
        self.authenticate(from, token)?;
        if from == to {
            bail!("자기 칸에는 일을 맡길 수 없습니다");
        }
        if description.trim().is_empty() || description.len() > 32_768 {
            bail!("작업 내용은 1~32768 바이트여야 합니다");
        }
        let receiver = self
            .agents
            .get(to)
            .filter(|a| a.connected)
            .ok_or_else(|| anyhow!("상대 칸에서 연결된 Claude 또는 Codex를 먼저 실행하세요"))?
            .token
            .clone();
        if self.tasks.iter().filter(|t| !t.terminal()).count() >= 64 {
            bail!("대기 중인 작업이 너무 많습니다");
        }
        while self.tasks.len() >= 256 {
            let index = self
                .tasks
                .iter()
                .position(Task::terminal)
                .ok_or_else(|| anyhow!("작업 기록이 가득 찼습니다"))?;
            self.tasks.remove(index);
        }
        let task = Task {
            id: self.next("task"),
            from: from.into(),
            to: to.into(),
            description: description.into(),
            status: "queued".into(),
            result: None,
            sender: token.into(),
            receiver,
            created: Some(Instant::now()),
        };
        self.tasks.push_back(task.clone());
        Ok(task)
    }

    fn task(&self, id: &str, pane: &str, token: &str) -> Result<&Task> {
        self.authenticate(pane, token)?;
        self.tasks
            .iter()
            .find(|t| {
                t.id == id
                    && ((t.from == pane && t.sender == token)
                        || (t.to == pane && t.receiver == token))
            })
            .ok_or_else(|| anyhow!("이 에이전트의 작업이 아닙니다: {id}"))
    }

    fn input_ready(&self, pane: &str) -> bool {
        self.inputs
            .get(pane)
            .is_none_or(|i| !i.draft && i.touched.elapsed() >= Duration::from_secs(2))
    }
}

fn value<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("필수 인자 누락: {name}"))
}

pub fn resolve(snapshot: &Snapshot, from: &str, target: &str) -> Result<String> {
    if snapshot.surfaces.iter().any(|s| s.id == target) {
        return Ok(target.into());
    }
    if let Some(id) = snapshot.neighbors.get(from).and_then(|n| n.get(target)) {
        return Ok(id.clone());
    }
    let candidates: Vec<_> = snapshot
        .surfaces
        .iter()
        .filter(|s| {
            s.id != from
                && (s
                    .title
                    .as_deref()
                    .is_some_and(|t| t.to_lowercase() == target.to_lowercase())
                    || s.character.as_deref() == Some(target))
        })
        .collect();
    if candidates.len() != 1 {
        bail!("상대 칸을 하나로 정할 수 없습니다. chiispace_context에서 ID를 확인하세요");
    }
    Ok(candidates[0].id.clone())
}

pub fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value> {
    let pane = value(params, "pane")?;
    let collab = app.state::<Collab>();
    if method == "chiispace.register" {
        if !app.state::<Panes>().0.lock().unwrap().contains_key(pane) {
            bail!("없는 칸: {pane}");
        }
        let harness = value(params, "harness")?;
        if !matches!(harness, "claude" | "codex") {
            bail!("지원하지 않는 에이전트");
        }
        let resume = if harness == "codex" {
            let session = params.get("resume").filter(|v| !v.is_null())
                .map(|v| serde_json::from_value::<crate::codex_session::Session>(v.clone())).transpose()?;
            if let Some(s) = &session { s.validate()?; }
            session
        } else { None };
        let mut q = collab.0.lock().unwrap();
        // 같은 pane ID라도 다시 실행된 에이전트에 과거 작업을 넘기지 않는다.
        let launch = params.get("launch").filter(|v| !v.is_null())
            .map(|v| serde_json::from_value::<crate::codex_session::Launch>(v.clone())).transpose()?;
        if let Some(l) = &launch { l.validate()?; }
        q.closed(pane);
        let token = q.next("agent");
        q.agents.insert(
            pane.into(),
            Agent {
                token: token.clone(),
                harness: harness.into(),
                connected: false,
            },
        );
        if harness == "codex" {
            q.codex.insert(pane.into(), CodexBinding { run: token.clone(), session: resume, launch, failed: false });
        }
        return Ok(json!({"token": token}));
    }
    let token = value(params, "token")?;
    let mut q = collab.0.lock().unwrap();
    q.authenticate(pane, token)?;
    match method {
        "chiispace.connect" => {
            q.agents.get_mut(pane).unwrap().connected = true;
            Ok(json!({"pane": pane}))
        }
        "chiispace.disconnect" => {
            q.agents.get_mut(pane).unwrap().connected = false;
            Ok(json!({}))
        }
        "chiispace.unregister" => {
            let mut binding = q.codex.get(pane).cloned();
            if let Some(b) = &mut binding { b.failed = params["failed"].as_bool().unwrap_or(false); }
            q.closed(pane);
            if let Some(b) = binding.filter(|b| b.failed && (b.session.is_some() || b.launch.is_some())) { q.codex.insert(pane.into(), b); }
            Ok(json!({}))
        }
        "chiispace.codex_session" => {
            if q.authenticate(pane, token)?.harness != "codex" { bail!("Codex 실행이 아닙니다"); }
            let session: crate::codex_session::Session = serde_json::from_value(params["session"].clone())?;
            session.validate()?;
            q.codex.insert(pane.into(), CodexBinding {
                run: token.into(), session: Some(session), launch: None, failed: false,
            });
            Ok(json!({}))
        }
        "chiispace.context" => {
            let bridge = app.state::<crate::bridge::Bridge>();
            let snapshot = bridge.snapshot.lock().unwrap();
            let panes: Vec<_> = snapshot.surfaces.iter().map(|s| json!({
                "id":s.id, "title":s.title, "character":s.character, "workspace_id":s.workspace_id,
                "cwd":s.cwd, "neighbors":snapshot.neighbors.get(&s.id),
                "agent":q.agents.get(&s.id).map(|a| &a.harness),
                "connected":q.agents.get(&s.id).is_some_and(|a| a.connected),
                "draft":q.inputs.get(&s.id).is_some_and(|i| i.draft)
            })).collect();
            let tasks: Vec<_> = q
                .tasks
                .iter()
                .filter(|t| {
                    (t.from == pane && t.sender == token) || (t.to == pane && t.receiver == token)
                })
                // 긴 결과가 쌓여도 context가 IPC 응답 한도를 넘지 않게 한다.
                .map(|t| {
                    json!({"id":t.id, "from":t.from, "to":t.to, "status":t.status,
                    "description":t.description.chars().take(120).collect::<String>(),
                    "has_result":t.result.is_some()})
                })
                .collect();
            Ok(json!({"self":pane, "panes":panes, "tasks":tasks}))
        }
        "chiispace.delegate" => {
            let bridge = app.state::<crate::bridge::Bridge>();
            let target = resolve(
                &bridge.snapshot.lock().unwrap(),
                pane,
                value(params, "target")?,
            )?;
            Ok(serde_json::to_value(q.submit(
                pane,
                &target,
                token,
                value(params, "description")?,
            )?)?)
        }
        "chiispace.status" => Ok(serde_json::to_value(q.task(
            value(params, "task_id")?,
            pane,
            token,
        )?)?),
        "chiispace.claim" | "chiispace.complete" | "chiispace.cancel" => {
            let id = value(params, "task_id")?;
            let task = q.task(id, pane, token)?;
            if method == "chiispace.cancel" {
                if task.from != pane || task.status != "queued" {
                    bail!("아직 전달하지 않은 자기 작업만 취소할 수 있습니다");
                }
            } else if task.to != pane || !matches!(task.status.as_str(), "delivered" | "running") {
                bail!("받아서 수행 중인 작업만 처리할 수 있습니다");
            }
            let result = if method == "chiispace.complete" {
                let text = value(params, "result")?;
                if text.trim().is_empty() || text.len() > 65_536 {
                    bail!("결과는 1~65536 바이트여야 합니다");
                }
                Some(text.to_owned())
            } else {
                None
            };
            let task = q.tasks.iter_mut().find(|t| t.id == id).unwrap();
            task.status = match method {
                "chiispace.claim" => "running",
                "chiispace.cancel" => "cancelled",
                _ if params
                    .get("failed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false) =>
                {
                    "failed"
                }
                _ => "completed",
            }
            .into();
            task.result = result;
            Ok(serde_json::to_value(task)?)
        }
        "chiispace.peek" => {
            let target = value(params, "target")?.to_owned();
            drop(q);
            use kasa_socket::Backend;
            let bridge = app.state::<crate::bridge::Bridge>();
            let id = resolve(&bridge.snapshot.lock().unwrap(), pane, &target)?;
            Ok(json!({"text": Host(app.clone()).peek(&id, 40)?}))
        }
        _ => bail!("지원하지 않는 협업 명령: {method}"),
    }
}

#[derive(Serialize)]
pub struct Delivery {
    task_id: String,
    pane: String,
    harness: String,
    revision: u64,
}

#[tauri::command]
pub fn collab_pending(app: AppHandle) -> Vec<Delivery> {
    let collab = app.state::<Collab>();
    let mut q = collab.0.lock().unwrap();
    for t in &mut q.tasks {
        if t.status == "queued"
            && t.created
                .is_some_and(|at| at.elapsed() > Duration::from_secs(900))
        {
            t.status = "failed".into();
            t.result = Some("15분 동안 상대 입력칸이 준비되지 않아 전달하지 못했습니다".into());
        }
    }
    let mut deliveries = Vec::new();
    for task in &q.tasks {
        if task.status != "queued" || deliveries.iter().any(|d: &Delivery| d.pane == task.to) {
            continue;
        }
        if q.tasks
            .iter()
            .any(|t| t.to == task.to && matches!(t.status.as_str(), "delivered" | "running"))
        {
            continue;
        }
        let Some(agent) = q
            .agents
            .get(&task.to)
            .filter(|a| a.connected && a.token == task.receiver)
        else {
            continue;
        };
        if !q.input_ready(&task.to) {
            continue;
        }
        deliveries.push(Delivery {
            task_id: task.id.clone(),
            pane: task.to.clone(),
            harness: agent.harness.clone(),
            revision: q.inputs.get(&task.to).map_or(0, |i| i.revision),
        });
    }
    deliveries
}

#[tauri::command]
pub fn collab_deliver(app: AppHandle, task_id: String, revision: u64) -> Result<bool, String> {
    let collab = app.state::<Collab>();
    let mut q = collab.0.lock().unwrap();
    let Some(task) = q
        .tasks
        .iter()
        .find(|t| t.id == task_id && t.status == "queued")
        .cloned()
    else {
        return Ok(false);
    };
    let Some(agent) = q
        .agents
        .get(&task.to)
        .filter(|a| a.connected && a.token == task.receiver)
    else {
        return Ok(false);
    };
    if !q.input_ready(&task.to) || q.inputs.get(&task.to).map_or(0, |i| i.revision) != revision {
        return Ok(false);
    }
    if q.tasks
        .iter()
        .any(|t| t.to == task.to && matches!(t.status.as_str(), "delivered" | "running"))
    {
        return Ok(false);
    }
    let panes = app.state::<Panes>();
    let map = panes.0.lock().unwrap();
    let Some(pane) = map.get(&task.to) else {
        return Ok(false);
    };
    if pane.active_agent().map(|a| a.as_str()) != Some(agent.harness.as_str())
        || pane.output_heartbeat()
        || crate::pane_shows_working_spinner(pane)
    {
        return Ok(false);
    }
    let message = format!("Chiispace {task_id}: use chiispace_claim, then chiispace_complete.");
    let text = if pane.full_snapshot().bracketed_paste {
        format!("\x1b[200~{message}\x1b[201~")
    } else {
        message
    };
    // 사용자 입력과 같은 락을 잡아, 빈 입력 확인과 실제 전송 사이에 초안이 끼지 않게 한다.
    q.tasks.iter_mut().find(|t| t.id == task_id).unwrap().status = "delivered".into();
    let sent = pane.send_bytes(text.as_bytes()).and_then(|_| {
        std::thread::sleep(Duration::from_millis(120));
        pane.send_bytes(b"\r")
    });
    if let Err(error) = sent {
        let task = q.tasks.iter_mut().find(|t| t.id == task_id).unwrap();
        task.status = "failed".into();
        task.result = Some(format!("입력 전송 실패; 자동 재전송하지 않습니다: {error}"));
        return Err(error.to_string());
    }
    q.input(&task.to, b"\r");
    app.state::<AgentTurns>()
        .0
        .lock()
        .unwrap()
        .insert(task.to, false);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> Queue {
        let mut q = Queue::default();
        for pane in ["a", "b", "c"] {
            q.agents.insert(
                pane.into(),
                Agent {
                    token: format!("lease-{pane}"),
                    harness: "claude".into(),
                    connected: true,
                },
            );
        }
        q
    }

    #[test]
    fn tasks_are_bound_to_both_agent_lifetimes() {
        let mut q = queue();
        let task = q.submit("a", "b", "lease-a", "테스트 실행").unwrap();
        assert!(q.task(&task.id, "c", "lease-c").is_err());
        assert!(q.task(&task.id, "a", "wrong").is_err());
        q.closed("b");
        assert_eq!(q.task(&task.id, "a", "lease-a").unwrap().status, "failed");
        q.agents.insert(
            "b".into(),
            Agent {
                token: "new-b".into(),
                harness: "claude".into(),
                connected: true,
            },
        );
        assert!(q.task(&task.id, "b", "new-b").is_err());
        assert!(q.authenticate("b", "lease-b").is_err());
    }

    #[test]
    fn queue_rejects_missing_peer_empty_work_and_unbounded_backlog() {
        let mut q = queue();
        assert!(q.submit("a", "a", "lease-a", "work").is_err());
        assert!(q.submit("a", "d", "lease-a", "work").is_err());
        assert!(q.submit("a", "b", "lease-a", " ").is_err());
        for _ in 0..64 {
            q.submit("a", "b", "lease-a", "work").unwrap();
        }
        assert!(q.submit("a", "b", "lease-a", "work").is_err());
    }

    #[test]
    fn draft_and_cursor_movement_prevent_delivery_until_submit_or_cancel() {
        let mut q = queue();
        q.input("b", b"draft");
        q.inputs.get_mut("b").unwrap().touched -= Duration::from_secs(3);
        assert!(!q.input_ready("b"));
        q.input("b", b"\x1b[H");
        q.input("b", b"\x1b[I");
        assert!(q.inputs["b"].draft);
        q.input("b", b"\x03");
        assert!(!q.input_ready("b"));
        q.inputs.get_mut("b").unwrap().touched -= Duration::from_secs(3);
        assert!(q.input_ready("b"));
        assert_eq!(q.inputs["b"].revision, 3);
    }

    #[test]
    fn terminal_reports_do_not_create_drafts_or_delay_delivery() {
        let mut q = queue();
        q.input("b", b"\r");
        q.inputs.get_mut("b").unwrap().touched -= Duration::from_secs(3);
        for reply in [
            "\x1b[12;3R",
            "\x1b[?12;3R",
            "\x1b[?1;2c",
            "\x1b[>0;276;0c",
            "\x1b[0n",
            "\x1b[?2004;1$y",
            "\x1b[8;40;120t",
            "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            "\x1b]11;rgb:fb/f5/ea\x07",
            "\x1b]4;15;rgb:ffff/ffff/ffff\x1b\\",
            "\x1b[I",
            "\x1b[O",
        ] {
            q.input("b", reply.as_bytes());
            assert!(
                q.input_ready("b"),
                "terminal reply became a draft: {reply:?}"
            );
            assert_eq!(q.inputs["b"].revision, 1);
        }
    }

    #[test]
    fn terminal_reports_preserve_drafts_and_do_not_hide_user_input() {
        let mut q = queue();
        q.input("b", b"draft");
        q.input("b", b"\x1b[12;3R");
        assert!(q.inputs["b"].draft);
        assert_eq!(q.inputs["b"].revision, 1);
        for input in [
            "\x1b[H",
            "\x1b[A",
            "\x1b[200~text\x1b[201~",
            "\x1b[12;3Rtext",
            "text\x1b[12;3R",
            "\x1b[;R",
            "\x1b]11;rgb:not-a-color\x07",
        ] {
            q.input("b", b"\r");
            q.input("b", input.as_bytes());
            assert!(q.inputs["b"].draft, "user input was ignored: {input:?}");
        }
    }

    #[test]
    fn target_resolution_uses_layout_neighbors_and_rejects_ambiguous_names() {
        let snapshot: Snapshot = serde_json::from_value(json!({
            "workspaces":[], "current":null,"focused":null,
            "surfaces":[
                {"id":"a","workspace_id":"w","title":"one","cwd":null,"character":null},
                {"id":"b","workspace_id":"w","title":"test","cwd":null,"character":"hachiware"},
                {"id":"c","workspace_id":"w","title":"test","cwd":null,"character":null}],
            "neighbors":{"a":{"right":"b"}}
        }))
        .unwrap();
        assert_eq!(resolve(&snapshot, "a", "right").unwrap(), "b");
        assert_eq!(resolve(&snapshot, "a", "hachiware").unwrap(), "b");
        assert!(resolve(&snapshot, "a", "test").is_err());
        assert!(resolve(&snapshot, "a", "left").is_err());
    }
}
