import { reduceCodex, resumedCodex, type CodexStream, type Data, type Request } from "./codex-stream.ts";

export type CodexPhoneAction =
  | { kind: "snapshot" }
  | { kind: "send"; run: string; turn: string | null; text: string; images: string[] }
  | { kind: "answer"; run: string; threadId: string; requestId: Request["id"]; result: Data }
  | { kind: "interrupt"; run: string; turn: string }
  | { kind: "child"; run: string; threadId: string };

export type CodexPhoneCall = { call: number; id: string; session: string; run: string; action: CodexPhoneAction };
export type CodexPhoneEvent = { id: string; session: string; run: string; seq: number; message: Data };
export type CodexPhoneSnapshot = { run: string; seq: number; ready: boolean; state: CodexStream };

function recentItems(items: Data[]): Data[] {
  // 다시 붙을 때 휴대폰 망으로 긴 도구 출력과 앞 대화의 그림을 한꺼번에 보내지 않는다.
  const entries = [];
  const utf8 = new TextEncoder();
  let remaining = 8 * 1024 * 1024;
  for (const item of items.slice(-160).reverse()) {
    const size = utf8.encode(JSON.stringify(item)).byteLength;
    if (size > remaining) continue;
    remaining -= size;
    entries.push(item);
  }
  return entries.reverse();
}

export function codexPhoneSnapshot(state: CodexStream, run: string, seq: number, ready: boolean): CodexPhoneSnapshot {
  return { run, seq, ready, state: { ...state, entries: recentItems(state.entries) } };
}

export function codexPhoneChild(thread: Data): Data {
  const byTurn = new Map<string, Data[]>();
  for (const { _turn, ...item } of recentItems(resumedCodex(thread).entries)) {
    const items = byTurn.get(_turn);
    if (items) items.push(item);
    else byTurn.set(_turn, [item]);
  }
  return { id: thread.id, agentNickname: thread.agentNickname, agentRole: thread.agentRole,
    turns: Array.from(byTurn, ([id, items]) => ({ id, items })) };
}

export function codexPhoneEvent(snapshot: CodexPhoneSnapshot, event: CodexPhoneEvent): CodexPhoneSnapshot {
  if (event.session !== snapshot.state.thread || event.run !== snapshot.run || event.seq <= snapshot.seq) return snapshot;
  if (event.message.method === "chiispace/exit") {
    return { ...snapshot, seq: event.seq, ready: false, state: { ...snapshot.state, busy: false, turn: null, prompts: [], agents: [] } };
  }
  return { ...snapshot, seq: event.seq, state: reduceCodex(snapshot.state, event.message) };
}
