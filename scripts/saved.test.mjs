import assert from "node:assert/strict";
import test from "node:test";
import { bootStreams, leavesOf, readSaved, savedJson } from "../ui/saved.ts";

const sid = "12345678-2222-4222-8222-222222222222";
const other = "87654321-3333-4333-8333-333333333333";
const leaf = (id) => ({ kind: "leaf", id });
const tabs = [
  { key: "t0", layout: { kind: "split", dir: "h", ratio: 0.5, a: leaf("%0"), b: leaf("%1") }, root: "C:\\work", focus: "%0" },
  { key: "t1", layout: leaf("%2"), root: "C:\\other", focus: "%2" },
];

test("깨진 세션 파일은 없는 것으로 본다", () => {
  for (const raw of [null, "", "{", "null", "[]", "3", '"x"']) assert.equal(readSaved(raw), null, String(raw));
  assert.deepEqual(readSaved('{"fontSize":14}'), { fontSize: 14 });
});

test("저장은 닫힌 칸의 복원 명령·이름·대화·터미널 고정을 빼고 적는다", () => {
  const json = JSON.parse(savedJson({
    tabs, active: 1, nextPane: 5, nextTab: 2, fontSize: 15,
    procs: { "%0": { cmd: `claude --resume ${sid}`, auto: true, claudeSession: sid }, "%9": { cmd: "npm run dev" } },
    names: { "%0": "서버" },
    paneTitles: { "%1": "빌드", "%9": "닫힌 칸", "%2": "C:\\Windows\\System32\\cmd.exe" },
    casting: { "%0": "chiikawa" },
    sideOpen: false,
    streams: { "%1": { agent: "claude", session: other, cwd: "C:\\work" }, "%9": { agent: "codex", session: "x", cwd: "C:\\" } },
    keepTerm: { "%0": true, "%9": true },
  }));
  assert.deepEqual(Object.keys(json.procs), ["%0"]);
  assert.equal(json.restoreMode, "native-continue");
  // 자동 이름도 저장할 때 다시 거른다 — 셸 경로가 마지막 이름을 덮지 않게.
  assert.deepEqual(json.paneTitles, { "%1": "빌드" });
  assert.deepEqual(Object.keys(json.streams), ["%1"]);
  assert.deepEqual(json.keepTerminal, ["%0"]);
  assert.equal(json.sideOpen, false);
  assert.equal(json.nextPane, 5);
  assert.deepEqual(leavesOf(json.tabs), ["%0", "%1", "%2"]);
});

test("켤 때 대화 파일이 있는 Claude 칸만 터미널 없는 칸으로 옮긴다", async () => {
  const seeds = {
    "%0": { cmd: `claude --resume ${sid}`, auto: true, cwd: "C:\\work", claudeSession: sid },
    "%1": { cmd: `claude --resume ${other}`, auto: true, claudeSession: other },
    "%2": { cmd: "claude --continue", auto: true, cwd: "C:\\other" },
  };
  const asked = [];
  const size = async (root, id) => {
    asked.push([root, id]);
    return id === sid ? 120 : 0;
  };
  const out = await bootStreams(seeds, {}, tabs, size);
  assert.deepEqual(out.moved, { "%0": { agent: "claude", session: sid, cwd: "C:\\work" } });
  // 파일을 못 찾은 칸과 어느 대화인지 모르는 --continue 칸은 터미널로 남는다.
  assert.deepEqual(Object.keys(out.seeds).sort(), ["%1", "%2"]);
  // 폴더가 적혀 있지 않으면 그 칸이 든 탭의 폴더에서 찾는다.
  assert.deepEqual(asked, [["C:\\work", sid], ["C:\\work", other]]);
  // 넘긴 원본은 그대로다.
  assert.equal(Object.keys(seeds).length, 3);
});

test("터미널로 되돌려 둔 칸과 조회 실패는 옮기지 않는다", async () => {
  const seeds = { "%0": { cmd: `claude --resume ${sid}`, auto: true, cwd: "C:\\work", claudeSession: sid } };
  const kept = await bootStreams(seeds, { "%0": true }, tabs, async () => 1);
  assert.deepEqual(kept.moved, {});
  const failed = await bootStreams(seeds, {}, tabs, async () => { throw new Error("no file"); });
  assert.deepEqual(failed.moved, {});
  assert.deepEqual(Object.keys(failed.seeds), ["%0"]);
});
