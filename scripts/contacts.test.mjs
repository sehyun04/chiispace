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
const codex = process.env.CHIISPACE_TEST_REAL_CODEX;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const hash = (file) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;

test("새 대화에서 상대를 누르면 새 탭에서 그 에이전트가 바로 켜진다", { skip: !exe || !claude, timeout: 150000 }, async () => {
  // 연락처에서 고르듯 누르면 끝이어야 한다 — 셸을 연 뒤 명령을 치는 단계가 사용자에게 남지 않는다.
  // 격리: 별도 앱 세션·CLAUDE_CONFIG_DIR·CODEX_HOME, 가짜 키와 닫힌 루프백 주소. 모델은 부르지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-contacts-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const home = path.join(root, "claude-state");
  mkdirSync(home);
  const protectedFiles = [
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json")),
    path.join(os.homedir(), ".codex", "config.toml"),
  ];
  const before = protectedFiles.map(hash);
  const settings = { hasCompletedOnboarding: true, theme: "light", projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key"], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  const codexState = path.join(root, "codex-state");
  mkdirSync(codexState);
  writeFileSync(path.join(codexState, "config.toml"), `
model = "contacts-test"
model_provider = "contacts_test"
check_for_update_on_startup = false
[model_providers.contacts_test]
name = "Offline contacts test"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(project)}]
trust_level = "trusted"
`);
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", root: project.replaceAll("\\", "/"), shell, layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, restoreMode: "native-continue", procs: {},
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
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home, CODEX_HOME: codexState };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = [path.dirname(claude), codex && path.dirname(codex), env[pathKey]].filter(Boolean).join(";");
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const side = document.querySelector('.side');
      const picker = side?.querySelector('.contacts');
      const screens = {};
      for (const [id, t] of Object.entries(window.__terms ?? {})) {
        const b = t?.buffer.active;
        if (b) screens[id] = Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n');
      }
      let stat = [];
      try { stat = await window.__TAURI_INTERNALS__.invoke('pane_status'); } catch {}
      const dom = {
        newtab: side?.querySelector('.newtab')?.textContent ?? null,
        picker: !!picker,
        head: picker?.querySelector('.ct-head')?.textContent ?? null,
        contacts: [...(picker?.querySelectorAll('.ct') ?? [])].map(e => e.dataset.agent),
        shells: picker?.querySelectorAll('.ct-shells .sp').length ?? 0,
        tabs: side?.querySelectorAll('.tgroup').length ?? 0,
        activeTab: [...(side?.querySelectorAll('.tgroup') ?? [])].findIndex(e => e.classList.contains('on')),
      };
      const r = await fetch(${JSON.stringify(apiBase + probe)}, {method:'POST',body:JSON.stringify({screens, stat, dom})});
      for (const c of await r.json()) {
        if (c.click) side?.querySelector(c.click)?.click();
        // 사람이 Esc 를 누른 것처럼 지금 포커스가 있는 곳에서 올린다.
        if (c.esc) (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
    } finally { pending = false; }
  }, 100); return 'isolated contacts test'; })()`;

  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const dom = () => latest.dom ?? {};
  const stat = (id) => (latest.stat ?? []).find(p => p.id === id);
  const screen = (id) => latest.screens?.[id] ?? "";
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) await delay(100); return ok(); };
  // 목록이 그려진 뒤에 누른다. 한 틱에 둘 다 보내면 두 번째는 아직 없는 줄을 누른다.
  const pick = async (selector) => {
    commands.push({ click: ".newtab" });
    assert.ok(await until(() => dom().picker, 50), "상대 목록이 안 펼쳐짐");
    commands.push({ click: selector });
  };
  try {
    assert.ok(await until(() => screen("%0") && dom().newtab, 300), "앱이 뜨지 않음");
    assert.equal(dom().newtab, "새 대화");

    // 누르면 상대 목록이 펼쳐진다. 어느 폴더에서 여는지도 보인다.
    commands.push({ click: ".newtab" });
    assert.ok(await until(() => dom().picker, 50), "상대 목록이 안 펼쳐짐");
    assert.deepEqual(dom().contacts, ["claude", "codex"]);
    assert.match(dom().head, /project/);
    assert.ok(dom().shells > 0, "셸만 여는 길이 없음");
    // Esc 는 목록만 닫는다.
    commands.push({ esc: true });
    assert.ok(await until(() => !dom().picker, 50), "Esc 로 목록이 안 닫힘");
    assert.equal(dom().tabs, 1);

    // Claude 를 누르면 새 탭이 열리고 그 칸에서 claude 가 바로 뜬다 — 명령을 칠 필요가 없다.
    await pick('.ct[data-agent="claude"]');
    assert.ok(await until(() => dom().tabs === 2 && !dom().picker, 50), "새 탭이 안 열림: " + JSON.stringify(dom()));
    assert.equal(dom().activeTab, 1, "새 탭으로 안 건너감");
    assert.ok(await until(() => stat("%1")?.agent === "claude", 300), "새 탭에서 claude 가 안 켜짐:\n" + screen("%1").slice(-800));
    // cmd 는 제 폴더를 알려 주지 않아 칸 상태의 cwd 가 빈다. 탭의 폴더와 claude 가 띄운 폴더로 본다.
    assert.ok(await until(() => {
      try { return JSON.parse(readFileSync(state, "utf8")).tabs?.[1]?.root === project.replaceAll("\\", "/"); } catch { return false; }
    }, 50), "새 탭이 지금 폴더로 안 열림: " + readFileSync(state, "utf8"));
    assert.ok(await until(() => screen("%1").includes(path.basename(root)), 100), "claude 가 고른 폴더에서 안 켜짐:\n" + screen("%1").slice(-800));
    assert.doesNotMatch(screen("%1"), /인식할 수 없|is not recognized/, "명령이 셸에서 깨짐");
    // 켜진 것을 폴링이 보면 그때부터 이어가기 명령으로 저장된다. 앱을 꺼도 그 대화로 돌아온다.
    assert.ok(await until(() => {
      try { return /^claude( |$)/.test(JSON.parse(readFileSync(state, "utf8")).procs?.["%1"]?.cmd ?? ""); } catch { return false; }
    }, 100), "켜진 claude 가 세션에 남지 않음: " + readFileSync(state, "utf8"));
    assert.equal(stat("%0")?.agent ?? null, null, "원래 칸이 영향을 받음");

    let next = 2;
    if (codex) {
      await pick('.ct[data-agent="codex"]');
      assert.ok(await until(() => dom().tabs === 3, 50), "Codex 탭이 안 열림");
      assert.ok(await until(() => stat("%2")?.agent === "codex", 300), "새 탭에서 codex 가 안 켜짐:\n" + screen("%2").slice(-800));
      next = 3;
    }

    // 셸만 고르면 명령 없이 셸로 연다.
    const shellId = "%" + next;
    await pick(".ct-shells .sp");
    assert.ok(await until(() => dom().tabs === next + 1 && screen(shellId), 100), "셸 탭이 안 열림");
    await delay(8000);
    assert.equal(stat(shellId)?.agent ?? null, null, "셸만 골랐는데 무언가 켜짐");
    assert.doesNotMatch(screen(shellId), />\s*(claude|codex)\b/i, "셸에 명령이 쳐짐");
  } finally {
    if (app.exitCode === null) {
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
      for (let i = 0; i < 80 && app.exitCode === null; i++) await delay(100);
      if (app.exitCode === null) app.kill();
    }
    server.close();
  }
  assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·설정 파일이 바뀜");
});
