import assert from "node:assert/strict";
import test from "node:test";
import { emptyAgentPrompt } from "../ui/agent-input.ts";

test("Claude와 Codex의 빈 입력창 및 추천 문구", () => {
  for (const [line, prefix] of [["❯ ", "❯ "], ["› Try implementing a feature", "› "], ["│ > Ask anything │", "│ > "]]) {
    assert.equal(emptyAgentPrompt(line, prefix, line), true);
  }
});

test("초안, 셸 프롬프트, 권한 질문, 작업 중 화면에는 전달 금지", () => {
  for (const [line, prefix, screen] of [
    ["❯ 작성 중", "❯ ", ""], ["❯ hello", "❯ hello", ""],
    ["C:\\work>", "C:\\work>", ""], ["❯ ", "❯ ", "esc to interrupt"],
    ["❯ ", "❯ ", "Do you want to allow this command?"],
    ["> Allow once", "> ", "Select an option"],
  ]) assert.equal(emptyAgentPrompt(line, prefix, screen), false);
});
