import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.env.CHIISPACE_TEST_EXE;
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (e) { last = e; }
    await delay(150);
  }
  throw new Error(`조건 대기 시간 초과: ${last ?? "상태 미도달"}`);
}
function rpc(pid, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\chiispace-${pid}`);
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(12000, () => socket.destroy(new Error(`${method}: timeout`)));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      socket.end();
      const r = JSON.parse(data.slice(0, data.indexOf("\n")));
      r.ok ? resolve(r.result) : reject(new Error(JSON.stringify(r.error)));
    });
  });
}

test("실제 PTY의 자동 MCP 연결, 초안·작업 중 대기, 결과 회수와 재시작 격리", { skip: !exe, timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-collab-"));
  const protectedFiles = [
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map((id) => path.join(process.env.APPDATA, id, "session.json")),
    path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".claude.json"),
  ];
  const before = protectedFiles.map(hash);
  const compile = spawnSync("rustc", [path.join(fixtures, "agent-proxy.rs"), "-o", path.join(root, "claude.exe")], { windowsHide: true, encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stderr);
  copyFileSync(path.join(root, "claude.exe"), path.join(root, "codex.exe"));
  const state = path.join(root, "session.json");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", layout: { kind: "split", dir: "h", ratio: 0.5,
      a: { kind: "leaf", id: "%0" }, b: { kind: "leaf", id: "%1" } },
      root: root.replaceAll("\\", "/"), shell: process.env.CHIISPACE_TEST_SHELL || path.join(process.env.SystemRoot, "System32", "cmd.exe") }],
    active: 0, nextPane: 2, nextTab: 1, procs: {},
  }));
  const env = { ...process.env, CHIISPACE_STATE: state, CHIISPACE_FIXTURE_ROOT: root,
    CHIISPACE_FIXTURE_NODE: process.execPath, CHIISPACE_FIXTURE_SCRIPT: path.join(fixtures, "agent.mjs") };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  env[pathKey] = `${root};${env[pathKey]}`;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT") delete env[key];
  }
  const app = spawn(exe, [], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  app.stderr.on("data", (c) => process.stderr.write(c));
  app.stdout.on("data", (c) => process.stdout.write(c));
  const call = (method, params) => rpc(app.pid, method, params);
  const send = (pane, text) => call("surface.send_text", { surface_id: pane, text });
  const peek = (pane) => call("surface.peek", { surface_id: pane, lines: 100 });
  const events = (pane) => readFileSync(path.join(root, `${pane}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const agent = (pane) => JSON.parse(readFileSync(path.join(root, `${pane}.agent.json`), "utf8"));
  let sender;
  const collab = (method, params) => call(`chiispace.${method}`, { pane: "%0", token: sender.token, ...params });
  try {
    await until(async () => (await call("surface.list")).surfaces.length === 2);
    await until(async () => (await peek("%1")).text.includes(">"));
    // cmd는 현재 폴더를 PATH보다 먼저 찾으므로 fixture exe가 없는 폴더에서 시작한다.
    await send("%0", `cd "${os.tmpdir().replaceAll("\\", "/")}"\rcodex "한글 인자 & 공백"\r`);
    await send("%1", `cd "${os.tmpdir().replaceAll("\\", "/")}"\rclaude "한글 인자 & 공백"\r`);
    await until(() => events("%0").some((e) => e.event === "ready"));
    await until(() => events("%1").some((e) => e.event === "ready"));
    sender = agent("%0");
    assert.equal(sender.args.at(-1), "한글 인자 & 공백");
    assert.equal(agent("%1").args.at(-1), "한글 인자 & 공백");
    if (process.env.CHIISPACE_TEST_CODEX_JS) {
      const config = spawnSync(process.execPath, [process.env.CHIISPACE_TEST_CODEX_JS,
        ...sender.args.slice(0, 8), "mcp", "get", "chiispace", "--json"], { windowsHide: true, encoding: "utf8" });
      assert.equal(config.status, 0, config.stderr);
      const server = JSON.parse(config.stdout);
      assert.equal(server.transport.env.CHIISPACE_PANE_ID, "%0");
      assert.deepEqual(server.transport.args, ["mcp"]);
    }
    const context = await collab("context", {});
    assert.equal(context.self, "%0");
    assert.equal(context.panes.find((p) => p.id === "%0").neighbors.right, "%1");

    await send("%1", "작성 중인 초안");
    await send("%0", `delegate ${JSON.stringify({ target: "right", description: "한글 테스트" })}\r`);
    const delegated = await until(() => events("%0").find((e) => e.event === "delegated"));
    const task = delegated.task;
    await delay(3500);
    assert.equal((await collab("status", { task_id: task.id })).status, "queued");
    assert.match((await peek("%1")).text, /작성 중인 초안/);
    await assert.rejects(() => collab("complete", { task_id: task.id, result: "incorrect" }), /받아서 수행/);
    await send("%1", "\x03busy\r");
    await delay(3000);
    assert.equal((await collab("status", { task_id: task.id })).status, "queued");
    await send("%0", `status ${task.id}\r`);
    const done = await until(() => events("%0").find((e) => e.event === "status"), 25000);
    assert.equal(done.task.status, "completed");
    assert.equal(done.task.result, "fixture complete: 한글 테스트");
    assert.equal(events("%1").filter((e) => e.event === "claimed" && e.task.id === task.id).length, 1);

    const fail = await collab("delegate", { target: "right", description: "fail" });
    await until(async () => (await collab("status", { task_id: fail.id })).status === "failed");
    await send("%1", "draft");
    const cancel = await collab("delegate", { target: "right", description: "cancel" });
    assert.equal((await collab("cancel", { task_id: cancel.id })).status, "cancelled");
    const stale = await collab("delegate", { target: "right", description: "do not replay" });
    const old = agent("%1");
    await send("%1", "\x03exit\r");
    await until(async () => (await collab("status", { task_id: stale.id })).status === "failed");
    await delay(500);
    await send("%1", "claude\r");
    await until(() => agent("%1").token !== old.token);
    await assert.rejects(() => call("chiispace.context", { pane: "%1", token: old.token }), /만료/);
    assert.equal(events("%1").filter((e) => e.event === "claimed" && e.task.id === stale.id).length, 0);
    const close = await collab("delegate", { target: "right", description: "close" });
    await call("surface.close", { surface_id: "%1" });
    assert.equal((await collab("status", { task_id: close.id })).status, "failed");
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·전역 설정 변경");
  } catch (error) {
    for (const pane of ["%0", "%1"]) console.error(pane, await peek(pane).catch(String));
    throw error;
  } finally {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    await until(() => app.exitCode !== null, 5000).catch(() => app.kill());
    assert.deepEqual(protectedFiles.map(hash), before, "검증 종료 후 사용자 세션·전역 설정 변경");
    console.log(`협업 검증 세션: ${root}`);
  }
});
