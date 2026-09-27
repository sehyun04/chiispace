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
const delay = ms => new Promise(r => setTimeout(r, ms));
const hash = file => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };

test("Codex 훅 신뢰·칸별 대화창·입력·새 대화·네이티브 이어가기", { skip: !exe || !codex, timeout: 180000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-chat-"));
  const home = path.join(root, "codex-state");
  const project = path.join(root, "project");
  mkdirSync(home); mkdirSync(project);
  const protectedFiles = [path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".codex", "hooks.json"),
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map(s => path.join(process.env.APPDATA, s, "session.json"))];
  const before = protectedFiles.map(hash);
  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const requests = [];
  const observations = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      if (req.url === probe) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        latest = JSON.parse(body); observations.push(latest);
        res.end(JSON.stringify(commands.splice(0))); return;
      }
      if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      const data = JSON.parse(body); requests.push(data);
      const id = `resp_${requests.length}`;
      const content = JSON.stringify(data.input);
      const marker = content.includes("NEW_CHAT_MARK") ? "NEW_CHAT_REPLY" : content.includes("SECOND_PANE_MARK") ? "SECOND_PANE_REPLY" : "FIRST_PANE_REPLY";
      const item = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: marker, annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      emit("response.created", { response: { id, status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      await delay(1200);
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: marker });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: marker });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(home, "config.toml"), `model = "chat-test"\nmodel_provider = "local_test"\ncheck_for_update_on_startup = false\n[model_providers.local_test]\nname = "Local chat fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root: project,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "split", dir: "h", ratio: 0.5, a: { kind: "leaf", id: "%0" }, b: { kind: "leaf", id: "%1" } } }],
    active: 0, nextPane: 2, nextTab: 1, procs: {} }));
  const apps = [];
  const until = async (fn, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (fn()) return; await delay(100); }
    throw new Error("Codex 대화창 대기 시간 초과");
  };
  const pane = id => latest[id] ?? {};
  async function launch(count = 2) {
    latest = {};
    const env = { ...process.env, CODEX_HOME: home, CHIISPACE_STATE: state };
    for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CODEX_TUI_RECORD|CODEX_TUI_SESSION_LOG/.test(key)) delete env[key];
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
    if (process.env.CHIISPACE_TEST_CODEX_PATH !== "inherited") env[pathKey] = `${path.dirname(codex)};${env[pathKey]}`;
    env.CHIISPACE_PROBE_MS = "500";
    env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const stat = await window.__TAURI_INTERNALS__.invoke('pane_status');
        const all = Object.fromEntries(Object.entries(window.__terms ?? {}).map(([id, t]) => {
          const slot = document.querySelector('[data-pane="' + id + '"]');
          const over = slot?.querySelector('.chat-over'), input = over?.querySelector('.composer textarea');
          const b = t.buffer.active;
          return [id, { stat: stat.find(p => p.id === id), screen: Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n'),
            shown: !!over && getComputedStyle(over).visibility !== 'hidden', input: !!input, focused: document.activeElement === input,
            mine: [...(over?.querySelectorAll('.msg.mine:not(.sending) .bubble') ?? [])].map(e => e.textContent),
            theirs: [...(over?.querySelectorAll('.msg:not(.mine):not(.live) .bubble') ?? [])].map(e => e.textContent),
            status: over?.querySelector('[role="status"]')?.textContent,
            value: input?.value, toggle: slot?.querySelector('.pane-head .view')?.textContent,
            guard: window.__chatGuard?.[id] }];
        }));
        const r = await fetch(${JSON.stringify(base + probe)}, {method:'POST', body:JSON.stringify(all)});
        for (const c of await r.json()) {
          const slot = document.querySelector('[data-pane="' + c.id + '"]');
          if (c.term !== undefined) window.__terms[c.id]?.input(c.term);
          if (c.toggle) slot?.querySelector('.pane-head .view')?.click();
          if (c.guard) {
            window.__chatGuard ??= {};
            try {
              await window.__TAURI_INTERNALS__.invoke('pty_submit', {id:c.id, text:'STALE_SUBMIT_MARK', agent:'codex', run:c.guard});
              window.__chatGuard[c.id] = 'unexpected success';
            } catch (e) { window.__chatGuard[c.id] = String(e); }
          }
          if (c.send) {
            const input = slot?.querySelector('.composer textarea');
            if (!input) continue;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
            input.dispatchEvent(new Event('input', {bubbles:true}));
            await new Promise(r => setTimeout(r, 50));
            input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
          }
        }
      } finally { pending = false; }
    }, 100); return 'isolated codex chat'; })()`;
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
  try {
    await launch();
    await input("%0", "codex --sandbox read-only --ask-for-approval never");
    await until(() => pane("%0").screen?.includes("Ask Codex to do anything"));
    assert.ok(!pane("%0").shown, "신뢰하지 않은 훅으로 대화창 연결");
    await input("%0", "/hooks");
    await until(() => pane("%0").screen?.includes("Press t to trust all"));
    commands.push({ id: "%0", term: "t" });
    await delay(500);
    assert.ok(!pane("%0").screen.includes("need review"), "격리 훅 신뢰 실패");
    commands.push({ id: "%0", term: "\x1b" });
    await until(() => !pane("%0").screen?.includes("Press enter to view hooks"));
    commands.push({ id: "%0", term: "\x15" });
    await delay(600);
    await input("%0", "FIRST_PANE_MARK");
    await until(() => pane("%0").shown && pane("%0").theirs?.includes("FIRST_PANE_REPLY"));
    assert.deepEqual(pane("%0").mine, ["FIRST_PANE_MARK"]);
    assert.deepEqual(pane("%0").theirs, ["FIRST_PANE_REPLY"]);
    assert.ok(observations.some(o => o["%0"]?.status), "진행 상태 표시 누락");
    await input("%1", "codex --sandbox read-only --ask-for-approval never");
    await until(() => pane("%1").screen?.includes("Ask Codex to do anything"));
    await input("%1", "SECOND_PANE_MARK");
    await until(() => pane("%1").shown);
    assert.ok(!pane("%1").mine.includes("FIRST_PANE_MARK"), "같은 폴더의 다른 칸 내용 혼입");
    await until(() => pane("%1").theirs?.includes("SECOND_PANE_REPLY"));
    commands.push({ id: "%1", send: "SECOND_PANE_MARK\n한글 입력" });
    await until(() => pane("%1").theirs?.length === 2);
    assert.deepEqual(pane("%1").mine, ["SECOND_PANE_MARK", "SECOND_PANE_MARK\n한글 입력"]);
    assert.deepEqual(pane("%0").mine, ["FIRST_PANE_MARK"]);
    commands.push({ id: "%0", guard: "not-the-current-run" });
    await until(() => pane("%0").guard);
    assert.match(pane("%0").guard, /Codex 실행이 바뀌어/);
    if (process.env.CHIISPACE_TEST_SCREENSHOT === "1") {
      const shot = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(apps.at(-1).pid),
        "-WaitSec", "1", "-Out", path.join(root, "codex-chat.png")], { windowsHide: true, encoding: "utf8" });
      assert.equal(shot.status, 0, shot.stderr);
    }
    commands.push({ id: "%0", send: "/new" });
    await until(() => !pane("%0").shown);
    await input("%0", "NEW_CHAT_MARK");
    await until(() => pane("%0").theirs?.includes("NEW_CHAT_REPLY"));
    assert.deepEqual(pane("%0").mine, ["NEW_CHAT_MARK"]);
    commands.push({ id: "%0", send: "/model" });
    await until(() => !pane("%0").shown && pane("%0").toggle === "대화로");
    commands.push({ id: "%0", term: "\x1b" });
    await delay(500);
    commands.push({ id: "%0", toggle: true });
    await until(() => pane("%0").shown && pane("%0").focused);
    const saved = JSON.parse(readFileSync(state, "utf8"));
    assert.ok(saved.procs["%0"].codexLaunch && !saved.procs["%0"].codex, "기존 네이티브 이어가기 정책 변경");
    await close(apps.at(-1));
    // 같은 폴더의 동시 --last 잠금은 Codex가 판단한다. 복원 표시는 한 칸으로 따로 검증한다.
    const restart = JSON.parse(readFileSync(state, "utf8"));
    restart.tabs[0].layout = { kind: "leaf", id: "%0" };
    restart.tabs[0].focus = "%0";
    delete restart.procs["%1"];
    writeFileSync(state, JSON.stringify(restart));
    await launch(1);
    await until(() => pane("%0").screen?.includes("NEW_CHAT_REPLY") && pane("%0").screen?.includes("Ask Codex to do anything"));
    await input("%0", "CONTINUED_MARK");
    await until(() => pane("%0").shown && pane("%0").mine?.includes("NEW_CHAT_MARK"));
    await until(() => pane("%0").theirs?.length === 2);
    assert.deepEqual(pane("%0").mine, ["NEW_CHAT_MARK", "CONTINUED_MARK"]);
    const oldRun = pane("%0").stat.codex.run;
    commands.push({ id: "%0", send: "/quit" });
    await until(() => !pane("%0").input);
    commands.push({ id: "%0", guard: oldRun });
    await until(() => pane("%0").guard);
    assert.match(pane("%0").guard, /에이전트가 종료되어/);
    assert.ok(!pane("%0").screen.includes("STALE_SUBMIT_MARK"), "종료 뒤 입력이 셸에 전달됨");
    assert.equal(apps.at(-1).exitCode, null, "Codex 종료가 앱 종료로 전파됨");
    console.log("신뢰 전 터미널·신뢰 후 두 칸 격리·한글 제출·/new·메뉴 전환·재시작·CLI 종료 확인");
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ latest, requests, observations }));
    throw e;
  } finally {
    for (const app of apps) await close(app).catch(() => app.kill());
    server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·설정 변경");
    console.log("Codex 대화창 검증:", root);
  }
});
