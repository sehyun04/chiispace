import assert from "node:assert/strict";
import test from "node:test";
import {
  initialStream, reduceStream, sentStream, answeredStream, INIT_ID,
  allowLine, denyLine, answerLine, suggestionLabel, titleFrom, userLine,
} from "../ui/claude-stream.ts";

const run = (...msgs) => msgs.reduce((s, m) => reduceStream(s, m), initialStream);
const permission = {
  type: "control_request", request_id: "r1",
  request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "mkdir x", description: "폴더 만들기" },
    description: "폴더 만들기", tool_use_id: "toolu_1",
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "mkdir x" }], behavior: "allow", destination: "localSettings" }],
  },
};

test("초기화 답에서 모델 목록과 권한 모드를 받는다", () => {
  const s = run({ type: "control_response", response: { subtype: "success", request_id: INIT_ID, response: {
    models: [{ value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" }, { nope: 1 }], current_permission_mode: "default" } } });
  assert.equal(s.ready, true);
  assert.deepEqual(s.models.map((m) => m.value), ["sonnet"]);
  assert.equal(s.mode, "default");
  // 다른 요청의 답은 초기화가 아니다.
  assert.equal(run({ type: "control_response", response: { request_id: "x", response: { models: [] } } }).ready, false);
});

test("권한 묻기는 화면 대신 카드로 오고, 결과가 오면 걷힌다", () => {
  let s = run(permission);
  assert.equal(s.busy, true);
  assert.equal(s.prompts.length, 1);
  const p = s.prompts[0];
  assert.equal(p.kind, "permission");
  assert.equal(p.tool, "Bash");
  assert.equal(p.toolUseId, "toolu_1");
  // 같은 요청이 두 번 와도 카드는 하나다.
  assert.equal(reduceStream(s, permission).prompts.length, 1);
  // claude 가 거둬 가면 걷는다.
  assert.equal(reduceStream(s, { type: "control_cancel_request", request_id: "r1" }).prompts.length, 0);
  s = reduceStream(s, { type: "result", subtype: "success", is_error: false });
  assert.equal(s.busy, false);
  assert.equal(s.prompts.length, 0);
});

test("허락·거절에는 어느 호출인지(toolUseID)가 실린다 — 빠지면 claude 가 계속 기다린다", () => {
  const p = run(permission).prompts[0];
  const allow = allowLine(p);
  assert.equal(allow.response.request_id, "r1");
  assert.equal(allow.response.response.behavior, "allow");
  assert.equal(allow.response.response.toolUseID, "toolu_1");
  assert.deepEqual(allow.response.response.updatedInput, p.input);
  assert.equal(allow.response.response.updatedPermissions, undefined);
  const always = allowLine(p, { always: p.suggestions[0] });
  assert.deepEqual(always.response.response.updatedPermissions, [p.suggestions[0]]);
  const deny = denyLine(p);
  assert.equal(deny.response.response.behavior, "deny");
  assert.equal(deny.response.response.toolUseID, "toolu_1");
  assert.equal(answeredStream(run(permission), "r1").prompts.length, 0);
});

test("선택지 질문은 질문 카드가 되고 답은 질문 문장을 열쇠로 돌아간다", () => {
  const s = run({ type: "control_request", request_id: "a1", request: {
    subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_q",
    input: { questions: [{ question: "어느 쪽?", header: "고르기", multiSelect: false, options: [{ label: "왼쪽" }, { label: "오른쪽", description: "R" }] }, { question: "빈 질문", options: [] }] } } });
  const p = s.prompts[0];
  assert.equal(p.kind, "ask");
  assert.deepEqual(p.questions.map((q) => q.question), ["어느 쪽?"]);
  const line = answerLine(p, { "어느 쪽?": "오른쪽" });
  assert.deepEqual(line.response.response.updatedInput.answers, { "어느 쪽?": "오른쪽" });
  assert.equal(line.response.response.updatedInput.questions.length, 2);
  assert.equal(line.response.response.toolUseID, "toolu_q");
});

test("중단은 실패로 보이지 않고, 모델 오류는 까닭이 남는다", () => {
  assert.equal(run({ type: "result", subtype: "error_during_execution", is_error: true }).error, undefined);
  assert.equal(run({ type: "result", subtype: "success", is_error: true, result: "API Error: 529" }).error, "API Error: 529");
  // 다음 말을 보내면 지난 오류는 걷는다.
  assert.equal(sentStream(run({ type: "result", is_error: true, subtype: "success", result: "x" })).error, undefined);
});

test("/clear 로 새 대화가 되면 그 id 를 따라간다", () => {
  let s = run({ type: "system", subtype: "init", session_id: "a", model: "m" });
  assert.equal(s.session, "a");
  s = reduceStream(s, { type: "conversation_reset" });
  s = reduceStream(s, { type: "system", subtype: "init", session_id: "b" });
  assert.equal(s.session, "b");
  // 결과에도 실린다. 모델 이름은 새 init 이 안 주면 그대로 둔다.
  assert.equal(reduceStream(s, { type: "result", subtype: "success", session_id: "c" }).session, "c");
  assert.equal(s.model, "m");
});

test("모르는 말이 와도 깨지지 않는다", () => {
  for (const m of [null, "x", 3, {}, { type: "system", subtype: "status" }, { type: "control_request", request: { subtype: "hook_callback" } }]) {
    assert.deepEqual(reduceStream(initialStream, m), initialStream);
  }
});

test("다시 묻지 않기 갈래와 칸 이름", () => {
  assert.equal(suggestionLabel({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }] }), "다시 묻지 않기 · npm test");
  assert.equal(suggestionLabel({ type: "setMode", mode: "acceptEdits" }), "이 대화에선 편집 묻지 않기");
  assert.equal(suggestionLabel({ type: "setMode", mode: "bypassPermissions" }), null);
  assert.equal(titleFrom("\n  로그 좀 봐 줘\n두 번째 줄"), "로그 좀 봐 줘");
  assert.equal(titleFrom("/compact"), null);
  assert.equal(Array.from(titleFrom("가".repeat(60))).length, 41);
  assert.deepEqual(userLine("hi").message, { role: "user", content: "hi" });
});
