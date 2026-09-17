import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

test("실제 Codex의 네이티브 continue·작업 폴더별 복원·권한 유지", { skip: !exe || !codex, timeout: 240000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-resume-"));
  const home = path.join(root, "한글 & state");
  mkdirSync(home);
  const projects = [path.join(root, "project-a"), path.join(root, "project-b")];
  projects.forEach(p => mkdirSync(p));
  const protectedFiles = [
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json")),
    path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".claude.json"),
  ];
  const before = protectedFiles.map(hash);
  const clients = new Map();
  let modelRequests = 0;
  const models = [];
  const inputs = [];
  const server = http.createServer((req, res) => {
    const client = clients.get(req.url);
    if (!client && req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (client) {
        const state = JSON.parse(body);
        client.latest = state.panes;
        client.seeds = state.seeds;
        res.end(JSON.stringify(client.commands.splice(0)));
        return;
      }
      // 외부 모델·인증 없이 실제 Codex의 대화 저장 경로까지 검증한다.
      modelRequests++;
      const request = JSON.parse(body);
      models.push(request.model);
      inputs.push(JSON.stringify(request.input));
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
[projects.${JSON.stringify(projects[0])}]
trust_level = "trusted"
[projects.${JSON.stringify(projects[1])}]
trust_level = "trusted"
`);
  writeFileSync(path.join(home, "restore-test.config.toml"), 'model = "profile-model"\nsandbox_mode = "workspace-write"\n');
  const shell = process.env.CHIISPACE_TEST_SHELL || path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const initial = { tabs: projects.map((project, i) => ({ key: `t${i}`, focus: `%${i}`,
    layout: { kind: "leaf", id: `%${i}` }, root: i === 1 ? root : project, shell })),
    active: 0, nextPane: 2, nextTab: 2, procs: {} };
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify(initial));
  const apps = [];
  const readState = (file = state) => JSON.parse(readFileSync(file, "utf8"));
  function turnContexts(id) {
    const sessions = path.join(home, "sessions");
    const file = readdirSync(sessions, { recursive: true }).find((name) => name.endsWith(`${id}.jsonl`));
    return file ? readFileSync(path.join(sessions, file), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).filter((record) => record.type === "turn_context").map((record) => record.payload) : [];
  }
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
          const response = await fetch(${JSON.stringify(base + key)}, { method: "POST", body: JSON.stringify({panes, seeds: window.__restore?.seeds}) });
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
  const sessionFor = (marker) => {
    const directory = path.join(home, "sessions");
    for (const name of readdirSync(directory, { recursive: true }).filter(n => n.endsWith(".jsonl"))) {
      const text = readFileSync(path.join(directory, name), "utf8");
      if (!text.includes(marker)) continue;
      return JSON.parse(text.split("\n")[0]).payload.id;
    }
  };
  let active;
  try {
    active = await launch();
    for (const [id, marker] of [["%0", "CHIISPACE_SESSION_A"], ["%1", "CHIISPACE_SESSION_B"]]) {
      clientBlank(active, id);
      await delay(500);
      await input(active, id, `codex --sandbox read-only --ask-for-approval never${id === "%1" ? " --profile restore-test -C project-b" : ""}`);
      await until(() => active.latest[id]?.text.includes("Ask Codex to do anything"));
      await input(active, id, marker);
      await until(() => active.latest[id]?.history.includes("CHIISPACE_LOCAL_REPLY"));
      await until(() => readState().procs[id]?.codexLaunch);
    }
    const a = sessionFor("CHIISPACE_SESSION_A");
    const b = sessionFor("CHIISPACE_SESSION_B");
    assert.ok(a && b && a !== b);
    await close(active);
    const saved = readState();
    assert.equal(saved.restoreMode, "native-continue");
    assert.ok(!JSON.stringify(saved).includes(a) && !JSON.stringify(saved).includes(b), "앱 상태에 대화 ID 저장");
    assert.deepEqual(saved.procs["%1"].codexLaunch.args, ["--sandbox", "read-only", "--ask-for-approval", "never", "--profile", "restore-test"]);
    assert.equal(saved.procs["%1"].codexLaunch.cwd, projects[1]);
    saved.procs["%1"].codexLaunch.args[3] = "on-request";
    writeFileSync(state, JSON.stringify(saved));
    active = await launch();
    for (const [id, marker, other] of [["%0", "CHIISPACE_SESSION_A", "CHIISPACE_SESSION_B"], ["%1", "CHIISPACE_SESSION_B", "CHIISPACE_SESSION_A"]]) {
      await until(() => active.latest[id]?.history.includes(marker) && active.latest[id]?.text.includes("Ask Codex to do anything"));
      assert.ok(!active.latest[id].history.includes(other), "다른 폴더의 최근 대화로 복원됨");
    }
    const requestsBefore = modelRequests;
    await input(active, "%1", "CHIISPACE_NATIVE_CONTINUED");
    await until(() => modelRequests > requestsBefore && active.latest["%1"]?.text.includes("Ask Codex to do anything"));
    await until(() => turnContexts(b).length >= 2);
    assert.equal(models.at(-1), "profile-model");
    assert.equal(turnContexts(b).at(-1).sandbox_policy.type, "read-only");
    assert.equal(turnContexts(b).at(-1).approval_policy, "on-request");
    assert.ok(inputs.at(-1).includes("CHIISPACE_SESSION_B"));
    assert.ok(!inputs.at(-1).includes("CHIISPACE_SESSION_A"));
    console.log("네이티브 resume --last의 폴더별 이전 대화·실제 권한·프로필 유지 확인");

    await input(active, "%0", "/new");
    await until(() => active.latest["%0"]?.text.includes("Ask Codex to do anything"));
    await input(active, "%0", "CHIISPACE_SESSION_NEW");
    await until(() => active.latest["%0"]?.text.includes("Ask Codex to do anything") && sessionFor("CHIISPACE_SESSION_NEW"));
    const fresh = sessionFor("CHIISPACE_SESSION_NEW");
    assert.notEqual(fresh, a);
    await close(active);
    active = await launch();
    await until(() => active.latest["%0"]?.history.includes("CHIISPACE_SESSION_NEW"));
    assert.ok(!active.latest["%0"].history.includes("CHIISPACE_SESSION_A"));
    await until(() => active.latest["%1"]?.history.includes("CHIISPACE_SESSION_B"));
    await close(active);
    console.log("/new 이후 최신 대화 이어가기와 숨긴 탭 복원 확인");

    const duplicate = readState();
    duplicate.tabs[1].root = duplicate.tabs[0].root;
    duplicate.procs["%1"].codexLaunch.cwd = duplicate.procs["%0"].codexLaunch.cwd;
    duplicate.procs["%1"].cwd = duplicate.procs["%0"].cwd;
    const duplicateState = path.join(root, "duplicate.json");
    writeFileSync(duplicateState, JSON.stringify(duplicate));
    active = await launch(duplicateState);
    await until(() => active.seeds?.["%1"]?.cmd.endsWith("--picker"));
    await until(() => active.latest["%0"]?.history.includes("CHIISPACE_SESSION_NEW"));
    await until(() => /resume|session|conversation/i.test(active.latest["%1"]?.text ?? ""));
    assert.ok(!active.latest["%1"].text.includes("Ask Codex to do anything"), "중복 칸이 선택 없이 대화에 연결됨");
    await close(active);
    console.log("같은 폴더의 중복 칸은 자동 중복 연결 대신 선택 목록 확인");

    const invalid = readState();
    invalid.procs["%1"].codexLaunch.args = ["--profile", "broken"];
    writeFileSync(path.join(home, "broken.config.toml"), 'sandbox_mode = [\n');
    const invalidState = path.join(root, "invalid.json");
    writeFileSync(invalidState, JSON.stringify(invalid));
    active = await launch(invalidState);
    await until(() => readState(invalidState).procs["%1"]?.auto === false);
    assert.deepEqual(readState(invalidState).procs["%1"].codexLaunch.args, ["--profile", "broken"]);
    assert.equal(active.app.exitCode, null);
    console.log("설정 오류는 자동 재시도 중단, 옆 칸·앱 생존 확인");
  } catch (error) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ state: readState(), panes: active?.latest }));
    console.error("복원 검증 실패 기록", path.join(root, "failure.json"));
    throw error;
  } finally {
    for (const client of clients.values()) await close(client).catch(() => client.app.kill());
    for (const app of apps) if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log(`Codex 복원 검증 세션: ${root}`);
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·전역 설정 변경");
  }
});

function clientBlank(client, id) { client.commands.push({ id, input: "\r" }); }
