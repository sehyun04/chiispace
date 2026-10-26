import assert from "node:assert/strict";
import test from "node:test";
import { agentCommands, ago, barCommands, choose, complete, mergeCommands, paletteView } from "../ui/palette.ts";

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

test("고르는 순간 불러오는 목록은 불러오는 동안·비었을 때도 자리를 띄우고, Enter 는 아무것도 보내지 않는다", async () => {
  let ran = null;
  const resume = { name: "resume", hint: "지난 대화", empty: "지난 대화가 없다", load: async () => [], run: (v) => (ran = v) };
  assert.deepEqual(choose(paletteView("/resume", [resume]), 0), { kind: "fill", text: "/resume " }, "불러올 목록이 있으면 먼저 그 목록으로");
  const loading = paletteView("/resume ", [resume]);
  assert.equal(loading.note, "불러오는 중");
  assert.equal(choose(loading, 0), null, "불러오는 중에 Enter 가 /resume 을 claude 에 보내면 안 된다");
  assert.equal(paletteView("/resume ", [{ ...resume, choices: [] }]).note, "지난 대화가 없다");
  const loaded = { ...resume, choices: [{ value: "a1", label: "로그 찾기" }, { value: "b2", label: "배포" }] };
  assert.deepEqual(paletteView("/resume 배", [loaded]).items.map((c) => c.value), ["b2"]);
  assert.equal(paletteView("/resume 없는말", [loaded]).note, "맞는 것 없음");
  choose(paletteView("/resume 로그", [loaded]), 0).run();
  assert.equal(ran, "a1");
});

test("목록의 언제는 하루 안이면 몇 분·시간 전, 그보다 오래면 날짜", () => {
  const now = new Date(2026, 9, 26, 12, 0).getTime();
  assert.equal(ago(now - 20 * 1000, now), "방금");
  assert.equal(ago(now - 5 * 60000, now), "5분 전");
  assert.equal(ago(now - 3 * 3600000, now), "3시간 전");
  assert.equal(ago(new Date(2026, 9, 20, 9, 0).getTime(), now), "10월 20일");
});
