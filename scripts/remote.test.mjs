import assert from "node:assert/strict";
import test from "node:test";
import { listenerTable } from "../ui/remote-shim.ts";
import { fromSnapshot, deviceName, folderName, paneState, paneHash, paneFromHash } from "../ui/phone.ts";
import { b64u, unb64u, commitOf, loadKey, newKey, open, sasOf, seal, sessionKeys } from "../ui/phone-crypto.ts";
import { socketUrl } from "../ui/phone-link.ts";

// src-tauri/src/remote_crypto.rs 의 시험과 같은 값. Node 의 crypto 로 따로 계산해 둔 것이다 — 두 쪽이 이 값을 내야 폰과 PC 가 말이 통한다.
const V = {
  d: "ERERERERERERERERERERERERERERERERERERERERERE",
  x: "AhfmF_C2RDkoJ4-WmZ5pojpPLBUr321s32bluAKC1O0",
  y: "GUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q",
  phonePub: "BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q",
  pcPub: "BNZak5d8qj0bCBhS_1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc_3bZ1XwW9UHw8Uz_OnJEoU",
};

test("폰의 암호는 PC 와 같은 값을 낸다 — 약속·여섯 자리·방향별 키·암호문", async () => {
  const key = await loadKey({ kty: "EC", crv: "P-256", d: V.d, x: V.x, y: V.y, ext: true });
  assert.equal(b64u(key.pub), V.phonePub);
  const nA = new Uint8Array(16).fill(0xaa);
  const nB = new Uint8Array(16).fill(0xbb);
  const pc = unb64u(V.pcPub);
  assert.equal(b64u(await commitOf(key.pub, nA)), "E9oHB8Ni0IrtYIZSzH3yyq94cGa8u3y6TR4QKuoCHN0");
  assert.equal(await sasOf(key.pub, pc, nA, nB), "816604");
  const k = await sessionKeys(key.priv, pc, nA, nB, "0123456789abcdef");
  assert.equal(Buffer.from(k.raw).toString("hex"),
    "b798196ef38dc56fce438a6813fffcaccf4bf9745a1e62951bde0067cae5d8b1ed1393d272fddb9aae3d984867155d22423dbfa5f5d8a0cbafff03b5e881cdc5");
  assert.equal(await seal(k.up, 0, '{"t":"invoke","i":1}'), "1ofJnyf65KeJedF6yXZxCMXDTj7pH4ypYG-SiSgiPQiNT1RH");
  assert.equal(await open(k.down, 7, "mg5Tvypfk8JxNu1wyXT5nk9n6HzzaGUyZJk"), '{"t":"ev"}');
  // 순번이 다르면 안 풀린다.
  await assert.rejects(open(k.down, 8, "mg5Tvypfk8JxNu1wyXT5nk9n6HzzaGUyZJk"));
});

test("새로 만든 폰 키는 저장했다 다시 읽어도 같은 공개키다", async () => {
  const k = await newKey();
  assert.equal(k.pub.length, 65);
  const again = await loadKey(JSON.parse(JSON.stringify(k.jwk)));
  assert.equal(b64u(again.pub), b64u(k.pub));
});

test("통로 주소는 페이지 옆의 ws 다 — 중계에서는 방 아래", () => {
  assert.equal(socketUrl("https://relay.me.workers.dev/r/0123456789abcdef0123456789abcdef/#/p/%253"), "wss://relay.me.workers.dev/r/0123456789abcdef0123456789abcdef/ws");
  assert.equal(socketUrl("http://127.0.0.1:8787/r/ab/"), "ws://127.0.0.1:8787/r/ab/ws");
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
