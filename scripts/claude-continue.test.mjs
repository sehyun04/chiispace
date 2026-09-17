import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const hash = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };

test("실제 Claude continue의 구형 복원 전환과 저장 대화 표시", { skip: !exe || !claude, timeout: 70000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-claude-continue-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const sessions = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(sessions, { recursive: true });
  const sid = randomUUID(), userId = randomUUID();
  const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  writeFileSync(path.join(sessions, `${sid}.jsonl`), [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "CHIISPACE_CLAUDE_PRIOR_USER" } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "CHIISPACE_CLAUDE_PRIOR_REPLY" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key"], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), `${home}.json`]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root: project,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, procs: { "%0": { cmd: `claude --resume ${randomUUID()}`, auto: true } } }));
  const protectedFiles = [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json"), path.join(process.env.APPDATA, "com.sehyun.chiispace", "session.json")];
  const before = protectedFiles.map(hash);
  const probe = `/${randomUUID()}`;
  let latest = {};
  const calls = [];
  const commands = [];
  const server = http.createServer((req, res) => {
    if (req.url !== probe) { calls.push(`${req.method} ${req.url}`); res.writeHead(503).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = `${path.dirname(claude)};${env[pathKey]}`;
  env.CHIISPACE_PROBE_MS = "1000";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    const t = window.__terms?.['%0']; if (!t || pending) return; pending = true;
    try { const b = t.buffer.active; const lines = Array.from({length:b.length}, (_,y) => b.getLine(y)?.translateToString(true) ?? '');
      const text = lines.join('\\n'), screen = lines.slice(b.baseY).join('\\n');
      const r = await fetch(${JSON.stringify(base + probe)}, {method:'POST',body:JSON.stringify({text,screen,seeds:window.__restore?.seeds})});
      for (const c of await r.json()) t.input(c);
    } finally { pending = false; }
  }, 100); return 'isolated Claude continue test'; })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const choose = async (arrow, selected) => {
    await delay(750);
    commands.push(arrow);
    for (let i = 0; i < 100 && !selected.test(latest.screen ?? ""); i++) await delay(100);
    assert.match(latest.screen ?? "", selected, "테스트 폴더의 초기 설정 선택 실패");
    commands.push("\r");
    await delay(750);
  };
  try {
    let trustedFixture = false, approvedFixtureKey = false;
    for (let i = 0; i < 450 && !latest.text?.includes("CHIISPACE_CLAUDE_PRIOR_REPLY"); i++) {
      if (!trustedFixture && latest.screen?.includes(project) && latest.screen.includes("Yes, I trust this folder")) {
        trustedFixture = true;
        await choose("\x1b[B", /❯ Yes, I trust this folder/);
      }
      if (!approvedFixtureKey && latest.screen?.includes("hiispace-fixture-key") && latest.screen.includes("Do you want to use this API key?")) {
        approvedFixtureKey = true;
        await choose("\x1b[A", /❯ Yes/);
      }
      await delay(100);
    }
    assert.equal(latest.seeds?.["%0"]?.cmd, "claude --continue");
    assert.match(latest.text ?? "", /CHIISPACE_CLAUDE_PRIOR_REPLY/, "실제 Claude에서 저장된 대화 미표시");
    assert.equal(app.exitCode, null);
    // CLI의 연결 확인도 외부로 나가지 않고 이 테스트 서버에서만 받는다.
    assert.deepEqual(calls.filter(c => c !== "HEAD /api/hello"), [], "이어가기 검증 중 모델 API 요청 발생");
    console.log("실제 Claude --continue의 합성 저장 대화 표시 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, calls }));
    console.error("Claude 이어가기 검증 기록", root);
    throw e;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·Claude 설정 변경");
  }
});
