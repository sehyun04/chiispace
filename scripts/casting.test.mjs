import assert from "node:assert/strict";
import test from "node:test";
import { assign } from "../ui/casting.ts";

const pool = ["a", "b", "c"];

test("새 칸은 떠 있는 칸과 겹치지 않는 사람을 받는다", () => {
  const got = assign({ "%0": "a" }, ["%0", "%1"], ["%1"], pool);
  assert.equal(got["%1"], "b");
  const two = assign({ "%0": "a" }, ["%0", "%1", "%2"], ["%1", "%2"], pool);
  assert.deepEqual([two["%1"], two["%2"]], ["b", "c"], "한 번에 여럿이 생겨도 서로 겹치지 않는다");
});

test("모두가 한 번씩 나온 뒤에도 닫힌 칸의 사람을 다시 써서 떠 있는 칸과 겹치지 않는다", () => {
  // 닫힌 칸 %0·%1·%2 가 a·b·c 를 다 썼다. 예전에는 이때 순번으로 돌아 떠 있는 %3(a)과 겹쳤다.
  const casting = { "%0": "a", "%1": "b", "%2": "c", "%3": "a" };
  const got = assign(casting, ["%3", "%4"], ["%4"], pool);
  assert.notEqual(got["%4"], "a");
  assert.equal(got["%0"], "a", "닫힌 칸의 배정은 지우지 않는다");
});

test("아직 안 나온 사람을 닫힌 칸의 사람보다 먼저 쓴다", () => {
  const got = assign({ "%0": "a" }, ["%1"], ["%1"], pool);
  assert.equal(got["%1"], "b");
});

test("떠 있는 칸이 사람보다 많을 때만 겹친다", () => {
  const got = assign({ "%0": "a", "%1": "b", "%2": "c" }, ["%0", "%1", "%2", "%3"], ["%3"], pool);
  assert.ok(pool.includes(got["%3"]));
  assert.equal(assign({ "%0": "a" }, ["%0"], [], pool)["%0"], "a", "붙일 칸이 없으면 그대로");
});
