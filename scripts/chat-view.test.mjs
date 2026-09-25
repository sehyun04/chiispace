import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

test("claude 칸이 대화창으로 덮이고 입력바의 말이 claude 에 제출된다", { skip: !exe || !claude, timeout: 150000 }, async () => {
  // 대화창은 화면을 뜯지 않고 원문(jsonl)을 그린다. 그 원문이 정말 그 칸의 대화인지는
  // 명부(`<config>/sessions/<pid>.json`)가 정한다. 여기서는 그 한 바퀴를 실제 claude 로 본다 —
  // 명부 → 대화창 → 입력바 → claude 가 제출해 원문에 적음 → 대화창에 내 말풍선.
  // 격리: 별도 CLAUDE_CONFIG_DIR·앱 세션, 가짜 키와 루프백 서버. 모델은 부르지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-chat-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const store = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(store, { recursive: true });
  const sid = randomUUID(), userId = randomUUID(), toolId = "toolu_" + randomUUID().replaceAll("-", "");
  const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  const asst = (content) => ({ ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model: "claude-sonnet-4-6", content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 7 } } });
  writeFileSync(path.join(store, sid + ".jsonl"), [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "ASK_CHAT_VIEW" } },
    asst([{ type: "tool_use", id: toolId, name: "Bash", input: { command: "echo CHAT_TOOL" } }]),
    { ...common, type: "user", uuid: randomUUID(), parentUuid: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "CHAT_TOOL" }] }, toolUseResult: { stdout: "CHAT_TOOL" } },
    asst([{ type: "text", text: "CHAT_VIEW_MARK" }]),
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key"], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", root: project, shell, layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, restoreMode: "native-continue",
    procs: { "%0": { cmd: "claude --continue", auto: true, cwd: project } },
  }));

  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const server = http.createServer((req, res) => {
    // 모델 요청은 받지 않는다. 입력이 제출됐는지는 원문에 적힌 것으로 본다.
    if (req.url !== probe) { res.writeHead(503).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  // 대화창에 쓰는 것은 사람이 하듯 입력바의 값을 바꾸고 Enter 를 누른다. React 는 value 를
  // 직접 넣으면 모르므로 원래의 setter 로 넣고 input 이벤트를 보낸다.
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const slot = document.querySelector('[data-pane="%0"]');
      const over = slot?.querySelector('.chat-over');
      const b = window.__terms?.['%0']?.buffer.active;
      const pane = b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '') : null;
      const input = over?.querySelector('.composer textarea');
      const dom = {
        over: !!over,
        // 파일에서 온 말풍선만 센다. 보내는 중(.sending)·쓰이는 중(.live)은 claude 가 받았다는 증거가 아니다.
        mine: [...(over?.querySelectorAll('.msg.mine:not(.sending) .bubble') ?? [])].map(e => e.textContent),
        theirs: [...(over?.querySelectorAll('.msg:not(.mine):not(.live) .bubble') ?? [])].map(e => e.textContent),
        faces: over?.querySelectorAll('.msg-face img').length ?? 0,
        tools: [...(over?.querySelectorAll('.tool-name') ?? [])].map(e => e.textContent),
        input: !!input, inputFocused: !!input && document.activeElement === input,
        hidden: !!over && getComputedStyle(over).visibility === 'hidden',
        termFocused: !!document.activeElement?.classList.contains('xterm-helper-textarea'),
        toggle: slot?.querySelector('.pane-head .view')?.textContent ?? null,
        cmds: [...(over?.querySelectorAll('.cmd span') ?? [])].map(e => e.textContent),
      };
      const r = await fetch(${JSON.stringify(apiBase + probe)}, {method:'POST',body:JSON.stringify({pane,dom})});
      for (const c of await r.json()) {
        if (c.term) window.__terms?.['%0']?.input(c.term);
        if (c.send && input) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }
        if (c.toggle) slot?.querySelector('.pane-head .view')?.click();
      }
    } finally { pending = false; }
  }, 100); return 'isolated chat test'; })()`;

  // pid -> 부모 pid. 칸 셸 아래 claude.exe 는 실행기이고 실제 claude 는 그 자식으로 떠서
  // 자기 pid 로 명부를 쓴다. 명부를 쓸 자리를 현실과 같게 고르려면 부모를 알아야 한다.
  const claudePids = () => {
    const raw = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { \"$($_.ProcessId):$($_.ParentProcessId)\" }) -join ','"],
      { encoding: "utf8", windowsHide: true }).stdout.trim();
    return new Map(raw ? raw.split(",").map(s => s.split(":").map(Number)) : []);
  };
  const claudeBefore = claudePids();
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const screen = () => (latest.pane ?? []).join("\n");
  const dom = () => latest.dom ?? {};
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) await delay(100); return ok(); };
  const ESC = String.fromCharCode(27), CR = String.fromCharCode(13);
  try {
    let settled = false;
    for (let i = 0; i < 900 && !screen().includes("CHAT_VIEW_MARK"); i++) {
      const s = screen();
      if (!settled && /Do you want to use this API key/.test(s)) {
        if (/❯ No/.test(s)) commands.push({ term: ESC + "[A" });
        else if (/❯ Yes/.test(s)) { commands.push({ term: CR }); settled = true; }
      }
      await delay(100);
    }
    assert.match(screen(), /CHAT_VIEW_MARK/, "저장된 대화가 터미널에 뜨지 않음");
    // 대화 id 를 모르는 동안은 덮지 않는다. 앱이 대화를 골라 그리지 않는다는 뜻이다.
    assert.equal(dom().over, false, "명부를 읽기 전에 대화창이 떴다");

    let pids = [];
    for (let i = 0; i < 60 && !pids.length; i++) { const now = claudePids(); const fresh = [...now.keys()].filter(v => !claudeBefore.has(v)); pids = fresh.filter(p => !fresh.some(q => now.get(q) === p)); if (!pids.length) await delay(500); }
    assert.ok(pids.length, "새로 뜬 claude 가 없음");
    mkdirSync(path.join(home, "sessions"), { recursive: true });
    const roster = (id) => {
      for (const pid of pids) writeFileSync(path.join(home, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId: id, cwd: project, kind: "interactive" }));
    };

    // 새 대화는 첫 말 전까지 파일이 없다. 그동안 claude 의 시작 대화상자(폴더 신뢰, 키 승인)는
    // TUI 에만 있으므로 대화창은 올려만 두고 터미널을 보여야 한다.
    const fresh = randomUUID();
    roster(fresh);
    assert.ok(await until(() => dom().over && dom().hidden, 150), "파일 없는 새 대화에 대화창이 보이거나 올라오지 않음: " + JSON.stringify(dom()));
    assert.ok(await until(() => dom().termFocused, 30), "새 대화에서 키가 터미널로 가지 않음");
    writeFileSync(path.join(store, fresh + ".jsonl"), JSON.stringify({ ...common, sessionId: fresh, type: "user", uuid: randomUUID(), parentUuid: null, message: { role: "user", content: "NEW_CONV_FIRST" } }) + "\n");
    assert.ok(await until(() => dom().over && !dom().hidden && dom().mine?.includes("NEW_CONV_FIRST"), 100), "첫 말이 적혔는데 대화창으로 넘어가지 않음: " + JSON.stringify(dom()));
    assert.ok(await until(() => dom().inputFocused, 50), "대화창으로 넘어갔는데 포커스가 입력바로 오지 않음");

    // /clear 처럼 같은 claude 가 다른 대화로 넘어가면 명부가 바뀐다. 대화창이 따라가야 한다.
    roster(sid);

    // 밑줄이 든 이름을 그대로 찾는다. 마크다운이 단어 안 밑줄을 기울임으로 먹으면
    // CHATVIEWMARK 로 나와 여기서 걸린다(실제로 그랬다).
    assert.ok(await until(() => dom().theirs?.some(t => t.includes("CHAT_VIEW_MARK"))), "대화창에 원문이 그려지지 않음: " + JSON.stringify(dom()));
    assert.deepEqual(dom().mine, ["ASK_CHAT_VIEW"]);
    assert.deepEqual(dom().tools, ["Bash"], "도구 호출이 카드로 서지 않음");
    assert.ok(dom().faces >= 1, "치이카와 얼굴이 붙지 않음");
    assert.equal(dom().toggle, "터미널로");
    // 대화창이 덮은 칸의 키는 입력바로 가야 한다. 숨은 터미널이 먹으면 보이지 않는 곳에 쳐진다.
    assert.ok(await until(() => dom().inputFocused, 50), "포커스가 입력바가 아니라 숨은 터미널에 있음");

    commands.push({ send: "CHAT_VIEW_SENT" });
    // claude 가 제출을 받아야만 원문에 적힌다. 줄바꿈으로 입력창에 머물면 여기서 멈춘다.
    assert.ok(await until(() => dom().mine?.includes("CHAT_VIEW_SENT"), 400), "보낸 말이 제출되지 않음: " + JSON.stringify(dom()) + "\n" + screen().slice(-800));

    // 메뉴를 여는 명령은 보내면 터미널로 넘어가고, 메뉴를 닫으면 대화창으로 돌아와야 한다.
    // 닫힌 것은 claude 가 대화 파일에 적는 명령·결과 줄로 안다(열 때는 아무것도 안 적는다).
    // /config 는 첫 Esc 가 검색어 지우기라 두 번 눌러야 닫힌다.
    for (const [cmd, escs] of [["/config", 2], ["/model", 1]]) {
      commands.push({ send: cmd });
      assert.ok(await until(() => dom().over && dom().hidden && dom().toggle === "대화로", 50), cmd + " 을 보냈는데 터미널로 넘어가지 않음: " + JSON.stringify(dom()));
      assert.ok(await until(() => /Esc to (close|cancel|clear)/.test(screen()), 80), cmd + " 메뉴가 열리지 않음:\n" + screen().slice(-600));
      await delay(800);
      // 메뉴가 열려 있는 동안은 돌아오면 안 된다.
      assert.equal(dom().hidden, true, cmd + " 메뉴가 열려 있는데 대화창이 덮였음");
      for (let i = 0; i < escs; i++) { commands.push({ term: ESC }); await delay(500); }
      assert.ok(await until(() => dom().over && !dom().hidden && dom().toggle === "터미널로", 80), cmd + " 을 닫았는데 대화창으로 돌아오지 않음: " + JSON.stringify(dom()));
      assert.ok(dom().cmds.includes(cmd), cmd + " 기록이 대화창에 안 보임: " + JSON.stringify(dom().cmds));
      assert.ok(await until(() => dom().inputFocused, 30), cmd + " 뒤 포커스가 입력바로 오지 않음");
    }

    commands.push({ toggle: true });
    assert.ok(await until(() => dom().over === false && dom().toggle === "대화로", 50), "터미널로 돌아가지 않음");
    commands.push({ toggle: true });
    assert.ok(await until(() => dom().over === true, 50), "대화창으로 돌아오지 않음");
    assert.equal(app.exitCode, null);
    console.log("명부 -> 대화창 -> 제출 -> 원문 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify(latest));
    console.error("대화창 검증 기록", root);
    throw e;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + app.pid + " -ErrorAction SilentlyContinue).CloseMainWindow()"], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
