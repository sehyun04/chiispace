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
  // 사용자 앱·claude 가 떠 있으면 그것들이 자기 파일을 계속 쓴다. 우리 탓이 아닌 변화라
  // 실행 중일 때는 비교에서 빼고 뺐다는 사실을 남긴다. 이 테스트의 claude 는 CLAUDE_CONFIG_DIR 로 격리한다.
  const busy = (name) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process ${name} -ErrorAction SilentlyContinue | Measure-Object).Count`],
    { encoding: "utf8", windowsHide: true }).stdout.trim() !== "0";
  const otherApp = busy("chiispace"), otherClaude = busy("claude");
  const protectedFiles = [
    ...(otherClaude ? [] : [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json")]),
    ...(otherApp ? [] : [path.join(process.env.APPDATA, "com.sehyun.chiispace", "session.json")])];
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

test("칸마다 제 대화로 되살아나고 서로 섞이지 않는다", { skip: !exe || !claude, timeout: 120000 }, async () => {
  // 사용자가 겪은 것: 껐다 켜면 모든 칸이 같은 대화로 열렸다. `--continue` 는 폴더 기준이라
  // 칸을 구별할 수단이 없기 때문이다. 이제 칸마다 그 칸의 claude 가 자기 pid 명부에 써 둔
  // 대화 id 를 들고 `--resume` 한다. 두 칸이 서로 다른 대화를 보여야 통과다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-per-pane-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const sessions = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(sessions, { recursive: true });
  const ids = { "%0": randomUUID(), "%1": randomUUID() };
  const marks = { "%0": "CHIISPACE_PANE_A_ONLY", "%1": "CHIISPACE_PANE_B_ONLY" };
  for (const pane of ["%0", "%1"]) {
    const sid = ids[pane], userId = randomUUID();
    const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
    writeFileSync(path.join(sessions, `${sid}.jsonl`), [
      { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: `ASK_${marks[pane]}` } },
      { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_" + sid.slice(0, 8), type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: marks[pane] }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map(v => JSON.stringify(v)).join("\n") + "\n");
  }
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key"], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), `${home}.json`]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [0, 1].map(i => ({ key: "t" + i, focus: "%" + i, root: project, shell, layout: { kind: "leaf", id: "%" + i } })),
    active: 0, nextPane: 2, nextTab: 2, restoreMode: "native-continue",
    procs: Object.fromEntries(["%0", "%1"].map(id => [id, { cmd: "claude --continue", auto: true, cwd: project, claudeSession: ids[id] }])),
  }));
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
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey2 = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey2] = `${path.dirname(claude)};${env[pathKey2]}`;
  env.CHIISPACE_PROBE_MS = "500";
  const probeUrl2 = `${apiBase}${probe}`;
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const panes = {};
      for (const id of ['%0', '%1']) {
        const b = window.__terms?.[id]?.buffer.active;
        panes[id] = b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '') : null;
      }
      const r = await fetch(${JSON.stringify(probeUrl2)}, {method:'POST',body:JSON.stringify({panes,seeds:window.__restore?.seeds})});
      for (const c of await r.json()) window.__terms?.[c.id]?.input(c.input);
    } finally { pending = false; }
  }, 100); return 'isolated per-pane session test'; })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const screen = id => (latest.panes?.[id] ?? []).join("\n");
  const readState = () => JSON.parse(readFileSync(state, "utf8"));
  try {
    // 격리한 fixture 키와 임시 폴더라 claude 가 확인을 묻는다. 칸마다 한 번씩 넘긴다.
    const ESC = String.fromCharCode(27), CR = String.fromCharCode(13);
    const settled = { "%0": false, "%1": false };
    const confirm = (id, screenText) => {
      if (settled[id]) return;
      if (/Do you want to use this API key/.test(screenText) && /❯ No/.test(screenText)) {
        commands.push({ id, input: ESC + "[A" });
        return;
      }
      if (/Do you want to use this API key/.test(screenText) && /❯ Yes/.test(screenText)) {
        commands.push({ id, input: CR });
        settled[id] = true;
        return;
      }
      if (/trust this folder/.test(screenText) && /❯ No/.test(screenText)) {
        commands.push({ id, input: ESC + "[B" });
        return;
      }
      if (/trust this folder/.test(screenText) && /❯ Yes/.test(screenText)) {
        commands.push({ id, input: CR });
      }
    };
    for (let i = 0; i < 900 && !["%0", "%1"].every(id => screen(id).includes(marks[id])); i++) {
      for (const id of ["%0", "%1"]) confirm(id, screen(id));
      await delay(100);
    }
    for (const id of ["%0", "%1"]) {
      // 복원 명령이 그 칸의 대화를 가리켜야 한다.
      assert.equal(latest.seeds?.[id]?.cmd, `claude --resume ${ids[id]}`, `${id} 이 제 대화로 복원되지 않음`);
      // 그리고 화면에 그 대화의 내용이 떠야 한다.
      assert.match(screen(id), new RegExp(marks[id]), `${id} 에 제 대화가 안 보임`);
    }
    // 핵심: 두 칸이 같은 대화로 열리면 안 된다. 사용자가 겪은 증상이 그것이다.
    assert.doesNotMatch(screen("%0"), /CHIISPACE_PANE_B_ONLY/, "첫 칸에 다른 칸의 대화가 섞임");
    assert.doesNotMatch(screen("%1"), /CHIISPACE_PANE_A_ONLY/, "둘째 칸에 다른 칸의 대화가 섞임");
    // 저장(명부 -> 칸)은 pid 와 칸을 이어 줄 근거가 있어야 보는데, claude 는 실행 뒤 자기
    // 명령줄에서 대화 id 를 지운다. 칸이 둘이면 어느 pid 가 어느 칸인지 밖에서 알 길이 없어,
    // 저장은 매핑이 자명한 한 칸짜리 테스트에서 따로 본다.
    assert.equal(app.exitCode, null);
    assert.deepEqual(calls.filter(c => c !== "HEAD /api/hello"), [], "검증 중 모델 API 요청 발생");
    console.log("칸마다 제 대화로 복원·저장 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, calls, state: readState() }));
    console.error("칸별 대화 복원 검증 기록", root);
    throw e;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test("칸이 돌리는 대화를 claude 명부에서 읽어 저장한다", { skip: !exe || !claude, timeout: 120000 }, async () => {
  // 칸마다 제 대화로 돌아오려면 "이 칸이 어느 대화인가"가 저장돼 있어야 한다. 그 답은 claude 가
  // 자기 pid 로 쓰는 명부(`<config>/sessions/<pid>.json`)에서만 온다 — 대화 파일을 뒤져 고르지
  // 않는다. 칸을 하나만 두어 pid 와 칸의 대응을 분명히 한 뒤 앱이 그 명부를 읽어 저장하는지 본다.
  // 격리한 claude 는 명부를 남기지 않으므로(폴더만 만든다) 실사용에서 그 파일이 놓이는 자리에
  // 테스트가 같은 내용을 놓는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-roster-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const store = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(store, { recursive: true });
  const sid = randomUUID(), userId = randomUUID();
  const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  writeFileSync(path.join(store, sid + ".jsonl"), [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "ASK_CHIISPACE_ROSTER" } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_roster", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "CHIISPACE_ROSTER_MARK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
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
  const key3 = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[key3] = path.dirname(claude) + ";" + env[key3];
  env.CHIISPACE_PROBE_MS = "500";
  const url3 = apiBase + probe;
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const b = window.__terms?.['%0']?.buffer.active;
      const pane = b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '') : null;
      const r = await fetch(${JSON.stringify(url3)}, {method:'POST',body:JSON.stringify({pane,seeds:window.__restore?.seeds})});
      for (const c of await r.json()) window.__terms?.['%0']?.input(c);
    } finally { pending = false; }
  }, 100); return 'isolated roster test'; })()`;
  const claudeBefore = claudePids();
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const screen = () => (latest.pane ?? []).join("\n");
  const readState = () => JSON.parse(readFileSync(state, "utf8"));
  const ESC = String.fromCharCode(27), CR = String.fromCharCode(13);
  // ConPTY 가 중간에 끼어서 앱 pid 아래 자손으로는 잡히지 않는다. 대신 이 테스트가 앱을
  // 띄우기 전후의 차이로 고른다 — 칸이 하나뿐이라 새로 생긴 claude 도 하나여야 한다.
  const claudePids = () => {
    const raw = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Process claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: "utf8", windowsHide: true }).stdout.trim();
    return new Set(raw ? raw.split(",").map(Number) : []);
  };
  try {
    let settled = false;
    for (let i = 0; i < 900 && !screen().includes("CHIISPACE_ROSTER_MARK"); i++) {
      const s = screen();
      if (!settled && /Do you want to use this API key/.test(s)) {
        if (/❯ No/.test(s)) commands.push(ESC + "[A");
        else if (/❯ Yes/.test(s)) { commands.push(CR); settled = true; }
      }
      await delay(100);
    }
    assert.match(screen(), /CHIISPACE_ROSTER_MARK/, "저장된 대화가 뜨지 않음");
    let pids = [];
    for (let i = 0; i < 60 && pids.length !== 1; i++) { pids = [...claudePids()].filter(v => !claudeBefore.has(v)); if (pids.length !== 1) await delay(500); }
    assert.equal(pids.length, 1, "이 칸의 claude 를 하나로 특정하지 못함: " + JSON.stringify(pids));
    const sessionsDir = path.join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(path.join(sessionsDir, pids[0] + ".json"),
      JSON.stringify({ pid: pids[0], sessionId: sid, cwd: project, kind: "interactive" }));
    for (let i = 0; i < 200 && readState().procs?.["%0"]?.claudeSession !== sid; i++) await delay(100);
    assert.equal(readState().procs["%0"].claudeSession, sid, "명부의 대화 id 가 칸에 저장되지 않음");
    assert.equal(readState().procs["%0"].cmd, "claude --resume " + sid, "다음에 켤 때 제 대화로 열리지 않음");
    assert.equal(app.exitCode, null);
    console.log("명부 -> 칸 저장과 다음 실행 명령 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, state: readState() }));
    console.error("명부 저장 검증 기록", root);
    throw e;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + app.pid + " -ErrorAction SilentlyContinue).CloseMainWindow()"], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
