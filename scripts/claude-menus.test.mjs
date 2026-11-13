import assert from "node:assert/strict";
import test from "node:test";
import { memoryChoices, lastAnswer, exportName, exportMarkdown } from "../ui/claude-menus.ts";

test("/memory 목록은 claude 가 불러온 메모리 파일 그대로다", () => {
  // claude 2.1.323 `get_context_usage` 답의 memoryFiles 모양.
  const body = {
    totalTokens: 21108,
    memoryFiles: [
      { path: "C:\\Users\\me\\.claude\\CLAUDE.md", type: "User", tokens: 885 },
      { path: "C:\\work\\app\\CLAUDE.md", type: "Project", tokens: 1200 },
      { path: "C:\\Users\\me\\.claude\\memory\\MEMORY.md", type: "AutoMem", tokens: 3939 },
      { path: "C:\\work\\app\\CLAUDE.md", type: "Project", tokens: 1200 },
      { path: "C:\\work\\app\\x.md", type: "Rules" },
      { type: "User" },
    ],
  };
  assert.deepEqual(memoryChoices(body), [
    { value: "C:\\Users\\me\\.claude\\CLAUDE.md", label: "사용자 · CLAUDE.md", hint: "C:\\Users\\me\\.claude\\CLAUDE.md" },
    { value: "C:\\work\\app\\CLAUDE.md", label: "프로젝트 · CLAUDE.md", hint: "C:\\work\\app\\CLAUDE.md" },
    { value: "C:\\Users\\me\\.claude\\memory\\MEMORY.md", label: "자동 메모리 · MEMORY.md", hint: "C:\\Users\\me\\.claude\\memory\\MEMORY.md" },
    { value: "C:\\work\\app\\x.md", label: "Rules · x.md", hint: "C:\\work\\app\\x.md" },
  ]);
  assert.deepEqual(memoryChoices({}), []);
  assert.deepEqual(memoryChoices(null), []);
});

const me = (text, extra = {}) => ({ kind: "bubble", role: "user", text, ...extra });
const cl = (text) => ({ kind: "bubble", role: "assistant", text });

test("/copy 는 맨 끝 Claude 말풍선을 준다", () => {
  assert.equal(lastAnswer([me("a"), cl("첫 답"), { kind: "tool", toolUse: { name: "Bash", input: {} } }, cl("끝 답"), me("다음")]), "끝 답");
  assert.equal(lastAnswer([me("a"), cl("  ")]), undefined);
  assert.equal(lastAnswer([]), undefined);
});

test("내보낼 파일 이름은 날짜·시각과 칸 이름, 경로 글자는 지운다", () => {
  const now = new Date(2026, 10, 13, 9, 5);
  assert.equal(exportName("로그 좀 봐 줘", now), "2026-11-13-0905-로그 좀 봐 줘.md");
  assert.equal(exportName("..\\a/b:c*?\"<>|", now), "2026-11-13-0905-a b c.md");
  assert.equal(exportName("", now), "2026-11-13-0905-claude 대화.md");
  assert.equal(exportName(undefined, now), "2026-11-13-0905-claude 대화.md");
  assert.equal(Array.from(exportName("가".repeat(80), now)).length, "2026-11-13-0905-".length + 40 + 3);
});

test("대화를 마크다운으로 — 누가 말했는지 제목, 도구는 한 목록", () => {
  const now = new Date(2026, 10, 13, 22, 10);
  const md = exportMarkdown(
    [
      me("이 화면 봐", { images: ["data:image/png;base64,AAA"] }),
      { kind: "thinking", text: "속생각" },
      cl("봤어"),
      { kind: "tool", toolUse: { name: "Bash", input: { command: "ls" } } },
      { kind: "tool", toolUse: { name: "Read", input: { file_path: "C:\\a\\b\\c.ts" } } },
      { kind: "tool", toolUse: { name: "Grep", input: { pattern: "x" } } },
      cl("다 봤다"),
      me("골라 줘"),
      { kind: "qa", qa: [{ q: "어느 쪽?", a: "오른쪽" }] },
      { kind: "command", name: "/model", args: "sonnet" },
      { kind: "command", name: "context", args: "" },
      { kind: "local-command", stdout: "## Context Usage\n" },
      { kind: "system", text: "훅 알림" },
      me("고마워"),
      { kind: "interrupted" },
    ],
    { title: "화면 보기", session: "abc", folder: "C:\\work", now },
  );
  assert.equal(
    md,
    [
      "# 화면 보기",
      "",
      "C:\\work · 대화 abc · 2026-11-13 22:10 내보냄",
      "",
      "## 나",
      "",
      "이 화면 봐",
      "",
      "(그림 1장)",
      "",
      "## Claude",
      "",
      "봤어",
      "",
      "- Bash: ls",
      `- Read: ${md.match(/- Read: (.*)/)[1]}`,
      `- Grep: ${md.match(/- Grep: (.*)/)[1]}`,
      "",
      "다 봤다",
      "",
      "## 나",
      "",
      "골라 줘",
      "",
      "## Claude",
      "",
      "- 질문: 어느 쪽? → 오른쪽",
      "",
      "## 나",
      "",
      "`/model sonnet`",
      "",
      "`/context`",
      "",
      "```",
      "## Context Usage",
      "```",
      "",
      "고마워",
      "",
      "_(여기서 중단했다)_",
      "",
    ].join("\n"),
  );
  assert.ok(!md.includes("속생각"), "생각은 내보내지 않는다");
  assert.ok(!md.includes("훅 알림"), "시스템 알림은 내보내지 않는다");
});
