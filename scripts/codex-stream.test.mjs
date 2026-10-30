import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { initialCodex, resumedCodex, reduceCodex, codexItems, approvalOptions, questionAnswer, blockingPrompt, agentActive, hydrateCodexAgent } from "../ui/codex-stream.ts";
import { savedStreams, missingUnstarted } from "../ui/stream-session.ts";

const opened = () => resumedCodex({ id: "thread-a", turns: [] });
const event = (method, params = {}) => ({ method, params: { threadId: "thread-a", ...params } });
const start = s => reduceCodex(s, event("turn/started", { turn: { id: "turn-a", status: "inProgress" } }));
const done = s => reduceCodex(s, event("turn/completed", { turn: { id: "turn-a", status: "completed", items: [] } }));

test("Codex 저장은 구형 Claude 칸을 보존하고 서버 발급 ID와 설정을 구분한다", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const saved = savedStreams({ a: { session: uuid, cwd: "C:/a" }, b: { agent: "codex", session: "thread-1", cwd: "C:/a", model: "m", effort: "high", sandbox: { type: "readOnly" }, approvalPolicy: "never" },
    c: { agent: "codex", session: "", cwd: "", unstarted: true }, d: { agent: "codex", session: "../../a", cwd: "C:/a" }, e: { agent: "unknown", session: uuid, cwd: "C:/a" } });
  assert.equal(saved.a.agent, "claude");
  assert.equal(saved.b.session, "thread-1");
  assert.deepEqual(saved.b.sandbox, { type: "readOnly" });
  assert.equal(saved.b.approvalPolicy, "never");
  assert.equal(saved.c.session, "");
  assert.equal(saved.c.unstarted, true); assert.equal(saved.b.unstarted, undefined);
  assert.equal(saved.d, undefined); assert.equal(saved.e, undefined);
  for (const value of [null, [], "a"]) assert.deepEqual(savedStreams(value), {});
});

test("Codex 복원은 서버가 준 순서와 활성 턴을 따른다", () => {
  const s = resumedCodex({ id: "thread-a", turns: [{ id: "old", status: "completed", items: [{ id: "x", type: "agentMessage", text: "지난 답" }] }, { id: "active", status: "inProgress", items: [] }] });
  assert.equal(s.turn, "active"); assert.equal(s.busy, true);
  assert.equal(codexItems(s.entries)[0].text, "지난 답");
  assert.deepEqual(s.settled, ["old"]);
  assert.equal(initialCodex.entries.length, 0);
});

test("Codex 빈 칸 재생성은 미전송 표시와 정확한 이력 없음 응답이 함께 있어야 한다", () => {
  const chat = { agent: "codex", session: "thread-a", cwd: "C:/a", unstarted: true };
  assert.ok(missingUnstarted(chat, "no rollout found for thread id thread-a"));
  assert.equal(missingUnstarted({ ...chat, unstarted: false }, "no rollout found for thread id thread-a"), false);
  assert.equal(missingUnstarted(chat, "no rollout found for thread id thread-b"), false);
  for (const e of ["timeout", "permission denied", "not authenticated"]) assert.equal(missingUnstarted(chat, e), false);
});

test("Codex 답 조각과 완료 메시지는 같은 말풍선으로 합쳐진다", () => {
  let s = start(opened());
  s = reduceCodex(s, event("item/started", { turnId: "turn-a", item: { id: "msg", type: "agentMessage", text: "" } }));
  for (const delta of ["한글", " 응답"]) s = reduceCodex(s, event("item/agentMessage/delta", { turnId: "turn-a", itemId: "msg", delta }));
  assert.equal(codexItems(s.entries)[0].text, "한글 응답");
  s = reduceCodex(s, event("item/completed", { turnId: "turn-a", item: { id: "msg", type: "agentMessage", text: "한글 응답" } }));
  assert.equal(s.entries.length, 1);
  assert.equal(codexItems(done(s).entries).length, 1);
});

test("Codex 다른 칸·턴과 끝난 턴의 늦은 알림은 현재 대화를 바꾸지 않는다", () => {
  const s = start(opened());
  assert.equal(reduceCodex(s, { method: "turn/started", params: { threadId: "other", turn: { id: "other" } } }), s);
  assert.equal(reduceCodex(s, event("item/agentMessage/delta", { turnId: "other", itemId: "x", delta: "누출" })), s);
  const finished = done(s);
  assert.equal(start(finished), finished);
  assert.equal(reduceCodex(finished, event("item/agentMessage/delta", { turnId: "turn-a", itemId: "x", delta: "늦은 답" })), finished);
  assert.equal(reduceCodex(finished, { ...event("item/tool/requestUserInput", { turnId: "turn-a" }), id: 3 }), finished);
});

test("Codex 승인 요청은 ID로 중복 제거되고 해결·중단 때 걷힌다", () => {
  const prompt = { ...event("item/commandExecution/requestApproval", { turnId: "turn-a", command: "mkdir fixture" }), id: 1 };
  let s = reduceCodex(start(opened()), prompt);
  s = reduceCodex(s, prompt); assert.equal(s.prompts.length, 1);
  assert.equal(reduceCodex(s, event("serverRequest/resolved", { requestId: 1 })).prompts.length, 0);
  s = reduceCodex(s, event("turn/completed", { turn: { id: "turn-a", status: "interrupted" } }));
  assert.equal(s.busy, false); assert.equal(s.prompts.length, 0);
  assert.equal(codexItems(s.entries)[0].kind, "interrupted");
});

test("Codex 질문은 표시 문구가 아닌 질문 ID로 여러 답과 건너뛰기를 보낸다", () => {
  const p = { method: "item/tool/requestUserInput", id: 2, params: { isBlocking: false, questions: [{ id: "a", question: "방향" }, { id: "b", question: "다음" }] } };
  assert.deepEqual(questionAnswer(p, { a: " 오른쪽 ", b: "직접 입력" }), { answers: { a: { answers: ["오른쪽"] }, b: { answers: ["직접 입력"] } } });
  assert.deepEqual(questionAnswer(p, {}).answers.a.answers, []);
  assert.equal(blockingPrompt(p), false);
  assert.equal(blockingPrompt({ ...p, params: {} }), true);
});

test("Codex 승인은 서버의 가능한 선택만 내보내며 파일·추가 권한을 구분한다", () => {
  const p = { id: 1, method: "item/commandExecution/requestApproval", params: { availableDecisions: ["accept", "cancel"] } };
  assert.deepEqual(approvalOptions(p).map(o => o.result.decision), ["accept", "cancel"]);
  const permissions = { fileSystem: { write: ["C:/fixture"] } };
  const choices = approvalOptions({ ...p, method: "item/permissions/requestApproval", params: { permissions } });
  assert.deepEqual(choices[0].result, { permissions, scope: "turn" });
  assert.deepEqual(choices[1].result, { permissions: {}, scope: "turn" });
});

test("Codex 도구 결과·실패와 공개 요약만 표시한다", () => {
  const items = codexItems([{ id: "r", type: "reasoning", summary: ["공개 요약"], content: ["표시 안 함"] }, { id: "h", type: "hookPrompt", text: "숨김" },
    { id: "cmd", type: "commandExecution", command: "test", status: "failed", aggregatedOutput: "실패 원인" },
    { id: "f", type: "fileChange", status: "completed", changes: [{ path: "a.ts", diff: "+ a" }] }]);
  assert.equal(items.length, 3); assert.equal(items[0].text, "공개 요약");
  assert.equal(items[1].pair.toolResult.is_error, true);
  assert.equal(items[1].pair.toolResult.content, "실패 원인");
  assert.equal(items[2].toolUse.name, "apply_patch");
});

const collab = JSON.parse(readFileSync(new URL("./fixtures/codex-collab-0.164.json", import.meta.url), "utf8"));
test("실제 Codex 서브에이전트는 부모 완료 뒤에도 남고 자식 완료 때만 걷힌다", () => {
  let s = resumedCodex({ id: collab.parent, turns: [] });
  let parentEnded = false;
  for (const e of collab.events) {
    s = reduceCodex(s, e);
    if (e.method === "turn/completed" && e.params.threadId === collab.parent) {
      parentEnded = true;
      assert.equal(s.busy, false);
      assert.equal(s.agents.filter(agentActive).length, 1, "본 대화가 끝나자 자식도 걷힘");
    }
  }
  assert.ok(parentEnded);
  assert.equal(s.agents[0].thread, collab.child);
  assert.equal(s.agents.filter(agentActive).length, 0);
  assert.ok(codexItems(s.entries).some(i => i.kind === "launch"));
  assert.ok(!JSON.stringify(codexItems(s.entries).filter(i => i.kind === "bubble")).includes("SUB_FIXTURE_REPLY"), "자식 답이 본 대화에 섞임");
  const late = { method: "item/agentMessage/delta", params: { threadId: collab.child, turnId: s.agents[0].settled[0], itemId: "late", delta: "뒤늦은 답" } };
  assert.equal(reduceCodex(s, late), s);
  assert.equal(reduceCodex(s, { method: "turn/started", params: { threadId: "unrelated", turn: { id: "other" } } }), s);
});

test("서브에이전트 상태·활동은 끝난 호출과 끝난 에이전트를 구분한다", () => {
  const notice = (item) => event("item/completed", { turnId: "turn-a", item });
  let s = start(opened());
  s = reduceCodex(s, notice({ id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } }));
  assert.equal(s.agents.filter(agentActive).length, 1);
  s = done(s);
  s = reduceCodex(s, notice({ id: "activity", type: "subAgentActivity", agentThreadId: "child", agentPath: "검토", kind: "completed" }));
  assert.equal(s.agents.filter(agentActive).length, 0);
  s = reduceCodex(s, notice({ id: "resume", type: "collabAgentToolCall", tool: "resumeAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } }));
  assert.equal(s.agents.filter(agentActive).length, 1);
  s = reduceCodex(s, { method: "item/tool/requestUserInput", id: 99, params: { threadId: "child", questions: [] } });
  assert.equal(s.prompts.length, 0, "자식 질문이 본 대화의 질문으로 들어옴");
});

test("복원된 서브에이전트는 읽어 확인하며 늦은 이력 읽기가 현재 진행 상태를 덮지 않는다", () => {
  let s = resumedCodex({ id: "thread-a", turns: [{ id: "old", status: "completed", items: [{ id: "spawn", type: "collabAgentToolCall", receiverThreadIds: ["child"], agentsStates: { child: { status: "pendingInit" } } }] }] });
  assert.equal(s.agents[0].status, "unknown");
  s = reduceCodex(s, { method: "turn/started", params: { threadId: "child", turn: { id: "new" } } });
  s = hydrateCodexAgent(s, { id: "child", agentNickname: "검토자", turns: [] });
  assert.equal(s.agents[0].label, "검토자");
  assert.equal(s.agents[0].turn, "new");
  assert.equal(s.agents[0].status, "running");
});
