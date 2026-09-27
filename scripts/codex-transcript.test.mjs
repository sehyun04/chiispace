import assert from "node:assert/strict";
import test from "node:test";
import { codexTranscript } from "../ui/codex-transcript.ts";

const event = payload => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload });
const response = payload => ({ type: "response_item", payload });
const parse = (...rows) => codexTranscript(rows.map(r => JSON.stringify(r)).join("\n"));
const reply = (id, value) => response({ type: "message", role: "assistant", id, content: [{ type: "output_text", text: value }] });

test("Codex의 실제 사용자 이벤트만 표시하고 환경·응답 중복은 제외", () => {
  const { items } = parse(
    response({ type: "message", role: "user", content: [{ text: "<environment_context>설정</environment_context>" }] }),
    response({ type: "message", role: "user", content: [{ text: "질문" }] }),
    event({ type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "질문" }] } }),
    event({ type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ text: "답" }] } }),
    reply("a1", "답"), reply("a1", "답"),
  );
  assert.deepEqual(items.map(i => [i.role, i.text]), [["user", "질문"], ["assistant", "답"]]);
});

test("구형 사용자 이벤트·동일한 연속 질문·생각 요약·도구 짝 유지", () => {
  const { items } = parse(
    event({ type: "user_message", message: "반복" }), event({ type: "user_message", message: "반복" }),
    response({ type: "reasoning", summary: [{ type: "summary_text", text: "공개 요약" }], encrypted_content: "표시 금지" }),
    response({ type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"echo hello"}' }),
    response({ type: "function_call_output", call_id: "c1", output: "hello" }),
    response({ type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "*** patch" }),
    response({ type: "custom_tool_call_output", call_id: "c2", output: "denied", is_error: true }),
  );
  assert.equal(items.filter(i => i.role === "user").length, 2);
  assert.equal(items[2].text, "공개 요약");
  assert.deepEqual(items[3].toolUse.input, { cmd: "echo hello" });
  assert.equal(items[3].pair.toolResult.content, "hello");
  assert.equal(items[4].pair.toolResult.is_error, true);
  assert.ok(!JSON.stringify(items).includes("표시 금지"));
});

test("진행 중·완료·중단·되돌리기와 출력 토큰", () => {
  const rows = [event({ type: "task_started" }), event({ type: "user_message", message: "첫째" }), reply("a", "답")];
  assert.equal(parse(...rows).busy, true);
  const done = parse(...rows, event({ type: "token_count", info: { last_token_usage: { output_tokens: 7 } } }),
    event({ type: "task_complete", duration_ms: 1200 }));
  assert.equal(done.busy, false);
  assert.equal(done.durs.get("a"), 1200);
  assert.equal(done.toks.get("a"), 7);
  const rollback = parse(...rows, event({ type: "user_message", message: "둘째" }), reply("b", "버림"), event({ type: "thread_rolled_back", num_turns: 1 }));
  assert.deepEqual(rollback.items.map(i => i.text), ["첫째", "답"]);
  assert.equal(parse(...rows, event({ type: "turn_aborted" })).items.at(-1).kind, "interrupted");
});

test("깨진 줄·알 수 없는 레코드·원격 이미지 제외", () => {
  const raw = JSON.stringify(event({ type: "item_completed", item: { type: "UserMessage", id: "u", content: [
    { type: "text", text: "한글" }, { type: "image", image_url: "https://private.invalid/image" },
    { type: "image", image_url: "data:image/png;base64,YQ==" },
  ] } })) + '\nnull\n{"type":"future"}\n{"unfinished';
  const out = codexTranscript(raw);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.items[0].images, ["data:image/png;base64,YQ=="]);
});
