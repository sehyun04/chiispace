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
