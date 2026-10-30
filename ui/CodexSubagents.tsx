import { useContext, useEffect, useRef, useState } from "react";
import { agentActive, codexItems, resumedCodex, type CodexAgent, type Data } from "./codex-stream";
import { SubAgentRow } from "./SubAgents";
import { OpenSubContext, SubagentPanel, type SubTarget } from "./SubagentView";
import { Row } from "./ChatRows";

export function CodexSubagents({ agents }: { agents: CodexAgent[] }) {
  const open = useContext(OpenSubContext);
  const active = agents.filter(agentActive);
  if (!active.length) return null;
  return <div className="subs">{active.map(a => {
    const step = a.step;
    const tool = step?.type === "commandExecution" ? "명령" : step?.type === "fileChange" ? "파일" : undefined;
    const what = step?.text || step?.command || (step?.type === "reasoning" ? "생각하는 중" : a.task) || "시작하는 중";
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
  const known = agents.some(a => a.thread === threadId);
  const [thread, setThread] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const read = useRef(request);
  read.current = request;
  useEffect(() => {
    setThread(null); setError("");
    if (!threadId || !known) return;
    let active = true, pending = false;
    const tick = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await read.current("thread/read", { threadId, includeTurns: true });
        if (active && result.thread?.id === threadId) { setThread(result.thread); setError(""); }
      } catch (e) { if (active) setError(String(e)); }
      finally { pending = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [threadId, known]);
  const items = thread ? codexItems(resumedCodex(thread).entries) : [];
  const name = thread?.agentNickname || thread?.agentRole || target.label;
  return <SubagentPanel title={target.label} name={name} items={items} loading={!thread && !error} error={error}
    onClose={onClose} taskLabel="Codex가 맡긴 일"
    renderRow={(item, o) => <Row key={o.key} item={item} slug={slug} name={o.name} showFace={o.showFace} grouped={o.grouped} />} />;
}
