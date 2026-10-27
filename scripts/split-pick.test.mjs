import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watchUserFiles } from "./user-files.mjs";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const faces = readdirSync(fileURLToPath(new URL("../ui/assets/faces/", import.meta.url)))
  .filter(f => f.endsWith(".png") && !f.endsWith("-work.png")).map(f => f.slice(0, -4));

test("칸 나누기 단축키는 상대를 먼저 묻고, 새 칸의 아이는 떠 있는 칸과 겹치지 않는다", { skip: !exe || !claude, timeout: 120000 }, async () => {
  // 고르기 창은 키보드로만 다룬다(단축키로 연 창이다). 키는 OS 가 아니라 웹뷰 안에서 칸의 입력 자리에 쏜다.
  // Claude 를 고르면 실제 claude 가 대화창 통로로 뜨므로 CLAUDE_CONFIG_DIR·가짜 키로 격리한다. 말은 보내지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-split-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const home = path.join(root, "claude-state");
  mkdirSync(home);
  const settings = { hasCompletedOnboarding: true, theme: "light", hasSeenAutoDefaultNudge: true, hasSeenAutoModeEntryWarning: true, projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  // 닫힌 칸들이 아이를 한 번씩 다 썼고, 떠 있는 %0 은 하치와레다. 예전 배정은 이때 순번으로 돌아
  // 새 칸에 다시 하치와레를 붙였다.
  const casting = Object.fromEntries(faces.map((slug, i) => [`%${90 + i}`, slug]));
  casting["%0"] = "hachiware";
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", root: project.replaceAll("\\", "/"), shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, restoreMode: "native-continue", procs: {}, casting,
  }));
  const guard = watchUserFiles([path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json"),
    path.join(process.env.APPDATA, "com.sehyun.chiispace", "session.json")], { root, exe });
  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url !== probe) { calls.push(`${req.method} ${req.url}`); res.writeHead(503).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || key === "CHIISPACE_PROXY" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|ENABLE_TOOL_SEARCH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const dom = {
        roster: document.querySelector('.side')?.textContent.includes('아이들') ?? null,
        pick: document.querySelector('.split-pick')?.textContent ?? null,
        on: document.querySelector('.split-opt.on')?.dataset.kind ?? null,
        panes: [...document.querySelectorAll('[data-pane]')].map(el => ({ id: el.dataset.pane,
          chat: !!el.querySelector('.composer textarea'), term: !!el.querySelector('.xterm'),
          face: el.querySelector('.pane-head .face')?.getAttribute('src') ?? null,
          title: el.querySelector('.pane-head .title')?.textContent ?? null, ring: !!el.querySelector('.work-ring') })),
      };
      const r = await fetch(${JSON.stringify(base + probe)}, {method:'POST',body:JSON.stringify({dom})});
      for (const c of await r.json()) {
        if (c.term) window.__terms?.[c.term]?.input(c.data);
        else (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: c.key, ctrlKey: !!c.ctrl, shiftKey: !!c.shift, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 120));
      }
    } finally { pending = false; }
  }, 200); return 'isolated split picker test'; })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const dom = () => latest.dom ?? {};
  const until = async (ok, what, ms = 20000) => {
    for (let i = 0; i < ms / 100 && !ok(); i++) await delay(100);
    assert.ok(ok(), `${what}\n${JSON.stringify(dom())}`);
  };
  const shot = (name) => {
    if (process.env.CHIISPACE_TEST_SCREENSHOT !== "1") return;
    spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid), "-WaitSec", "1", "-Out", path.join(root, name + ".png")], { windowsHide: true });
  };
  const key = (k, mod = {}) => commands.push({ key: k, ...mod });
  try {
    await until(() => dom().panes?.length === 1 && dom().panes[0].term, "앱이 뜨지 않음", 40000);
    await delay(1500);
    assert.equal(dom().roster, false, "옆칸 아래 아이들 목록이 남음");

    key("D", { ctrl: true, shift: true });
    await until(() => /오른쪽에 새 칸/.test(dom().pick ?? ""), "Ctrl+Shift+D 로 고르기 창이 안 뜸");
    assert.equal(dom().on, "claude", "처음 짚은 것은 Claude");
    shot("picker");
    key("Escape");
    await until(() => dom().pick === null, "Esc 로 안 닫힘");
    await delay(500);
    assert.equal(dom().panes.length, 1, "닫았는데 칸이 생김");

    key("E", { ctrl: true, shift: true });
    await until(() => /아래에 새 칸/.test(dom().pick ?? ""), "Ctrl+Shift+E 로 고르기 창이 안 뜸");
    key("ArrowRight");
    await until(() => dom().on === "codex", "방향키로 안 옮겨짐");
    key("3");
    await until(() => dom().panes.length === 2 && dom().pick === null, "3 으로 터미널 칸이 안 생김");
    await until(() => dom().panes.find(p => p.id !== "%0")?.term, "새 칸이 터미널이 아님");

    key("D", { ctrl: true, shift: true });
    await until(() => dom().pick !== null, "두 번째 고르기 창이 안 뜸");
    key("Enter");
    await until(() => dom().panes.length === 3, "Enter 로 Claude 칸이 안 생김");
    const fresh = () => dom().panes.find(p => p.id !== "%0" && !p.term);
    await until(() => fresh()?.chat, "새 Claude 칸이 대화창이 아님");
    assert.equal(fresh().title, "새 대화");

    const shown = dom().panes.map(p => p.face);
    assert.ok(shown.every(Boolean), "얼굴 없는 칸");
    assert.equal(new Set(shown).size, shown.length, `떠 있는 칸끼리 아이가 겹침: ${shown.join(", ")}`);
    shot("split");

    // 셸 칸은 전경 명령이 도는 동안 테두리가 돈다.
    commands.push({ term: "%0", data: "ping -n 6 127.0.0.1\r" });
    await until(() => dom().panes.find(p => p.id === "%0")?.ring, "일하는 중 테두리가 안 뜸");
    shot("working");
    await until(() => !dom().panes.find(p => p.id === "%0")?.ring, "명령이 끝났는데 테두리가 남음", 30000);
    assert.equal(app.exitCode, null);
    assert.deepEqual(calls.filter(c => c !== "HEAD /api/hello"), [], "검증 중 모델 API 요청 발생");
    console.log("칸 나누기 고르기 창·아이 배정·일하는 중 테두리 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, calls }));
    console.error("칸 나누기 고르기 검증 기록", root);
    throw e;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    guard("사용자 세션·Claude 설정 변경");
  }
});
