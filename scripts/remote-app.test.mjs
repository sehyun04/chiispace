import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { watchUserFiles } from "./user-files.mjs";
import { takeFrames } from "../ui/remote-shim.ts";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const edge = [
  path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
].find((p) => existsSync(p));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, n = 300) => {
  for (let i = 0; i < n && !(await ok()); i++) await delay(100);
  return ok();
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const userLine = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
const answer = (requestId, toolUseId, behavior = "allow", input = {}) =>
  JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: behavior === "allow" ? { behavior, updatedInput: input, toolUseID: toolUseId } : { behavior, message: "no", toolUseID: toolUseId } },
  });

/** 별도 프로필의 헤드리스 Edge 한 탭. 사용자 브라우저·OS 입력을 쓰지 않고 페이지 안에서만 누른다(CDP). */
async function phoneBrowser(dir) {
  const proc = spawn(edge, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const portFile = path.join(dir, "DevToolsActivePort");
  assert.ok(await until(() => existsSync(portFile), 100), "Edge 디버깅 포트가 안 열림");
  const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
  let page;
  await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    page = list.find((t) => t.type === "page");
    return !!page;
  }, 100);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      waiting.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  return {
    send,
    evaluate,
    shot: async (file) => writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")),
    close: () => {
      try {
        ws.close();
      } catch {}
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    },
  };
}

test("폰 연결 — 짝짓기, PC 칸에 붙어 말하기·권한 답하기, PC 와 카드 맞추기, 허락하지 않은 명령 막기", { skip: !exe || !claude, timeout: 420000 }, async () => {
  // 격리: 별도 앱 세션·CLAUDE_CONFIG_DIR·폰 연결 설정(remote.json 은 세션 파일 옆), 가짜 키와 가짜 Anthropic 서버.
  // 폰 서버 포트도 비어 있는 것을 고른다 — 사용자 앱이 기본 포트를 쥐고 있을 수 있다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-remote-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const home = path.join(root, "claude-state");
  mkdirSync(home);
  const protectedFiles = ["com.sehyun.chiispace", "com.sehyun.kasaspace"].flatMap((id) =>
    ["session.json", "remote.json"].map((f) => path.join(process.env.APPDATA, id, f)),
  );
  const guard = watchUserFiles(protectedFiles, { root, exe });
  const settings = {
    hasCompletedOnboarding: true,
    theme: "light",
    hasSeenAutoDefaultNudge: true,
    hasSeenAutoModeEntryWarning: true,
    projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] },
  };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
  const sid = randomUUID();
  const cwd = project.replaceAll("\\", "/");
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(
    state,
    JSON.stringify({
      tabs: [{ key: "t0", focus: "%0", root: cwd, shell, layout: { kind: "leaf", id: "%0" } }],
      active: 0,
      nextPane: 1,
      nextTab: 1,
      restoreMode: "native-continue",
      procs: {},
      streams: { "%0": { agent: "claude", session: sid, cwd } },
    }),
  );
  const port = await freePort();
  const remoteFile = path.join(root, "remote.json");
  writeFileSync(remoteFile, JSON.stringify({ on: true, port, devices: [] }));

  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const requests = [];
  const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const server = http.createServer((req, res) => {
    if (req.url === probe) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        latest = JSON.parse(body);
        res.end(JSON.stringify(commands.splice(0)));
      });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
        return;
      }
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const all = JSON.stringify(j.messages ?? []);
      const message = { id: "msg_" + randomUUID().slice(0, 8), type: "message", role: "assistant", model: j.model ?? "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "제목" }], stop_reason: "end_turn" }));
        return;
      }
      const marks = ["HELLO_A", "TOOL_A", "TOOL_B", "UI_HELLO", "TOOL_C"];
      const [mark, at] = marks.map((k) => [k, all.lastIndexOf(k)]).sort((x, y) => y[1] - x[1])[0];
      const afterTool = all.lastIndexOf("tool_result") > at;
      if (at >= 0) requests.push({ mark, afterTool });
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { message });
      const text = async (parts) => {
        sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for (const p of parts) {
          sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: p } });
          await delay(100);
        }
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      };
      const tool = (name, input) => {
        sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_" + randomUUID().replaceAll("-", "").slice(0, 20), name, input: {} } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      };
      if (afterTool) await text(["도구 ", "결과 ", `받음 ${mark}_AFTER`]);
      else if (mark.startsWith("TOOL_")) tool("Bash", { command: `mkdir dir_${mark.toLowerCase()}`, description: `${mark} 폴더 만들기` });
      else await text(["안녕 ", `${mark}_REPLY`]);
      if (!res.writableEnded && !res.destroyed) {
        sse(res, "message_stop", {});
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || key === "CHIISPACE_PROXY" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|ENABLE_TOOL_SEARCH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false;
  setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const side = document.querySelector('.side');
      const slot = document.querySelector('[data-pane="%0"]');
      const over = slot?.querySelector('.chat-over');
      const input = over?.querySelector('.composer textarea');
      const panel = document.querySelector('.remote');
      const texts = (root, sel) => [...(root?.querySelectorAll(sel) ?? [])].map(e => e.textContent);
      const dom = {
        input: !!input, inputDisabled: !!input?.disabled,
        mine: texts(over, '.msg.mine:not(.sending) .bubble'),
        theirs: texts(over, '.msg:not(.mine):not(.live) .bubble'),
        perm: over?.querySelector('.ask.perm')?.textContent ?? null,
        remoteButton: !!side?.querySelector('.side-remote'),
        remote: panel ? {
          state: panel.querySelector('.remote-switch span')?.textContent ?? null,
          code: panel.querySelector('.remote-digits')?.dataset.code ?? null,
          devices: texts(panel, '.remote-dev span'),
          sub: panel.querySelector('.remote-sub')?.textContent ?? null,
          error: panel.querySelector('.remote-bad')?.textContent ?? null,
        } : null,
      };
      const r = await fetch(${JSON.stringify(apiBase + probe)}, { method: 'POST', body: JSON.stringify({ dom }) });
      for (const c of await r.json()) {
        if (c.click) ({ side, over, remote: panel })[c.in ?? 'over']?.querySelector(c.click)?.click();
        if (c.button) [...(document.querySelectorAll('.remote button'))].filter(b => b.textContent === c.button)[c.nth ?? 0]?.click();
        if (c.send && input) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }
      }
    } finally { pending = false; }
  }, 100); return 'isolated remote test'; })()`;

  const dom = () => latest.dom ?? {};
  const base = `http://127.0.0.1:${port}`;
  const call = async (cmd, args, token) => {
    const r = await fetch(base + "/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ cmd, args }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  /** 다른 이름(Host)으로 들어온 요청. fetch 는 Host 를 못 바꾸므로 http 로 보낸다. */
  const withHost = (host, extra = {}) =>
    new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", headers: { Host: host, ...extra } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve(0));
      req.end();
    });
  const listenEvents = async (token) => {
    const frames = [];
    const ctrl = new AbortController();
    const res = await fetch(base + "/api/events", { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    assert.equal(res.status, 200, "이벤트 스트림이 안 열림");
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    void (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const r = takeFrames(buf + dec.decode(value, { stream: true }));
          buf = r.rest;
          frames.push(...r.frames);
        }
      } catch {}
      frames.push({ event: "__end" });
    })();
    return { frames, stop: () => ctrl.abort() };
  };
  const launch = () => spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const close = async (app) => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
  };

  const app = launch();
  let phone = null;
  let ev = null;
  try {
    try {
      // 0. 켤 때 폰 연결이 켜져 있으면 서버가 같이 뜬다. 칸의 claude 도 뜬다.
      assert.ok(await until(() => dom().input && !dom().inputDisabled, 600), "칸의 claude 가 안 켜짐: " + JSON.stringify(dom()));
      assert.ok(dom().remoteButton, "옆칸에 폰 연결 단추가 없음");
      assert.ok(await until(async () => (await fetch(base + "/").then((r) => r.status, () => 0)) === 200, 100), "폰 서버가 안 뜸");

      // 1. 화면 파일은 구운 묶음에서 나온다. 데스크톱 첫 화면은 내주지 않는다. 남의 이름·출처는 막는다.
      const page = await fetch(base + "/");
      const html = await page.text();
      assert.match(html, /<div id="root">/);
      assert.match(html, /mobile\.webmanifest/);
      assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      assert.ok(script, "폰 화면 묶음 경로가 없음: " + html);
      const js = await fetch(base + script, { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(js.status, 200);
      assert.equal(js.headers.get("content-encoding"), "gzip", "묶음을 줄여 보내지 않음");
      assert.equal((await fetch(base + "/mobile-icon.png")).status, 200, "홈 화면 아이콘이 없음");
      assert.equal((await fetch(base + "/main.tsx")).status, 404);
      assert.equal(await withHost("evil.example:" + port), 403, "남의 이름으로 들어온 요청을 받음");
      assert.equal(await withHost("desk.tail1234.ts.net"), 200, "Tailscale 이름으로 들어온 요청을 막음");
      assert.equal(await withHost(`127.0.0.1:${port}`, { Origin: "https://evil.example" }), 403, "남의 출처를 받음");
      assert.equal((await call("remote_panes", {})).status, 401, "토큰 없이 명령을 받음");
      assert.equal((await call("remote_panes", {}, "0".repeat(64))).status, 401, "모르는 토큰을 받음");
      assert.equal((await fetch(base + "/api/events")).status, 401, "토큰 없이 이벤트를 받음");
      const early = await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code: "000000", name: "x" }) });
      assert.equal(early.status, 403, "번호를 받기 전에 짝지어짐");

      // 2. PC 에서 번호를 받아 짝짓는다. 틀린 번호는 거절, 맞는 번호는 토큰 하나.
      commands.push({ in: "side", click: ".side-remote" });
      assert.ok(await until(() => /켜짐/.test(dom().remote?.state ?? ""), 50), "폰 연결 창이 안 뜨거나 꺼져 있음: " + JSON.stringify(dom().remote));
      commands.push({ button: "짝짓기 번호 받기" });
      assert.ok(await until(() => /^\d{6}$/.test(dom().remote?.code ?? ""), 50), "짝짓기 번호가 안 뜸: " + JSON.stringify(dom().remote));
      const code = dom().remote.code;
      const pair = (c) => fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code: c, name: "iPhone" }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
      const wrong = await pair(code === "000000" ? "111111" : "000000");
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body.error, "번호가 틀렸다");
      const ok = await pair(code);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const token = ok.body.token;
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.equal((await pair(code)).status, 403, "한 번 쓴 번호로 또 짝지어짐");
      assert.ok(await until(() => dom().remote?.devices?.some((d) => d.startsWith("iPhone")) && !dom().remote.code, 50), "짝지은 폰이 PC 에 안 보임: " + JSON.stringify(dom().remote));
      const saved = readFileSync(remoteFile, "utf8");
      assert.ok(!saved.includes(token), "토큰을 그대로 적음");

      ev = await listenEvents(token);
      assert.ok(await until(() => /붙은 화면 1/.test(dom().remote?.sub ?? ""), 50), "붙은 화면 수가 안 보임: " + JSON.stringify(dom().remote));

      // 3. 폰은 PC 가 연 칸만 본다.
      const panes = await call("remote_panes", {}, token);
      assert.equal(panes.status, 200);
      assert.deepEqual(
        panes.body.map((p) => [p.id, p.session, p.cwd, p.alive, p.waiting]),
        [["%0", sid, cwd, true, 0]],
        JSON.stringify(panes.body),
      );

      // 4. 폰에서 말하면 PC 칸의 claude 가 받고, PC 대화창에도 그 말과 답이 남는다.
      assert.equal((await call("claude_chat_send", { id: "%0", line: userLine("HELLO_A 폰에서") }, token)).status, 200);
      assert.ok(await until(() => dom().theirs?.some((t) => t.includes("HELLO_A_REPLY")) && dom().mine?.some((t) => t.includes("HELLO_A")), 400), "폰에서 보낸 말이 PC 칸에 안 남음: " + JSON.stringify(dom()));
      assert.ok(ev.frames.some((f) => f.event === "chat:live" && f.payload.session === sid), "쓰이는 중인 답이 폰에 안 옴");
      const lines = ev.frames.filter((f) => f.event === "claude:chat").map((f) => f.payload.line);
      assert.ok(lines.some((l) => l.includes('"type":"result"')), "통로 줄이 폰에 안 옴");
      assert.ok(!lines.some((l) => l.startsWith('{"type":"stream_event"')), "답의 조각을 폰 망에 두 번 실음");
      const raw = await call("claude_transcript_raw", { root: cwd, id: sid }, token);
      assert.match(raw.body, /HELLO_A_REPLY/, "폰이 대화 원문을 못 읽음");

      // 5. 권한 묻기는 폰에도 오고, 폰에서 허락하면 PC 카드도 걷힌다.
      const before = ev.frames.length;
      assert.equal((await call("claude_chat_send", { id: "%0", line: userLine("TOOL_A 폴더") }, token)).status, 200);
      const askOf = (from) => ev.frames.slice(from).map((f) => (f.event === "claude:chat" ? JSON.parse(f.payload.line) : null)).find((m) => m?.type === "control_request" && m.request?.subtype === "can_use_tool");
      assert.ok(await until(() => askOf(before), 300), "권한 묻기가 폰에 안 옴");
      const ask = askOf(before);
      assert.ok(await until(() => dom().perm?.includes("mkdir dir_tool_a"), 100), "PC 에 권한 카드가 안 뜸");
      const snap = await call("claude_chat_snapshot", { id: "%0" }, token);
      assert.equal(snap.body.busy, true);
      assert.equal(snap.body.prompts.length, 1, "통로의 지금 상태에 권한 묻기가 없음: " + JSON.stringify(snap.body));
      assert.match(snap.body.init ?? "", /"subtype":"init"/);
      assert.equal((await call("remote_panes", {}, token)).body[0].waiting, 1);

      // 폰이 할 수 없는 것들. 모두 칸에 닿기 전에 막힌다.
      const refused = async (cmd, args, why) => {
        const r = await call(cmd, args, token);
        assert.equal(r.status, 400, `${why}: ${JSON.stringify(r)}`);
        return r.body.error;
      };
      await refused("claude_chat_send", { id: "%0", line: answer("chiispace-none", "t") }, "기다리지 않는 요청에 답함");
      await refused("claude_chat_send", { id: "%0", line: JSON.stringify({ type: "control_request", request_id: "x", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } }) }, "권한 모드를 바꿈");
      await refused("claude_chat_send", { id: "%9", line: userLine("x") }, "PC 에 없는 칸에 보냄");
      await refused("claude_transcript_raw", { root: cwd, id: randomUUID() }, "다른 대화를 읽음");
      await refused("claude_transcript_raw", { root: "C:/", id: sid }, "다른 폴더로 대화를 읽음");
      for (const cmd of ["pty_write", "claude_chat_start", "claude_chat_stop", "open_memory_file", "save_export", "claude_conversations", "remote_switch", "state_load", "fs_dirs"]) {
        assert.match(await refused(cmd, { id: "%0", data: "x", path: "C:/x.md" }, `${cmd} 을 받음`), /폰에서는 부를 수 없는/);
      }

      assert.equal((await call("claude_chat_send", { id: "%0", line: answer(ask.request_id, ask.request.tool_use_id, "allow", ask.request.input) }, token)).status, 200);
      assert.ok(await until(() => dom().perm === null, 100), "폰에서 답했는데 PC 권한 카드가 남음");
      assert.ok(ev.frames.some((f) => f.event === "claude:chat-answered" && f.payload.request_id === ask.request_id), "답했다는 신호가 안 옴");
      assert.ok(await until(() => dom().theirs?.some((t) => t.includes("TOOL_A_AFTER")), 400), "허락 뒤 답이 PC 에 안 옴");
      assert.ok(existsSync(path.join(project, "dir_tool_a")), "폰에서 허락했는데 실행이 안 됨");
      assert.equal((await call("claude_chat_send", { id: "%0", line: answer(ask.request_id, ask.request.tool_use_id) }, token)).status, 400, "이미 답한 요청에 또 답함");

      // 6. PC 에서 답하면 폰 쪽도 걷을 신호를 받는다.
      const mark = ev.frames.length;
      commands.push({ send: "TOOL_B PC 에서" });
      assert.ok(await until(() => askOf(mark) && dom().perm?.includes("dir_tool_b"), 400), "PC 에서 보낸 말의 권한 묻기가 폰에 안 옴");
      const askB = askOf(mark);
      commands.push({ click: ".ask.perm .ask-no" });
      assert.ok(await until(() => ev.frames.some((f) => f.event === "claude:chat-answered" && f.payload.request_id === askB.request_id), 100), "PC 에서 답한 것이 폰에 안 알려짐");
      assert.ok(await until(() => dom().theirs?.some((t) => t.includes("TOOL_B_AFTER")), 400), "거절 뒤 답이 안 옴");
      assert.equal(existsSync(path.join(project, "dir_tool_b")), false, "거절했는데 실행됨");

      // 7. 폰 화면(헤드리스 Edge, 아이폰 크기). 짝짓기 → 칸 목록 → 칸 → 말하기 → 권한 카드.
      if (edge) {
        phone = await phoneBrowser(path.join(root, "edge-profile"));
        await phone.send("Page.navigate", { url: base + "/" });
        assert.ok(await until(() => phone.evaluate("!!document.querySelector('.m-code')").catch(() => false), 100), "폰 화면에 번호 칸이 안 뜸");
        await phone.shot(path.join(root, "phone-pair.png"));
        // 앞 번호는 짝지을 때 썼다. 번호가 없으면 단추는 "짝짓기 번호 받기"다.
        commands.push({ button: "짝짓기 번호 받기" });
        assert.ok(await until(() => /^\d{6}$/.test(dom().remote?.code ?? ""), 50), "새 번호가 안 뜸: " + JSON.stringify(dom().remote));
        const code2 = dom().remote.code;
        await phone.evaluate(`(() => { const i = document.querySelector('.m-code'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(code2)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await delay(100);
        await phone.evaluate("document.querySelector('.m-go').click()");
        assert.ok(await until(() => phone.evaluate("document.querySelectorAll('.m-row').length === 1"), 100), "폰 화면에 칸 목록이 안 뜸");
        assert.ok(await until(() => dom().remote?.devices?.length === 2, 50), "폰 화면이 짝지어지지 않음: " + JSON.stringify(dom().remote));
        await delay(400);
        await phone.shot(path.join(root, "phone-list.png"));
        const row = await phone.evaluate("document.querySelector('.m-row').textContent");
        assert.match(row, /쉬는 중/, "칸 상태가 안 보임: " + row);
        await phone.evaluate("document.querySelector('.m-row').click()");
        assert.ok(await until(() => phone.evaluate("[...document.querySelectorAll('.msg .bubble')].some(b => b.textContent.includes('TOOL_B_AFTER'))"), 100), "폰 칸에 대화가 안 그려짐");
        assert.ok(await phone.evaluate("!!document.querySelector('.composer-send') && document.querySelector('.composer textarea').placeholder === '보낼 말'"), "폰 입력바가 손가락용이 아님");
        await phone.shot(path.join(root, "phone-pane.png"));
        const type = (t) =>
          phone.evaluate(`(() => { const i = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ${JSON.stringify(t)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        // 화상 키보드의 줄바꿈은 보내지 않는다.
        await type("UI_HELLO 폰 화면에서");
        await delay(100);
        await phone.evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
        await delay(500);
        assert.ok(!requests.some((r) => r.mark === "UI_HELLO"), "폰에서 줄바꿈 키가 보내기가 됨");
        await phone.evaluate("document.querySelector('.composer-send').click()");
        assert.ok(await until(() => phone.evaluate("[...document.querySelectorAll('.msg:not(.live) .bubble')].some(b => b.textContent.includes('UI_HELLO_REPLY'))"), 300), "폰 화면에서 보낸 말의 답이 폰에 안 남음");
        assert.ok(await until(() => dom().theirs?.some((t) => t.includes("UI_HELLO_REPLY")), 100), "폰 화면에서 보낸 말이 PC 칸에 안 남음");
        await type("TOOL_C 폰 화면 권한");
        await phone.evaluate("document.querySelector('.composer-send').click()");
        assert.ok(await until(() => phone.evaluate("document.querySelector('.ask.perm')?.textContent.includes('dir_tool_c') ?? false"), 300), "폰 화면에 권한 카드가 안 뜸");
        assert.ok(await until(() => dom().perm?.includes("dir_tool_c"), 50), "PC 에도 같은 카드가 떠야 함");
        await phone.shot(path.join(root, "phone-permission.png"));
        await phone.evaluate("document.querySelector('.ask.perm .ask-go').click()");
        assert.ok(await until(() => dom().perm === null, 100), "폰 화면에서 답했는데 PC 카드가 남음");
        assert.ok(await until(() => phone.evaluate("[...document.querySelectorAll('.msg:not(.live) .bubble')].some(b => b.textContent.includes('TOOL_C_AFTER'))"), 400), "폰 화면에서 허락한 뒤 답이 안 옴");
        assert.ok(existsSync(path.join(project, "dir_tool_c")), "폰 화면에서 허락했는데 실행이 안 됨");
        await phone.shot(path.join(root, "phone-after.png"));
      } else {
        console.log("Edge 가 없어 폰 화면 검증은 건너뜀");
      }

      // 8. 잊은 폰은 바로 끊기고 다시 못 부른다. 끄면 서버가 내려간다. 다음에 켤 때도 꺼진 채다.
      commands.push({ button: "잊기", nth: 0 });
      assert.ok(await until(() => ev.frames.some((f) => f.event === "__end"), 100), "잊은 폰의 이벤트 스트림이 안 끊김");
      assert.equal((await call("remote_panes", {}, token)).status, 401, "잊은 폰이 명령을 부름");
      commands.push({ button: "끄기" });
      assert.ok(await until(() => /꺼짐/.test(dom().remote?.state ?? ""), 50), "폰 연결이 안 꺼짐");
      // 새 연결은 받지 않는다. 끄기 전에 맺어 둔 연결(fetch 가 다시 쓰는 것)로 온 요청은 503 으로 돌려보낸다.
      const refusedConnect = () =>
        new Promise((r) => {
          const s = net.connect(port, "127.0.0.1");
          s.on("connect", () => (s.destroy(), r(false)));
          s.on("error", () => r(true));
        });
      assert.ok(await until(refusedConnect, 50), "끈 뒤에도 서버가 새 연결을 받음");
      assert.ok([0, 503].includes(await fetch(base + "/").then((r) => r.status, () => 0)), "끈 뒤에 남은 연결로 화면을 내줌");
      const after = JSON.parse(readFileSync(remoteFile, "utf8"));
      assert.equal(after.on, false);
      assert.equal(after.devices.length, edge ? 1 : 0);
    } finally {
      ev?.stop();
      phone?.close();
      await close(app);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
  console.log("remote test files:", root);
  guard("사용자 세션·폰 연결 파일 보호");
});
