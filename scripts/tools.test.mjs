import assert from "node:assert/strict";
import test from "node:test";
import { shortPath, shortToolName, toolSummary, toolStats, diffLines } from "../ui/tools.ts";

test("경로는 뒤를 남긴다", () => {
  assert.equal(shortPath("ui/Term.tsx"), "ui/Term.tsx");
  assert.equal(shortPath("C:/Users/kshkj/desktop/sehyun/kasaspace/ui/Term.tsx"), "…/ui/Term.tsx");
  assert.equal(shortPath("C:\\Users\\kshkj\\ui\\Term.tsx", 1), "…/Term.tsx");
});

test("MCP 도구 이름을 줄인다", () => {
  // 그대로 두면 한 줄을 다 먹는다.
  assert.equal(shortToolName("mcp__plugin_playwright_playwright__browser_click"), "browser_click");
  assert.equal(shortToolName("mcp__exa__web_search_exa"), "web_search_exa");
  assert.equal(shortToolName("Bash"), "Bash");
  assert.equal(shortToolName(undefined), "도구");
});

test("명령은 줄바꿈을 접어 한 줄로", () => {
  assert.equal(toolSummary("Bash", { command: "npm run build\n  && npm test" }), "npm run build ⏎ && npm test");
  assert.equal(toolSummary("PowerShell", { command: "Get-ChildItem" }), "Get-ChildItem");
});

test("앞의 폴더 이동은 줄이고 진짜 명령을 남긴다", () => {
  // 이게 없으면 긴 경로가 한 줄을 다 먹어 무슨 명령인지가 잘린다.
  assert.equal(
    toolSummary("Bash", { command: "cd /c/Users/kshkj/desktop/sehyun/kasaspace && npm test" }),
    "…/kasaspace › npm test",
  );
  assert.equal(toolSummary("Bash", { command: 'cd "C:/Program Files/x" && dir' }), "…/x › dir");
  // 이동만 있는 명령은 건드리지 않는다.
  assert.equal(toolSummary("Bash", { command: "cd /some/where" }), "cd /some/where");
});

test("읽기는 범위가 있으면 같이 보인다", () => {
  assert.equal(toolSummary("Read", { file_path: "a/b/c.ts" }), "…/b/c.ts");
  assert.equal(toolSummary("Read", { file_path: "c.ts", offset: 40, limit: 20 }), "c.ts (40부터 20)");
});

test("고치기는 전부 바꾸기를 표시한다", () => {
  assert.equal(toolSummary("Edit", { file_path: "ui/App.tsx" }), "ui/App.tsx");
  assert.equal(toolSummary("Edit", { file_path: "ui/App.tsx", replace_all: true }), "ui/App.tsx (전부)");
});

test("찾기는 무엇을 어디서 찾는지", () => {
  assert.equal(toolSummary("Grep", { pattern: "pty_write", path: "ui" }), "pty_write  ·  ui");
  assert.equal(toolSummary("Grep", { pattern: "pty_write" }), "pty_write");
  assert.equal(toolSummary("Glob", { pattern: "**/*.tsx" }), "**/*.tsx");
});

test("할 일은 지금 하는 것과 진척을 같이", () => {
  const todos = [
    { content: "A", status: "completed" },
    { content: "B", activeForm: "B 하는 중", status: "in_progress" },
    { content: "C", status: "pending" },
  ];
  assert.equal(toolSummary("TodoWrite", { todos }), "B 하는 중 (1/3)");
  assert.equal(toolSummary("TodoWrite", { todos: [{ status: "completed" }] }), "할 일 1/1");
});

test("모르는 도구도 빈 줄로 두지 않는다", () => {
  assert.equal(toolSummary("어떤도구", { query: "무엇" }), "무엇");
  assert.equal(toolSummary("어떤도구", { file_path: "a/b/c.ts" }), "…/b/c.ts");
  assert.equal(toolSummary("어떤도구", { 이상한키: 1 }), "이상한키");
  assert.equal(toolSummary("어떤도구", {}), "");
  assert.equal(toolSummary("어떤도구", undefined), "");
});

test("고친 줄 수는 구조화된 결과에서 센다", () => {
  const patch = [{ lines: ["-옛것", "+새것", "+덧붙임", " 그대로"] }];
  assert.deepEqual(toolStats("Edit", { structuredPatch: patch }), [{ label: "+2" }, { label: "−1" }]);
});

test("실패한 명령만 끝 코드를 붙인다", () => {
  assert.deepEqual(toolStats("Bash", { exitCode: 0 }), []);
  assert.deepEqual(toolStats("Bash", { exitCode: 1 }), [{ label: "끝 코드 1", bad: true }]);
  assert.deepEqual(toolStats("Bash", { interrupted: true }), [{ label: "중단됨", bad: true }]);
});

test("구조화된 결과가 없으면 표시도 없다", () => {
  assert.deepEqual(toolStats("Edit", undefined), []);
  assert.deepEqual(toolStats("Edit", "그냥 글"), []);
});

test("바뀐 줄의 번호는 새 파일 기준이고 지운 줄은 번호가 없다", () => {
  const patch = [{ newStart: 10, lines: [" 그대로", "-지움", "+더함", " 끝"] }];
  assert.deepEqual(diffLines({ structuredPatch: patch }), [
    { sign: " ", text: "그대로", n: 10 },
    { sign: "-", text: "지움", n: undefined },
    { sign: "+", text: "더함", n: 11 },
    { sign: " ", text: "끝", n: 12 },
  ]);
});

test("긴 diff 는 잘라 낸다", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `+줄${i}`);
  assert.equal(diffLines({ structuredPatch: [{ newStart: 1, lines }] }, 10).length, 10);
});
