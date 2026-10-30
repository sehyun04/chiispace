import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_COMMANDS, codexCommand, codexPrompt, mcpReport, skillsReport, usageReport } from "../ui/codex-commands.ts";

test("Codex 명령 목록은 구현한 조회·일반 턴만 올리고 별도 실행·설정 쓰기는 올리지 않는다", () => {
  const names = CODEX_COMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
  for (const name of ["mcp", "skills", "diff", "pwd", "cwd", "usage", "warnings", "agents", "subagents", "init", "recap"]) assert.ok(names.includes(name));
  for (const name of ["review", "fork", "config", "hooks", "experimental"]) assert.ok(!names.includes(name));
  assert.equal(codexCommand("/cwd"), "/pwd");
  assert.equal(codexCommand("/subagents"), "/agents");
});

test("init·recap은 추가 요청을 보존하는 일반 턴이고 다른 명령은 프롬프트로 보내지 않는다", () => {
  assert.match(codexPrompt("/init", ["한글", "규칙"]), /AGENTS\.md[\s\S]*한글 규칙/);
  assert.match(codexPrompt("/recap", []), /파일을 변경하지 말고/);
  for (const c of ["/mcp", "/skills", "/review", "/fork"]) assert.equal(codexPrompt(c, []), null);
});

test("조회 결과는 서버·스킬의 표시 필드만 쓰며 설정·인증 원문을 내보내지 않는다", () => {
  const mcp = mcpReport([{ name: "fixture", tools: { alpha: {}, beta: {} }, authStatus: "notLoggedIn", config: { token: "SECRET" } }]);
  assert.match(mcp, /fixture[\s\S]*alpha[\s\S]*beta/); assert.ok(!mcp.includes("SECRET"));
  const skills = skillsReport([{ cwd: "C:/fixture", skills: [{ name: "audit", enabled: false, description: "첫 줄\n긴 설명" }], errors: [{ path: "bad", message: "파싱 실패" }] }]);
  assert.match(skills, /꺼짐 · audit/); assert.match(skills, /파싱 실패/); assert.ok(!skills.includes("긴 설명"));
});

test("사용 한도 표시는 한도·사용률만 받고 계정 원문을 노출하지 않는다", () => {
  const usage = usageReport({ rateLimitsByLimitId: { codex: { limitName: "Codex", primary: { usedPercent: 23, limitWindowMinutes: 300 } } }, token: "SECRET" });
  assert.match(usage, /300분 한도 · 23%/); assert.ok(!usage.includes("SECRET"));
  assert.match(usageReport({}), /정보가 없다/);
});
