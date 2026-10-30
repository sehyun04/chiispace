import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { watchUserFiles } from "./user-files.mjs";

const exe = process.env.CHIISPACE_TEST_EXE;
const codex = process.env.CHIISPACE_TEST_REAL_CODEX;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("Codex 대화창은 같은 대화의 터미널로 옮기고 빈 대화는 새로 연다", { skip: !exe || !codex, timeout: 180000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-switch-"));
  const home = path.join(root, "codex-state"), project = path.join(root, "project"), empty = path.join(root, "empty");
  const state = path.join(root, "session.json"), probe = "/" + randomUUID();
  mkdirSync(home); mkdirSync(project); mkdirSync(empty);
  const guard = watchUserFiles([path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".codex", "hooks.json"),
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map(s => path.join(process.env.APPDATA, s, "session.json"))], { root, exe });
  let latest = {};
  const commands = [], apps = [], requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      if (req.url === probe) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        latest = JSON.parse(body);
        res.end(JSON.stringify(commands.splice(0))); return;
      }
      if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      const data = JSON.parse(body); requests.push(data);
      const marker = "SWITCH_REPLY", n = requests.length;
      const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: marker, annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      emit("response.created", { response: { id: `resp_${n}`, status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: marker });
      await delay(1000);
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: marker });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id: `resp_${n}`, status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(home, "config.toml"), `model = "switch-test"\nmodel_provider = "local_test"\ncheck_for_update_on_startup = false\n[model_providers.local_test]\nname = "Local switch fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(empty)}]\ntrust_level = "trusted"\n`);
  const layout = { kind: "leaf", id: "%0" };
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root: project,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout }],
  active: 0, nextPane: 1, nextTab: 1, procs: {}, restoreMode: "native-continue",
  streams: { "%0": { agent: "codex", session: "", cwd: project } } }));
  const saved = () => JSON.parse(readFileSync(state, "utf8"));
  const pane = id => latest[id] ?? {};
  const until = async (fn, message, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (fn()) return; await delay(100); }
    throw new Error(message + ": " + JSON.stringify(latest));
  };
  const launch = async (expectStreams = true) => {
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
        const panes = {};
        for (const slot of document.querySelectorAll('[data-pane]')) {
          const over = slot.querySelector('.chat-over'), id = slot.dataset.pane, b = window.__terms?.[id]?.buffer.active;
          panes[id] = { stream: !!over?.querySelector('.stream-bar'), xterm: !!slot.querySelector('.xterm'),
            error: [...(over?.querySelectorAll('[role="alert"]') ?? [])].map(e => e.textContent),
            disabled: over?.querySelector('.composer textarea')?.disabled,
            theirs: [...(over?.querySelectorAll('.msg:not(.mine) .bubble') ?? [])].map(e => e.textContent),
            buttons: [...slot.querySelectorAll('.pane-head .mode button')].map(e => ({ text: e.textContent, disabled: e.disabled, pressed: e.getAttribute('aria-pressed') })),
            screen: b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n') : '' };
        }
        const r = await fetch(${JSON.stringify(base + probe)}, {method:'POST',body:JSON.stringify(panes)});
        for (const c of await r.json()) {
          const slot = document.querySelector('[data-pane="' + c.id + '"]');
          if (c.button) [...(slot?.querySelectorAll('.pane-head .mode button') ?? [])].find(e => e.textContent === c.button)?.click();
          if (c.send) {
            const input = slot?.querySelector('.composer textarea'); if (!input) continue;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
            input.dispatchEvent(new Event('input', {bubbles:true})); await new Promise(r => setTimeout(r, 50));
            input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
          }
        }
      } finally { pending = false; }
    }, 100); return 'isolated Codex switch'; })()`;
    const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" }); apps.push(app);
    await until(() => expectStreams ? pane("%0").stream : pane("%0").xterm,
      "Codex 칸 시작");
    return app;
  };
  const close = async app => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    await until(() => app.exitCode !== null, "테스트 앱 종료", 8000);
  };
  try {
    let app = await launch();
    try {
      await until(() => saved().streams?.["%0"]?.session && pane("%0").disabled === false, "서버 대화 ID 저장");
      assert.deepEqual(pane("%0").buttons.map(b => b.text), ["터미널", "대화창"]);
      commands.push({ id: "%0", send: "SWITCH_MARK" });
      await until(() => pane("%0").buttons.some(b => b.text === "터미널" && b.disabled), "작업 중 전환 잠금");
      commands.push({ id: "%0", button: "터미널" });
      await until(() => pane("%0").theirs?.includes("SWITCH_REPLY"), "대화창 첫 답");
      await until(() => pane("%0").buttons.some(b => b.text === "터미널" && !b.disabled), "완료 뒤 전환 해제");
      assert.equal(pane("%0").stream, true, "하던 답을 끊고 터미널로 옮김");
      const session = saved().streams["%0"].session;
      assert.match(session, /^[0-9a-f]{8}-/i);
      commands.push({ id: "%0", button: "터미널" });
      await until(() => pane("%0").xterm && pane("%0").screen?.includes("SWITCH_REPLY"), "같은 대화의 TUI 복원", 40000);
      assert.equal(pane("%0").stream, false);
      assert.equal(pane("%0").buttons.find(b => b.text === "대화창")?.disabled, true, "현재 ID 근거 없이 대화창으로 돌아감");
      await until(() => saved().procs?.["%0"]?.codexLaunch && saved().keepTerminal?.includes("%0"), "터미널 복원 정보 저장");
      assert.ok(saved().procs["%0"].codexLaunch, "터미널 Codex의 네이티브 복원 정보 누락");
    } finally { await close(app); }
    app = await launch(false);
    try {
      await until(() => pane("%0").screen?.includes("SWITCH_REPLY"), "다시 켠 터미널의 대화");
      assert.equal(pane("%0").stream, false, "터미널로 되돌린 칸을 자동 대화창으로 열었음");
    } finally { await close(app); }
    // 새 CODEX_HOME을 두 프로세스가 동시에 초기화하면 SQLite 초기화가 경합하므로 한 칸씩 검증한다.
    const blank = saved();
    blank.procs = {}; blank.keepTerminal = []; blank.streams = { "%0": { agent: "codex", session: "", cwd: empty } };
    writeFileSync(state, JSON.stringify(blank));
    app = await launch();
    try {
      await until(() => saved().streams?.["%0"]?.session && pane("%0").disabled === false, "미전송 대화 연결");
      commands.push({ id: "%0", button: "터미널" });
      await until(() => pane("%0").xterm && pane("%0").screen?.includes("Ask Codex to do anything"), "빈 대화의 새 터미널");
      assert.ok(!/codex resume|no rollout found/i.test(pane("%0").screen), "미전송 대화를 복원하려 함");
      await until(() => saved().procs?.["%0"]?.codexLaunch, "빈 터미널의 복원 정보");
      assert.equal(saved().procs["%0"].cwd.replaceAll("\\", "/").toLowerCase(), empty.replaceAll("\\", "/").toLowerCase());
    } finally { await close(app); }
  } finally {
    for (const app of apps) if (app.exitCode === null) await close(app).catch(() => app.kill());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    guard("사용자 세션·설정 변경");
    console.log("Codex 전환 검증:", root);
  }
});
