import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

test("서브에이전트가 일하는 동안 대화창에 그 일이 한 줄로 보이고, 결과가 돌아가면 걷힌다", { skip: !exe || !claude, timeout: 180000 }, async () => {
  // 가짜 Anthropic 서버가 본 대화에서 Agent 도구를 부르게 하면 실제 claude 가 실제로
  // 서브에이전트를 띄워 같은 서버로 요청을 보낸다. 그 요청은 앱 프록시를 지나며 chat:sub 로
  // 흐른다. 서브에이전트의 답을 붙잡아 둔 동안 대화창을 본다. 유료 모델은 부르지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-sub-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const store = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(store, { recursive: true });
  const sid = randomUUID(), userId = randomUUID();
  const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  writeFileSync(path.join(store, sid + ".jsonl"), [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "ASK_SUB_START" } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_0", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "SUB_READY_MARK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  // claude 는 승인한 키를 끝 20글자로 기억한다. 전체만 두면 승인으로 치지 않고 "Not logged in" 이 된다.
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  // 서브에이전트를 부르는 데 허락을 묻지 않게 한다. 서브에이전트는 글만 쓰고 도구는 안 쓴다.
  // 권한 모드를 적어 둔다. API 키 과금의 격리 claude 는 auto 모드로 뜨는데, 그때 프록시 뒤에서는
  // "분류기 요청 과금" 안내 대화상자를 띄우고 첫 도구를 붙잡는다(Pro·Max·Team 은 안 띄운다고 문서에 있다).
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default", allow: ["Agent", "Task"] } }));
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
  const seen = { main1: 0, main2: 0, sub: 0, subHeader: null, subFirst: null };
  let release;
  const held = new Promise(r => { release = r; });
  const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const text = (j) => JSON.stringify(j.messages ?? []);
  const server = http.createServer((req, res) => {
    if (req.url === probe) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
      return;
    }
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}'); return; }
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const message = { id: "msg_" + randomUUID().slice(0, 8), type: "message", role: "assistant", model: j.model ?? "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "제목" }], stop_reason: "end_turn" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { message });
      const all = text(j);
      // 서브에이전트는 헤더로 가른다. 본문으로 가르면 본 대화의 다음 요청에도 맡긴 일이 실려 있어
      // 본 대화에 서브에이전트의 답을 주게 된다(실제로 그랬다).
      const isSub = !!req.headers["x-claude-code-agent-id"];
      const isMain = !isSub && Array.isArray(j.tools) && j.tools.some(t => t.name === "Agent") && all.includes("CHAT_SUB_ASK");
      if (isSub) {
        // 서브에이전트: 조각을 흘리고, 테스트가 볼 때까지 붙잡아 둔다.
        seen.sub++;
        seen.subHeader = req.headers["x-claude-code-agent-id"] ?? null;
        seen.subFirst ??= JSON.stringify(j.messages?.[0]?.content ?? "").slice(0, 300);
        sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "SUB_WORKING 찾는 중" } });
        await Promise.race([held, delay(60000)]);
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: " SUB_DONE" } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
      } else if (isMain && !all.includes("tool_result")) {
        // 본 대화 첫 요청: 서브에이전트를 부른다.
        seen.main1++;
        sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_sub" + randomUUID().replaceAll("-", "").slice(0, 16), name: "Agent", input: {} } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ description: "로그 찾기", prompt: "SUB_TASK 로그에서 실패 원인 찾기", subagent_type: "general-purpose" }) } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      } else {
        // 서브에이전트 결과를 받은 본 대화의 다음 요청(또는 그 밖의 보조 요청).
        if (isMain) seen.main2++;
        sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: isMain ? "MAIN_AFTER_SUB" : "제목" } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      }
      sse(res, "message_stop", {});
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || key === "CHIISPACE_PROXY" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|ENABLE_TOOL_SEARCH/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const slot = document.querySelector('[data-pane="%0"]');
      const over = slot?.querySelector('.chat-over');
      const b = window.__terms?.['%0']?.buffer.active;
      const pane = b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '') : null;
      const input = over?.querySelector('.composer textarea');
      const texts = (sel) => [...(over?.querySelectorAll(sel) ?? [])].map(e => e.textContent);
      const dom = {
        shown: !!over && getComputedStyle(over).visibility !== 'hidden',
        theirs: texts('.msg:not(.mine):not(.live) .bubble'),
        live: texts('.msg.live .bubble'),
        subs: [...(over?.querySelectorAll('.sub') ?? [])].map(e => ({
          label: e.querySelector('.sub-label')?.textContent,
          what: e.querySelector('.sub-what')?.textContent,
          state: e.querySelector('.tool-stat')?.textContent ?? null,
        })),
        notes: texts('.note'),
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
      }
    } finally { pending = false; }
  }, 100); return 'isolated sub test'; })()`;

  // pid -> 부모 pid. 명부는 실제 claude 처럼 잎(실행기 아래 자식)에만 쓴다.
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
    for (let i = 0; i < 900 && !screen().includes("SUB_READY_MARK"); i++) {
      const s = screen();
      if (!settled && /Do you want to use this API key/.test(s)) {
        if (/❯ No/.test(s)) commands.push({ term: ESC + "[A" });
        else if (/❯ Yes/.test(s)) { commands.push({ term: CR }); settled = true; }
      }
      await delay(100);
    }
    assert.match(screen(), /SUB_READY_MARK/, "저장된 대화가 뜨지 않음");
    let pids = [];
    for (let i = 0; i < 60 && !pids.length; i++) { const now = claudePids(); const fresh = [...now.keys()].filter(v => !claudeBefore.has(v)); pids = fresh.filter(p => !fresh.some(q => now.get(q) === p)); if (!pids.length) await delay(500); }
    assert.ok(pids.length, "새로 뜬 claude 가 없음");
    mkdirSync(path.join(home, "sessions"), { recursive: true });
    for (const pid of pids) writeFileSync(path.join(home, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId: sid, cwd: project, kind: "interactive" }));
    assert.ok(await until(() => dom().shown && dom().theirs?.some(t => t.includes("SUB_READY_MARK"))), "대화창이 뜨지 않음: " + JSON.stringify(dom()));

    commands.push({ send: "CHAT_SUB_ASK" });
    // 서브에이전트가 일하는 동안: 그 한 줄이 보이고, 본 대화 말풍선에는 섞이지 않는다.
    const working = () => dom().subs?.some(s => (s.what ?? "").includes("SUB_WORKING"));
    assert.ok(await until(working, 400), "서브에이전트의 일이 대화창에 보이지 않음: " + JSON.stringify({ dom: dom(), seen }) + "\n" + screen().slice(-800));
    const row = dom().subs.find(s => (s.what ?? "").includes("SUB_WORKING"));
    assert.equal(row.state, "쓰는 중");
    assert.match(row.label ?? "", /SUB_TASK|로그/, "서브에이전트에 맡긴 일이 이름으로 안 보임: " + JSON.stringify(row));
    assert.ok(![...dom().theirs, ...dom().live].some(t => t.includes("SUB_WORKING")), "서브에이전트의 글이 본 대화 말풍선에 섞였음");
    assert.ok(seen.subHeader, "서브에이전트 요청에 에이전트 id 헤더가 없음 — 프록시가 가를 근거가 없다");

    // 서브에이전트가 마지막 답을 끝내면 그 줄은 걷히고, 본 대화의 답은 제자리에 선다.
    // 새 claude 는 서브에이전트를 백그라운드로 돌려 본 대화가 먼저 답할 수도 있다 — 순서는 묻지 않는다.
    release();
    assert.ok(await until(() => !dom().subs?.length, 300), "서브에이전트가 끝났는데 줄이 안 걷힘: " + JSON.stringify({ dom: dom(), seen }));
    assert.ok(await until(() => dom().theirs?.some(t => t.includes("MAIN_AFTER_SUB")), 300), "본 대화의 답이 안 섬: " + JSON.stringify({ dom: dom(), seen }));
    assert.ok(![...dom().theirs, ...dom().live].some(t => t.includes("SUB_WORKING") || t.includes("SUB_DONE")), "서브에이전트의 글이 본 대화 말풍선에 섞였음");
    assert.equal(seen.main1, 1);
    assert.ok(seen.main2 >= 1, "서브에이전트 결과를 받은 본 대화 요청이 없음");
    assert.equal(app.exitCode, null);
    console.log("서브에이전트 표시 확인", root, "헤더:", seen.subHeader);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, seen }));
    console.error("서브에이전트 검증 기록", root);
    throw e;
  } finally {
    release();
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + app.pid + " -ErrorAction SilentlyContinue).CloseMainWindow()"], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
