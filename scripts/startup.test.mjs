import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const leaves = (node) => node.kind === "leaf" ? [node.id] : [...leaves(node.a), ...leaves(node.b)];
function list(pid) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\chiispace-${pid}`);
    let body = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("startup IPC timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method: "surface.list" }) + "\n"));
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      socket.end();
      const r = JSON.parse(body.slice(0, body.indexOf("\n")));
      r.ok ? resolve(r.result) : reject(new Error(JSON.stringify(r.error)));
    });
  });
}

test("복원 배치의 독립 실행에서 앱 생존과 세션 보존", { skip: !exe, timeout: 45000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-startup-"));
  const userState = path.join(process.env.APPDATA, "com.sehyun.chiispace", "session.json");
  const protectedFiles = [userState, path.join(process.env.APPDATA, "com.sehyun.kasaspace", "session.json")];
  const before = protectedFiles.map(hash);
  const original = process.env.CHIISPACE_TEST_LAYOUT ? JSON.parse(readFileSync(process.env.CHIISPACE_TEST_LAYOUT, "utf8")) : {
    tabs: [{ key: "t0", focus: "%0", layout: { kind: "leaf", id: "%0" } }], active: 0, nextPane: 1, nextTab: 1,
  };
  // 배치만 복제한다. 사용자 대화 자동 실행이나 실제 작업 폴더의 설정 로딩은 검증에 필요 없다.
  const state = { ...original, procs: {}, tabs: original.tabs.map((tab) => ({ ...tab, root: root.replaceAll("\\", "/") })) };
  const file = path.join(root, "session.json");
  writeFileSync(file, JSON.stringify(state));
  const env = { ...process.env, CHIISPACE_STATE: file };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  }
  const app = spawn(exe, [], { cwd: path.dirname(exe), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  app.stderr.on("data", (chunk) => { stderr += chunk; });
  app.stdout.resume();
  const expected = state.tabs.flatMap((tab) => leaves(tab.layout)).length;
  try {
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      assert.equal(app.exitCode, null, `앱 조기 종료 ${app.exitCode}: ${stderr}`);
      try { ready = (await list(app.pid)).surfaces.length === expected; } catch {}
      if (ready) break;
      await delay(200);
    }
    assert.ok(ready, `칸 초기화 실패: ${stderr}`);
    await delay(10000);
    assert.equal(app.exitCode, null, `복원 중 종료 ${app.exitCode}: ${stderr}`);
    assert.equal((await list(app.pid)).surfaces.length, expected);
    console.log(`독립 시작: 탭 ${state.tabs.length}개, 칸 ${expected}개 유지`);
  } finally {
    if (app.exitCode === null) {
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
      for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
      if (app.exitCode === null) app.kill();
    }
    writeFileSync(path.join(root, "stderr.txt"), stderr);
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션 변경");
    console.log(`시작 검증 파일: ${root}`);
  }
});
