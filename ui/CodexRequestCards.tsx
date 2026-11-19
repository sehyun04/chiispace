import { useState } from "react";
import { approvalOptions, questionAnswer, type CodexStream, type Data, type Request } from "./codex-stream";

export function CodexRequestCards({ state, disabled, answer }: {
  state: CodexStream; disabled: boolean; answer: (p: Request, result?: Data, error?: string) => void;
}) {
  return state.prompts.map(p => {
    const child = state.agents.find(a => a.thread === p.params.threadId);
    const item = child ? (child.step?.id === p.params.itemId ? child.step : undefined)
      : state.entries.find(i => i.id === p.params.itemId && i._turn === p.params.turnId);
    return <RequestCard key={p.id} prompt={p} item={item} agent={child?.label} disabled={disabled}
      answer={(result, error) => answer(p, result, error)} />;
  });
}

function RequestCard({ prompt: p, item, agent, disabled, answer }: { prompt: Request; item?: Data; agent?: string; disabled: boolean; answer: (result?: Data, error?: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (p.method === "item/tool/requestUserInput") {
    const qs: Data[] = p.params.questions ?? [];
    return <div className="ask choose" role="group" aria-label="Codex의 질문">
      {agent && <div className="ask-chip">{agent}</div>}
      {qs.map(q => <div className="ask-q" key={q.id}>
        <span className="ask-chip">{q.header}</span><div className="ask-title">{q.question}</div>
        <div className="ask-opts">{(q.options ?? []).map((o: Data) => <button disabled={disabled} key={o.label} aria-pressed={answers[q.id] === o.label} className={answers[q.id] === o.label ? "ask-opt on" : "ask-opt"}
          onClick={() => setAnswers(a => ({ ...a, [q.id]: o.label }))}><span className="ask-opt-label">{o.label}</span><span className="ask-opt-desc">{o.description}</span></button>)}</div>
        <input className="ask-typed" type={q.isSecret ? "password" : "text"} aria-label={q.question} placeholder="직접 쓰기" value={answers[q.id] ?? ""} disabled={disabled}
          onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} />
      </div>)}
      <div className="ask-row"><button className="ask-go" disabled={disabled || !qs.every(q => answers[q.id]?.trim())} onClick={() => answer(questionAnswer(p, answers))}>보내기</button>
        <button className="ask-no" disabled={disabled} onClick={() => answer(questionAnswer(p, {}))}>넘기기</button></div>
    </div>;
  }
  const approved = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(p.method);
  const network = p.params.networkApprovalContext;
  return <div className="ask perm" role="alertdialog" aria-label="Codex 실행 허락">
    {agent && <div className="ask-chip">{agent}</div>}
    <div className="ask-title">{network ? "이 네트워크 연결을 허락할까" : approved ? "이 작업을 허락할까" : "이 요청은 아직 화면에서 처리할 수 없어"}</div>
    <pre className="perm-input">{network ? [network.host, network.protocol].filter(Boolean).join(" · ") : p.params.command ?? p.params.reason ?? p.method}</pre>
    {(network || p.params.command) && p.params.reason && <div className="q">{p.params.reason}</div>}
    {p.params.cwd && <div className="q">폴더: {p.params.cwd}</div>}
    {item?.type === "fileChange" && <pre className="perm-input">{(item.changes ?? []).map((c: Data) => `${c.path}\n${c.diff ?? ""}`).join("\n")}</pre>}
    {p.params.grantRoot && <div className="q">대상: {p.params.grantRoot}</div>}
    {p.params.permissions && <pre className="perm-input">{JSON.stringify(p.params.permissions, null, 2)}</pre>}
    <div className="ask-row">{approved ? approvalOptions(p).map(o => <button key={o.label} className="ask-go" disabled={disabled} onClick={() => answer(o.result)}>{o.label}</button>)
      : <button className="ask-no" disabled={disabled} onClick={() => answer(undefined, "치이스페에서 지원하지 않는 요청")}>요청 거절</button>}</div>
  </div>;
}
