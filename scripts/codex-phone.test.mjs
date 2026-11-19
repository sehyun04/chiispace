import assert from "node:assert/strict";
import test from "node:test";
import { codexPhoneChild, codexPhoneEvent, codexPhoneSnapshot } from "../ui/codex-phone.ts";
import { initialCodex } from "../ui/codex-stream.ts";

test("폰은 받은 상태보다 새롭고 같은 Codex 실행의 답 조각만 반영한다", () => {
  const state = { ...initialCodex, thread: "root", turn: "turn", busy: true,
    entries: [{ type: "agentMessage", id: "item", _turn: "turn", text: "앞" }] };
  const snap = codexPhoneSnapshot(state, "live-run", 5, true);
  const base = { id: "%1", session: "root", run: "live-run", seq: 6,
    message: { method: "item/agentMessage/delta", params: { threadId: "root", turnId: "turn", itemId: "item", delta: " 뒤" } } };
  assert.equal(codexPhoneEvent(snap, { ...base, seq: 5 }), snap);
  assert.equal(codexPhoneEvent(snap, { ...base, session: "other" }), snap);
  assert.equal(codexPhoneEvent(snap, { ...base, run: "old" }), snap);
  const next = codexPhoneEvent(snap, base);
  assert.equal(next.state.entries[0].text, "앞 뒤");
  assert.equal(codexPhoneEvent(next, base), next);
  const gone = codexPhoneEvent(next, { ...base, seq: 7, message: { method: "chiispace/exit" } });
  assert.equal(gone.ready, false);
  assert.equal(gone.state.turn, null);
  assert.equal(gone.state.entries[0].text, "앞 뒤");
});

test("폰에 처음 보이는 Codex 기록은 순서를 유지하고 자식 기록은 필요한 항목만 받는다", () => {
  const items = Array.from({ length: 180 }, (_, i) => ({ type: "agentMessage", id: String(i), text: String(i) }));
  const child = codexPhoneChild({ id: "child", agentNickname: "child name", other: "no", turns: [{ id: "one", items }] });
  assert.equal(child.other, undefined);
  assert.equal(child.turns[0].items.length, 160);
  assert.equal(child.turns[0].items[0].id, "20");
  assert.equal(child.turns[0].items.at(-1).id, "179");
});
