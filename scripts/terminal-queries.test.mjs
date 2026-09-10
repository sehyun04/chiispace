import assert from "node:assert/strict";
import test from "node:test";
import { delegateTerminalQueries } from "../ui/terminal-queries.ts";

function handlers() {
  const csi = new Map();
  const osc = new Map();
  delegateTerminalQueries({ parser: {
    registerCsiHandler: (id, fn) => csi.set((id.prefix ?? "") + id.final, fn),
    registerOscHandler: (id, fn) => osc.set(id, fn),
  } });
  return { csi, osc };
}

test("엔진이 답한 장치·커서 조회의 xterm 중복 응답 방지", () => {
  const { csi } = handlers();
  for (const code of ["c", ">c"]) assert.equal(csi.get(code)([0]), true);
  for (const n of [5, 6]) assert.equal(csi.get("n")([n]), true);
  assert.equal(csi.get("?n")([6]), true);
  assert.equal(csi.get("n")([99]), false);
});

test("색 조회만 위임하고 실제 팔레트 변경은 보존", () => {
  const { osc } = handlers();
  for (const code of [10, 11, 12]) {
    assert.equal(osc.get(code)("?"), true);
    assert.equal(osc.get(code)("?;?"), true);
    assert.equal(osc.get(code)("rgb:ffff/0000/0000"), false);
  }
  assert.equal(osc.get(4)("1;?;2;?"), true);
  assert.equal(osc.get(4)("1;rgb:ffff/0000/0000"), false);
});
