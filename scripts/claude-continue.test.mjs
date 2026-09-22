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

test("같은 폴더의 두 칸 모두 선택 목록 없이 이어가기 명령을 받는다", { skip: !exe, timeout: 70000 }, async () => {
  // 사용자는 한 폴더에 칸을 여러 개 띄워 쓴다. 둘째 칸부터 선택 목록으로 돌리던 가드를 뺐으므로
  // 두 칸 모두 저장된 이어가기 명령을 그대로 받아 실행해야 한다.
  // 앱이 자기 claude 래퍼를 PATH 맨 앞에 넣으므로 대역으로는 가로챌 수 없다. 대신 CLAUDE_CONFIG_DIR 로
  // 격리해 사용자 설정·대화를 건드리지 않는다. 모델 요청까지 가지 않고 폴더 신뢰 확인에서 멈춘다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-continue-dup-"));
  const project = path.join(root, "project");
  const claudeHome = path.join(root, "claude-state");
  mkdirSync(project);
  mkdirSync(claudeHome, { recursive: true });
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [0, 1].map(i => ({ key: "t" + i, focus: "%" + i, root: project, shell,
      layout: { kind: "leaf", id: "%" + i } })),
    active: 0, nextPane: 2, nextTab: 2, restoreMode: "native-continue",
    procs: { "%0": { cmd: "claude --continue", auto: true, cwd: project },
             "%1": { cmd: "claude --continue", auto: true, cwd: project } },
  }));
  // 사용자 앱이 떠 있으면 그 앱이 자기 세션을 계속 저장하므로 이 해시는 우리 탓이 아니어도 바뀐다.
  // CHIISPACE_STATE 를 준 앱은 사용자 자리를 아예 열지 않으니(probe_state_file 이 legacy 까지 막는다)
  // 떠 있을 때는 비교에서 빼고 그 사실을 남긴다. 닫혀 있으면 평소대로 엄격히 본다.
  const running = (name) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process ${name} -ErrorAction SilentlyContinue | Measure-Object).Count`],
    { encoding: "utf8", windowsHide: true }).stdout.trim() !== "0";
  const liveApp = running("chiispace"), liveClaude = running("claude");
  const userState = path.join(process.env.APPDATA, "com.sehyun.chiispace", "session.json");
  const claudeFiles = [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json")];
  const protectedFiles = [...(liveClaude ? [] : claudeFiles), ...(liveApp ? [] : [userState])];
  const before = protectedFiles.map(hash);
  const probe = `/${randomUUID()}`;
  let latest = {};
  const server = http.createServer((req, res) => {
    if (req.url !== probe) { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end("[]"); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CHIISPACE_STATE: state };
  for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  env.CLAUDE_CONFIG_DIR = claudeHome;
  env.CHIISPACE_PROBE_MS = "500";
  const probeUrl = `http://127.0.0.1:${server.address().port}${probe}`;
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const panes = {};
      for (const id of ['%0', '%1']) {
        const b = window.__terms?.[id]?.buffer.active;
        panes[id] = b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '') : null;
      }
      await fetch(${JSON.stringify(probeUrl)}, {method:'POST',body:JSON.stringify({panes,seeds:window.__restore?.seeds})});
    } finally { pending = false; }
  }, 100); return 'isolated duplicate continue test'; })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const screen = id => (latest.panes?.[id] ?? []).join("\n");
  try {
    for (let i = 0; i < 500 && !["%0", "%1"].every(id => /claude --continue/.test(screen(id))); i++) await delay(100);
    // 앱이 계획한 명령: 둘째 칸도 선택 목록(--resume)이 아니라 이어가기여야 한다.
    for (const id of ["%0", "%1"]) {
      assert.equal(latest.seeds?.[id]?.cmd, "claude --continue", `${id} 이 이어가기 명령을 못 받음`);
      assert.ok(!latest.seeds[id].notice, `${id} 에 선택 안내가 남음`);
    }
    // 그 명령이 실제로 셸에 들어갔는지, 선택 목록이 섞이지 않았는지 화면으로 확인한다.
    for (const id of ["%0", "%1"]) {
      assert.match(screen(id), /claude --continue/, `${id} 에서 이어가기 명령이 실행되지 않음`);
      assert.doesNotMatch(screen(id), /--resume|--session-id/, `${id} 에 선택 목록·ID 복원이 섞임`);
    }
    assert.equal(app.exitCode, null);
    console.log("같은 폴더 두 칸 모두 --continue 실행 확인", root);
    // 검증이 제 자리에만 썼는지 확인한다 — 임시 세션은 갱신되고 사용자 자리는 손대지 않는다.
    assert.notEqual(hash(state), null, "임시 세션 파일이 사라짐");
    // 격리한 claude 는 폴더 신뢰 확인에서 멈추므로 모델 요청도, 사용자 설정 변경도 없다.
    if (liveApp) console.log("사용자 앱이 실행 중이라 사용자 세션 해시는 비교하지 않았다:", userState);
    if (liveClaude) console.log("사용자 claude 가 실행 중이라 claude 설정 해시는 비교하지 않았다. 이 테스트의 claude 는 CLAUDE_CONFIG_DIR 로 격리했다.");
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify(latest));
    console.error("중복 칸 이어가기 검증 기록", root);
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
