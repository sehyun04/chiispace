import assert from "node:assert/strict";
import test from "node:test";
import {
  parseJsonl,
  buildToolMap,
  toItems,
  stripMeta,
  isSystemInjection,
  parseSlashCommand,
  turnDurations,
  turnTokens,
  fmtClock,
  resultText,
} from "../ui/transcript.ts";

const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n");
const items = (...rows) => {
  const events = parseJsonl(jsonl(...rows));
  return toItems(events, buildToolMap(events));
};
const user = (text, extra = {}) => ({ type: "user", message: { role: "user", content: text }, ...extra });
const asst = (content, extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });

test("깨진 줄이 섞여도 나머지를 읽는다", () => {
  const text = ['{"type":"user"}', "{반 토막", "", '{"type":"assistant"}'].join("\n");
  assert.deepEqual(
    parseJsonl(text).map((e) => e.type),
    ["user", "assistant"],
  );
});

test("주고받은 말이 말풍선이 된다", () => {
  const out = items(user("빌드 해줘"), asst([{ type: "text", text: "했다" }]));
  assert.deepEqual(
    out.map((i) => [i.kind, i.role, i.text]),
    [
      ["bubble", "user", "빌드 해줘"],
      ["bubble", "assistant", "했다"],
    ],
  );
});

test("위임 알림은 내 말풍선으로 새지 않는다", () => {
  // 칸 이름을 덮어쓰던 그 쪽지다. 대화에서도 사용자가 친 말로 보이면 안 된다.
  const out = items(user("<task-notification>Chiispace task-42488-6 시작</task-notification>"));
  assert.deepEqual(out, []);
});

test("메타 블록을 벗기고 남은 말만 말풍선이 된다", () => {
  const out = items(user("<system-reminder>규칙</system-reminder>\n진짜 할 말"));
  assert.deepEqual(
    out.map((i) => i.text),
    ["진짜 할 말"],
  );
});

test("닫히지 않은 래퍼는 그 뒤를 통째로 버린다", () => {
  // 잘린 래퍼 뒤의 글은 믿을 수 없다. 남기면 태그 부스러기가 화면에 박힌다.
  assert.equal(stripMeta("앞말<system-reminder>잘린 규칙"), "앞말");
});

test("이미지 자리 표시는 지운다", () => {
  assert.equal(stripMeta("[Image #1]\n설명"), "설명");
});

test("compact 이어가기 요약은 사용자가 보낸 말이 아니다", () => {
  assert.equal(isSystemInjection("This session is being continued from a previous conversation"), true);
  assert.equal(isSystemInjection("평범한 말"), false);
  assert.deepEqual(items(user("This session is being continued from a previous conversation...")), []);
});

test("슬래시 명령은 카드로 승격한다", () => {
  assert.deepEqual(parseSlashCommand("<command-name>/rename</command-name><command-args>치이카와</command-args>"), {
    kind: "command",
    name: "/rename",
    args: "치이카와",
    message: undefined,
  });
  const out = items(user("<command-name>/rename</command-name>"));
  assert.deepEqual(out, [{ kind: "command", name: "/rename", args: undefined, message: undefined }]);
});

test("로컬 명령 출력은 따로 선다", () => {
  const out = items(user("<local-command-stdout>내용</local-command-stdout>"));
  assert.deepEqual(out, [{ kind: "local-command", stdout: "내용" }]);
});

test("도구 호출과 그 결과가 한 장으로 묶인다", () => {
  const out = items(
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
      toolUseResult: { stdout: "a.txt" },
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "tool");
  assert.equal(out[0].toolUse.name, "Bash");
  assert.equal(resultText(out[0].pair.toolResult.content), "a.txt");
  assert.deepEqual(out[0].pair.toolUseResult, { stdout: "a.txt" });
});

test("도구 결과만 든 레코드는 말풍선이 되지 않는다", () => {
  const out = items({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "없는것", content: "x" }] },
  });
  assert.deepEqual(out, []);
});

test("생각은 따로 선다", () => {
  const out = items(asst([{ type: "thinking", thinking: "음..." }, { type: "text", text: "답" }]));
  assert.deepEqual(
    out.map((i) => i.kind),
    ["thinking", "bubble"],
  );
});

test("서브에이전트 호출은 한 줄 표시다", () => {
  const out = items(asst([{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "Explore", description: "찾기" } }]));
  assert.deepEqual(out, [{ kind: "launch", agentType: "Explore", description: "찾기" }]);
});

test("답한 질문만 문답 카드가 된다", () => {
  const asked = (id) => asst([{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: "어느 쪽?" }] } }]);
  // 아직 안 고른 것은 터미널로 보내는 카드가 된다. 고르는 화면은 TUI 에만 있다.
  assert.deepEqual(items(asked("t1")), [{ kind: "ask", questions: ["어느 쪽?"] }]);
  const out = items(asked("t1"), {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: 'answered: "어느 쪽?"="왼쪽".' }] },
  });
  assert.deepEqual(out, [{ kind: "qa", qa: [{ q: "어느 쪽?", a: "왼쪽" }] }]);
});

test("답 없는 질문도 뒤로 대화가 이어졌으면 버려진 것이다", () => {
  // 남겨 두면 이미 끝난 일을 고르라고 계속 조른다.
  const out = items(
    asst([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [{ question: "어느 쪽?" }] } }]),
    user("[Request interrupted by user]"),
    user("그냥 왼쪽으로 해"),
  );
  assert.deepEqual(
    out.map((i) => i.kind),
    ["interrupted", "bubble"],
  );
});

test("답 없는 질문 뒤의 시스템 카드는 끝을 가리지 않는다", () => {
  const out = items(
    asst([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [{ header: "방향" }] } }]),
    { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } },
  );
  assert.deepEqual(out[0], { kind: "ask", questions: ["방향"] });
});

test("따옴표가 든 질문의 답도 잃지 않는다", () => {
  // 쌍 정규식만 쓰면 여기서 답이 통째로 사라진다.
  const q = '"현재 경로"를 쓸까?';
  const out = items(
    asst([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [{ question: q }] } }]),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `answered: "${q}"="그래".` }] },
    },
  );
  assert.deepEqual(out[0].qa, [{ q, a: "그래" }]);
});

test("중단은 그 자리에 마커로 남고 앞 프롬프트는 지워지지 않는다", () => {
  const out = items(
    user("긴 작업 해줘", { uuid: "u1" }),
    user("[Request interrupted by user]"),
    user("[Request interrupted by user]"),
    user("다시", { uuid: "u2", parentUuid: "u1" }),
  );
  assert.deepEqual(
    out.map((i) => i.kind),
    ["bubble", "interrupted", "bubble"],
  );
  assert.equal(out[0].text, "긴 작업 해줘");
});

test("사이드체인은 기본으로 빠지고 따로 볼 때만 살아난다", () => {
  const rows = [user("본 대화"), user("서브 대화", { isSidechain: true })];
  assert.deepEqual(
    items(...rows).map((i) => i.text),
    ["본 대화"],
  );
  const kept = toItems(parseJsonl(jsonl(...rows)), new Map(), true);
  assert.deepEqual(
    kept.map((i) => i.text),
    ["본 대화", "서브 대화"],
  );
});

test("지우고 다시 친 발화만 사라진다", () => {
  // 아무도 부모로 안 가리키는데 다음 발화가 이 글로 시작하면 물린 것이다.
  const out = items(
    user("빌드", { uuid: "u1" }),
    user("빌드하고 배포까지", { uuid: "u2" }),
    asst([{ type: "text", text: "예" }], { parentUuid: "u2" }),
  );
  assert.deepEqual(
    out.map((i) => i.text),
    ["빌드하고 배포까지", "예"],
  );
});

test("빠르게 두 번 친 말은 지우지 않는다", () => {
  // 고아라는 것만으로 지우면 이것까지 사라진다.
  const out = items(user("먼저", { uuid: "u1" }), user("그리고 다른 말", { uuid: "u2" }));
  assert.deepEqual(
    out.map((i) => i.text),
    ["먼저", "그리고 다른 말"],
  );
});

test("예약 메시지는 대기 중으로 뜨고 처리되면 본문 하나만 남는다", () => {
  const enqueue = { type: "queue-operation", operation: "enqueue", content: "이것도 해줘", timestamp: "t" };
  const waiting = items(enqueue);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].queued, true);

  // 꺼내 가면 같은 말이 정식 턴으로 다시 온다. 큐 쪽은 중복이라 빠진다.
  const done = items(enqueue, { type: "queue-operation", operation: "dequeue" }, user("이것도 해줘"));
  assert.deepEqual(
    done.map((i) => [i.text, i.queued]),
    [["이것도 해줘", undefined]],
  );
});

test("큐에서 빠지기만 한 예약은 본문에 남고 표시만 풀린다", () => {
  const out = items(
    { type: "queue-operation", operation: "enqueue", content: "주입됨" },
    { type: "queue-operation", operation: "remove" },
  );
  assert.deepEqual(
    out.map((i) => [i.text, i.queued]),
    [["주입됨", false]],
  );
});

test("예약에 붙은 그림은 그 글과 한 말풍선이 된다", () => {
  // 따로 띄우면 시각이 갈라져 보낼 때 자리가 튄다.
  const out = items(
    {
      type: "attachment",
      attachment: { type: "queued_command", prompt: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
    },
    { type: "queue-operation", operation: "enqueue", content: "이거 봐" },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "이거 봐");
  assert.deepEqual(out[0].images, ["data:image/png;base64,AAA"]);
});

test("붙인 그림은 같은 턴의 말풍선에 합쳐진다", () => {
  const out = items(
    asst([{ type: "text", text: "봐봐" }]),
    {
      type: "user",
      timestamp: "t1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "이 화면" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "BBB" } },
        ],
      },
    },
  );
  const last = out[out.length - 1];
  assert.equal(last.text, "이 화면");
  assert.deepEqual(last.images, ["data:image/png;base64,BBB"]);
});

test("훅이 남긴 시스템 메시지만 카드가 된다", () => {
  const out = items(
    { type: "attachment", attachment: { type: "hook_success", stdout: JSON.stringify({ systemMessage: "훅 알림" }) } },
    { type: "attachment", attachment: { type: "hook_success", stdout: "그냥 출력" } },
  );
  assert.deepEqual(out, [{ kind: "system", text: "훅 알림" }]);
});

test("API 오류와 대화 줄이기는 시스템 카드로 보인다", () => {
  const out = items(
    { type: "system", subtype: "api_error", error: { status: 529, error: { message: "Overloaded" } }, retryAttempt: 1, maxRetries: 3 },
    { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 150000 } },
    { type: "system", subtype: "그밖" },
  );
  assert.equal(out.length, 2);
  assert.match(out[0].text, /529/);
  assert.match(out[0].text, /Overloaded/);
  assert.match(out[1].text, /auto/);
});

test("한 번 묻고 답이 끝나기까지 걸린 시간", () => {
  const events = parseJsonl(
    jsonl(
      user("해줘", { timestamp: "2026-09-23T00:00:00.000Z" }),
      asst([{ type: "text", text: "중간" }], { uuid: "a1", timestamp: "2026-09-23T00:00:01.000Z" }),
      asst([{ type: "text", text: "끝" }], { uuid: "a2", timestamp: "2026-09-23T00:00:03.500Z" }),
    ),
  );
  // 마지막 답에만 붙는다 — 한 번 물은 것의 전체 소요다.
  assert.deepEqual([...turnDurations(events)], [["a2", 3500]]);
});

test("도구 결과만 든 레코드는 새 질문으로 세지 않는다", () => {
  const events = parseJsonl(
    jsonl(
      user("해줘", { timestamp: "2026-09-23T00:00:00.000Z" }),
      { type: "user", timestamp: "2026-09-23T00:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } },
      asst([{ type: "text", text: "끝" }], { uuid: "a1", timestamp: "2026-09-23T00:00:04.000Z" }),
    ),
  );
  assert.deepEqual([...turnDurations(events)], [["a1", 4000]]);
});

test("출력 토큰은 원문에 적힌 값을 쓴다", () => {
  const events = parseJsonl(
    jsonl(
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [], usage: { output_tokens: 1234 } } },
      { type: "assistant", uuid: "a2", message: { role: "assistant", content: [], usage: { output_tokens: 0 } } },
      { type: "assistant", uuid: "a3", isSidechain: true, message: { role: "assistant", content: [], usage: { output_tokens: 99 } } },
    ),
  );
  assert.deepEqual([...turnTokens(events)], [["a1", 1234]]);
});

test("시각은 못 읽으면 빈 글자다", () => {
  assert.equal(fmtClock(undefined), "");
  assert.equal(fmtClock("말도 안 되는 것"), "");
  assert.match(fmtClock("2026-09-23T14:47:00.000Z"), /^(오전|오후) \d{1,2}:\d{2}$/);
});
