import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const hash = (file) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;

test("켤 때 대화 id 가 확실한 Claude 칸은 터미널 없이 열리고, 두 방향으로 같은 대화를 오간다", { skip: !exe || !claude, timeout: 240000 }, async () => {
  // 터미널 Claude 칸의 복원 정보에 명부의 대화 id 가 있고 그 대화 파일이 있으면 터미널 없는 칸으로 연다.
  // 파일을 못 찾는 칸은 새 대화로 덮지 않고 예전처럼 터미널로 연다. 격리: 별도 앱 세션·CLAUDE_CONFIG_DIR,
  // 가짜 키, 모델 요청은 다시 시도하지 않는 400 으로 끝낸다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-restore-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const store = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(store, { recursive: true });
  const known = randomUUID(), missing = randomUUID(), userId = randomUUID();
  const common = { sessionId: known, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  writeFileSync(path.join(store, known + ".jsonl"), [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "RESTORE_ASK" } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "RESTORE_MARK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 3 } } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const protectedFiles = ["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json"));
  const before = protectedFiles.map(hash);
  // claude 2.1.285 부터 환경의 API 키를 끝 20글자로 승인했는지 보고, 시작할 때 auto 모드를 기본으로 하라는 창을 띄운다.
  // 둘 다 미리 답해 둔다. 안 그러면 확인창·권유 창이 TUI 를 막는다.
  const settings = { hasCompletedOnboarding: true, theme: "light", hasSeenAutoDefaultNudge: true, hasSeenAutoModeEntryWarning: true, projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", root: project, shell, layout: { kind: "split", dir: "h", ratio: 0.5, a: { kind: "leaf", id: "%0" }, b: { kind: "leaf", id: "%1" } } }],
    active: 0, nextPane: 2, nextTab: 1, restoreMode: "native-continue",
    procs: {
      "%0": { cmd: `claude --resume ${known}`, auto: true, cwd: project, claudeSession: known },
      // 다른 폴더에서 열었던 대화라 이 폴더에는 파일이 없다.
      "%1": { cmd: `claude --resume ${missing}`, auto: true, cwd: project, claudeSession: missing },
    },
  }));

  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const server = http.createServer((req, res) => {
    if (req.url === probe) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
      return;
    }
    res.writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "chiispace test: no model" } }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const panes = {};
      for (const id of ['%0', '%1']) {
        const slot = document.querySelector('[data-pane="' + id + '"]');
        const over = slot?.querySelector('.chat-over');
        const b = window.__terms?.[id]?.buffer.active;
        panes[id] = {
          xterm: !!slot?.querySelector('.xterm'),
          stream: !!over?.querySelector('.stream-bar'),
          theirs: [...(over?.querySelectorAll('.msg:not(.mine):not(.live) .bubble') ?? [])].map(e => e.textContent),
          buttons: [...(slot?.querySelectorAll('.pane-head .view') ?? [])].map(e => e.textContent),
          disabled: [...(slot?.querySelectorAll('.pane-head .view') ?? [])].filter(e => e.disabled).map(e => e.textContent),
          screen: b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n') : '',
        };
      }
      const r = await fetch(${JSON.stringify(apiBase + probe)}, {method:'POST',body:JSON.stringify({panes})});
      for (const c of await r.json()) {
        const slot = document.querySelector('[data-pane="' + c.id + '"]');
        [...(slot?.querySelectorAll('.pane-head .view') ?? [])].find(e => e.textContent === c.button)?.click();
      }
    } finally { pending = false; }
  }, 150); return 'isolated restore test'; })()`;

  const pane = (id) => latest.panes?.[id] ?? {};
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) await delay(100); return ok(); };
  const saved = () => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return {}; } };
  // 이 대화를 잡고 있는 claude 프로세스. 같은 대화를 두 프로세스가 함께 쥐면 안 된다.
  const holders = () => {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${known}*' } | ForEach-Object { if ($_.CommandLine -like '*stream-json*') { 'stream' } else { 'tui' } }) -join ','`],
      { encoding: "utf8", windowsHide: true }).stdout.trim();
    // 터미널 claude 는 실행기와 그 자식(실제 claude)이 같은 명령줄로 둘 뜬다. 종류만 센다.
    return [...new Set(out ? out.split(",") : [])].sort();
  };
  const launch = () => spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const close = async (app) => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
  };

  let app = launch();
  try {
    try {
      // 1. 대화 파일이 있는 칸은 터미널 없이, 없는 칸은 예전처럼 터미널로.
      assert.ok(await until(() => pane("%0").stream && pane("%0").theirs.some(t => t.includes("RESTORE_MARK")), 300),
        "대화 id 가 있는 칸이 터미널 없이 안 열림: " + JSON.stringify(latest));
      assert.equal(pane("%0").xterm, false, "터미널 없는 칸에 터미널이 있다");
      assert.deepEqual(pane("%0").buttons, ["터미널로 열기"]);
      assert.ok(await until(() => pane("%1").xterm, 100), "파일 없는 칸이 터미널로 안 열림");
      assert.equal(pane("%1").stream, false, "파일 없는 칸을 새 대화로 덮었다");
      assert.ok(await until(() => saved().streams?.["%0"]?.session === known && !saved().procs?.["%0"] && saved().procs?.["%1"], 50),
        "세션에 옮긴 결과가 안 남음: " + JSON.stringify(saved()));
      assert.ok(await until(() => holders().join() === "stream", 50), "이 대화를 쥔 claude 가 통로 하나가 아님: " + holders());

      // 2. 터미널로 열기: 같은 대화를 터미널 칸으로. 통로 쪽 claude 는 내려간다.
      commands.push({ id: "%0", button: "터미널로 열기" });
      assert.ok(await until(() => pane("%0").xterm && /RESTORE_MARK/.test(pane("%0").screen), 300),
        "터미널로 열었는데 같은 대화가 안 뜸:\n" + pane("%0").screen?.slice(-600));
      assert.equal(pane("%0").stream, false);
      assert.ok(await until(() => holders().join() === "tui", 80), "터미널로 바꿨는데 통로 claude 가 남거나 터미널 claude 가 없음: " + holders());
      assert.ok(await until(() => saved().keepTerminal?.includes("%0") && saved().procs?.["%0"]?.claudeSession === known && !saved().streams?.["%0"], 50),
        "터미널로 둔 칸이 세션에 안 남음: " + JSON.stringify(saved()));
    } finally {
      await close(app);
    }

    // 3. 다시 켜도 터미널로 되돌린 칸은 터미널로 남는다.
    app = launch();
    try {
      assert.ok(await until(() => pane("%0").xterm && /RESTORE_MARK/.test(pane("%0").screen), 300),
        "되돌린 칸이 다시 켜자 터미널로 안 열림: " + JSON.stringify(latest.panes?.["%0"]?.buttons));
      assert.equal(pane("%0").stream, false, "되돌린 칸을 다시 터미널 없이 열었다");

      // 4. 터미널 없이: 명부로 대화가 붙은 칸을 같은 대화의 터미널 없는 칸으로. 터미널 쪽 claude 는 내려간다.
      assert.ok(await until(() => pane("%0").buttons?.includes("터미널 없이") && !pane("%0").disabled?.includes("터미널 없이"), 200),
        "터미널 없이 단추가 안 뜸: " + JSON.stringify(pane("%0").buttons));
      // 막 이어 연 claude 가 화면을 다시 그리는 동안은 "일하는 중"으로 잡혀 단추가 잠깐씩 잠긴다. 바뀔 때까지 다시 누른다.
      for (let i = 0; i < 15 && !pane("%0").stream; i++) {
        commands.push({ id: "%0", button: "터미널 없이" });
        await until(() => pane("%0").stream, 20);
      }
      assert.ok(await until(() => pane("%0").stream && !pane("%0").xterm && pane("%0").theirs.some(t => t.includes("RESTORE_MARK")), 300),
        "터미널 없이로 안 바뀜: " + JSON.stringify({ pane: pane("%0").buttons, proc: saved().procs?.["%0"], known,
          roster: existsSync(path.join(home, "sessions")) ? readdirSync(path.join(home, "sessions")).filter(f => f.endsWith(".json")).map(f => readFileSync(path.join(home, "sessions", f), "utf8").slice(0, 200)) : [],
          files: readdirSync(store) }));
      assert.ok(await until(() => holders().join() === "stream", 80), "터미널 없이로 바꿨는데 터미널 claude 가 남음: " + holders());
      assert.ok(await until(() => !saved().keepTerminal?.includes("%0") && saved().streams?.["%0"]?.session === known, 50),
        "되돌린 표시가 안 걷힘: " + JSON.stringify(saved()));
    } finally {
      await close(app);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션 파일이 바뀜");
});
