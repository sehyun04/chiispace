import type { Bubble, Item, ToolPair } from "./transcript";

type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const list = (v: unknown): RecordValue[] => Array.isArray(v) ? v.map(object) : [];
const contentText = (v: unknown) => typeof v === "string" ? v : list(v).map(b => text(b.text)).filter(Boolean).join("\n");
const images = (v: unknown) => list(v).map(b => text(b.image_url ?? b.url))
  .filter(s => /^data:image\/(png|jpeg|webp|gif);base64,/i.test(s));

export function codexTranscript(raw: string) {
  const records: RecordValue[] = [];
  for (const line of raw.split("\n")) {
    try { records.push(object(JSON.parse(line))); } catch { /* 기록 중인 마지막 줄은 다음 읽기에서 받는다. */ }
  }
  const items: Item[] = [];
  const durs = new Map<string, number>();
  const toks = new Map<string, number>();
  const tools = new Map<string, ToolPair>();
  const seen = new Set<string>();
  const turns: number[] = [];
  let busy = false;
  let lastReply: Bubble | undefined;
  let started: number | undefined;
  let outputTokens: number | undefined;
  // 모델 입력에는 환경·AGENTS.md도 user 역할로 들어간다. 실제 사용자 이벤트를 우선한다.
  const hasUsers = records.some(r => r.type === "event_msg" && (object(r.payload).type === "user_message"
    || (object(r.payload).type === "item_completed" && object(object(r.payload).item).type === "UserMessage")));
  const pushUser = (message: string, ts: string, id?: string, pics?: string[]) => {
    if (id && seen.has(`user:${id}`)) return;
    if (!message && !pics?.length) return;
    if (id) seen.add(`user:${id}`);
    turns.push(items.length);
    items.push({ kind: "bubble", role: "user", text: message, ts, uuid: id, images: pics });
    lastReply = undefined;
  };
  for (const [index, r] of records.entries()) {
    const p = object(r.payload);
    const ts = text(r.timestamp);
    if (r.type === "event_msg") {
      switch (p.type) {
        case "task_started": case "turn_started":
          busy = true; started = Date.parse(ts); outputTokens = undefined;
          break;
        case "user_message":
          pushUser(text(p.message), ts, text(p.id) || undefined,
            Array.isArray(p.images) ? p.images.filter((s): s is string => typeof s === "string" && s.startsWith("data:image/")) : []);
          break;
        case "item_completed": {
          const item = object(p.item);
          if (item.type === "UserMessage") pushUser(contentText(item.content), ts, text(item.id), images(item.content));
          break;
        }
        case "token_count": {
          const n = object(object(p.info).last_token_usage).output_tokens;
          if (typeof n === "number") outputTokens = n;
          break;
        }
        case "task_complete": case "turn_complete":
          busy = false;
          if (lastReply?.uuid) {
            const duration = typeof p.duration_ms === "number" ? p.duration_ms : started === undefined ? NaN : Date.parse(ts) - started;
            if (Number.isFinite(duration) && duration >= 0) durs.set(lastReply.uuid, duration);
            if (outputTokens !== undefined) toks.set(lastReply.uuid, outputTokens);
          }
          break;
        case "turn_aborted":
          busy = false; items.push({ kind: "interrupted" });
          break;
        case "thread_rolled_back": {
          const n = typeof p.num_turns === "number" ? Math.max(0, Math.floor(p.num_turns)) : 0;
          if (n) {
            const at = Math.max(0, turns.length - n);
            items.splice(turns[at] ?? 0); turns.splice(at);
            seen.clear(); tools.clear(); lastReply = undefined;
          }
          busy = false;
          break;
        }
      }
      continue;
    }
    if (r.type !== "response_item") continue;
    const id = text(p.id) || `codex-${index}`;
    if (p.type === "message") {
      const body = contentText(p.content);
      if (p.role === "assistant" && body && !seen.has(`assistant:${id}`)) {
        seen.add(`assistant:${id}`);
        lastReply = { kind: "bubble", role: "assistant", text: body, ts, uuid: id };
        items.push(lastReply);
      } else if (p.role === "user" && !hasUsers && body
        && !/^\s*(?:<environment_context>|<permissions instructions>|# AGENTS\.md instructions|<turn_aborted>|<INSTRUCTIONS>)/.test(body)) {
        pushUser(body, ts, id, images(p.content));
      }
    } else if (p.type === "reasoning") {
      // 암호화된 추론 대신 CLI가 저장한 공개 요약만 그린다.
      const summary = contentText(p.summary);
      if (summary) items.push({ kind: "thinking", text: summary });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const call = text(p.call_id);
      if (!call || tools.has(call)) continue;
      let input = p.arguments ?? p.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* 패치 같은 평문 도구 입력을 보존한다. */ } }
      const toolUse = { id: call, name: text(p.name), input };
      const pair: ToolPair = { toolUse, toolResult: null, toolUseResult: null };
      tools.set(call, pair);
      items.push({ kind: "tool", toolUse, pair });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const pair = tools.get(text(p.call_id));
      if (pair) pair.toolResult = { content: p.output, is_error: p.is_error === true };
    }
  }
  return { items, durs, toks, busy };
}
