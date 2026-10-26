import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { watchUserFiles } from "./user-files.mjs";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

test("실제 Claude 고르기 창을 Esc·Ctrl+C 로 닫으면 프롬프트가 남은 목록 아래에 찍힌다", { skip: !exe || !claude, timeout: 120000 }, async () => {
  // claude 는 고르기 창에서 커서를 고른 줄에 세워 두고, Esc 로 닫을 때 그 커서를 그린 것 아래로 내리지 않고
  // 나간다. 대체 화면 없이 돌리는 칸에서는 프롬프트가 목록 한가운데에 찍히고 다음 claude 가 남은 글자 위에 겹쳐
  // 그려졌다. 앱의 claude 래퍼가 끝난 뒤 커서를 내려 준다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-claude-exit-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const sessions = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(sessions, { recursive: true });
  for (const n of [1, 2, 3]) {
    const sid = randomUUID(), userId = randomUUID();
    const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date(Date.now() - n * 60000).toISOString() };
    writeFileSync(path.join(sessions, `${sid}.jsonl`), [
      { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: `CHIISPACE_EXIT_PRIOR_${n}` } },
      { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: `msg_fixture_${n}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: `CHIISPACE_EXIT_REPLY_${n}` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map(v => JSON.stringify(v)).join("\n") + "\n");
  }
  // 확인창·권유 창을 미리 답해 둔다(claude-continue 검증과 같은 까닭).
  const settings = { hasCompletedOnboarding: true, theme: "light", hasSeenAutoDefaultNudge: true, hasSeenAutoModeEntryWarning: true, projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), `${home}.json`]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  // 사용자 기본 셸이 PowerShell 이고, 프롬프트를 절대 좌표로 그려 커서가 어긋나면 바로 드러난다.
  const shell = process.env.CHIISPACE_TEST_SHELL || path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root: project, shell, layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, restoreMode: "native-continue", procs: {} }));
  const guard = watchUserFiles([path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json"),
    path.join(process.env.APPDATA, "com.sehyun.chiispace", "session.json")], { root, exe });
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
      const r = await fetch(${JSON.stringify(base + probe)}, {method:'POST',body:JSON.stringify({screen: lines.slice(b.baseY).join('\\n'), all: lines.join('\\n')})});
      for (const c of await r.json()) t.input(c);
    } finally { pending = false; }
  }, 100); return 'isolated Claude exit test'; })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const lines = () => (latest.screen ?? "").split("\n");
  const until = async (ok, what, ms = 40000) => {
    for (let i = 0; i < ms / 100 && !ok(); i++) await delay(100);
    assert.ok(ok(), what);
  };
  // 명령을 친 프롬프트 줄도 센다. 화면 밖으로 밀려난 것까지 세려고 스크롤백 전체에서 센다.
  const prompts = () => (latest.all ?? "").split("\n").filter(l => /^PS [^>]*>/.test(l)).length;
  // 고르기 창을 띄웠다가 keys 로 닫고, 새 프롬프트가 남은 목록 맨 아랫줄보다 아래에 있는지 본다.
  const pickAndClose = async (name, keys) => {
    const before = prompts();
    // 앞에서 닫은 목록이 화면에 남아 있으므로 이번에 친 명령 줄 아래에서 새 목록을 찾는다.
    const typed = (latest.all ?? "").split("\n").filter(l => /^PS [^>]*> claude --resume/.test(l)).length;
    const opened = () => {
      const all = (latest.all ?? "").split("\n");
      const runs = all.flatMap((l, i) => /^PS [^>]*> claude --resume/.test(l) ? [i] : []);
      if (runs.length <= typed) return false;
      const after = all.slice(runs[runs.length - 1]);
      return [/Resume session/, /CHIISPACE_EXIT_PRIOR_3/, /Esc to/].every(re => after.some(l => re.test(l)));
    };
    commands.push("claude --resume\r");
    await until(opened, `${name}: 고르기 창이 안 뜸`);
    await delay(1000);
    for (const k of keys) { commands.push(k); await delay(400); }
    await until(() => prompts() > before, `${name}: 닫은 뒤 프롬프트가 안 돌아옴`, 20000);
    await delay(800);
    const ls = lines();
    let prompt = ls.length - 1;
    while (prompt >= 0 && !/^PS .*>\s*$/.test(ls[prompt])) prompt--;
    const picker = ls.findLastIndex(l => /CHIISPACE_EXIT_PRIOR_\d|minutes? ago|Esc to|Press Ctrl-C again/.test(l));
    assert.ok(prompt > picker, `${name}: 프롬프트가 남은 목록 사이에 찍힘\n${ls.join("\n")}`);
  };
  try {
    await until(() => prompts() > 0, "셸 프롬프트가 안 뜸");
    await delay(1500);
    await pickAndClose("Esc", ["\x1b"]);
    await pickAndClose("Ctrl+C", ["\x03", "\x03"]);
    // 다음에 띄운 claude 가 남은 글자 위에 겹쳐 그리지 않는다 — 새 첫 화면에는 지난 대화 목록이 없다.
    commands.push("claude\r");
    await until(() => /plan mode on/.test(latest.screen ?? ""), "다시 띄운 claude 가 안 뜸");
    await delay(1000);
    const ls = lines();
    const launched = ls.findLastIndex(l => /^PS .*> claude\s*$/.test(l));
    assert.ok(launched >= 0, "다시 띄운 명령 줄이 안 보임");
    const fresh = ls.slice(launched + 1);
    assert.ok(fresh.some(l => /Claude Code v\d/.test(l)), "다시 띄운 claude 의 머리글이 안 보임");
    assert.ok(!fresh.some(l => /CHIISPACE_EXIT_PRIOR_\d|minutes? ago/.test(l)), `다시 띄운 claude 아래에 지난 목록이 남음\n${fresh.join("\n")}`);
    assert.equal(app.exitCode, null);
    assert.deepEqual(calls.filter(c => c !== "HEAD /api/hello"), [], "검증 중 모델 API 요청 발생");
    console.log("고르기 창 Esc·Ctrl+C 뒤 프롬프트 자리 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, calls }));
    console.error("Claude 고르기 창 닫기 검증 기록", root);
    throw e;
  } finally {
    commands.push("\x03", "\x03");
    await delay(800);
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    guard("사용자 세션·Claude 설정 변경");
  }
});
