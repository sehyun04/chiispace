import assert from "node:assert/strict";
import test from "node:test";
import { attach, leaves, rects } from "../ui/layout.ts";

const leaf = (id) => ({ kind: "leaf", id });
const width = (n, id) => rects(n).find((s) => s.id === id).rect.w;
const height = (n, id) => rects(n).find((s) => s.id === id).rect.h;

test("딸린 칸은 처음엔 오른쪽에 붙고, 다음부터는 그 아래로 쌓여 본 칸 넓이가 그대로다", () => {
  let n = { kind: "split", dir: "v", ratio: 0.5, a: leaf("%0"), b: leaf("%1") };
  n = attach(n, "%0", [], "%2");
  assert.deepEqual(leaves(n), ["%0", "%2", "%1"]);
  assert.equal(width(n, "%0"), 0.5);
  n = attach(n, "%0", ["%2"], "%3");
  n = attach(n, "%0", ["%2", "%3"], "%4");
  assert.deepEqual(leaves(n), ["%0", "%2", "%3", "%4", "%1"]);
  assert.equal(width(n, "%0"), 0.5, "딸린 칸이 늘어도 본 칸이 줄면 안 된다");
  // 쌓인 셋은 본 칸 높이를 고르게 나눈다.
  for (const id of ["%2", "%3", "%4"]) assert.ok(Math.abs(height(n, id) - 0.5 / 3) < 1e-9, id);
  // 다른 칸은 손대지 않는다.
  assert.equal(height(n, "%1"), 0.5);
});

test("이미 닫힌 딸린 칸은 무리로 치지 않는다", () => {
  const n = attach(leaf("%0"), "%0", ["%7"], "%8");
  assert.deepEqual(leaves(n), ["%0", "%8"]);
  assert.equal(n.dir, "h");
});
