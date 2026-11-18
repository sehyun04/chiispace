import { useContext, useEffect, useRef, useState } from "react";
import { agentActive, codexItems, resumedCodex, type CodexAgent, type Data, type Request } from "./codex-stream";
import { SubAgentRow } from "./SubAgents";
import { OpenSubContext, SubagentPanel, type SubTarget } from "./SubagentView";
import { Row } from "./ChatRows";

export function CodexSubagents({ agents, prompts }: { agents: CodexAgent[]; prompts: Request[] }) {
  const open = useContext(OpenSubContext);
  const active = agents.filter(agentActive);
  if (!active.length) return null;
  return <div className="subs">{active.map(a => {
    const step = a.step;
    const tool = step?.type === "commandExecution" ? "명령" : step?.type === "fileChange" ? "파일" : undefined;
    const what = prompts.some(p => p.params.threadId === a.thread) ? "질문이나 승인을 기다리는 중"
      : step?.text || step?.command || (step?.type === "reasoning" ? "생각하는 중" : a.task) || "시작하는 중";
    return <SubAgentRow key={a.thread} label={a.label} tool={tool} what={String(what).replace(/\s+/g, " ").slice(-90)}
      state={a.status === "pendingInit" ? "시작하는 중" : "진행 중"}
      onOpen={open ? () => open({ agent: a.thread, label: a.label }) : undefined} />;
  })}</div>;
}

export function CodexSubagentView({ target, entries, agents, request, onClose, slug }: {
  target: SubTarget; entries: Data[]; agents: CodexAgent[];
  request: (method: string, params: Data) => Promise<Data>; onClose: () => void; slug?: string;
}) {
  const threadId = target.agent ?? entries.find(i => i.id === target.toolUseId && i.type === "collabAgentToolCall")?.receiverThreadIds?.[0];
  const agent = agents.find(a => a.thread === threadId);
  const { name, items, loading, error } = useCodexChild(agent?.thread, agent ? request : undefined, !!agent && (agentActive(agent) || agent.status === "unknown"));
  return <SubagentPanel title={target.label} name={name || target.label} items={items} loading={loading} error={error}
    onClose={onClose} taskLabel="Codex가 맡긴 일"
    renderRow={(item, o) => <Row key={o.key} item={item} slug={slug} name={o.name} showFace={o.showFace} grouped={o.grouped} />} />;
}

export function useCodexChild(
  threadId: string | undefined,
  request: ((method: string, params: Data) => Promise<Data>) | undefined,
  watch: boolean,
  run?: string,
) {
  const [snapshot, setSnapshot] = useState<{ id: string; thread?: Data; error?: string }>();
  const read = useRef(request);
  read.current = request;
  const connected = !!request;
  useEffect(() => {
    if (!threadId || !connected) return;
    let active = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const result = await read.current?.("thread/read", { threadId, includeTurns: true });
        if (active && result?.thread?.id === threadId) setSnapshot({ id: threadId, thread: result.thread });
      } catch (e) {
        if (active) setSnapshot((s) => ({ id: threadId, thread: s?.id === threadId ? s.thread : undefined, error: String(e) }));
      }
      if (active && watch) timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => { active = false; window.clearTimeout(timer); };
  }, [threadId, connected, watch, run]);
  const current = snapshot?.id === threadId ? snapshot : undefined;
  const thread = current?.thread;
  return {
    items: thread ? codexItems(resumedCodex(thread).entries) : [],
    name: thread?.agentNickname || thread?.agentRole,
    loading: !!threadId && connected && !thread && !current?.error,
    error: connected ? current?.error : undefined,
    hasTranscript: !!thread,
  };
}
