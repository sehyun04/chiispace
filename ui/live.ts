/** 지금 쓰이는 중인 답.
 *
 *  대화 파일(jsonl)은 claude 가 답을 다 받은 뒤에 적는다. 그 사이 — 글자가 한 자씩
 *  나오고, 생각이 흐르고, 도구 호출이 채워지는 동안 — 을 보여주는 것이 여기다.
 *  재료는 앱의 루프백 프록시(proxy.rs)가 옆에서 읽어 넘기는 SSE 이벤트다.
 *
 *  React 를 부르지 않는다. 이벤트를 모으는 규칙을 브라우저 없이 돌려 보려고. */

export type LiveBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; json: string };

export type Live = {
  /** 앱이 매기는 요청 번호. 늦게 도착한 옛 요청의 조각이 새 답에 섞이지 않게 가른다. */
  req: number;
  blocks: LiveBlock[];
  /** 스트림이 끝났다. 대화 파일이 따라잡을 때까지만 더 보여준다. */
  done: boolean;
  stop?: string;
  error?: string;
};

export type LiveEvent = {
  session: string;
  req: number;
  phase: "begin" | "data" | "end";
  events?: string[];
};

type Sse = {
  type?: string;
  index?: number;
  content_block?: { type?: string; name?: string; text?: string; thinking?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  error?: { message?: string };
};

function withBlock(blocks: LiveBlock[], index: number, block: LiveBlock): LiveBlock[] {
  const next = blocks.slice();
  next[index] = block;
  return next;
}

/** 이벤트 한 묶음을 반영한 새 상태. 받은 상태는 고치지 않는다(React 가 바뀐 줄 알게). */
export function applyLive(live: Live | null, ev: LiveEvent): Live | null {
  if (ev.phase === "begin") return { req: ev.req, blocks: [], done: false };
  // 다른 요청의 조각. 새 답이 이미 시작됐으면 옛 것의 꼬리는 버린다.
  if (live && ev.req < live.req) return live;
  let cur: Live = live && live.req === ev.req ? live : { req: ev.req, blocks: [], done: false };
  if (ev.phase === "end") return { ...cur, done: true };

  let blocks = cur.blocks;
  let stop = cur.stop;
  let error = cur.error;
  let done = cur.done;
  for (const raw of ev.events ?? []) {
    let e: Sse;
    try {
      e = JSON.parse(raw) as Sse;
    } catch {
      continue;
    }
    const i = e.index ?? 0;
    switch (e.type) {
      case "content_block_start": {
        const cb = e.content_block ?? {};
        if (cb.type === "text") blocks = withBlock(blocks, i, { kind: "text", text: cb.text ?? "" });
        else if (cb.type === "thinking") blocks = withBlock(blocks, i, { kind: "thinking", text: cb.thinking ?? "" });
        else if (cb.type === "tool_use" || cb.type === "server_tool_use")
          blocks = withBlock(blocks, i, { kind: "tool", name: cb.name ?? "도구", json: "" });
        break;
      }
      case "content_block_delta": {
        const b = blocks[i];
        const d = e.delta ?? {};
        if (!b) break;
        if (d.type === "text_delta" && b.kind === "text") blocks = withBlock(blocks, i, { ...b, text: b.text + (d.text ?? "") });
        else if (d.type === "thinking_delta" && b.kind === "thinking")
          blocks = withBlock(blocks, i, { ...b, text: b.text + (d.thinking ?? "") });
        else if (d.type === "input_json_delta" && b.kind === "tool")
          blocks = withBlock(blocks, i, { ...b, json: b.json + (d.partial_json ?? "") });
        break;
      }
      case "message_delta":
        stop = e.delta?.stop_reason ?? stop;
        break;
      case "message_stop":
        done = true;
        break;
      case "error":
        error = e.error?.message ?? "오류";
        done = true;
        break;
    }
  }
  cur = { ...cur, blocks, stop, error, done };
  return cur;
}

/** 채워지는 중인 도구 입력. 아직 반쪽짜리 JSON 이라 닫아 보고 읽을 수 있는 만큼만 읽는다 —
 *  명령이 다 오기 전에도 무엇을 하려는지는 보이는 게 낫다. */
export function partialInput(json: string): unknown {
  if (!json.trim()) return {};
  for (const tail of ["", '"}', "}", '"]}', "]}", '""}']) {
    try {
      return JSON.parse(json + tail);
    } catch {
      // 다음 꼬리로
    }
  }
  return {};
}

/** 끝난 답을 대화 파일이 따라잡았는가.
 *
 *  스트림이 끝나도 claude 가 파일에 적기까지 잠깐 걸린다. 그 사이에 쓰이던 말풍선을
 *  걷으면 방금 본 답이 사라졌다가 다시 나타난다. 파일에 새 줄이 생긴 뒤에 걷는다. */
export function caughtUp(live: Live | null, rawAtEnd: number | null, rawNow: number): boolean {
  if (!live?.done || rawAtEnd == null) return false;
  return rawNow > rawAtEnd;
}

// ── 서브에이전트 (proxy.rs → chat:sub) ──────────────────────────────

export type SubEvent = LiveEvent & { agent: string; label?: string };

/** 서브에이전트가 마지막으로 한 일. 요청과 요청 사이 — 도구가 실제로 도는 동안 — 에는
 *  스트림이 없으므로, 이걸 들고 있지 않으면 가장 오래 걸리는 순간에 아무것도 안 보인다. */
export type SubStep =
  | { kind: "tool"; name: string; json: string }
  | { kind: "text"; text: string }
  | { kind: "thinking" };

export type Sub = {
  agent: string;
  label: string;
  live: Live | null;
  step: SubStep | null;
  /** 마지막으로 무엇이 온 때(ms). 오래 조용한 것은 걷는다. */
  at: number;
};

function lastStep(live: Live | null): SubStep | null {
  const blocks = live?.blocks.filter(Boolean) ?? [];
  const b = blocks[blocks.length - 1];
  if (!b) return null;
  if (b.kind === "tool") return { kind: "tool", name: b.name, json: b.json };
  if (b.kind === "text") return b.text.trim() ? { kind: "text", text: b.text } : null;
  return { kind: "thinking" };
}

/** 서브에이전트 이벤트 한 묶음을 반영한 새 목록. 처음 본 에이전트는 뒤에 붙는다. */
export function applySub(subs: Sub[], ev: SubEvent, now: number): Sub[] {
  const i = subs.findIndex((s) => s.agent === ev.agent);
  // 모르는 에이전트의 끝 신호는 버린다. 마쳐서 걷은 뒤에 스트림 종료가 늦게 오면 빈 줄이
  // 새로 생겨 "시작하는 중"으로 오래 남는다.
  if (i < 0 && ev.phase === "end") return subs;
  const cur: Sub = i >= 0 ? subs[i] : { agent: ev.agent, label: ev.label || "서브에이전트", live: null, step: null, at: now };
  const live = applyLive(cur.live, ev);
  // 새 요청이 막 시작돼 아직 아무것도 안 왔으면 앞 요청의 마지막 일을 그대로 보인다.
  const next: Sub = { ...cur, label: ev.label || cur.label, live, step: lastStep(live) ?? cur.step, at: now };
  return i >= 0 ? subs.map((s, k) => (k === i ? next : s)) : [...subs, next];
}

/** 오래 조용한 서브에이전트를 걷는다. 마친 것은 `subFinished` 가 가려내므로 이것은 스트림이
 *  끊겨 끝을 못 본 경우의 안전망이다. */
export function pruneSubs(subs: Sub[], now: number, quietMs: number): Sub[] {
  const keep = subs.filter((s) => now - s.at < quietMs);
  return keep.length === subs.length ? subs : keep;
}

/** 지금 쓰는 중인가(요청이 흐르는 중). 아니면 도구가 도는 중이거나 쉬는 중이다. */
export function subStreaming(s: Sub): boolean {
  return !!s.live && !s.live.done;
}

/** 서브에이전트가 일을 마쳤는가. 중간 요청은 도구를 부르며 끝나고(`tool_use`), 마지막 요청만
 *  답으로 끝난다. 본 대화가 다시 말하는 것으로는 알 수 없다 — 새 claude 는 서브에이전트를
 *  백그라운드로 돌리며 본 대화를 계속 진행한다. */
export function subFinished(s: Sub): boolean {
  const l = s.live;
  if (!l?.done) return false;
  return !!l.error || (!!l.stop && l.stop !== "tool_use");
}
