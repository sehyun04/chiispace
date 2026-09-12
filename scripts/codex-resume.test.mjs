import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const codex = process.env.CHIISPACE_TEST_REAL_CODEX;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await delay(100);
  }
  throw new Error(`Codex 복원 조건 대기 시간 초과: ${last ?? "상태 미도달"}`);
}

test("실제 Codex의 두 칸별 대화 복원·새 대화 전환·다른 창 충돌 보호", { skip: !exe || !codex, timeout: 240000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-resume-"));
  const home = path.join(root, "한글 & state");
  mkdirSync(home);
  const protectedFiles = [
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json")),
    path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".claude.json"),
  ];
  const before = protectedFiles.map(hash);
  const clients = new Map();
  let modelRequests = 0;
  const models = [];
  const server = http.createServer((req, res) => {
    const client = clients.get(req.url);
    if (!client && req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (client) {
        client.latest = JSON.parse(body);
        res.end(JSON.stringify(client.commands.splice(0)));
        return;
      }
      // 외부 모델·인증 없이 실제 Codex의 대화 저장 경로까지 검증한다.
      modelRequests++;
      models.push(JSON.parse(body).model);
      const id = `resp_${modelRequests}`;
      const item = { type: "message", id: `msg_${modelRequests}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "CHIISPACE_LOCAL_REPLY", annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit("response.created", { response: { id, status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(home, "config.toml"), `
model = "resume-test"
model_provider = "local_test"
check_for_update_on_startup = false
[model_providers.local_test]
name = "Local restoration fixture"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(root)}]
trust_level = "trusted"
`);
  writeFileSync(path.join(home, "restore-test.config.toml"), 'model = "profile-model"\n');
  const shell = process.env.CHIISPACE_TEST_SHELL || path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const initial = { tabs: [{ key: "t0", focus: "%0", layout: { kind: "split", dir: "h", ratio: 0.5,
    a: { kind: "leaf", id: "%0" }, b: { kind: "leaf", id: "%1" } }, root, shell }],
    active: 0, nextPane: 2, nextTab: 1, procs: {} };
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify(initial));
  const apps = [];
  const readState = (file = state) => JSON.parse(readFileSync(file, "utf8"));
  async function launch(file = state) {
    const key = `/${randomUUID()}`;
    const client = { latest: {}, commands: [] };
    clients.set(key, client);
    const env = { ...process.env, CHIISPACE_STATE: file, CODEX_HOME: home };
    for (const name of Object.keys(env)) {
      if (name.startsWith("CHIISPACE_AUTO") || name.startsWith("CHIISPACE_PROBE") || name === "CHIISPACE_ROOT"
        || /API_KEY|AUTH_TOKEN|CODEX_TUI_RECORD|CODEX_TUI_SESSION_LOG/.test(name)) delete env[name];
    }
    const pathKey = Object.keys(env).find((name) => name.toLowerCase() === "path");
    if (process.env.CHIISPACE_TEST_CODEX_PATH !== "inherited") env[pathKey] = `${path.dirname(codex)};${env[pathKey]}`;
    env.CHIISPACE_PROBE_MS = "1000";
    env.CHIISPACE_PROBE = `(() => {
      let pending = false;
      setInterval(async () => {
        if (pending) return;
        pending = true;
        try {
          const panes = Object.fromEntries(Object.entries(window.__terms ?? {}).map(([id, t]) => {
            const b = t.buffer.active;
            const lines = Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "");
            return [id, { text: lines.slice(b.baseY).join("\\n"), history: lines.join("\\n") }];
          }));
          const response = await fetch(${JSON.stringify(base + key)}, { method: "POST", body: JSON.stringify(panes) });
          for (const c of await response.json()) window.__terms?.[c.id]?.input(c.input);
        } finally { pending = false; }
      }, 100);
      return "isolated Codex restore test";
    })()`;
    const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
    apps.push(app);
    client.app = app;
    client.key = key;
    await until(() => Object.keys(client.latest).length === 2);
    return client;
  }
  async function close(client) {
    if (client.app.exitCode === null) {
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${client.app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
      await until(() => client.app.exitCode !== null, 10000);
    }
    clients.delete(client.key);
  }
  async function input(client, id, text) {
    client.commands.push({ id, input: text });
    await delay(850);
    client.commands.push({ id, input: "\r" });
  }
  let active;
  try {
    active = await launch();
    for (const id of ["%0", "%1"]) {
      clientBlank(active, id);
      await delay(500);
      await input(active, id, `codex --sandbox read-only${id === "%1" ? " --profile restore-test" : ""}`);
      await until(() => active.latest[id]?.text.includes("Ask Codex to do anything"));
      await until(() => readState().procs[id]?.codex?.id);
    }
    let saved = readState();
    let a = saved.procs["%0"].codex.id;
    let b = saved.procs["%1"].codex.id;
    assert.notEqual(a, b, "두 칸에 같은 대화가 연결됨");
    await close(active);
    active = await launch();
    await until(() => {
      const procs = readState().procs;
      return procs["%0"]?.codex?.id && procs["%0"].codex.id !== a && procs["%1"]?.codex?.id && procs["%1"].codex.id !== b;
    });
    for (const id of ["%0", "%1"]) await until(() => active.latest[id]?.text.includes("Ask Codex to do anything") && readState().procs[id]?.codex?.id);
    a = readState().procs["%0"].codex.id;
    b = readState().procs["%1"].codex.id;
    assert.notEqual(a, b);
    console.log("미저장 빈 대화는 서로 다른 새 빈 대화로 복원 확인");
    for (const [id, marker] of [["%0", "CHIISPACE_SESSION_A"], ["%1", "CHIISPACE_SESSION_B"]]) {
      await input(active, id, marker);
      await until(() => active.latest[id]?.history.includes("CHIISPACE_LOCAL_REPLY"));
      await until(() => readState().procs[id]?.codex?.resumable === true);
    }
    await delay(1000);
    await close(active);
    saved = readState();
    assert.equal(saved.procs["%0"].codex.id, a);
    assert.equal(saved.procs["%1"].codex.id, b);
    assert.deepEqual(saved.procs["%0"].codex.args, ["--sandbox", "read-only"]);
    assert.deepEqual(saved.procs["%1"].codex.args, ["--sandbox", "read-only", "--profile", "restore-test"]);
    assert.ok(models.includes("profile-model"), "실행별 모델 프로필 미적용");
    console.log("두 칸의 고유 ID 저장과 읽기 전용 실행 옵션 보존 확인");

    active = await launch();
    for (const [id, marker, other, sid] of [["%0", "CHIISPACE_SESSION_A", "CHIISPACE_SESSION_B", a], ["%1", "CHIISPACE_SESSION_B", "CHIISPACE_SESSION_A", b]]) {
      await until(() => active.latest[id]?.history.includes(marker) && active.latest[id]?.text.includes("Ask Codex to do anything"));
      assert.ok(!active.latest[id].history.includes(other), "다른 칸의 대화가 복원됨");
      await until(() => readState().procs[id]?.codex?.id === sid);
    }
    console.log("앱 재시작 후 두 대화의 ID·이전 본문 일치 확인");
    const requestsBefore = modelRequests;
    await input(active, "%1", "CHIISPACE_PROFILE_RESTORED");
    await until(() => modelRequests > requestsBefore && active.latest["%1"]?.text.includes("Ask Codex to do anything"));
    assert.equal(models.at(-1), "profile-model", "복원 뒤 모델 프로필 변경");

    const secondState = path.join(root, "other-window.json");
    writeFileSync(secondState, JSON.stringify(readState()));
    const other = await launch(secondState);
    await until(() => Object.values(readState(secondState).procs).some((seed) => seed.auto === false), 30000);
    assert.equal(readState(secondState).procs["%0"].codex.id, a);
    assert.equal(readState().procs["%0"].codex.id, a);
    await close(other);
    console.log("다른 창이 사용 중인 대화는 ID를 유지하고 자동 실행 중단 확인");

    await input(active, "%0", "/new");
    await until(() => readState().procs["%0"]?.codex?.id && readState().procs["%0"].codex.id !== a);
    const fresh = readState().procs["%0"].codex.id;
    assert.notEqual(fresh, b);
    await input(active, "%0", "CHIISPACE_SESSION_NEW");
    await until(() => active.latest["%0"]?.history.includes("CHIISPACE_SESSION_NEW") && active.latest["%0"]?.text.includes("Ask Codex to do anything"));
    await delay(1000);
    await close(active);
    const tabbed = readState();
    tabbed.tabs = [
      { ...tabbed.tabs[0], layout: { kind: "leaf", id: "%0" }, focus: "%0" },
      { ...tabbed.tabs[0], key: "t1", layout: { kind: "leaf", id: "%1" }, focus: "%1" },
    ];
    tabbed.nextTab = 2;
    writeFileSync(state, JSON.stringify(tabbed));
    active = await launch();
    await until(() => active.latest["%0"]?.history.includes("CHIISPACE_SESSION_NEW"));
    assert.equal(readState().procs["%0"].codex.id, fresh);
    assert.equal(readState().procs["%1"].codex.id, b);
    console.log("/new 이후 새 ID로 갱신·재복원과 옆 칸의 기존 ID 유지 확인");
    await close(active);
    const missingState = path.join(root, "missing-session.json");
    const missing = readState();
    const missingId = randomUUID();
    missing.procs["%0"].codex.id = missingId;
    missing.procs["%0"].codex.resumable = true;
    writeFileSync(missingState, JSON.stringify(missing));
    active = await launch(missingState);
    await until(() => readState(missingState).procs["%0"]?.auto === false);
    assert.equal(readState(missingState).procs["%0"].codex.id, missingId);
    await until(() => active.latest["%1"]?.history.includes("CHIISPACE_SESSION_B"));
    assert.equal(active.app.exitCode, null);
    console.log("없는 대화 ID는 보존·자동 재시도 중단, 옆 칸과 앱 생존 확인");
    assert.ok(modelRequests >= 3);
  } catch (error) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ state: readState(), panes: active?.latest }));
    console.error("복원 검증 실패 기록", path.join(root, "failure.json"));
    throw error;
  } finally {
    for (const client of clients.values()) await close(client).catch(() => client.app.kill());
    for (const app of apps) if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·전역 설정 변경");
    console.log(`Codex 복원 검증 세션: ${root}`);
  }
});

function clientBlank(client, id) { client.commands.push({ id, input: "\r" }); }
