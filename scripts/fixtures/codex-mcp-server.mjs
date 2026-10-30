import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  if (r.id === undefined) return;
  const result = r.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "parity_fixture", version: "1" } }
    : r.method === "tools/list" ? { tools: [{ name: "fixture_tool", description: "Isolated inventory fixture", inputSchema: { type: "object", properties: {} } }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n");
});
