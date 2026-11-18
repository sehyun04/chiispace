import type { Item } from "./transcript";
import { codexUserImages } from "./codex-images.ts";

// 버전마다 확장되는 프로토콜은 경계에서 확인하고, 알 수 없는 항목은 원문을 버리지 않는다.
export type Data = Record<string, any>;
export type Request = { id: string | number; method: string; params: Data & { threadId: string } };
export type CodexAgent = { thread: string; label: string; task?: string; status: string; turn: string | null; settled: string[]; step?: Data; live?: boolean };
export type CodexStream = {
  thread: string;
  turn: string | null;
  busy: boolean;
  entries: Data[];
  prompts: Request[];
  settled: string[];
  agents: CodexAgent[];
  error?: string;
  tokens?: number;
  warnings?: string[];
};
export const initialCodex: CodexStream = { thread: "", turn: null, busy: false, entries: [], prompts: [], settled: [], agents: [] };
export function resumedCodex(thread: Data): CodexStream {
  const turns: Data[] = Array.isArray(thread.turns) ? thread.turns : [];
  const active = [...turns].reverse().find(t => t.status === "inProgress");
  let state: CodexStream = { ...initialCodex, thread: thread.id, turn: active?.id ?? null, busy: !!active,
    settled: turns.filter(t => t.status !== "inProgress").map(t => t.id),
    entries: turns.flatMap(t => (t.items ?? []).map((i: Data) => ({ ...i, _turn: t.id }))) };
  for (const item of state.entries) state = linkAgents(state, item, true);
  return state;
}
export const agentActive = (a: CodexAgent) => a.status === "pendingInit" || a.status === "running";
function linkAgents(s: CodexStream, item: Data, replay = false): CodexStream {
  if (item?.type !== "collabAgentToolCall" && item?.type !== "subAgentActivity") return s;
  let agents = s.agents;
  const ids: string[] = item.type === "subAgentActivity" ? [item.agentThreadId] : item.receiverThreadIds ?? [];
  for (const thread of ids.filter(id => typeof id === "string" && id && id !== s.thread)) {
    const old = agents.find(a => a.thread === thread);
    const status = item.agentsStates?.[thread]?.status ?? (item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "interrupted" : "running");
    const a: CodexAgent = { thread, label: old?.label ?? (item.agentPath || `서브에이전트 ${agents.length + 1}`),
      task: item.prompt ?? old?.task, turn: old?.turn ?? null, settled: old?.settled ?? [], step: old?.step,
      live: old?.live || !replay,
      status: replay ? old?.status ?? "unknown"
        : old && old.settled.length && !old.turn && ["running", "pendingInit"].includes(status)
          && !["sendInput", "resumeAgent", "followupTask"].includes(item.tool) ? old.status : status };
    agents = old ? agents.map(o => o.thread === thread ? a : o) : [...agents, a];
  }
  return agents === s.agents ? s : { ...s, agents };
}
export function hydrateCodexAgent(s: CodexStream, thread: Data): CodexStream {
  const old = s.agents.find(a => a.thread === thread.id);
  if (!old) return s;
  const child = resumedCodex(thread);
  const step = [...child.entries].reverse().find(i => i.type !== "userMessage");
  const agent = { ...old, label: thread.agentNickname || thread.agentRole || old.label,
    ...(old.status === "unknown" ? { status: child.busy ? "running" : "completed", turn: child.turn, settled: child.settled, step: step ?? old.step } : {}) };
  return { ...s, agents: s.agents.map(a => a === old ? agent : a) };
}
function childEvent(s: CodexStream, agent: CodexAgent, message: Data): CodexStream {
  const p = message.params ?? {}, method = message.method;
  const turn = p.turnId ?? p.turn?.id;
  if (turn && agent.settled.includes(turn)) return s;
  let next = agent;
  if (method === "turn/started") next = { ...agent, status: "running", turn, step: undefined };
  else if (method === "turn/completed") {
    next = agent.turn && agent.turn !== turn ? { ...agent, settled: [...agent.settled, turn] }
      : { ...agent, status: p.turn.status, turn: null, settled: [...agent.settled, turn] };
  } else if (method === "thread/closed") {
    if (agentActive(agent)) next = { ...agent, status: "completed", turn: null };
  } else if (p.turnId && agent.turn && p.turnId !== agent.turn) return s;
  else if (method === "item/started" || method === "item/completed") {
    if (p.item.type !== "userMessage") next = { ...agent, step: p.item };
  } else if (method === "item/agentMessage/delta") {
    const text = agent.step?.id === p.itemId ? agent.step?.text ?? "" : "";
    next = { ...agent, step: { type: "agentMessage", id: p.itemId, text: text + p.delta } };
  }
  const prompts = updatePrompts(s.prompts, message);
  if (prompts.length > s.prompts.length && !agentActive(next)) next = { ...next, status: "running", turn: turn ?? null };
  if (next === agent && prompts === s.prompts) return s;
  const live = !!agent.live || next !== agent || message.id !== undefined;
  return { ...s, prompts, agents: s.agents.map(a => a.thread === agent.thread ? { ...next, live } : a) };
}

function updatePrompts(prompts: Request[], message: Data): Request[] {
  const p = message.params ?? {}, method = message.method;
  if (typeof p.threadId !== "string") return prompts;
  if (typeof method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
    if (prompts.some(q => q.id === message.id)) return prompts;
    return [...prompts, { id: message.id, method, params: { ...p, threadId: p.threadId } }];
  }
  if (method === "serverRequest/resolved") return prompts.filter(q => q.params.threadId !== p.threadId || q.id !== p.requestId);
  if (method === "turn/completed") return prompts.filter(q => q.params.threadId !== p.threadId || q.params.turnId !== p.turn?.id);
  if (method === "thread/closed") return prompts.filter(q => q.params.threadId !== p.threadId);
  return prompts;
}
function upsert(entries: Data[], item: Data, turn: string): Data[] {
  const index = entries.findIndex(i => i.id === item.id && i._turn === turn);
  const next = { ...(index >= 0 ? entries[index] : {}), ...item, _turn: turn };
  return index < 0 ? [...entries, next] : entries.map((i, n) => n === index ? next : i);
}
export function reduceCodex(s: CodexStream, message: Data): CodexStream {
  const p = message.params ?? {};
  if (p.threadId && p.threadId !== s.thread) {
    const agent = s.agents.find(a => a.thread === p.threadId);
    if (!agent) return s;
    const next = linkAgents(s, p.item);
    return childEvent(next, next.agents.find(a => a.thread === agent.thread) ?? agent, message);
  }
  const parent = p.thread?.parentThreadId ?? p.thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
  if (message.method === "thread/started" && parent && (parent === s.thread || s.agents.some(a => a.thread === parent))) {
    return linkAgents(s, { type: "subAgentActivity", agentThreadId: p.thread.id, agentPath: p.thread.agentNickname, kind: "started" });
  }
  const method = message.method;
  const turn = p.turnId ?? p.turn?.id;
  // 빠른 완료 알림이 turn/start의 응답보다 먼저 도착해도 끝난 답을 다시 작업 중으로 만들지 않는다.
  if (turn && s.settled.includes(turn)) return linkAgents(s, p.item);
  if (message.id !== undefined && typeof method === "string") {
    if (p.turnId && s.turn && p.turnId !== s.turn) return s;
    const prompts = s.thread && p.threadId === s.thread ? updatePrompts(s.prompts, message) : s.prompts;
    return prompts === s.prompts ? s : { ...s, prompts };
  }
  if (method === "serverRequest/resolved" || method === "thread/closed") return { ...s, prompts: updatePrompts(s.prompts, message) };
  if (method === "turn/started") return { ...s, turn: p.turn.id, busy: true, error: undefined };
  if (method === "turn/completed") {
    const prompts = updatePrompts(s.prompts, message);
    if (s.turn && s.turn !== p.turn.id) return prompts === s.prompts ? s : { ...s, prompts };
    let entries = s.entries;
    for (const item of p.turn.items ?? []) entries = upsert(entries, item, p.turn.id);
    if (p.turn.status === "interrupted") entries = upsert(entries, { id: `interrupted-${p.turn.id}`, type: "interrupted" }, p.turn.id);
    return { ...s, entries, busy: false, turn: null, settled: [...s.settled, p.turn.id], prompts, error: p.turn.error?.message };
  }
  if (p.turnId && s.turn && p.turnId !== s.turn) return s;
  if (method === "item/started" || method === "item/completed") return { ...linkAgents(s, p.item), entries: upsert(s.entries, p.item, p.turnId) };
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
  if (method === "warning" && typeof p.message === "string") return { ...s, warnings: [...new Set([...(s.warnings ?? []), p.message])].slice(-50) };
  return s;
}
export function codexItems(entries: Data[]): Item[] {
  return entries.flatMap((i): Item[] => {
    const uuid = `${i._turn}:${i.id}`;
    if (i.type === "userMessage") return [{ kind: "bubble", role: "user", uuid,
      text: (i.content ?? []).filter((c: Data) => c.type === "text").map((c: Data) => c.text).join("\n"), images: codexUserImages(i.content) }];
    if (i.type === "agentMessage") return i.text ? [{ kind: "bubble", role: "assistant", uuid, text: i.text }] : [];
    if (i.type === "reasoning") return i.summary?.length ? [{ kind: "thinking", text: i.summary.join("\n") }] : [];
    if (i.type === "hookPrompt") return [];
    if (i.type === "subAgentActivity") return [];
    if (i.type === "collabAgentToolCall") return i.tool === "spawnAgent"
      ? [{ kind: "launch", description: i.prompt?.split(/\r?\n/)[0].slice(0, 90), id: i.id }] : [];
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
