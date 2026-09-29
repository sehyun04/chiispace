import type { Item } from "./transcript";

// 버전마다 확장되는 프로토콜은 경계에서 확인하고, 알 수 없는 항목은 원문을 버리지 않는다.
export type Data = Record<string, any>;
export type Request = { id: string | number; method: string; params: Data };
export type CodexStream = {
  thread: string;
  turn: string | null;
  busy: boolean;
  entries: Data[];
  prompts: Request[];
  settled: string[];
  error?: string;
  tokens?: number;
};
export const initialCodex: CodexStream = { thread: "", turn: null, busy: false, entries: [], prompts: [], settled: [] };
export function resumedCodex(thread: Data): CodexStream {
  const turns: Data[] = Array.isArray(thread.turns) ? thread.turns : [];
  const active = [...turns].reverse().find(t => t.status === "inProgress");
  return { ...initialCodex, thread: thread.id, turn: active?.id ?? null, busy: !!active,
    settled: turns.filter(t => t.status !== "inProgress").map(t => t.id),
    entries: turns.flatMap(t => (t.items ?? []).map((i: Data) => ({ ...i, _turn: t.id }))) };
}
function upsert(entries: Data[], item: Data, turn: string): Data[] {
  const index = entries.findIndex(i => i.id === item.id && i._turn === turn);
  const next = { ...(index >= 0 ? entries[index] : {}), ...item, _turn: turn };
  return index < 0 ? [...entries, next] : entries.map((i, n) => n === index ? next : i);
}
export function reduceCodex(s: CodexStream, message: Data): CodexStream {
  const p = message.params ?? {};
  if (p.threadId && p.threadId !== s.thread) return s;
  const method = message.method;
  const turn = p.turnId ?? p.turn?.id;
  // 빠른 완료 알림이 turn/start의 응답보다 먼저 도착해도 끝난 답을 다시 작업 중으로 만들지 않는다.
  if (turn && s.settled.includes(turn)) return s;
  if (message.id !== undefined && typeof method === "string") {
    if (p.turnId && s.turn && p.turnId !== s.turn) return s;
    const r: Request = { id: message.id, method, params: p };
    return { ...s, prompts: [...s.prompts.filter(q => q.id !== r.id), r] };
  }
  if (method === "serverRequest/resolved") return { ...s, prompts: s.prompts.filter(q => q.id !== p.requestId) };
  if (method === "turn/started") return { ...s, turn: p.turn.id, busy: true, error: undefined };
  if (method === "turn/completed") {
    if (s.turn && s.turn !== p.turn.id) return s;
    let entries = s.entries;
    for (const item of p.turn.items ?? []) entries = upsert(entries, item, p.turn.id);
    if (p.turn.status === "interrupted") entries = upsert(entries, { id: `interrupted-${p.turn.id}`, type: "interrupted" }, p.turn.id);
    return { ...s, entries, busy: false, turn: null, settled: [...s.settled, p.turn.id], prompts: s.prompts.filter(q => q.params.turnId !== p.turn.id), error: p.turn.error?.message };
  }
  if (p.turnId && s.turn && p.turnId !== s.turn) return s;
  if (method === "item/started" || method === "item/completed") return { ...s, entries: upsert(s.entries, p.item, p.turnId) };
  if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/commandExecution/outputDelta") {
    const old = s.entries.find(i => i.id === p.itemId && i._turn === p.turnId);
    const type = method.includes("agentMessage") ? "agentMessage" : method.includes("reasoning") ? "reasoning" : "commandExecution";
    let item: Data = { ...old, id: p.itemId, type };
    if (type === "reasoning") {
      const summary = [...(old?.summary ?? [])];
      summary[p.summaryIndex ?? 0] = (summary[p.summaryIndex ?? 0] ?? "") + p.delta;
      item = { ...item, summary };
    } else {
      const field = type === "agentMessage" ? "text" : "aggregatedOutput";
      item[field] = (old?.[field] ?? "") + p.delta;
    }
    return { ...s, entries: upsert(s.entries, item, p.turnId) };
  }
  if (method === "thread/tokenUsage/updated") return { ...s, tokens: p.tokenUsage?.total?.totalTokens };
  if (method === "error") return { ...s, error: p.error?.message ?? "Codex 요청이 실패했다" };
  return s;
}
export function codexItems(entries: Data[]): Item[] {
  return entries.flatMap((i): Item[] => {
    const uuid = `${i._turn}:${i.id}`;
    if (i.type === "userMessage") return [{ kind: "bubble", role: "user", uuid,
      text: (i.content ?? []).filter((c: Data) => c.type === "text").map((c: Data) => c.text).join("\n") }];
    if (i.type === "agentMessage") return i.text ? [{ kind: "bubble", role: "assistant", uuid, text: i.text }] : [];
    if (i.type === "reasoning") return i.summary?.length ? [{ kind: "thinking", text: i.summary.join("\n") }] : [];
    if (i.type === "hookPrompt") return [];
    if (i.type === "interrupted") return [{ kind: "interrupted" }];
    if (i.type === "contextCompaction") return [{ kind: "system", text: "대화 내용을 정리했다" }];
    if (i.type === "plan") return [{ kind: "bubble", role: "assistant", uuid, text: i.text ?? "" }];
    const tool = i.type === "commandExecution" ? { name: "Bash", input: { command: i.command } }
      : i.type === "fileChange" ? { name: "apply_patch", input: { patch: (i.changes ?? []).map((c: Data) => `${c.path}\n${c.diff ?? ""}`).join("\n") } }
      : i.type === "mcpToolCall" ? { name: `mcp__${i.server}__${i.tool}`, input: i.arguments }
      : i.type === "webSearch" ? { name: "WebSearch", input: { query: i.query } }
      : { name: i.type ?? "도구", input: i.input ?? i.arguments ?? {} };
    const content = i.aggregatedOutput ?? i.result ?? i.error ?? i.status ?? "";
    const toolUse = { id: i.id, ...tool };
    return [{ kind: "tool", toolUse, pair: { toolUse, toolResult: i.status && i.status !== "inProgress" ? { content, is_error: i.status === "failed" || i.status === "declined" } : null, toolUseResult: null } }];
  });
}
export const blockingPrompt = (p: Request) => p.method !== "item/tool/requestUserInput" || p.params.isBlocking !== false;
export function approvalOptions(p: Request): { label: string; result: Data }[] {
  if (p.method === "item/permissions/requestApproval") return [
    { label: "이번 턴 허락", result: { permissions: p.params.permissions, scope: "turn" } },
    { label: "거절", result: { permissions: {}, scope: "turn" } },
  ];
  const labels: Record<string, string> = { accept: "허락", acceptForSession: "이 대화 동안 허락", decline: "거절", cancel: "취소" };
  const available = p.params.availableDecisions ?? ["accept", "decline", "cancel"];
  return available.flatMap((decision: unknown) => typeof decision === "string" && labels[decision] ? [{ label: labels[decision], result: { decision } }] : []);
}
export function questionAnswer(p: Request, answers: Record<string, string>): Data {
  return { answers: Object.fromEntries((p.params.questions ?? []).map((q: Data) => [q.id, { answers: answers[q.id]?.trim() ? [answers[q.id].trim()] : [] }])) };
}
