import assert from "node:assert/strict";
import test from "node:test";
import { freshSession, liveAttach, splitContinue, seedSession } from "../ui/session.ts";

const worker = "abcdef12-1111-4111-8111-111111111111";
const human = "12345678-2222-4222-8222-222222222222";
const older = "87654321-3333-4333-8333-333333333333";
const sessions = [worker, human, older].map((id) => ({ id, title: id }));

test("최신 백그라운드 대화를 제외하고 사용자 대화 하나만 복원", () => {
  const result = splitContinue(["%1", "%2"], sessions, new Set(), ["ABCDEF12"]);
  assert.equal(result["%1"].seed.cmd, `claude --resume ${human}`);
  assert.match(result["%2"].seed.cmd, /^claude --session-id /);
  assert.notEqual(result["%2"].sid, human);
});

test("사용자 대화가 이미 다른 칸에 있으면 더 오래된 대화를 추측하지 않음", () => {
  const result = splitContinue(["%1"], sessions, new Set([human]), [worker]);
  assert.match(result["%1"].seed.cmd, /^claude --session-id /);
  assert.notEqual(result["%1"].sid, older);
});

test("후보가 없거나 백그라운드 대화뿐이면 칸마다 고유한 새 대화", () => {
  for (const list of [[], [{ id: worker }]]) {
    const result = splitContinue(["%1", "%2"], list, new Set(), [worker]);
    const ids = Object.values(result).map(({ seed, sid }) => {
      assert.match(seed.cmd, /^claude --session-id /);
      assert.equal(seed.auto, true);
      assert.equal(seedSession(seed.cmd), sid);
      return sid;
    });
    assert.equal(new Set(ids).size, 2);
  }
});

test("새 대화 탐색에서 워커와 기존 대화와 다른 칸의 대화를 제외", () => {
  assert.equal(freshSession(sessions, ["ABCDEF12"], new Set([older]), new Set())?.id, human);
  assert.equal(freshSession(sessions, [worker], new Set([older]), new Set([human])), undefined);
  assert.equal(freshSession([{ id: worker }], [worker], new Set(), new Set()), undefined);
});

test("명시적으로 지정된 백그라운드 대화는 attach 복원을 유지", () => {
  assert.deepEqual(liveAttach({ cmd: `claude --resume ${worker}`, auto: true }, ["ABCDEF12"]), {
    cmd: "claude attach abcdef12", auto: true,
  });
  const seed = { cmd: `claude --resume ${human}`, auto: true };
  assert.deepEqual(liveAttach(seed, [worker]), seed);
});

test("탐색 중 워커가 종료돼도 그 파일을 사용자 대화로 재분류하지 않음", () => {
  const seen = new Set();
  assert.equal(freshSession([{ id: worker }], [worker], seen, new Set()), undefined);
  assert.equal(freshSession([{ id: worker }], [], seen, new Set()), undefined);
  assert.equal(freshSession(sessions, [], seen, new Set())?.id, human);
});

test("다른 창이 열어 둔 대화는 --continue 대체 후보에서 뺀다", () => {
  // 사용자가 이 폴더에서 claude 를 켜 두고 일을 시키면 그 대화가 늘 가장 최근이라,
  // 안 빼면 켤 때마다 그 대화를 뺏으려 들다 거절당해 그 칸이 죽는다.
  const result = splitContinue(["%1"], sessions, new Set(), [worker], [human]);
  assert.match(result["%1"].seed.cmd, /^claude --session-id /);
  assert.notEqual(result["%1"].sid, human);
  assert.notEqual(result["%1"].sid, older);
});

test("다른 창이 붙들고 있는 대화는 정체를 지키되 실행하지 않는다", () => {
  // `attach` 는 데몬에 맡긴 대화에만 통한다. 명령을 바꾸면 이 칸이 무엇이었는지를
  // 잃으므로 명령은 그대로 두고 실행만 미룬다 — 저쪽 창을 닫고 Enter 하면 열린다.
  const seed = { cmd: `claude --resume ${human}`, auto: true };
  assert.deepEqual(liveAttach(seed, [], [human]), { cmd: seed.cmd, auto: false });
  // 살아 있는 것이 백그라운드면 여전히 데려온다.
  assert.deepEqual(liveAttach({ cmd: `claude --resume ${worker}`, auto: true }, [worker], [worker]), {
    cmd: "claude attach abcdef12", auto: true,
  });
  // 아무 데서도 안 열려 있으면 그대로 이어 연다.
  assert.deepEqual(liveAttach(seed, [], [worker]), seed);
});
