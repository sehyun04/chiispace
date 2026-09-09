import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const pane = process.env.CHIISPACE_PANE_ID;
const root = process.env.CHIISPACE_FIXTURE_ROOT;
const name = process.argv[2];
const args = process.argv.slice(3);
const log = (event) => appendFileSync(path.join(root, `${pane}.jsonl`), JSON.stringify(event) + "\n");
if (args[0] === "--version") {
  log({ event: "version", args });
  console.log("fixture 1.0");
  process.exit(0);
}
assert.ok(process.env.CHIISPACE_AGENT_TOKEN);
if (name === "claude") {
  assert.equal(args[0], "--mcp-config");
  const config = JSON.parse(args[1]).mcpServers.chiispace;
  assert.equal(config.command, process.env.CHIISPACE_CLI);
  assert.equal(config.env.CHIISPACE_PANE_ID, pane);
  assert.equal(config.env.CHIISPACE_AGENT_TOKEN, process.env.CHIISPACE_AGENT_TOKEN);
} else {
  assert.equal(args[0], "-c");
  assert.equal(args[1], `mcp_servers.chiispace.command=${JSON.stringify(process.env.CHIISPACE_CLI)}`);
  assert.match(args[5], /CHIISPACE_AGENT_TOKEN/);
  assert.equal(args[8], "--no-alt-screen");
}
writeFileSync(path.join(root, `${pane}.agent.json`), JSON.stringify({ pane, token: process.env.CHIISPACE_AGENT_TOKEN, args, name }));
const mcp = spawn(process.env.CHIISPACE_CLI, ["mcp"], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
let serial = 0;
let buffer = "";
const waiting = new Map();
mcp.stdout.setEncoding("utf8");
mcp.stdout.on("data", (data) => {
  buffer += data;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n");
    const response = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    waiting.get(response.id)?.(response);
    waiting.delete(response.id);
  }
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 35000);
  waiting.set(id, (r) => { clearTimeout(timer); r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const tool = async (name, args) => {
  const result = await call("tools/call", { name: `chiispace_${name}`, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
assert.match(init.instructions, new RegExp(`Your pane is ${pane.replace("%", "%")}`));
assert.equal((await call("tools/list", {})).tools.length, 7);
log({ event: "ready", context: await tool("context", {}) });
let draft = "";
const prompt = () => process.stdout.write(`\x1b[2J\x1b[H${name} fixture\r\n❯ `);
prompt();
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (text) => {
  try {
    for (const char of text.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "")) {
      if (char === "\x03") { draft = ""; prompt(); continue; }
      if (char !== "\r" && char !== "\n") { draft += char; process.stdout.write(char); continue; }
      const command = draft;
      draft = "";
      log({ event: "input", command });
      if (command === "scrollback") {
        process.stdout.write("\r\nSCROLL-HISTORY-BEGIN\r\n");
        for (let i = 0; i < 100; i++) process.stdout.write(`previous conversation ${i}\r\n`);
        process.stdout.write("SCROLL-HISTORY-END\r\n❯ ");
      } else if (command === "busy") {
        process.stdout.write("\x1b[2J\x1b[HWorking... esc to interrupt\r\n❯ ");
        setTimeout(prompt, 6000);
      } else if (command === "exit") {
        mcp.stdin.end();
        setTimeout(() => process.exit(0), 200);
      } else if (command.startsWith("delegate ")) {
        log({ event: "delegated", task: await tool("delegate", JSON.parse(command.slice(9))) });
        prompt();
      } else if (command.startsWith("status ")) {
        log({ event: "status", task: await tool("status", { task_id: command.slice(7), wait_seconds: 25 }) });
        prompt();
      } else if (/^Chiispace (task-[\d-]+):/.test(command)) {
        const task_id = command.match(/^Chiispace (task-[\d-]+):/)[1];
        const task = await tool("claim", { task_id });
        log({ event: "claimed", task });
        process.stdout.write("\x1b[2J\x1b[HWorking... esc to interrupt");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        log({ event: "completed", task: await tool("complete", { task_id, result: `fixture complete: ${task.description}`, failed: task.description === "fail" }) });
        prompt();
      } else { prompt(); }
    }
  } catch (error) {
    log({ event: "error", error: error.message });
    console.error(error);
  }
});
