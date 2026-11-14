import assert from "node:assert/strict";
import test from "node:test";
import { takeFrames, listenerTable } from "../ui/remote-shim.ts";
import { fromSnapshot, deviceName, folderName, paneState, paneHash, paneFromHash } from "../ui/phone.ts";

test("SSE 조각은 덩이 경계에서 끊어 읽고, 덜 온 끝은 다음 조각과 잇는다", () => {
  const a = takeFrames(': hello\n\ndata: {"event":"claude:chat","payload":{"id":"%1","line":"x"}}\n\ndata: {"event":"chat:li');
  assert.deepEqual(a.frames, [{ event: "claude:chat", payload: { id: "%1", line: "x" } }]);
  const b = takeFrames(a.rest + 've","payload":{"session":"s"}}\n\n: ping\n\n');
  assert.deepEqual(b.frames, [{ event: "chat:live", payload: { session: "s" } }]);
  assert.equal(b.rest, "");
  // 깨진 덩이 하나가 뒤 덩이를 막지 않는다. 서버가 \r\n 으로 줘도 같다.
  const c = takeFrames('data: {broken\r\n\r\ndata: {"event":"remote:panes","payload":null}\r\n\r\n');
  assert.deepEqual(c.frames, [{ event: "remote:panes", payload: null }]);
});

test("listen 이 단 귀만 그 이벤트를 받고, 뗀 귀는 받지 않는다", () => {
  const t = listenerTable();
  const got = [];
  const h1 = t.callback((d) => got.push(["a", d]));
  const h2 = t.callback((d) => got.push(["b", d]));
  const e1 = t.listen("claude:chat", h1);
  t.listen("chat:live", h2);
  t.emit("claude:chat", 1);
  t.emit("chat:live", 2);
  t.unlisten("claude:chat", e1);
  t.emit("claude:chat", 3);
  assert.deepEqual(got, [
    ["a", { event: "claude:chat", id: e1, payload: 1 }],
    ["b", { event: "chat:live", id: got[1][1].id, payload: 2 }],
  ]);
  const once = [];
  const h3 = t.callback((d) => once.push(d.payload), true);
  t.listen("x", h3);
  t.emit("x", 1);
  t.emit("x", 2);
  assert.deepEqual(once, [1]);
});

test("뒤늦게 붙은 폰은 PC 와 같은 해석으로 지금 상태를 세운다", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5", permissionMode: "default", session_id: "abc" });
  const ask = (id, tool) => JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input: { command: "ls" }, tool_use_id: "t" + id } });
  const s = fromSnapshot({ alive: true, busy: true, init, prompts: [ask("r1", "Bash"), "{broken"] });
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.session, "abc");
  assert.equal(s.busy, true);
  assert.deepEqual(s.prompts.map((p) => [p.requestId, p.kind]), [["r1", "permission"]]);
  // 받는 사이에 새 권한 묻기가 왔고, 앞의 것은 취소됐다.
  const later = fromSnapshot({ alive: true, busy: true, init, prompts: [ask("r1", "Bash")] }, [
    JSON.parse(ask("r2", "AskUserQuestion")),
    { type: "control_cancel_request", request_id: "r1" },
  ]);
  assert.deepEqual(later.prompts.map((p) => [p.requestId, p.kind]), [["r2", "ask"]]);
  // 쉬는 칸. 지난 init 이 없어도 빈 상태로 선다.
  const idle = fromSnapshot({ alive: true, busy: false, init: null, prompts: [] });
  assert.equal(idle.busy, false);
  assert.deepEqual(idle.prompts, []);
});

test("칸 목록의 상태 글은 허락 기다림이 먼저다", () => {
  assert.deepEqual(paneState({ alive: true, busy: true, waiting: 2 }), { text: "허락 기다림 2", tone: "wait" });
  assert.deepEqual(paneState({ alive: true, busy: true, waiting: 1 }), { text: "허락 기다림", tone: "wait" });
  assert.deepEqual(paneState({ alive: true, busy: true, waiting: 0 }), { text: "일하는 중", tone: "busy" });
  assert.deepEqual(paneState({ alive: true, busy: false, waiting: 0 }), { text: "쉬는 중", tone: "idle" });
  assert.deepEqual(paneState({ alive: false, busy: true, waiting: 1 }), { text: "멈춤", tone: "off" });
});

test("폰 이름과 칸 주소", () => {
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 15)"), "Android");
  assert.equal(deviceName("Mozilla/5.0 (Windows NT 10.0)"), "브라우저");
  assert.equal(folderName("C:/Users/me/desktop/kasaspace"), "kasaspace");
  assert.equal(folderName("C:\\work\\app\\"), "app");
  assert.equal(folderName(""), "홈");
  assert.equal(paneHash("%3"), "#/p/%253");
  assert.equal(paneFromHash(paneHash("%3")), "%3");
  assert.equal(paneFromHash("#/"), null);
  assert.equal(paneFromHash("#/p/%E0"), null);
});
