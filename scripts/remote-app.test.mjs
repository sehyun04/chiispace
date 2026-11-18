import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watchUserFiles } from "./user-files.mjs";
import { Link, pair, socketUrl } from "../ui/phone-link.ts";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const wrangler = path.join(relayDir, "node_modules", ".bin", "wrangler.cmd");
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
const killTree = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
const userLine = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
const answer = (requestId, toolUseId, behavior = "allow", input = {}) =>
  JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: behavior === "allow" ? { behavior, updatedInput: input, toolUseID: toolUseId } : { behavior, message: "no", toolUseID: toolUseId } },
  });

/** 별도 프로필의 헤드리스 Edge 한 탭(아이폰 크기). 사용자 브라우저·OS 입력을 쓰지 않고 페이지 안에서만 누른다(CDP). */
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
      killTree(proc.pid);
    },
  };
}

test("폰 연결 — Cloudflare 중계(로컬), 숫자 비교 짝짓기, 암호 통로로 말하기·권한 답하기, PC 와 카드 맞추기, 막기", { skip: !exe || !claude || !existsSync(wrangler), timeout: 480000 }, async () => {
  // 격리: 별도 앱 세션·CLAUDE_CONFIG_DIR·폰 연결 설정(remote.json 은 세션 파일 옆), 가짜 키와 가짜 Anthropic 서버,
  // 중계는 wrangler 로 이 PC 안에 띄운 것(상태 폴더도 따로). Cloudflare 계정에는 닿지 않는다.
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

  // 로컬 중계.
  const relayPort = await freePort();
  const relayBase = `http://127.0.0.1:${relayPort}`;
  // .cmd 는 셸로만 뜬다. 인자를 따로 주면 Node 가 이스케이프 경고를 내므로 한 줄로 준다(경로는 우리가 만든 것뿐이다).
  const relay = spawn(`"${wrangler}" dev --ip 127.0.0.1 --port ${relayPort} --persist-to "${path.join(root, "relay-state")}"`, {
    cwd: relayDir,
    shell: true,
    windowsHide: true,
    stdio: "ignore",
  });
  const room = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const remoteFile = path.join(root, "remote.json");
  writeFileSync(remoteFile, JSON.stringify({ on: true, relay: relayBase, room, secret, devices: [] }));
  const page = `${relayBase}/r/${room}/`;
  const wsUrl = socketUrl(page);

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
          page: panel.querySelector('.remote-url')?.textContent ?? null,
          qr: !!panel.querySelector('.remote-qr path'),
          pair: panel.querySelector('.remote-pair')?.textContent ?? null,
          sas: panel.querySelector('.remote-digits')?.dataset.sas ?? null,
          devices: texts(panel, '.remote-dev span'),
          sub: panel.querySelector('.remote-sub:last-of-type')?.textContent ?? null,
          subs: texts(panel, '.remote-sub'),
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
  /** PC 를 흉내 내는 붙기. 웹소켓 업그레이드 요청에 비밀을 실어 보내고 상태 번호만 본다. */
  const pcUpgrade = (bearer) =>
    new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: relayPort,
        path: `/pc/${room}`,
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Authorization: `Bearer ${bearer}` },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.on("error", () => resolve(0));
      req.end();
    });
  /** 평문으로 말하는 날것의 폰. 짝짓기 규칙을 어기는 말을 보내 본다. */
  const rawPhone = async () => {
    const ws = new WebSocket(wsUrl);
    const got = [];
    ws.addEventListener("message", (e) => {
      try {
        got.push(JSON.parse(e.data));
      } catch {}
    });
    await new Promise((r, j) => {
      ws.addEventListener("open", r, { once: true });
      ws.addEventListener("error", j, { once: true });
    });
    return { ws, got, send: (m) => ws.send(JSON.stringify(m)) };
  };
  const launch = () => spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const close = async (app) => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
  };

  // CHIISPACE_TEST_SCREENSHOT=1 이면 PC 쪽 [폰 연결] 창을 검증 창에서 찍는다. 사용자 창은 건드리지 않는다.
  const shot = (name) => {
    if (process.env.CHIISPACE_TEST_SCREENSHOT !== "1" || !app) return;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid), "-WaitSec", "1", "-Out", path.join(root, name + ".png")], { windowsHide: true, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  const RealWebSocket = globalThis.WebSocket;
  let app = null;
  let phone = null;
  let link = null;
  try {
    try {
      assert.ok(await until(async () => (await fetch(relayBase + "/").then((r) => r.status, () => 0)) === 404, 300), "로컬 중계가 안 뜸");
      app = launch();
      // 0. 켤 때 폰 연결이 켜져 있으면 중계에 붙는다. 칸의 claude 도 뜬다.
      assert.ok(await until(() => dom().input && !dom().inputDisabled, 600), "칸의 claude 가 안 켜짐: " + JSON.stringify(dom()));
      assert.ok(dom().remoteButton, "옆칸에 폰 연결 단추가 없음");
      commands.push({ in: "side", click: ".side-remote" });
      assert.ok(await until(() => /중계에 붙음/.test(dom().remote?.state ?? ""), 200), "중계에 안 붙음: " + JSON.stringify(dom().remote));
      assert.equal(dom().remote.page, page, "폰 주소가 방 주소가 아님");
      assert.ok(dom().remote.qr, "폰 주소 QR 이 없음");
      shot("pc-panel");

      // 1. 폰 화면 파일은 PC 앱이 구워 넣은 폰 묶음에서 중계를 거쳐 나온다. 데스크톱 화면 파일은 안 나온다.
      const html = await fetch(page);
      assert.equal(html.status, 200);
      const text = await html.text();
      assert.match(text, /<div id="root">/);
      assert.match(html.headers.get("content-security-policy") ?? "", /connect-src 'self' wss:\/\/127\.0\.0\.1:\d+ ws:\/\/127\.0\.0\.1:\d+; frame-ancestors 'none'/);
      const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(text)?.[1];
      assert.ok(script, "폰 묶음 경로가 상대 경로가 아님: " + text);
      const js = await fetch(page + script);
      assert.equal(js.status, 200);
      assert.match(js.headers.get("cache-control") ?? "", /immutable/);
      assert.ok((await js.text()).length > 100000, "폰 묶음이 덜 옴(조각 잇기)");
      assert.equal((await fetch(page + "mobile.webmanifest")).headers.get("content-type"), "application/manifest+json");
      assert.equal((await fetch(page + "index.html")).status, 404, "데스크톱 화면 파일을 내줌");
      assert.equal((await fetch(`${relayBase}/r/${randomBytes(16).toString("hex")}/`)).status, 503, "다른 방이 PC 를 봄");
      // 방 주인은 처음 붙은 PC 의 비밀이다. 다른 비밀로는 PC 자리에 못 붙는다.
      assert.equal(await pcUpgrade(randomBytes(32).toString("hex")), 403, "다른 비밀로 PC 자리에 붙음");

      // 2. 짝짓기는 PC 에서 [폰 짝짓기]를 누른 동안만 된다.
      await assert.rejects(pair(wsUrl, "iPhone", () => {}), /폰 짝짓기/);
      commands.push({ button: "폰 짝짓기" });
      assert.ok(await until(() => /폰에서 \[연결\]/.test(dom().remote?.pair ?? ""), 50), "짝짓기 받기가 안 열림: " + JSON.stringify(dom().remote));
      // 약속한 키와 다른 키를 열면 거절한다(중계가 키를 바꿔치기하는 경우).
      const raw = await rawPhone();
      assert.ok(await until(() => raw.got.some((m) => m.relay === "pc-online"), 50));
      raw.send({ k: "pair1", c: Buffer.from(createHash("sha256").update(randomBytes(81)).digest()).toString("base64url"), name: "x" });
      assert.ok(await until(() => raw.got.some((m) => m.k === "pair2"), 50), "pair2 가 안 옴");
      const fake = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url");
      raw.send({ k: "pair3", pub: fake, na: randomBytes(16).toString("base64url") });
      assert.ok(await until(() => raw.got.some((m) => m.k === "no" && /맞지 않는다/.test(m.why)), 50), "약속을 어긴 짝짓기를 받음: " + JSON.stringify(raw.got));
      // 모르는 기기의 인사는 거절한다.
      raw.send({ k: "hello", dev: "0123456789abcdef", na: randomBytes(16).toString("base64url") });
      assert.ok(await until(() => raw.got.some((m) => m.k === "no" && m.why === "unknown"), 50), "모르는 기기를 받음");
      // 키 없이 보낸 암호 덩이는 아무 답도 없다.
      raw.send({ k: "x", n: 0, c: "AAAA" });
      await delay(500);
      assert.ok(!raw.got.some((m) => m.k === "x"), "키 없는 덩이에 답함");
      raw.ws.close();

      // 3. 숫자 비교 짝짓기. 두 화면의 여섯 자리가 같고, PC 에서 [맞다]를 눌러야 끝난다.
      let shown = null;
      const pairing = pair(wsUrl, "iPhone", (s) => (shown = s));
      assert.ok(await until(() => shown && dom().remote?.sas, 100), "숫자가 안 뜸: " + JSON.stringify(dom().remote));
      assert.equal(dom().remote.sas, shown, "PC 와 폰의 숫자가 다름");
      shot("pc-sas");
      commands.push({ button: "맞다" });
      const paired = await pairing;
      assert.match(paired.dev, /^[0-9a-f]{16}$/);
      assert.ok(await until(() => dom().remote?.devices?.some((d) => d.startsWith("iPhone")) && !dom().remote.sas, 50), "짝지은 폰이 PC 에 안 보임: " + JSON.stringify(dom().remote));
      // [아니다]를 누르면 짝짓기가 끝나지 않는다.
      commands.push({ button: "폰 짝짓기" });
      assert.ok(await until(() => /폰에서 \[연결\]/.test(dom().remote?.pair ?? ""), 50));
      const refused = pair(wsUrl, "다른 폰", () => {});
      assert.ok(await until(() => dom().remote?.sas, 100), "두 번째 숫자가 안 뜸");
      commands.push({ button: "아니다" });
      await assert.rejects(refused, /숫자가 다르다/);
      commands.push({ button: "그만" });
      assert.ok(await until(() => dom().remote?.devices?.length === 1 && !/폰에서 \[연결\]/.test(dom().remote?.pair ?? ""), 50), "거절한 폰이 남음: " + JSON.stringify(dom().remote));
      const saved = readFileSync(remoteFile, "utf8");
      assert.ok(!saved.includes(paired.jwk.d), "폰 비밀키가 PC 에 적힘");

      // 4. 평소 연결. 중계를 지나는 날것의 줄은 모두 엿본다 — 대화 글자가 보이면 안 된다.
      const wire = [];
      globalThis.WebSocket = class extends RealWebSocket {
        constructor(...a) {
          super(...a);
          this.addEventListener("message", (e) => wire.push(String(e.data)));
        }
      };
      const events = [];
      let status = null;
      let unpaired = false;
      link = new Link({ url: wsUrl, paired, onStatus: (s) => (status = s), onEvent: (e, p) => events.push({ e, p }), onUnpaired: () => (unpaired = true) });
      link.start();
      assert.ok(await until(() => status === "open", 100), "평소 연결이 안 열림: " + status);
      assert.ok(await until(() => dom().remote?.subs?.some((t) => /붙은 화면 1/.test(t)), 50), "붙은 화면 수가 안 보임: " + JSON.stringify(dom().remote));
      const call = (cmd, args) => link.invoke(cmd, args);
      const panes = await call("remote_panes", {});
      assert.deepEqual(panes.map((p) => [p.id, p.session, p.cwd, p.alive, p.waiting]), [["%0", sid, cwd, true, 0]], JSON.stringify(panes));

      // 5. 폰에서 말하면 PC 칸의 claude 가 받고, PC 대화창에도 그 말과 답이 남는다.
      await call("claude_chat_send", { id: "%0", line: userLine("HELLO_A 폰에서") });
      assert.ok(await until(() => dom().theirs?.some((t) => t.includes("HELLO_A_REPLY")) && dom().mine?.some((t) => t.includes("HELLO_A")), 400), "폰에서 보낸 말이 PC 칸에 안 남음: " + JSON.stringify(dom()));
      assert.ok(events.some((x) => x.e === "chat:live" && JSON.stringify(x.p).includes("HELLO_A_REPLY")), "쓰이는 중인 답이 폰에 안 옴");
      const lines = events.filter((x) => x.e === "claude:chat").map((x) => x.p.line);
      assert.ok(lines.some((l) => l.includes('"type":"result"')), "통로 줄이 폰에 안 옴");
      assert.ok(!lines.some((l) => l.startsWith('{"type":"stream_event"')), "답의 조각을 폰 망에 두 번 실음");
      const rawText = await call("claude_transcript_raw", { root: cwd, id: sid });
      assert.match(rawText, /HELLO_A_REPLY/, "폰이 대화 원문을 못 읽음");
      assert.ok(wire.length > 10, "엿본 줄이 없음");
      assert.ok(!wire.some((w) => /HELLO_A|claude:chat|remote_panes|안녕/.test(w)), "중계를 지나는 줄에 평문이 보임: " + wire.find((w) => /HELLO_A|claude:chat|안녕/.test(w))?.slice(0, 200));
      assert.ok(wire.some((w) => /"z":true/.test(w)), "긴 원문을 줄여 보내지 않음");

      // 6. 권한 묻기는 폰에도 오고, 폰에서 허락하면 PC 카드도 걷힌다.
      const before = events.length;
      await call("claude_chat_send", { id: "%0", line: userLine("TOOL_A 폴더") });
      const askOf = (from) => events.slice(from).map((x) => (x.e === "claude:chat" ? JSON.parse(x.p.line) : null)).find((m) => m?.type === "control_request" && m.request?.subtype === "can_use_tool");
      assert.ok(await until(() => askOf(before), 300), "권한 묻기가 폰에 안 옴");
      const ask = askOf(before);
      assert.ok(await until(() => dom().perm?.includes("mkdir dir_tool_a"), 100), "PC 에 권한 카드가 안 뜸");
      const snap = await call("claude_chat_snapshot", { id: "%0" });
      assert.equal(snap.busy, true);
      assert.equal(snap.prompts.length, 1, "통로의 지금 상태에 권한 묻기가 없음: " + JSON.stringify(snap));
      assert.match(snap.init ?? "", /"subtype":"init"/);
      assert.equal((await call("remote_panes", {}))[0].waiting, 1);
      const refuse = async (cmd, args, why) => {
        const e = await call(cmd, args).then(() => null, (e) => String(e));
        assert.ok(e, `${why}: 받음`);
        return e;
      };
      await refuse("claude_chat_send", { id: "%0", line: answer("chiispace-none", "t") }, "기다리지 않는 요청에 답함");
      await refuse("claude_chat_send", { id: "%0", line: JSON.stringify({ type: "control_request", request_id: "x", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } }) }, "권한 모드를 바꿈");
      await refuse("claude_chat_send", { id: "%9", line: userLine("x") }, "PC 에 없는 칸에 보냄");
      await refuse("claude_transcript_raw", { root: cwd, id: randomUUID() }, "다른 대화를 읽음");
      await refuse("claude_transcript_raw", { root: "C:/", id: sid }, "다른 폴더로 대화를 읽음");
      for (const cmd of ["pty_write", "claude_chat_start", "claude_chat_stop", "open_memory_file", "save_export", "claude_conversations", "remote_switch", "remote_pairing", "remote_confirm", "state_load", "fs_dirs"]) {
        assert.match(await refuse(cmd, { id: "%0", data: "x", path: "C:/x.md", on: true, ok: true }, `${cmd} 을 받음`), /폰에서는 부를 수 없는/);
      }
      await call("claude_chat_send", { id: "%0", line: answer(ask.request_id, ask.request.tool_use_id, "allow", ask.request.input) });
      assert.ok(await until(() => dom().perm === null, 100), "폰에서 답했는데 PC 권한 카드가 남음");
      assert.ok(events.some((x) => x.e === "claude:chat-answered" && x.p.request_id === ask.request_id), "답했다는 신호가 안 옴");
      assert.ok(await until(() => dom().theirs?.some((t) => t.includes("TOOL_A_AFTER")), 400), "허락 뒤 답이 PC 에 안 옴");
      assert.ok(existsSync(path.join(project, "dir_tool_a")), "폰에서 허락했는데 실행이 안 됨");
      await refuse("claude_chat_send", { id: "%0", line: answer(ask.request_id, ask.request.tool_use_id) }, "이미 답한 요청에 또 답함");

      // 7. PC 에서 답하면 폰 쪽도 걷을 신호를 받는다.
      const mark = events.length;
      commands.push({ send: "TOOL_B PC 에서" });
      assert.ok(await until(() => askOf(mark) && dom().perm?.includes("dir_tool_b"), 400), "PC 에서 보낸 말의 권한 묻기가 폰에 안 옴");
      const askB = askOf(mark);
      commands.push({ click: ".ask.perm .ask-no" });
      assert.ok(await until(() => events.some((x) => x.e === "claude:chat-answered" && x.p.request_id === askB.request_id), 100), "PC 에서 답한 것이 폰에 안 알려짐");
      assert.ok(await until(() => dom().theirs?.some((t) => t.includes("TOOL_B_AFTER")), 400), "거절 뒤 답이 안 옴");
      assert.equal(existsSync(path.join(project, "dir_tool_b")), false, "거절했는데 실행됨");

      // 8. 폰 화면(헤드리스 Edge, 아이폰 크기). 숫자 비교 짝짓기 → 칸 목록 → 칸 → 말하기 → 권한 카드.
      if (edge) {
        phone = await phoneBrowser(path.join(root, "edge-profile"));
        await phone.send("Page.navigate", { url: page });
        assert.ok(await until(() => phone.evaluate("!!document.querySelector('.m-go')").catch(() => false), 150), "폰 화면에 연결 단추가 안 뜸");
        await phone.shot(path.join(root, "phone-pair.png"));
        commands.push({ button: "폰 짝짓기" });
        assert.ok(await until(() => /폰에서 \[연결\]/.test(dom().remote?.pair ?? ""), 50));
        await phone.evaluate("document.querySelector('.m-go').click()");
        assert.ok(await until(async () => dom().remote?.sas && (await phone.evaluate("document.querySelector('.m-sas')?.dataset.sas ?? null")) === dom().remote.sas, 150), "폰 화면과 PC 의 숫자가 안 맞음");
        await phone.shot(path.join(root, "phone-sas.png"));
        commands.push({ button: "맞다" });
        assert.ok(await until(() => phone.evaluate("document.querySelectorAll('.m-row').length === 1"), 150), "폰 화면에 칸 목록이 안 뜸");
        assert.ok(await until(() => dom().remote?.devices?.length === 2, 50), "폰 화면이 짝지어지지 않음: " + JSON.stringify(dom().remote));
        await delay(400);
        await phone.shot(path.join(root, "phone-list.png"));
        await phone.evaluate("document.querySelector('.m-row').click()");
        assert.ok(await until(() => phone.evaluate("[...document.querySelectorAll('.msg .bubble')].some(b => b.textContent.includes('TOOL_B_AFTER'))"), 150), "폰 칸에 대화가 안 그려짐");
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

      // 9. 잊은 폰은 바로 끊기고, 다시 붙으면 PC 가 모른다고 해서 짝짓기 화면으로 돌아간다.
      commands.push({ button: "잊기", nth: 0 });
      assert.ok(await until(() => unpaired, 150), "잊은 폰이 안 끊김");
      await assert.rejects(link.invoke("remote_panes", {}));
      link.stop();
      // 10. 끄면 중계에서 PC 가 사라진다. 폰 화면은 PC 가 안 보인다고 알린다. 다음에 켤 때도 꺼진 채다.
      commands.push({ button: "끄기" });
      assert.ok(await until(() => /꺼짐/.test(dom().remote?.state ?? ""), 50), "폰 연결이 안 꺼짐");
      // 끈 PC 는 중계에서 바로 사라져야 한다. 남아 있으면 화면 요청이 답 없는 PC 에 20초씩 붙잡힌다(504).
      assert.ok(await until(async () => (await fetch(page, { signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0)) === 503, 30), "끈 뒤에도 PC 가 중계에 붙어 있음");
      if (edge) assert.ok(await until(() => phone.evaluate("document.querySelector('.m-link.off')?.textContent ?? ''").then((t) => /PC 가 안 보인다/.test(t)), 100), "폰 화면이 PC 가 꺼진 것을 모름");
      const after = JSON.parse(readFileSync(remoteFile, "utf8"));
      assert.equal(after.on, false);
      assert.equal(after.devices.length, edge ? 1 : 0);
      assert.equal(after.room, room, "방이 바뀜");
    } finally {
      globalThis.WebSocket = RealWebSocket;
      link?.stop();
      phone?.close();
      if (app) await close(app);
    }
  } finally {
    killTree(relay.pid);
    server.closeAllConnections();
    server.close();
  }
  console.log("remote test files:", root);
  guard("사용자 세션·폰 연결 파일 보호");
});
