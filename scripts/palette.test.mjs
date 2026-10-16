import assert from "node:assert/strict";
import test from "node:test";
import { agentCommands, barCommands, choose, complete, mergeCommands, paletteView, terminalCommands } from "../ui/palette.ts";

const field = (value, values, calls) => ({ value, choices: values.map((v) => ({ value: v, label: v.toUpperCase() })), onChange: (v) => calls.push(v) });

test("빗금 뒤 이름으로 고르고, 정확히 같은 이름과 앞이 맞는 이름이 먼저 선다", () => {
  const list = agentCommands([{ name: "compact" }, { name: "config", aliases: ["settings"] }, { name: "context" }, { name: "recap" }]);
  assert.deepEqual(paletteView("/", list).items.map((c) => c.name), ["compact", "config", "context", "recap"]);
  assert.deepEqual(paletteView("/co", list).items.map((c) => c.name), ["compact", "config", "context"]);
  assert.deepEqual(paletteView("/settings", list).items.map((c) => c.name), ["config"], "별칭으로도 찾는다");
  assert.deepEqual(paletteView("/cap", list).items.map((c) => c.name), ["recap"], "이름 가운데도 찾는다");
  assert.equal(paletteView("/zzz", list), null, "맞는 게 없으면 목록을 안 띄워 그대로 보내게 둔다");
  assert.equal(paletteView("그냥 말", list), null);
  assert.equal(paletteView("/compact\n둘째 줄", list), null);
});

test("한글로 치면 설명에서 찾는다", () => {
  const list = barCommands({ model: field("a", ["a", "b"], []), permission: field("x", ["x"], []), onStatus() {}, onNew() {}, busy: false });
  assert.deepEqual(paletteView("/모델", list).items.map((c) => c.name), ["model", "status"], "상태 설명에도 모델이 있다");
  assert.deepEqual(paletteView("/새 대화".split(" ")[0], list).items.map((c) => c.name), ["clear"]);
});

test("줄의 모델을 명령으로 고르면 줄과 같은 바꾸기를 부른다", () => {
  const calls = [];
  const list = barCommands({ model: field("sonnet", ["", "opus", "sonnet"], calls), permission: field("default", ["default", "plan"], []), onStatus() {}, onNew() {}, busy: false });
  const top = paletteView("/model", list);
  assert.deepEqual(choose(top, 0), { kind: "fill", text: "/model " }, "고를 것이 있으면 먼저 그 목록으로 간다");
  const choices = paletteView("/model ", list);
  assert.equal(choices.stage, "choices");
  assert.deepEqual(choices.items.map((c) => [c.value, !!c.current]), [["opus", false], ["sonnet", true]], "값이 빈 자리표시는 고를 것이 아니다");
  const action = choose(paletteView("/model op", list), 0);
  assert.equal(action.kind, "run");
  action.run();
  assert.deepEqual(calls, ["opus"]);
  assert.equal(complete(choices, 0), "/model opus");
});

test("일하는 중에는 새 대화를, 막힌 항목은 명령에서도 뺀다", () => {
  const off = { ...field("a", ["a"], []), disabled: true };
  const names = (busy, model) => barCommands({ model, permission: field("x", ["x"], []), onStatus() {}, onNew() {}, busy }).map((c) => c.name);
  assert.deepEqual(names(false, field("a", ["a"], [])), ["model", "permissions", "status", "clear"]);
  assert.deepEqual(names(true, off), ["permissions", "status"]);
});

test("앱이 하는 명령이 같은 이름의 에이전트 명령을 가린다", () => {
  let ran = 0;
  const app = barCommands({ model: field("a", ["a"], []), permission: field("x", ["x"], []), onStatus() {}, onNew: () => ran++, busy: false });
  const agent = agentCommands([
    { name: "clear", aliases: ["reset", "new"], description: "Start a new session" },
    { name: "model", argumentHint: "<model>" },
    { name: "__remote-workflow" },
    { name: "code-review", description: "Review the diff\nmore lines", argumentHint: "[low|high]" },
  ]);
  const merged = mergeCommands(app, agent);
  assert.deepEqual(merged.map((c) => c.name), ["model", "permissions", "status", "clear", "code-review"]);
  assert.equal(merged.at(-1).hint, "Review the diff", "설명은 첫 줄만");
  const action = choose(paletteView("/new", merged), 0);
  assert.equal(action.kind, "run", "별칭으로 쳐도 앱이 한다");
  action.run();
  assert.equal(ran, 1);
});

test("앱이 하지 않는 명령은 보낸다 — 꼭 써야 하는 인자가 있으면 이름만 채운다", () => {
  const list = agentCommands([
    { name: "compact", argumentHint: "<optional custom summarization instructions>" },
    { name: "rename", argumentHint: "[name]" },
    { name: "config", argumentHint: "key=value" },
    { name: "context" },
  ]);
  assert.deepEqual(choose(paletteView("/compact", list), 0), { kind: "send", text: "/compact" });
  assert.deepEqual(choose(paletteView("/rename", list), 0), { kind: "send", text: "/rename" });
  assert.deepEqual(choose(paletteView("/config", list), 0), { kind: "fill", text: "/config " });
  assert.deepEqual(choose(paletteView("/context", list), 0), { kind: "send", text: "/context" });
  assert.equal(complete(paletteView("/comp", list), 0), "/compact ", "Tab 은 보내지 않고 채우기만");
  assert.equal(paletteView("/compact 남길 것", list), null, "인자를 쓰는 중에는 목록이 없다");
});

test("터미널 칸의 모델·추론은 인자를 붙여 보내 TUI 메뉴를 띄우지 않는다", () => {
  const list = terminalCommands((v) => `L-${v}`);
  assert.deepEqual(choose(paletteView("/model son", list), 0), { kind: "send", text: "/model sonnet" });
  assert.deepEqual(choose(paletteView("/effort ", list), 2), { kind: "send", text: "/effort high" });
  assert.equal(paletteView("/effort ", list).items[2].label, "L-high");
  assert.equal(list.find((c) => c.name === "config").terminal, true, "메뉴로 넘어가는 명령은 표시한다");
  assert.deepEqual(choose(paletteView("/config", list), 0), { kind: "send", text: "/config" });
});
