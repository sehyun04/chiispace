import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { watchUserFiles } from "./user-files.mjs";

const exe = process.env.CHIISPACE_TEST_EXE;
const codex = process.env.CHIISPACE_TEST_REAL_CODEX;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("PTY Codex는 훅·덮개 없이 두 칸 대화와 네이티브 복원", { skip: !exe || !codex, timeout: 180000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-chat-"));
  const home = path.join(root, "codex-state");
  const project = path.join(root, "project");
  mkdirSync(home); mkdirSync(project);
  const protectedFiles = [path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".codex", "hooks.json"),
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map(id => path.join(process.env.APPDATA, id, "session.json"))];
  const guard = watchUserFiles(protectedFiles, { root, exe });
  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      if (req.url === probe) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        latest = JSON.parse(body);
        res.end(JSON.stringify(commands.splice(0)));
        return;
      }
      if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      const data = JSON.parse(body);
      requests.push(data);
      const marker = JSON.stringify(data.input).includes("NEW_CHAT_MARK") ? "NEW_CHAT_REPLY"
        : JSON.stringify(data.input).includes("SECOND_PANE_MARK") ? "SECOND_PANE_REPLY" : "FIRST_PANE_REPLY";
      const id = `resp_${requests.length}`;
      const item = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: marker, annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      emit("response.created", { response: { id, status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: marker });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: marker });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(home, "config.toml"), `model = "chat-test"\nmodel_provider = "local_test"\ncheck_for_update_on_startup = false\n[model_providers.local_test]\nname = "Local chat fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root: project,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"),
    layout: { kind: "split", dir: "h", ratio: 0.5, a: { kind: "leaf", id: "%0" }, b: { kind: "leaf", id: "%1" } } }],
    active: 0, nextPane: 2, nextTab: 1, procs: {} }));
  const apps = [];
  const until = async (fn, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (fn()) return; await delay(100); }
    throw new Error("PTY Codex 대기 시간 초과");
  };
  const pane = id => latest[id] ?? {};
  const sessionFor = marker => {
    const dir = path.join(home, "sessions");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { recursive: true }).filter(n => n.endsWith(".jsonl"))) {
      const text = readFileSync(path.join(home, "sessions", name), "utf8");
      if (text.includes(marker)) return JSON.parse(text.split("\n")[0]).payload.id;
    }
  };
  async function launch(count = 2) {
    latest = {};
    const env = { ...process.env, CODEX_HOME: home, CHIISPACE_STATE: state };
    for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT"
      || /API_KEY|AUTH_TOKEN|CODEX_TUI_RECORD|CODEX_TUI_SESSION_LOG/.test(key)) delete env[key];
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
    if (process.env.CHIISPACE_TEST_CODEX_PATH !== "inherited") env[pathKey] = `${path.dirname(codex)};${env[pathKey]}`;
    env.CHIISPACE_PROBE_MS = "500";
    env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const stat = await window.__TAURI_INTERNALS__.invoke('pane_status');
        const all = Object.fromEntries(Object.entries(window.__terms ?? {}).map(([id, t]) => {
          const slot = document.querySelector('[data-pane="' + id + '"]');
          const b = t.buffer.active;
          return [id, { stat: stat.find(p => p.id === id), history: Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n'),
            overlay: !!slot?.querySelector('.chat-over'), toggle: !!slot?.querySelector('.pane-head .view.toggle') }];
        }));
        const response = await fetch(${JSON.stringify(base + probe)}, {method:'POST', body:JSON.stringify(all)});
        for (const command of await response.json()) window.__terms[command.id]?.input(command.term);
      } finally { pending = false; }
    }, 100); return 'isolated PTY Codex'; })()`;
    const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
    apps.push(app);
    await until(() => Object.keys(latest).length === count);
    return app;
  }
  const input = async (id, text) => { commands.push({ id, term: text }); await delay(850); commands.push({ id, term: "\r" }); };
  const close = async app => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    await until(() => app.exitCode !== null, 8000);
  };
  const screenshot = app => {
    const output = path.join(root, "codex-terminal.png");
    const shot = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid),
      "-WaitSec", "1", "-Out", output], { windowsHide: true, encoding: "utf8" });
    console.log("PTY Codex 화면:", shot.status === 0 ? output : shot.stderr);
  };
  try {
    await launch();
    await input("%0", "codex --sandbox read-only --ask-for-approval never");
    await until(() => pane("%0").history?.includes("Ask Codex to do anything"));
    assert.ok(!pane("%0").history.includes("Hooks need review"), "PTY Codex에 훅 신뢰 화면이 나타남");
    assert.ok(!pane("%0").overlay && !pane("%0").toggle, "PTY Codex 위에 대화창 덮개가 나타남");
    await input("%0", "FIRST_PANE_MARK");
    await until(() => pane("%0").history?.includes("FIRST_PANE_REPLY"));
    await until(() => sessionFor("FIRST_PANE_MARK"));
    const firstSession = sessionFor("FIRST_PANE_MARK");
    await input("%1", "codex --sandbox read-only --ask-for-approval never");
    await until(() => pane("%1").history?.includes("Ask Codex to do anything"));
    await input("%1", "SECOND_PANE_MARK");
    await until(() => pane("%1").history?.includes("SECOND_PANE_REPLY"));
    assert.ok(!pane("%1").history.includes("FIRST_PANE_MARK"), "다른 칸의 대화가 섞임");
    assert.ok(!pane("%1").overlay && !pane("%1").toggle, "둘째 PTY Codex 위에 대화창 덮개가 나타남");
    if (process.env.CHIISPACE_TEST_SCREENSHOT === "1") screenshot(apps.at(-1));
    await input("%0", "/new");
    await until(() => pane("%0").history?.includes("Ask Codex to do anything"));
    await input("%0", "NEW_CHAT_MARK");
    await until(() => pane("%0").history?.includes("NEW_CHAT_REPLY"));
    await until(() => sessionFor("NEW_CHAT_MARK"));
    assert.notEqual(sessionFor("NEW_CHAT_MARK"), firstSession, "/new가 기존 대화를 계속 사용함");
    await until(() => JSON.parse(readFileSync(state, "utf8")).procs?.["%0"]?.codexLaunch);
    const saved = JSON.parse(readFileSync(state, "utf8"));
    assert.ok(saved.procs["%0"].codexLaunch && !saved.procs["%0"].codex, "네이티브 이어가기 정보가 바뀜");
    await close(apps.at(-1));
    // 같은 폴더의 동시 --last 선택은 Codex의 몫이라 재시작은 한 칸으로 본다.
    const restart = JSON.parse(readFileSync(state, "utf8"));
    restart.tabs[0].layout = { kind: "leaf", id: "%0" };
    restart.tabs[0].focus = "%0";
    delete restart.procs["%1"];
    writeFileSync(state, JSON.stringify(restart));
    await launch(1);
    await until(() => pane("%0").history?.includes("NEW_CHAT_REPLY") && pane("%0").history?.includes("Ask Codex to do anything"));
    assert.ok(!pane("%0").overlay && !pane("%0").toggle, "복원된 PTY Codex에 대화창 덮개가 나타남");
    await input("%0", "CONTINUED_MARK");
    await until(() => requests.some(r => JSON.stringify(r.input).includes("CONTINUED_MARK")));
    await until(() => pane("%0").stat?.agent === "codex");
    await input("%0", "/quit");
    await until(() => pane("%0").stat?.agent !== "codex");
    assert.equal(apps.at(-1).exitCode, null, "Codex 종료가 앱 종료로 전파됨");
    console.log("훅·덮개 없음, 두 칸 대화 격리, /new, 네이티브 복원 확인");
  } catch (error) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ latest, requests }));
    if (process.env.CHIISPACE_TEST_SCREENSHOT === "1" && apps.at(-1)?.exitCode === null) screenshot(apps.at(-1));
    throw error;
  } finally {
    for (const app of apps) await close(app).catch(() => app.kill());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    guard("사용자 세션·설정 변경");
    console.log("PTY Codex 검증:", root);
  }
});
