import assert from "node:assert/strict";
import test from "node:test";
import { applyLive, partialInput, caughtUp } from "../ui/live.ts";

const sse = (o) => JSON.stringify(o);
const data = (req, ...events) => ({ session: "s", req, phase: "data", events: events.map(sse) });
const run = (...evs) => evs.reduce((l, e) => applyLive(l, e), null);

test("글자가 조각으로 와도 한 말풍선에 모인다", () => {
  const live = run(
    { session: "s", req: 1, phase: "begin" },
    data(1, { type: "message_start" }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    data(1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "안녕" } }),
    data(1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "하세요" } }),
  );
  assert.deepEqual(live.blocks, [{ kind: "text", text: "안녕하세요" }]);
  assert.equal(live.done, false);
});

test("생각·글·도구가 제 자리에 선다", () => {
  const live = run(
    { session: "s", req: 1, phase: "begin" },
    data(
      1,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "음" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "볼게요" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "Bash" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"np' } },
    ),
  );
  assert.deepEqual(live.blocks, [
    { kind: "thinking", text: "음" },
    { kind: "text", text: "볼게요" },
    { kind: "tool", name: "Bash", json: '{"command":"np' },
  ]);
});

test("받은 상태를 고치지 않는다", () => {
  // React 는 참조가 바뀌어야 다시 그린다. 제자리에서 고치면 화면이 멈춘 것처럼 보인다.
  const a = run({ session: "s", req: 1, phase: "begin" }, data(1, { type: "content_block_start", index: 0, content_block: { type: "text" } }));
  const frozen = JSON.stringify(a);
  const b = applyLive(a, data(1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }));
  assert.equal(JSON.stringify(a), frozen);
  assert.notEqual(a, b);
  assert.notEqual(a.blocks, b.blocks);
});

test("끝은 message_stop 으로도 스트림 종료로도 온다", () => {
  const begun = run({ session: "s", req: 1, phase: "begin" });
  assert.equal(applyLive(begun, data(1, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" })).done, true);
  assert.equal(applyLive(begun, data(1, { type: "message_delta", delta: { stop_reason: "end_turn" } })).stop, "end_turn");
  // claude 가 Esc 로 끊으면 message_stop 없이 연결만 닫힌다.
  assert.equal(applyLive(begun, { session: "s", req: 1, phase: "end" }).done, true);
});

test("API 오류는 끝난 것으로 치고 이유를 남긴다", () => {
  const live = run({ session: "s", req: 1, phase: "begin" }, data(1, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  assert.equal(live.done, true);
  assert.equal(live.error, "Overloaded");
});

test("새 답이 시작되면 옛 요청의 꼬리는 섞이지 않는다", () => {
  let live = run({ session: "s", req: 1, phase: "begin" }, { session: "s", req: 2, phase: "begin" });
  live = applyLive(live, data(1, { type: "content_block_start", index: 0, content_block: { type: "text", text: "옛" } }));
  assert.equal(live.req, 2);
  assert.deepEqual(live.blocks, []);
  assert.equal(applyLive(live, { session: "s", req: 1, phase: "end" }).done, false);
});

test("시작을 놓쳐도 조각부터 모은다", () => {
  // 대화창을 연 순간 이미 답이 흐르는 중일 수 있다.
  const live = run(data(5, { type: "content_block_start", index: 0, content_block: { type: "text", text: "중간" } }));
  assert.equal(live.req, 5);
  assert.deepEqual(live.blocks, [{ kind: "text", text: "중간" }]);
});

test("깨진 이벤트 하나가 나머지를 막지 않는다", () => {
  const live = applyLive(run({ session: "s", req: 1, phase: "begin" }), {
    session: "s",
    req: 1,
    phase: "data",
    events: ["{반 토막", sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } })],
  });
  assert.deepEqual(live.blocks, [{ kind: "text", text: "ok" }]);
});

test("시작 없는 조각 델타는 무시한다", () => {
  const live = run({ session: "s", req: 1, phase: "begin" }, data(1, { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } }));
  assert.deepEqual(live.blocks, []);
});

test("반쪽짜리 도구 입력도 읽을 수 있는 만큼 읽는다", () => {
  assert.deepEqual(partialInput(""), {});
  assert.deepEqual(partialInput('{"command":"npm te'), { command: "npm te" });
  assert.deepEqual(partialInput('{"file_path":"a.ts"'), { file_path: "a.ts" });
  assert.deepEqual(partialInput('{"todos":[{"content":"a"}'), { todos: [{ content: "a" }] });
  // 값이 아직 안 온 키는 빈 값으로 둔다.
  assert.deepEqual(partialInput('{"a":'), { a: "" });
  assert.deepEqual(partialInput("[1,"), {});
});

test("대화 파일이 새로 자란 뒤에야 쓰이던 말풍선을 걷는다", () => {
  const done = { req: 1, blocks: [], done: true };
  assert.equal(caughtUp(done, 100, 100), false);
  assert.equal(caughtUp(done, 100, 180), true);
  assert.equal(caughtUp({ ...done, done: false }, 100, 180), false);
  assert.equal(caughtUp(done, null, 180), false);
});
