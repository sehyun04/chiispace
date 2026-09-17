import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const exe = process.env.CHIISPACE_TEST_EXE;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(100); }
  throw new Error("입력 검증 대기 시간 초과");
}

test("실제 키 이벤트의 백스페이스·조합 취소·중복 확정 방지", { skip: !exe, timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-input-"));
  const state = path.join(root, "session.json");
  const capture = path.join(root, "bytes.txt");
  const reader = path.join(root, "reader.cjs");
  writeFileSync(capture, "");
  writeFileSync(reader, `const fs = require('node:fs'); process.stdin.setRawMode(true);
process.stdin.on('data', b => fs.appendFileSync(${JSON.stringify(capture)}, b));
console.log('INPUT_READY');`);
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root,
    shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, procs: {} }));
  let latest = {};
  const commands = [];
  const probe = `/${randomUUID()}`;
  const server = http.createServer((req, res) => {
    if (req.url !== probe) { res.writeHead(404).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CHIISPACE_STATE: state };
  for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  env.CHIISPACE_PROBE_MS = "1000";
  env.CHIISPACE_PROBE = `(() => {
    let pending = false, result;
    setInterval(async () => {
      const t = window.__terms?.['%0']; if (!t || pending) return;
      pending = true;
      try {
        const b = t.buffer.active;
        const text = Array.from({length:b.length}, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\\n');
        const r = await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}${probe}`)}, {method:'POST',body:JSON.stringify({text,result})});
        for (const c of await r.json()) {
          const ta = t.textarea;
          if (c.input !== undefined) t.input(c.input);
          if (c.value !== undefined) ta.value = c.value;
          if (c.composition) ta.dispatchEvent(new CompositionEvent(c.composition, {bubbles:true,data:c.data ?? ''}));
          if (c.blur) ta.dispatchEvent(new FocusEvent('blur'));
          if (c.key) {
            const e = new KeyboardEvent('keydown', {bubbles:true,cancelable:true,key:c.key,keyCode:c.keyCode,which:c.keyCode,isComposing:!!c.composing});
            ta.dispatchEvent(e); result = {tag:c.tag,cancelled:e.defaultPrevented};
          }
        }
      } finally { pending = false; }
    }, 50);
    return 'isolated keyboard input test';
  })()`;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const bytes = () => readFileSync(capture, "utf8");
  const action = async (...list) => { commands.push(...list); await delay(350); };
  try {
    await until(() => latest.text?.includes(">"));
    await action({ input: `"${process.execPath}" "${reader}"\r` });
    await until(() => latest.text?.includes("INPUT_READY"));
    await action({ input: "abc" }, { key: "Backspace", keyCode: 8 });
    assert.match(bytes(), /^abc[\x08\x7f]$/, "일반 백스페이스 유실 또는 중복");
    const first = bytes();
    await action({ composition: "compositionstart" });
    await action({ key: "Backspace", keyCode: 8, composing: false });
    assert.match(bytes().slice(first.length), /^[\x08\x7f]$/, "compositionend 유실 뒤 첫 백스페이스가 먹힘");
    const beforeActive = bytes();
    await action({ composition: "compositionstart" }, { value: "한" }, { composition: "compositionupdate", data: "한" });
    await action({ key: "Backspace", keyCode: 8, composing: true, tag: "ime-delete" });
    await until(() => latest.result?.tag === "ime-delete");
    assert.equal(latest.result.cancelled, false, "IME 내부 삭제를 xterm이 취소함");
    assert.equal(bytes(), beforeActive, "조합 내부 삭제가 PTY로 샘");
    await action({ value: "" }, { composition: "compositionend", data: "" });
    await action({ composition: "compositionstart" }, { value: "미완" }, { composition: "compositionupdate", data: "미완" });
    await action({ blur: true });
    await action({ key: "Backspace", keyCode: 8, composing: false });
    assert.match(bytes().slice(beforeActive.length), /^[\x08\x7f]$/, "포커스를 잃은 조합의 유령 글자 전송");
    const beforeCommit = bytes();
    await action({ value: "" }, { composition: "compositionstart" }, { value: "한" }, { composition: "compositionupdate", data: "한" });
    await action({ composition: "compositionend", data: "한" });
    assert.equal(bytes().slice(beforeCommit.length), "한", "확정 글자의 누락 또는 중복");
    console.log("실제 WebView 키 이벤트와 PTY 수신 바이트 검증 통과", root);
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    for (let i = 0; app.exitCode === null && i < 50; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
