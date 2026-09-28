import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const hash = (file) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;

test("새 대화의 Claude 는 터미널 없이 대화창만으로 주고받고, 권한·질문·중단·모델·이어가기를 카드로 다룬다", { skip: !exe || !claude, timeout: 300000 }, async () => {
  // 실제 claude 를 `-p` stream-json 통로로 띄우고, 앱 프록시 뒤에 가짜 Anthropic 서버를 둔다.
  // 격리: 별도 앱 세션·CLAUDE_CONFIG_DIR, 가짜 키. 유료 모델은 부르지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-stream-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const home = path.join(root, "claude-state");
  mkdirSync(home);
  const protectedFiles = ["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json"));
  const before = protectedFiles.map(hash);
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key"], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", root: project.replaceAll("\\", "/"), shell, layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, restoreMode: "native-continue", procs: {},
  }));

  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const requests = [];
  let slowRes = null;
  const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
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
      const all = JSON.stringify(j.messages ?? []);
      const message = { id: "msg_" + randomUUID().slice(0, 8), type: "message", role: "assistant", model: j.model ?? "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!j.stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "제목" }], stop_reason: "end_turn" })); return; }
      // claude 는 사용자 말 뒤에 부가 블록을 덧붙여 보낸다. 가장 늦게 나온 표시로 가른다.
      const marks = ["STREAM_HELLO", "STREAM_BASH", "STREAM_DENY", "STREAM_ASK", "STREAM_SLOW", "STREAM_MODEL", "STREAM_AGAIN", "STREAM_CLEARED"];
      const [mark, at] = marks.map(k => [k, all.lastIndexOf(k)]).sort((x, y) => y[1] - x[1])[0];
      const afterTool = all.lastIndexOf("tool_result") > at;
      if (at >= 0) requests.push({ mark, afterTool, model: j.model, n: (j.messages ?? []).length, hello: all.includes("STREAM_HELLO") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { message });
      const text = async (parts, hold) => {
        sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for (const p of parts) { sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: p } }); await delay(120); }
        if (hold) await hold;
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      };
      const tool = (name, input) => {
        sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_" + randomUUID().replaceAll("-", "").slice(0, 20), name, input: {} } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      };
      if (afterTool) await text(["도구 ", "결과 ", `받음 ${mark}_AFTER_TOOL`]);
      else if (mark === "STREAM_BASH") tool("Bash", { command: "mkdir allowed_dir", description: "허락받을 폴더 만들기" });
      else if (mark === "STREAM_DENY") tool("Bash", { command: "mkdir denied_dir", description: "거절될 폴더 만들기" });
      else if (mark === "STREAM_ASK") tool("AskUserQuestion", { questions: [{ question: "어느 쪽으로 갈까?", header: "방향", multiSelect: false, options: [{ label: "왼쪽", description: "L" }, { label: "오른쪽", description: "R" }] }] });
      else if (mark === "STREAM_SLOW") {
        res.on("close", () => { slowRes = null; });
        slowRes = res;
        await text(["느린 ", "답 ", "SLOW_PART"], new Promise(r => setTimeout(r, 60000)));
      } else await text(["안녕 ", "STREAM_", mark === "STREAM_HELLO" ? "REPLY" : mark + "_REPLY"]);
      if (!res.writableEnded && !res.destroyed) { sse(res, "message_stop", {}); res.end(); }
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || key === "CHIISPACE_PROXY" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|ENABLE_TOOL_SEARCH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const side = document.querySelector('.side');
      const slot = document.querySelector('[data-pane="%1"]');
      const over = slot?.querySelector('.chat-over');
      const input = over?.querySelector('.composer textarea');
      const texts = (sel) => [...(over?.querySelectorAll(sel) ?? [])].map(e => e.textContent);
      const dom = {
        tabs: side?.querySelectorAll('.tgroup').length ?? 0,
        slot: !!slot,
        xterm: !!slot?.querySelector('.xterm'),
        termButton: !!over?.querySelector('.composer-term'),
        over: !!over,
        empty: over?.querySelector('.chat-empty')?.textContent ?? null,
        input: !!input, inputDisabled: !!input?.disabled, inputFocused: !!input && document.activeElement === input,
        mine: texts('.msg.mine:not(.sending) .bubble'),
        theirs: texts('.msg:not(.mine):not(.live) .bubble'),
        live: texts('.msg.live .bubble'),
        perm: over?.querySelector('.ask.perm')?.textContent ?? null,
        ask: over?.querySelector('.ask.choose')?.textContent ?? null,
        exit: over?.querySelector('.stream-exit')?.textContent ?? null,
        stop: !!over?.querySelector('.composer-stop'),
        models: [...(over?.querySelectorAll('.stream-bar select:first-of-type option') ?? [])].map(o => o.value),
        model: over?.querySelector('.stream-bar select')?.value ?? null,
        title: slot?.querySelector('.pane-head .title')?.textContent ?? null,
        chip: slot?.querySelector('.pane-head .chip')?.textContent ?? null,
      };
      const r = await fetch(${JSON.stringify(apiBase + probe)}, {method:'POST',body:JSON.stringify({dom})});
      for (const c of await r.json()) {
        if (c.click) (c.in === 'side' ? side : over)?.querySelector(c.click)?.click();
        if (c.send && input) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }
        if (c.model) {
          const sel = over?.querySelector('.stream-bar select');
          if (sel) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, c.model); sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        if (c.close) slot?.querySelector('.pane-head .x')?.click();
      }
    } finally { pending = false; }
  }, 100); return 'isolated stream test'; })()`;

  const streamProcs = (sid) => {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${sid}*' }).Count`],
      { encoding: "utf8", windowsHide: true }).stdout.trim();
    return Number(out) || 0;
  };
  const dom = () => latest.dom ?? {};
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) await delay(100); return ok(); };
  const launch = () => spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const close = async (app) => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
  };
  // CHIISPACE_TEST_SCREENSHOT=1 이면 카드가 뜬 자리를 자체 테스트 창에서 찍는다. 사용자 창은 건드리지 않는다.
  const shot = (name) => {
    if (process.env.CHIISPACE_TEST_SCREENSHOT !== "1") return;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid), "-WaitSec", "1", "-Out", path.join(root, name + ".png")], { windowsHide: true, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  const saved = () => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return {}; } };

  let app = launch();
  let sid = null;
  // 어느 단계에서 실패하든 가짜 서버를 닫는다. 안 닫으면 붙잡힌 연결 때문에 검증 프로세스가 끝나지 않는다.
  try {
  try {
    assert.ok(await until(() => dom().tabs === 1, 300), "앱이 뜨지 않음");
    commands.push({ in: "side", click: ".newtab" });
    await delay(700);
    commands.push({ in: "side", click: '.ct[data-agent="claude"]' });
    assert.ok(await until(() => dom().over && dom().input, 150), "새 대화 칸에 대화창이 안 뜸: " + JSON.stringify(dom()));
    // 터미널이 아예 없다. 터미널로 가는 단추도 없다.
    assert.equal(dom().xterm, false, "터미널 없는 칸에 터미널이 있다");
    assert.equal(dom().termButton, false, "터미널로 가는 단추가 있다");
    // 새 대화인지는 대화 파일을 한 번 물어보고 안다. 그 전 잠깐은 "여는 중"이다.
    assert.ok(await until(() => /새 대화/.test(dom().empty ?? ""), 50), "새 대화 안내가 안 뜸: " + dom().empty);
    assert.equal(dom().chip, "claude");
    assert.ok(await until(() => !dom().inputDisabled && dom().models.length > 0, 200), "claude 가 안 켜졌거나 모델 목록이 없음: " + JSON.stringify(dom()));
    assert.ok(dom().inputFocused, "새 대화 칸의 입력바에 포커스가 없음");
    // 저장은 0.4초 묶어 쓴다.
    await until(() => saved().streams?.["%1"]?.session, 50);
    sid = saved().streams?.["%1"]?.session;
    assert.match(sid ?? "", /^[0-9a-f-]{36}$/, "대화 id 가 세션에 안 남음: " + JSON.stringify(saved()));

    // 1. 말을 보내면 쓰이는 동안 흐르고, 끝나면 대화 파일의 말풍선으로 남는다.
    commands.push({ send: "STREAM_HELLO 첫 말" });
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_REPLY")), 300), "답이 대화창에 안 남음: " + JSON.stringify(dom()));
    assert.ok(dom().mine.some(t => t.includes("STREAM_HELLO")), "내 말이 대화 파일 말풍선으로 안 남음");
    assert.equal(dom().title, "STREAM_HELLO 첫 말", "첫 말이 칸 이름이 안 됨");
    const file = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), sid + ".jsonl");
    assert.ok(existsSync(file), "앱이 정한 id 로 대화 파일이 안 생김: " + file);

    // 2. 권한 묻기가 카드로 온다. 허락하면 실제로 실행된다.
    commands.push({ send: "STREAM_BASH 폴더 만들어" });
    assert.ok(await until(() => dom().perm?.includes("mkdir allowed_dir"), 300), "권한 카드가 안 뜸: " + JSON.stringify(dom()));
    shot("permission");
    commands.push({ click: ".ask.perm .ask-go" });
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_BASH_AFTER_TOOL")), 600), "허락 뒤 답이 안 옴: " + JSON.stringify(dom()));
    assert.ok(existsSync(path.join(project, "allowed_dir")), "허락했는데 실행이 안 됨");
    assert.equal(dom().perm, null, "답한 권한 카드가 남음");

    // 3. 거절하면 실행되지 않는다.
    commands.push({ send: "STREAM_DENY 이것도" });
    assert.ok(await until(() => dom().perm?.includes("mkdir denied_dir"), 300), "두 번째 권한 카드가 안 뜸");
    commands.push({ click: ".ask.perm .ask-no" });
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_DENY_AFTER_TOOL")), 300), "거절 뒤 답이 안 옴");
    assert.equal(existsSync(path.join(project, "denied_dir")), false, "거절했는데 실행됨");

    // 4. 선택지 질문도 카드로 온다. 누르면 그 답이 claude 에 간다.
    commands.push({ send: "STREAM_ASK 골라 줘" });
    assert.ok(await until(() => dom().ask?.includes("어느 쪽으로 갈까?"), 300), "질문 카드가 안 뜸: " + JSON.stringify(dom()));
    shot("ask");
    commands.push({ click: ".ask.choose .ask-opt:nth-child(2)" });
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_ASK_AFTER_TOOL")), 300), "답한 뒤 이어지지 않음");
    assert.match(readFileSync(file, "utf8"), /오른쪽/, "고른 답이 claude 에 안 감");

    // 5. 중단: 쓰는 도중 멈춤 단추를 누르면 멈추고 다시 보낼 수 있다.
    commands.push({ send: "STREAM_SLOW 길게" });
    assert.ok(await until(() => dom().stop && dom().live.some(t => t.includes("SLOW_PART")), 300), "느린 답이 흐르지 않음: " + JSON.stringify(dom()));
    commands.push({ click: ".composer-stop" });
    assert.ok(await until(() => !dom().stop, 200), "멈춤이 안 됨");

    // 6. 모델을 바꾸면 다음 요청부터 그 모델로 간다.
    commands.push({ model: "sonnet" });
    await until(() => dom().model === "sonnet", 50);
    commands.push({ send: "STREAM_MODEL 다음" });
    assert.ok(await until(() => requests.some(r => r.mark === "STREAM_MODEL"), 300), "모델 바꾼 뒤 요청이 없음");
    assert.match(requests.find(r => r.mark === "STREAM_MODEL").model, /sonnet/, "모델이 안 바뀜: " + JSON.stringify(requests.slice(-3)));
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_MODEL_REPLY")), 300));
  } finally {
    await close(app);
  }

  // 7. 다시 켜면 그 칸은 같은 대화로 이어 열린다. 터미널 없이.
  app = launch();
  try {
    assert.ok(await until(() => dom().over && dom().mine.some(t => t.includes("STREAM_HELLO")), 300), "다시 켰는데 지난 대화가 안 보임: " + JSON.stringify(dom()));
    assert.equal(dom().xterm, false);
    assert.equal(dom().title, "STREAM_HELLO 첫 말", "칸 이름이 안 남음");
    assert.ok(await until(() => !dom().inputDisabled, 200), "이어 연 claude 가 안 켜짐");
    shot("resumed");
    commands.push({ send: "STREAM_AGAIN 이어서" });
    assert.ok(await until(() => requests.some(r => r.mark === "STREAM_AGAIN"), 300), "이어 연 대화로 요청이 안 감");
    assert.ok(requests.find(r => r.mark === "STREAM_AGAIN").n > 4, "이어 열었는데 지난 말이 안 실림: " + JSON.stringify(requests.slice(-2)));
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_AGAIN_REPLY")), 300));
    assert.equal(saved().streams?.["%1"]?.session, sid, "이어 열었는데 대화 id 가 바뀜");

    // /clear 하면 claude 가 새 대화로 넘어간다. 칸은 그 대화를 따라가고, 다음에 켜도 그 대화로 연다.
    commands.push({ send: "/clear" });
    assert.ok(await until(() => { const s = saved().streams?.["%1"]?.session; return s && s !== sid; }, 200), "/clear 뒤 새 대화를 안 따라감: " + JSON.stringify(saved().streams));
    assert.ok(await until(() => !dom().mine.some(t => t.includes("STREAM_HELLO")), 100), "/clear 뒤에도 지난 대화를 그림");
    commands.push({ send: "STREAM_CLEARED 새로" });
    assert.ok(await until(() => dom().theirs.some(t => t.includes("STREAM_CLEARED_REPLY")), 300), "/clear 뒤 대화가 안 됨: " + JSON.stringify(dom()));
    assert.equal(requests.find(r => r.mark === "STREAM_CLEARED").hello, false, "/clear 뒤에도 지난 말이 실림");

    // 8. 칸을 닫으면 그 claude 도 내려간다.
    assert.ok(streamProcs(sid) > 0, "도는 claude 를 못 찾음");
    commands.push({ close: true });
    assert.ok(await until(() => !dom().slot, 100), "칸이 안 닫힘");
    assert.ok(await until(() => streamProcs(sid) === 0, 80), "칸을 닫았는데 claude 가 남음");
    assert.ok(await until(() => !saved().streams?.["%1"], 50), "닫은 칸의 대화 기록이 세션에 남음");
  } finally {
    await close(app);
  }
  } finally {
    if (slowRes) slowRes.destroy();
    server.closeAllConnections();
    server.close();
  }
  if (process.env.CHIISPACE_TEST_SCREENSHOT === "1") console.log("screenshots:", root);
  assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션 파일이 바뀜");
});
