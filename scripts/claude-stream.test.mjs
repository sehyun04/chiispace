import assert from "node:assert/strict";
import test from "node:test";
import {
  initialStream, reduceStream, sentStream, answeredStream, INIT_ID,
  allowLine, denyLine, answerLine, suggestionLabel, titleFrom, userLine,
  currentModel, effortChoices, effortRequest, appliedEffort, modelName, settingsModel,
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

test("초기화 답의 명령 목록이 그 claude 가 받는 슬래시 명령이다", () => {
  const s = run({ type: "control_response", response: { subtype: "success", request_id: INIT_ID, response: {
    models: [], commands: [{ name: "clear", description: "Start a new session", argumentHint: "[name]", aliases: ["reset", "new", 3] }, { description: "이름 없음" }] } } });
  assert.deepEqual(s.commands, [{ name: "clear", description: "Start a new session", argumentHint: "[name]", aliases: ["reset", "new"] }]);
  assert.deepEqual(run({ type: "system", subtype: "init" }).commands, [], "초기화 전에는 비어 있다");
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

test("추론 수준은 모델이 받는 것 중 설정으로 걸 수 있는 것만 고르고, 조회 답을 읽는다", () => {
  const s = run({ type: "control_response", response: { subtype: "success", request_id: INIT_ID, response: { models: [
    { value: "default", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5" },
  ] } } });
  // 첫 턴 전에는 기본 모델, 첫 턴 뒤에는 실제 이름으로 찾는다.
  assert.equal(currentModel(s).value, "default");
  assert.deepEqual(effortChoices(currentModel(s)), ["low", "medium", "high", "xhigh"]);
  const haiku = reduceStream(s, { type: "system", subtype: "init", model: "claude-haiku-4-5" });
  assert.equal(currentModel(haiku).value, "haiku");
  assert.deepEqual(effortChoices(currentModel(haiku)), []);
  assert.deepEqual(effortRequest("low"), { subtype: "apply_flag_settings", settings: { effortLevel: "low" } });
  assert.equal(appliedEffort({ applied: { effort: "high" }, effective: { effortLevel: "low" } }), "high");
  assert.equal(appliedEffort({ effective: { effortLevel: "low" } }), "low");
  assert.equal(appliedEffort(null), undefined);
});

// claude 2.1.318 의 실제 초기화 답 모양. 기본 줄과 opus 줄이 같은 모델로 풀린다.
const REAL = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
];
const withModels = run({ type: "control_response", response: { subtype: "success", request_id: INIT_ID, response: { models: REAL, claude_code_version: "2.1.318" } } });

test("줄의 모델은 Default 가 아니라 실제로 도는 모델 이름으로 보인다", () => {
  assert.equal(withModels.version, "2.1.318");
  // 기본 줄의 이름에 풀리는 모델을 붙인다.
  assert.equal(modelName(REAL[0], REAL), "Opus 5.5 (기본)");
  assert.equal(modelName(REAL[2], REAL), "Sonnet 5.5");
  assert.equal(modelName({ value: "default" }, []), "기본");
  // 설정에 opus 라 적혀 있으면 opus 줄, 설정이 비어 있으면 실제 이름으로 — 둘 다 기본 줄이 아니다.
  const set = settingsModel({ applied: { model: "claude-opus-5-5" }, effective: { model: "opus" } }, REAL);
  assert.equal(set, "opus");
  assert.equal(currentModel({ ...withModels, model: set }).value, "opus");
  const unset = settingsModel({ applied: { model: "claude-opus-5-5" }, effective: {} }, REAL);
  assert.equal(unset, "claude-opus-5-5");
  assert.equal(currentModel({ ...withModels, model: unset }).value, "opus");
  // 목록에 없는 설정 값(opus[1m] 같은)은 실제 이름으로 고른다.
  assert.equal(settingsModel({ applied: { model: "claude-opus-5-5" }, effective: { model: "opus[1m]" } }, REAL), "claude-opus-5-5");
  assert.equal(settingsModel(null, REAL), undefined);
  // 첫 턴의 system init 이 실제 이름을 줘도 줄에서 고른 이름은 그대로 둔다(턴마다 줄이 바뀌지 않게).
  const picked = { ...withModels, model: "default" };
  assert.equal(reduceStream(picked, { type: "system", subtype: "init", model: "claude-opus-5-5" }).model, "default");
  assert.equal(reduceStream(picked, { type: "system", subtype: "init", model: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
  assert.equal(currentModel(reduceStream(withModels, { type: "system", subtype: "init", model: "claude-opus-5-5" })).value, "opus");
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
