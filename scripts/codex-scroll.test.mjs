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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error("실제 Codex 화면 대기 시간 초과");
}

test("실제 Codex의 출력 누적·휠 이동·입력 오염 방지", { skip: !exe || !codex, timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-scroll-"));
  const codexState = path.join(root, "codex-state");
  mkdirSync(codexState);
  const protectedFiles = [
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json")),
    path.join(os.homedir(), ".codex", "config.toml"),
  ];
  const before = protectedFiles.map(hash);
  // 인증 정보와 실제 대화를 가져오지 않고, 모델 요청도 받을 수 없는 로컬 주소만 쓴다.
  writeFileSync(path.join(codexState, "config.toml"), `
model = "scroll-test"
model_provider = "scroll_test"
check_for_update_on_startup = false
[model_providers.scroll_test]
name = "Offline scroll test"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(root)}]
trust_level = "trusted"
`);
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", layout: { kind: "leaf", id: "%0" },
    root: root.replaceAll("\\", "/"), shell: process.env.CHIISPACE_TEST_SHELL || path.join(process.env.SystemRoot, "System32", "cmd.exe") }],
  active: 0, nextPane: 1, nextTab: 1, procs: {} }));
  let latest;
  const observations = [];
  const commands = [];
  const probePath = `/${randomUUID()}`;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== probePath) { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (body) { latest = JSON.parse(body); observations.push(latest); }
      res.end(JSON.stringify(commands.splice(0)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}${probePath}`;
  const env = { ...process.env, CHIISPACE_STATE: state, CODEX_HOME: codexState };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  env[pathKey] = `${path.dirname(codex)};${env[pathKey]}`;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  }
  env.CHIISPACE_PROBE_MS = "1000";
  env.CHIISPACE_PROBE = `(() => {
    let pending = false;
    const data = [];
    let subscribed;
    setInterval(async () => {
      const t = window.__terms?.["%0"];
      if (!t || pending) return;
      if (subscribed !== t) {
        subscribed = t;
        t.onData(s => data.push(s));
      }
      pending = true;
      try {
        const b = t.buffer.active;
        const lines = Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "");
        const r = await fetch(${JSON.stringify(endpoint)}, { method: "POST", body: JSON.stringify({
          type: b.type, baseY: b.baseY, viewportY: b.viewportY, rows: t.rows,
          mouse: t.modes.mouseTrackingMode, text: lines.slice(b.baseY).join("\\n"),
          history: lines.join("\\n"), input: data.splice(0),
          visible: lines.slice(b.viewportY, b.viewportY + t.rows).join("\\n")
        }) });
        for (const c of await r.json()) {
          if (c.input !== undefined) t.input(c.input);
          if (c.wheel !== undefined) {
            const screen = t.element.querySelector(".xterm-screen");
            const rect = screen.getBoundingClientRect();
            screen.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
              clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
              deltaY: c.wheel, deltaMode: 1 }));
          }
        }
      } finally { pending = false; }
    }, 100);
    return "isolated Codex scroll test";
  })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  try {
    await until(() => latest?.text.includes(">"));
    // PowerShell이 시작 심에서 대화형 입력으로 넘어갈 때 첫 바이트를 삼킬 수 있다.
    commands.push({ input: "\r" });
    await delay(500);
    commands.push({ input: "codex --sandbox read-only\r" });
    await until(() => latest.text.includes("Ask Codex to do anything") && latest.text.includes("OpenAI Codex"));
    await delay(1500);
    const count = () => (latest.history.match(/Token usage:\s+0 total/g) ?? []).length;
    for (let i = 0; i < 6; i++) {
      commands.push({ input: "/status" });
      await until(() => latest.text.includes("› /status"));
      // Codex의 빠른 연속 입력 판정이 Enter를 여러 줄 붙여넣기로 묶지 않게 한다.
      await delay(800);
      commands.push({ input: "\r" });
      await until(() => count() === i + 1 && latest.text.includes("Ask Codex to do anything"));
      await delay(300);
    }
    assert.equal(latest.type, "normal");
    assert.ok(latest.baseY > latest.rows, `스크롤백 부족: ${latest.baseY}`);
    assert.equal(latest.viewportY, latest.baseY);
    assert.match(latest.history, /Tip:/, "Codex의 최초 출력 유실");
    const tail = latest.baseY;
    commands.push({ wheel: -15 });
    await until(() => latest.viewportY < tail);
    assert.match(latest.visible, /Token usage:/, "휠로 이동한 화면에 지난 출력이 없음");
    commands.push({ wheel: -1000 });
    await until(() => latest.viewportY === 0);
    assert.match(latest.visible, /Tip:/, "휠로 최초 출력까지 이동 실패");
    commands.push({ wheel: 1000 });
    await until(() => latest.viewportY === latest.baseY);
    assert.equal(count(), 6, "지난 출력의 누락 또는 중복");
    assert.ok(!observations.some((o) => /Working \(|Thread name:|›.*rgb:/.test(o.text)), "조회 응답이 프롬프트로 전송됨");
    assert.ok(!observations.flatMap((o) => o.input).some((s) => /rgb:|\x1b\[\?1;2c/.test(s)), "xterm의 조회 중복 응답");
    console.log(`실제 Codex: 스크롤백 ${latest.baseY}줄, 상태 출력 6개, 휠 상단·하단 이동 확인`);
  } catch (error) {
    writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations));
    console.error("마지막 테스트 화면", latest);
    throw error;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    await until(() => app.exitCode !== null, 5000).catch(() => app.kill());
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·전역 설정 변경");
    console.log(`Codex 검증 세션: ${root}`);
  }
});
