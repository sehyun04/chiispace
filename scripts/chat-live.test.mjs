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

test("답이 쓰이는 동안 대화창에 글자가 흐르고, 끝나면 대화 파일의 답으로 겹침 없이 넘어간다", { skip: !exe || !claude, timeout: 180000 }, async () => {
  // 앱의 루프백 프록시(proxy.rs)가 칸의 claude 요청을 원래 가던 곳으로 넘기면서 스트림을
  // 옆에서 읽는지 본다. "원래 가던 곳"은 앱이 받은 ANTHROPIC_BASE_URL 이므로, 여기에 가짜
  // Anthropic 서버를 두면 실제 claude 가 실제 프록시를 거쳐 가짜 모델과 말한다.
  // 유료 모델은 부르지 않고 사용자 대화·인증은 쓰지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-live-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const store = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(store, { recursive: true });
  const sid = randomUUID(), userId = randomUUID();
  const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  const transcript = path.join(store, sid + ".jsonl");
  writeFileSync(transcript, [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "ASK_LIVE_START" } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_0", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "LIVE_READY_MARK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] } };
  // claude 는 승인한 키를 끝 20글자로 기억한다. 전체만 두면 승인으로 치지 않고 "Not logged in" 이 된다.
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
  // 가짜 모델이 본 것. 인증이 프록시를 지나 그대로 도착했는지 확인한다(값은 남기지 않는다).
  const seen = { main: 0, keyArrived: false, compressedAsked: false, paths: [] };
  let release;
  const held = new Promise(r => { release = r; });
  const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const server = http.createServer((req, res) => {
    if (req.url === probe) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
      return;
    }
    seen.paths.push(req.method + " " + req.url);
    if (req.method === "HEAD" || req.method === "GET") { res.writeHead(200).end(); return; }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      if (req.headers["x-api-key"] === "chiispace-fixture-key") seen.keyArrived = true;
      if (/gzip|br|deflate/.test(req.headers["accept-encoding"] ?? "")) seen.compressedAsked = true;
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}'); return; }
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const main = Array.isArray(j.tools) && j.tools.some(t => t.name === "Edit");
      const message = { id: "msg_" + randomUUID().slice(0, 8), type: "message", role: "assistant", model: j.model ?? "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...message, content: [{ type: "text", text: "제목" }], stop_reason: "end_turn" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, "message_start", { message });
      sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      if (main) {
        seen.main++;
        for (const piece of ["CHAT_", "LIVE_", "PART"]) {
          sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
          await delay(250);
        }
        // 테스트가 "쓰이는 중"을 확인할 때까지 답을 붙잡아 둔다.
        await Promise.race([held, delay(30000)]);
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "_DONE" } });
      } else {
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "제목" } });
      }
      sse(res, "content_block_stop", { index: 0 });
      sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
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
        over: !!over,
        mine: texts('.msg.mine:not(.sending) .bubble'),
        sending: texts('.msg.sending .bubble'),
        theirs: texts('.msg:not(.mine):not(.live) .bubble'),
        live: texts('.msg.live .bubble'),
        writing: !!over?.querySelector('.bubble.writing'),
        stop: !!over?.querySelector('.composer-stop'),
        input: !!input,
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
  }, 100); return 'isolated live test'; })()`;

  const claudePids = () => {
    const raw = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Process claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: "utf8", windowsHide: true }).stdout.trim();
    return new Set(raw ? raw.split(",").map(Number) : []);
  };
  const claudeBefore = claudePids();
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const screen = () => (latest.pane ?? []).join("\n");
  const dom = () => latest.dom ?? {};
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) await delay(100); return ok(); };
  const ESC = String.fromCharCode(27), CR = String.fromCharCode(13);
  try {
    let settled = false;
    for (let i = 0; i < 900 && !screen().includes("LIVE_READY_MARK"); i++) {
      const s = screen();
      if (!settled && /Do you want to use this API key/.test(s)) {
        if (/❯ No/.test(s)) commands.push({ term: ESC + "[A" });
        else if (/❯ Yes/.test(s)) { commands.push({ term: CR }); settled = true; }
      }
      await delay(100);
    }
    assert.match(screen(), /LIVE_READY_MARK/, "저장된 대화가 뜨지 않음");
    let pids = [];
    for (let i = 0; i < 60 && !pids.length; i++) { pids = [...claudePids()].filter(v => !claudeBefore.has(v)); if (!pids.length) await delay(500); }
    assert.ok(pids.length, "새로 뜬 claude 가 없음");
    mkdirSync(path.join(home, "sessions"), { recursive: true });
    for (const pid of pids) writeFileSync(path.join(home, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId: sid, cwd: project, kind: "interactive" }));
    assert.ok(await until(() => dom().theirs?.some(t => t.includes("LIVE_READY_MARK"))), "대화창이 뜨지 않음: " + JSON.stringify(dom()));

    commands.push({ send: "CHAT_LIVE_ASK" });
    // 파일에 적히기 전에도 내 말이 바로 보인다.
    assert.ok(await until(() => dom().sending?.includes("CHAT_LIVE_ASK") || dom().mine?.includes("CHAT_LIVE_ASK"), 50), "보낸 말이 바로 보이지 않음");
    // 가짜 모델이 답을 붙잡고 있는 동안: 쓰이는 말풍선에 조각이 보이고, 파일 쪽 답에는 아직 없다.
    assert.ok(await until(() => dom().live?.some(t => t.includes("CHAT_LIVE_PART")), 300), "쓰이는 중인 글이 대화창에 흐르지 않음: " + JSON.stringify({ dom: dom(), seen }) + "\n" + screen().slice(-600));
    assert.equal(dom().writing, true, "쓰이는 중 표시가 없음");
    assert.equal(dom().stop, true, "답이 흐르는 동안 중단 단추가 없음");
    assert.ok(!dom().theirs.some(t => t.includes("CHAT_LIVE")), "아직 파일에 없는 답이 확정된 말풍선으로 섰음");
    assert.ok(!readFileSync(transcript, "utf8").includes("CHAT_LIVE_PART"), "답이 끝나기 전에 파일에 적혔다 — 이 검증의 전제가 틀렸다");
    assert.ok(dom().mine.includes("CHAT_LIVE_ASK"), "새 요청이 나갔는데 내 말이 파일에서 뜨지 않음");

    release();
    // 끝나면 파일의 답 하나만 남는다. 쓰이던 말풍선과 겹쳐 두 번 보이면 안 된다.
    assert.ok(await until(() => dom().theirs?.some(t => t.includes("CHAT_LIVE_PART_DONE")) && !dom().live?.length, 150), "끝난 답이 파일의 말풍선으로 넘어가지 않음: " + JSON.stringify(dom()));
    const all = [...dom().theirs, ...dom().live].filter(t => t.includes("CHAT_LIVE_PART"));
    assert.equal(all.length, 1, "답이 겹쳐 보임: " + JSON.stringify(all));
    assert.equal(dom().writing, false);
    assert.equal(dom().sending.length, 0, "보내는 중 표시가 걷히지 않음");
    // 일하는 중 판정은 출력 박동으로 하므로 조금 늦게 풀린다. 끝내 남아 있으면 안 된다.
    assert.ok(await until(() => !dom().stop, 150), "답이 끝났는데 중단 단추가 남음");

    assert.ok(seen.main >= 1, "본 대화 요청이 가짜 모델에 닿지 않음");
    assert.ok(seen.keyArrived, "인증 헤더가 프록시를 지나 도착하지 않음");
    assert.equal(seen.compressedAsked, false, "압축된 응답을 청함 — 스트림을 옆에서 읽을 수 없다");
    assert.equal(app.exitCode, null);
    console.log("프록시 -> 쓰이는 중 -> 파일 답 전환 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, seen }));
    console.error("실시간 검증 기록", root);
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
