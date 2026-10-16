import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchUserFiles } from "./user-files.mjs";

// 감시가 흔들리지 않게 느슨해진 만큼, 정말 새는 경우는 여전히 잡는지 본다.
test("사용자 설정의 다른 변경은 넘기고 검증 흔적은 잡는다", () => {
  const user = mkdtempSync(path.join(os.tmpdir(), "chiispace-userfiles-"));
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-userfiles-root-"));
  const exe = path.join(os.tmpdir(), "chiispace-userfiles-build", "chiispace.exe");
  const config = path.join(user, ".claude.json"), toml = path.join(user, "config.toml");
  writeFileSync(config, JSON.stringify({ numStartups: 1, projects: {} }));
  writeFileSync(toml, 'model = "a"\n');
  const guard = watchUserFiles([config, toml], { root, exe });

  writeFileSync(config, JSON.stringify({ numStartups: 2, projects: { "C:/elsewhere": {} } }));
  writeFileSync(toml, 'model = "b"\n');
  guard("다른 claude·codex 의 변경");

  writeFileSync(config, JSON.stringify({ numStartups: 2, projects: { [root.replaceAll("\\", "/")]: {} } }));
  assert.throws(() => guard("임시 폴더가 프로젝트로 남음"), /검증 흔적/);
  writeFileSync(config, JSON.stringify({ numStartups: 2 }));
  writeFileSync(toml, `[mcp_servers.chiispace]\ncommand = ${JSON.stringify(path.join(path.dirname(exe), "chiispace-cli.exe"))}\n`);
  assert.throws(() => guard("검증 exe 가 MCP 로 등록됨"), /검증 흔적/);
  writeFileSync(toml, 'env = { CHIISPACE_AGENT_TOKEN = "x" }\n');
  assert.throws(() => guard("MCP 토큰이 남음"), /검증 흔적/);
  rmSync(toml);
  assert.throws(() => guard("설정이 지워짐"), /지워짐/);
});
