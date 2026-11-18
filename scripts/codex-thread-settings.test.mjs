import assert from "node:assert/strict";
import test from "node:test";
import { codexSettingsPending, codexThreadsInFolder, savedStreams, selectStreamThread } from "../ui/stream-session.ts";

test("Codex /resume은 첫 페이지에 해당 폴더가 없어도 뒤에서 찾는다", async () => {
  const cursors = [];
  const threads = await codexThreadsInFolder("C:/Project", async cursor => {
    cursors.push(cursor);
    return cursor === null
      ? { nextCursor: "older", data: Array.from({ length: 100 }, (_, i) => ({ id: "other-" + i, cwd: "C:/Other" })) }
      : { data: [
        { id: "first", cwd: "\\\\?\\c:\\PROJECT\\" },
        { id: "child", cwd: "C:/Project", parentThreadId: "first" },
        { id: "nested", cwd: "C:/Project", source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } } },
        { id: "first", cwd: "C:/PROJECT" },
        { id: "../invalid", cwd: "C:/PROJECT" },
        { id: "second", cwd: "C:/project//" },
      ] };
  });
  assert.deepEqual(cursors, [null, "older"]);
  assert.deepEqual(threads.map(thread => thread.id), ["first", "second"]);
});

test("Codex /resume은 중복 없이 최근 30개만 읽고 반복 페이지를 알린다", async () => {
  let calls = 0;
  const threads = await codexThreadsInFolder("//srv/Share", async () => {
    calls++;
    return { nextCursor: "older", data: Array.from({ length: 31 }, (_, i) => ({ id: "thread-" + i, cwd: "\\\\?\\UNC\\SRV\\share\\" })) };
  });
  assert.equal(calls, 1);
  assert.equal(threads.length, 30);
  assert.equal(threads.at(-1).id, "thread-29");
  await assert.rejects(codexThreadsInFolder("C:/Project", async () => ({ nextCursor: "same", data: [] })), /다음 페이지/);
});

test("다른 Codex 대화를 고르면 설정을 다시 받고 같은 대화는 저장한 선택을 복원한다", () => {
  const original = {
    agent: "codex", session: "thread-a", cwd: "C:/Project", unstarted: true,
    model: "model-a", effort: "high", approvalPolicy: "on-request", sandbox: { type: "readOnly" }, settingsPending: true,
  };
  const restored = savedStreams(JSON.parse(JSON.stringify({ "%0": original })))["%0"];
  assert.deepEqual(restored, original);
  assert.deepEqual(selectStreamThread(restored, "thread-a"), original);
  assert.deepEqual(selectStreamThread(restored, "thread-b"), {
    agent: "codex", session: "thread-b", cwd: "C:/Project", unstarted: false,
  });
});

test("터미널 전환은 기본값과 같은 추론 선택을 미적용 변경으로 보지 않는다", () => {
  const current = { model: "model-a", approvalPolicy: "on-request" };
  assert.equal(codexSettingsPending({ ...current, effort: "medium" }, current, "medium"), false);
  assert.equal(codexSettingsPending({ ...current, effort: "high" }, current, "medium"), true);
  assert.equal(codexSettingsPending({ ...current, model: "model-b" }, current, "medium"), true);
  assert.equal(codexSettingsPending({ ...current, approvalPolicy: "untrusted" }, current, "medium"), true);
});
