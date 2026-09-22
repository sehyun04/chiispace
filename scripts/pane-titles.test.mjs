import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const delay = ms => new Promise(r => setTimeout(r, ms));
const hash = file => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
async function until(fn) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(100); }
  throw new Error("pane 이름 검증 대기 시간 초과");
}
function rpc(pid, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\chiispace-${pid}`);
    let body = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("pane title IPC timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      body += chunk;
      if (!body.includes("\n")) return;
      socket.end();
      const response = JSON.parse(body.slice(0, body.indexOf("\n")));
      response.ok ? resolve(response.result) : reject(new Error(JSON.stringify(response.error)));
    });
  });
}

test("실제 pane 자동 이름의 저장·재시작·숨긴 탭·수동 이름 우선순위", { skip: !exe, timeout: 100000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-pane-titles-"));
  const file = path.join(root, "session.json");
  const protectedFiles = ["com.sehyun.chiispace", "com.sehyun.kasaspace"].map(id => path.join(process.env.APPDATA, id, "session.json"));
  const before = protectedFiles.map(hash);
  writeFileSync(file, JSON.stringify({ tabs: [0, 1, 2].map(i => ({ key: `t${i}`, focus: `%${i}`, root,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "leaf", id: `%${i}` } })),
    active: 0, nextPane: 3, nextTab: 3, procs: {}, restoreMode: "native-continue",
    names: { "%1": "직접 붙인 이름" }, paneTitles: { "%0": "이전 자동 이름", "%1": "이전 숨긴 이름", "%99": "이미 닫힌 칸" } }));
  const readState = () => JSON.parse(readFileSync(file, "utf8"));
  const probe = `/${randomUUID()}`;
  let latest = {}, app;
  const commands = [];
  const server = http.createServer((req, res) => {
    if (req.url !== probe) { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CHIISPACE_STATE: file };
  for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const panes = Object.fromEntries(Array.from(document.querySelectorAll('[data-pane]'), el => {
        const id = el.dataset.pane, t = window.__terms?.[id], b = t?.buffer.active;
        const text = b ? Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n') : '';
        return [id, {name:el.querySelector('.pane-head .title')?.textContent, raw:el.dataset.title, text}];
      }));
      const sidebar = Array.from(document.querySelectorAll('.prow .nm'), el => el.textContent);
      const r = await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}${probe}`)}, {method:'POST',body:JSON.stringify({panes,sidebar})});
      for (const c of await r.json()) {
        if (c.input !== undefined) window.__terms?.[c.id]?.input(c.input);
        const slot = document.querySelector('[data-pane="'+c.id+'"]');
        if (c.rename) slot?.querySelector('.pane-head .title')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
        if (c.name !== undefined) { const input = slot?.querySelector('input.rename');
          if (input) { input.value = c.name; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); }
        }
      }
    } finally { pending = false; }
  }, 100); return 'isolated pane title test'; })()`;
  const start = async () => {
    latest = {}; commands.length = 0;
    app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
    await until(() => ["%0", "%1", "%2"].every(id => latest.panes?.[id]?.text.includes(">")));
  };
  const close = async () => {
    if (!app || app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
  };
  const send = (id, title) => commands.push({ id, input: `title ${title}\r` });
  const check = async (id, name) => {
    await until(() => latest.panes?.[id]?.name === name && latest.sidebar.includes(name));
    await until(async () => (await rpc(app.pid, "surface.list")).surfaces.some(s => s.id === id && s.title === name));
  };
  try {
    await start();
    await check("%0", "이전 자동 이름");
    await check("%1", "직접 붙인 이름");
    send("%0", "서버 / 인증 검토");
    send("%1", "숨긴 탭 새 작업");
    send("%2", "새로 받은 이름");
    await check("%0", "서버 / 인증 검토");
    await check("%1", "직접 붙인 이름");
    await check("%2", "새로 받은 이름");
    await until(() => readState().paneTitles?.["%1"] === "숨긴 탭 새 작업");
    send("%0", "C:\\Windows\\System32\\cmd.exe");
    send("%2", "Codex");
    await until(() => latest.panes["%2"].raw === "Codex");
    await check("%0", "서버 / 인증 검토");
    await check("%2", "새로 받은 이름");
    await until(() => readState().paneTitles?.["%0"] === "서버 / 인증 검토");
    assert.equal(readState().paneTitles["%99"], undefined);
    await close();
    await start();
    await check("%0", "서버 / 인증 검토");
    await check("%1", "직접 붙인 이름");
    await check("%2", "새로 받은 이름");
    send("%0", "이어진 대화 새 제목");
    await check("%0", "이어진 대화 새 제목");
    commands.push({ id: "%1", rename: true });
    await delay(500);
    commands.push({ id: "%1", name: "" });
    await check("%1", "숨긴 탭 새 작업");
    await until(() => !readState().names["%1"]);
    await rpc(app.pid, "surface.close", { surface_id: "%2" });
    await until(() => !readState().paneTitles["%2"]);
    console.log("PTY 제목 → 헤더·옆 목록·연결 도구·저장·재시작 검증 통과", root);
  } catch (error) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ latest, state: readState() }));
    console.error("pane 이름 검증 기록", root);
    throw error;
  } finally {
    await close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션 변경");
  }
});
