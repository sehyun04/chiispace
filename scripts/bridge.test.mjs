import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; }
    catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`조건 대기 시간 초과: ${last ?? "상태 미도달"}`);
}

function rpc(pid, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\chiispace-${pid}`);
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(12000, () => socket.destroy(new Error(`${method}: 응답 시간 초과`)));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      socket.end();
      const response = JSON.parse(data.slice(0, data.indexOf("\n")));
      if (response.ok) resolve(response.result);
      else reject(new Error(JSON.stringify(response.error)));
    });
  });
}

test("실제 앱 두 개에서 칸 연결과 세션 격리", { skip: !exe, timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-bridge-"));
  const userFiles = ["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) =>
    path.join(process.env.APPDATA, id, "session.json"));
  const before = userFiles.map(hash);
  const apps = [];
  const start = (name) => {
    const folder = path.join(root, name);
    mkdirSync(folder);
    const state = path.join(folder, "session.json");
    writeFileSync(state, JSON.stringify({
      tabs: [0, 1].map((i) => ({ key: `t${i}`, focus: `%${i}`, layout: { kind: "leaf", id: `%${i}` },
        root: folder.replaceAll("\\", "/"), shell: path.join(process.env.SystemRoot, "System32", "cmd.exe") })),
      active: 0, nextPane: 2, nextTab: 2, procs: {},
    }));
    const env = { ...process.env, CHIISPACE_STATE: state };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
    }
    const child = spawn(exe, [], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.on("error", (error) => console.error(error));
    child.on("exit", (code) => console.log(`검증 앱 ${child.pid} 종료: ${code}`));
    apps.push(child);
    return { pid: child.pid, state };
  };
  try {
    const a = start("first");
    const call = (method, params) => rpc(a.pid, method, params);
    const peek = (id) => call("surface.peek", { surface_id: id, lines: 100 });
    await until(async () => (await call("surface.list")).surfaces.length === 2);
    // 동시 기동 초기화와 준비된 두 앱 사이의 연결 격리를 분리해 검증한다.
    const b = start("second");
    await until(async () => (await rpc(b.pid, "surface.list")).surfaces.length === 2);
    await until(async () => (await peek("%1")).text.includes(">"));
    await call("surface.send_text", { surface_id: "%1", text: "echo SOURCE-SURVIVES\r" });
    await until(async () => (await peek("%1")).text.includes("SOURCE-SURVIVES"));

    const split = await call("surface.split", { from: "%1", direction: "left", focus: false });
    const id = split.surface.id;
    assert.equal(split.surface.workspace_id, "t1");
    assert.equal((await call("workspace.current")).workspace.id, "t0");
    assert.deepEqual((await call("surface.list")).surfaces.map((s) => s.id), ["%0", id, "%1"]);
    assert.equal((await rpc(b.pid, "surface.list")).surfaces.length, 2);
    assert.match((await peek("%1")).text, /SOURCE-SURVIVES/);
    await until(async () => (await peek(id)).text.includes(">"));

    const cli = path.join(path.dirname(exe), "chiispace-cli.exe");
    const text = spawnSync(cli, ["--socket", `\\\\.\\pipe\\chiispace-${a.pid}`, "text", id, "echo BRIDGE-한글"], { encoding: "utf8", windowsHide: true });
    assert.equal(text.status, 0, text.stderr);
    await call("surface.send_key", { surface_id: id, key: "Enter" });
    await until(async () => (await peek(id)).text.includes("BRIDGE-한글")).catch(async (error) => {
      console.error(await peek(id));
      throw error;
    });

    // 자식 셸이 받은 주소가 부모 앱의 것인지 실제 CLI 호출로 확인한다.
    await call("surface.send_text", { surface_id: id, text: `"${cli}" list\r` });
    await until(async () => (await peek(id)).text.includes('"surfaces"'));
    await call("surface.send_text", { surface_id: id, text: "echo %CHIISPACE_PANE_ID% %CHIISPACE_SOCKET_PATH%\r" });
    await until(async () => (await peek(id)).text.includes(`${id} \\\\.\\pipe\\chiispace-${a.pid}`));
    await call("surface.focus", { surface_id: id });
    assert.equal((await call("workspace.current")).workspace.id, "t1");
    await call("surface.focus", { surface_id: "%0" });
    await call("surface.close", { surface_id: id });
    assert.equal((await call("surface.list")).surfaces.length, 2);
    await assert.rejects(() => peek(id), /없는 칸/);
    await assert.rejects(() => call("surface.send_key", { surface_id: "%0", key: "Ctrl+Enter" }), /지원하지 않는 키/);
    await until(() => JSON.parse(readFileSync(a.state, "utf8")).tabs[1].layout.kind === "leaf");
    assert.deepEqual(userFiles.map(hash), before, "사용자 세션 파일 해시 변경");
  } finally {
    for (const child of apps) {
      const close = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true, encoding: "utf8" });
      if (close.status !== 0) console.error(close.stderr);
      await until(() => child.exitCode !== null, 5000).catch(() => child.kill());
    }
    assert.deepEqual(userFiles.map(hash), before, "검증 종료 후 사용자 세션 파일 해시 변경");
    console.log(`검증 세션: ${root}`);
  }
});
