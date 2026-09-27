import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(100); }
  throw new Error("터미널 화면 검증 대기 시간 초과");
}

test("PowerShell 입력·삭제 뒤 배경색과 화면 잔상", { skip: !exe, timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-render-"));
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, procs: {} }));
  const snapshots = [];
  let latest = {};
  const commands = [], probe = `/${randomUUID()}`;
  const server = http.createServer((req, res) => {
    if (req.url !== probe) { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CHIISPACE_STATE: state };
  for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => {
    let pending = false, raw = '', installed = false;
    setInterval(async () => {
      const t = window.__terms?.['%0']; if (!t || pending) return;
      if (!installed) { installed = true; const write = t.write.bind(t);
        t.write = (d, cb) => { raw += typeof d === 'string' ? d : new TextDecoder().decode(d); write(d, cb); };
      }
      pending = true;
      try {
        const b = t.buffer.active, line = b.getLine(b.baseY + b.cursorY);
        const text = Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n');
        const cells = Array.from({length:t.cols}, (_, x) => { const c = line.getCell(x); return {
          x, text:c.getChars(), bg:c.getBgColor(), bgDefault:c.isBgDefault(), fg:c.getFgColor(), inverse:c.isInverse()
        }; });
        const cv = t.element.querySelector('.composition-view');
        const r = await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}${probe}`)}, {
          method:'POST',body:JSON.stringify({text,line:line.translateToString(true),cells,raw,cursor:b.cursorX,cols:t.cols,
            proc:t.element.closest('[data-pane]')?.dataset.proc,composition:getComputedStyle(cv).display})});
        for (const c of await r.json()) {
          if (c.input !== undefined) t.input(c.input);
          if (c.key) {
            const options = {bubbles:true,cancelable:true,key:c.key,keyCode:c.code,which:c.code};
            const e = new KeyboardEvent('keydown', options); t.textarea.dispatchEvent(e);
            if (!e.defaultPrevented && c.key.length === 1) t.textarea.dispatchEvent(new KeyboardEvent('keypress',
              {...options,charCode:c.key.charCodeAt(0),which:c.key.charCodeAt(0)}));
            t.textarea.dispatchEvent(new KeyboardEvent('keyup', options));
          }
        }
      } finally { pending = false; }
    }, 50); return 'isolated terminal rendering test';
  })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const action = async (...list) => { commands.push(...list); await delay(500); };
  const erase = n => action(...Array.from({ length:n }, () => ({ key:"Backspace", code:8 })));
  const clean = () => assert.deepEqual(latest.cells.filter(c => !c.bgDefault || c.inverse), [], "입력·삭제한 자리에 기본 배경이 아닌 셀이 남음");
  const snapshot = label => {
    snapshots.push({ label, ...latest });
    if (process.env.CHIISPACE_TEST_SCREENSHOT) {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-File", path.resolve("scripts/shot.ps1"),
        "-ProcessId", String(app.pid), "-WaitSec", "0", "-Out", path.join(root, `${label}.png`)], { windowsHide: true });
      assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
    }
  };
  try {
    await until(() => latest.line?.includes(">"));
    // 프로필과 사용자 히스토리를 읽거나 쓰지 않는 실제 PSReadLine 경로를 사용한다.
    const ps = `Import-Module PSReadLine; Set-PSReadLineOption -HistorySavePath '${root.replaceAll("'", "''")}\\history.txt' -HistorySaveStyle SaveNothing; function prompt { 'PS-EDIT> ' }; Write-Output 'EDIT_READY'`;
    await action({ input: `powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}\r` });
    await until(() => latest.line === "PS-EDIT> ");
    await until(() => latest.proc === "powershell");
    await action({ input: "\r" });
    snapshot("empty");
    for (const key of "codex abcdefghijklmnop") await action({ key, code: key.toUpperCase().charCodeAt(0) });
    snapshot("typed");
    assert.equal(latest.line.trimEnd(), "PS-EDIT> codex abcdefghijklmnop");
    clean();
    for (let i = 0; i < 15; i++) await action({ key: "Backspace", code: 8 });
    snapshot("deleted");
    clean();
    await action({ key: "a", code: 65 });
    snapshot("retyped");
    assert.equal(latest.line.trimEnd(), "PS-EDIT> codex aa");
    clean();
    assert.equal(latest.composition, "none");
    await erase(8);
    await action({ input:"한글 테스트" });
    assert.equal(latest.line.trimEnd(), "PS-EDIT> 한글 테스트");
    await erase(2);
    assert.equal(latest.line.trimEnd(), "PS-EDIT> 한글 테");
    clean();
    snapshot("korean-delete");
    await erase(4);
    await action({ input:"x".repeat(latest.cols + 20) });
    await erase(latest.cols + 20);
    assert.equal(latest.line.trimEnd(), "PS-EDIT>");
    clean();
    snapshot("wrapped-delete");
    const child = path.join(root, "color-child.cjs");
    const colored = "\x1b[?25l\x1b[1;1H\x1b[93mchild\x1b[37m\x1b[40m COLOR \x1b[0m\x1b[1;8H\x1b[?25h";
    writeFileSync(child, `process.stdin.setRawMode(true); console.log('COLOR_READY'); process.stdin.on('data',()=>process.stdout.write(${JSON.stringify(colored)}));`);
    await action({ input:`& '${process.execPath}' '${child}'\r` });
    await until(() => latest.proc === "node" && latest.text.includes("COLOR_READY"));
    await action({ input:"x" });
    assert.equal(latest.cells[6].bgDefault, false, "다른 프로그램의 명시적 검정 배경이 지워짐");
    assert.equal(latest.cells[6].bg, 0);
    snapshot("child-color");
  } finally {
    writeFileSync(path.join(root, "snapshots.json"), JSON.stringify(snapshots, null, 2));
    console.log("터미널 화면 검증 기록", root);
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; app.exitCode === null && i < 50; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
