import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatPane, type Transport } from "./Chat";
import { titleFrom } from "./claude-stream";
import { approvalOptions, blockingPrompt, codexItems, initialCodex, questionAnswer, reduceCodex, resumedCodex, type CodexStream, type Data, type Request } from "./codex-stream";
import { missingUnstarted, type StreamChat } from "./stream-session";

type Session = Extract<StreamChat, { agent: "codex" }>;
type Event = { id: string; run: string; message: Data };
export function CodexStreamPane({ id, chat, slug, name, focused, onTitle, onBusy, onChange }: {
  id: string; chat: Session; slug?: string; name?: string; focused: boolean;
  onTitle: (id: string, title: string) => void;
  onBusy: (id: string, busy: boolean) => void;
  onChange: (id: string, patch: Partial<Session>) => void;
}) {
  const [state, setState] = useState<CodexStream>(initialCodex);
  const latest = useRef(state);
  const put = (next: CodexStream) => { latest.current = next; setState(next); };
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const [boot, setBoot] = useState(0);
  const [models, setModels] = useState<Data[]>([]);
  const [settings, setSettings] = useState<Data>({});
  const settingsRef = useRef(settings);
  const configure = (patch: Data) => {
    settingsRef.current = { ...settingsRef.current, ...patch };
    setSettings(settingsRef.current);
    onChange(id, patch);
  };
  const [status, setStatus] = useState(false);
  const [answering, setAnswering] = useState<string | number | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const sending = useRef(false);
  const run = useRef("");
  const titled = useRef(false);
  const modelSelect = useRef<HTMLSelectElement>(null);
  const report = (error: unknown) => setFailure(String(error));
  const request = (method: string, params: Data = {}) => invoke<Data>("codex_stream_request", { id, run: run.current, method, params });
  const applyThread = (result: Data, unstarted: boolean) => {
    put(resumedCodex(result.thread));
    const options = { model: result.model, effort: chat.effort ?? result.reasoningEffort,
      approvalPolicy: chat.approvalPolicy ?? result.approvalPolicy, sandbox: chat.sandbox ?? result.sandbox };
    settingsRef.current = options;
    setSettings(options);
    onChange(id, { session: result.thread.id, cwd: result.cwd, unstarted, ...options });
  };
  useEffect(() => {
    let active = true;
    let token = "";
    let unlisten: (() => void) | undefined;
    setReady(false);
    setFailure("");
    put(initialCodex);
    void (async () => {
      unlisten = await listen<Event>("codex:stream", ({ payload }) => {
        if (!active || payload.id !== id || payload.run !== token) return;
        const m = payload.message;
        if (m.method === "chiispace/exit") { setReady(false); put({ ...latest.current, busy: false, prompts: [] }); report(m.params.error || "Codex 연결이 종료됐다"); return; }
        if (m.method === "thread/name/updated" && m.params.threadId === latest.current.thread && m.params.threadName) onTitle(id, m.params.threadName);
        put(reduceCodex(latest.current, m));
      });
      if (!active) { unlisten(); return; }
      try {
        token = await invoke<string>("codex_stream_start", { id, cwd: chat.cwd });
        if (!active) { await invoke("codex_stream_stop", { id, run: token }); return; }
        run.current = token;
        await request("initialize", { clientInfo: { name: "chiispace", title: "치이스페", version: "0.1.0" }, capabilities: { experimentalApi: true } });
        if (!active) return;
        const options = { ...(chat.cwd ? { cwd: chat.cwd } : {}), ...(chat.model ? { model: chat.model } : {}) };
        let unstarted = !chat.session;
        let result: Data;
        try {
          result = await request(chat.session ? "thread/resume" : "thread/start", { ...options, ...(chat.session ? { threadId: chat.session } : {}) });
        } catch (e) {
          // 첫 전송 직후 앱 저장이 늦어져도 실제 대화를 먼저 찾는다. 미전송·이력 없음이 함께 확인돼야 새로 연다.
          if (!missingUnstarted(chat, e)) throw e;
          result = await request("thread/start", options);
          unstarted = true;
        }
        if (!active) return;
        applyThread(result, unstarted);
        titled.current = !unstarted;
        const choices: Data[] = [];
        let cursor: string | null = null;
        do {
          const page = await request("model/list", { cursor, limit: 100 });
          choices.push(...(page.data ?? [])); cursor = page.nextCursor;
        } while (cursor && active);
        if (!active) return;
        setModels(choices);
        setReady(true);
      } catch (e) { if (active) report(e); }
    })().catch(e => { if (active) report(e); });
    return () => {
      active = false;
      unlisten?.();
      if (token) void invoke("codex_stream_stop", { id, run: token });
      if (run.current === token) run.current = "";
    };
    // 서버가 발급한 대화 ID를 저장해도 현재 프로세스를 다시 띄우지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, boot]);
  useEffect(() => { onBusy(id, state.busy || dispatching); }, [id, state.busy, dispatching, onBusy]);
  useEffect(() => {
    if (ready && focused) (window as unknown as { __chats?: Record<string, HTMLTextAreaElement | null> }).__chats?.[id]?.focus();
  }, [ready, focused, id]);

  const fresh = async () => {
    if (latest.current.busy) throw new Error("진행 중인 답을 먼저 멈춰 줘");
    const result = await request("thread/start", { ...(chat.cwd ? { cwd: chat.cwd } : {}), model: settingsRef.current.model });
    applyThread(result, true); titled.current = false; onTitle(id, "새 대화");
  };
  const transport: Transport = {
    isCommand: text => text.startsWith("/"),
    send: async (text) => {
      if (!ready || sending.current) throw new Error("Codex 연결을 기다려 줘");
      sending.current = true; setDispatching(true); setFailure("");
      try {
        const [command, ...args] = text.split(/\s+/);
        if (command === "/model") { modelSelect.current?.focus(); return; }
        if (command === "/status" || command === "/permissions") { setStatus(true); return; }
        if (command === "/new" || command === "/clear") { await fresh(); return; }
        if (command === "/compact") { await request("thread/compact/start", { threadId: latest.current.thread }); return; }
        if (command === "/rename") {
          if (!args.length) throw new Error("/rename 뒤에 대화 이름을 적어 줘");
          await request("thread/name/set", { threadId: latest.current.thread, name: args.join(" ") });
          onTitle(id, args.join(" ")); return;
        }
        if (command.startsWith("/")) throw new Error("이 명령은 지원하지 않아. 모델·권한·상태는 입력바 위에서 고를 수 있어.");
        const current = latest.current;
        if (current.prompts.some(blockingPrompt)) throw new Error("기다리는 질문에 먼저 답해 줘");
        // 응답을 받기 전에 앱이 닫혀도 이미 보낸 대화를 빈 칸으로 바꿔 버리지 않는다.
        onChange(id, { unstarted: false });
        const input = [{ type: "text", text, text_elements: [] }];
        const result = current.busy && current.turn
          ? await request("turn/steer", { threadId: current.thread, expectedTurnId: current.turn, input })
          : await request("turn/start", { threadId: current.thread, input, model: settingsRef.current.model,
            effort: settingsRef.current.effort, approvalPolicy: settingsRef.current.approvalPolicy, sandboxPolicy: settingsRef.current.sandbox });
        if (result.turn && !latest.current.turn) put(reduceCodex(latest.current, { method: "turn/started", params: { threadId: current.thread, turn: result.turn } }));
        if (!titled.current) {
          const title = titleFrom(text);
          if (title) { titled.current = true; onTitle(id, title); await request("thread/name/set", { threadId: current.thread, name: title }).catch(report); }
        }
      } catch (e) { report(e); throw e; }
      finally { sending.current = false; setDispatching(false); }
    },
    interrupt: () => {
      const current = latest.current;
      if (current.turn) void request("turn/interrupt", { threadId: current.thread, turnId: current.turn }).catch(report);
    },
  };
  const answer = async (prompt: Request, result?: Data, error?: string) => {
    setAnswering(prompt.id); setFailure("");
    try {
      await invoke("codex_stream_answer", { id, run: run.current, requestId: prompt.id, result, error });
      put({ ...latest.current, prompts: latest.current.prompts.filter(p => p.id !== prompt.id) });
    } catch (e) { report(e); }
    finally { setAnswering(null); }
  };
  const selected = models.find(m => m.model === settings.model || m.id === settings.model);
  const disabled = !ready || state.busy || dispatching;
  const rendered = codexItems(state.entries);
  const toolbar = <>
    <div className="stream-bar">
      <label><span>모델</span><select ref={modelSelect} aria-label="Codex 모델" disabled={disabled || !models.length} value={settings.model ?? ""}
        onChange={e => { const m = models.find(m => m.model === e.target.value); configure({ model: e.target.value, effort: m?.defaultReasoningEffort }); }}>
        {!selected && <option value={settings.model ?? ""}>{settings.model ?? "기본"}</option>}
        {models.map(m => <option key={m.id} value={m.model}>{m.displayName ?? m.model}</option>)}
      </select></label>
      {!!selected?.supportedReasoningEfforts?.length && <label><span>추론</span><select aria-label="Codex 추론" disabled={disabled} value={settings.effort ?? selected.defaultReasoningEffort}
        onChange={e => configure({ effort: e.target.value })}>{selected.supportedReasoningEfforts.map((e: Data) => <option key={e.reasoningEffort} value={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select></label>}
      <label><span>승인</span><select aria-label="Codex 승인" disabled={disabled} value={typeof settings.approvalPolicy === "string" ? settings.approvalPolicy : "custom"} onChange={e => configure({ approvalPolicy: e.target.value })}>
        {typeof settings.approvalPolicy !== "string" && <option value="custom">기존 설정</option>}
        <option value="untrusted">신뢰한 명령만 자동</option><option value="on-request">요청 시 묻기</option><option value="on-failure">실패 시 묻기</option><option value="never">승인 요청 안 함</option>
      </select></label>
      <button type="button" aria-expanded={status} onClick={() => setStatus(v => !v)}>상태</button>
      <button type="button" disabled={disabled} onClick={() => { void transport.send("/new").catch(() => {}); }}>새 대화</button>
    </div>
    {status && <div className="note codex-status" role="status">
      <div>모델: {settings.model ?? "연결 중"} · 추론: {settings.effort ?? "기본"}</div>
      <div>샌드박스: {settings.sandbox?.type ?? "기존 설정"} · 승인: {typeof settings.approvalPolicy === "string" ? settings.approvalPolicy : "기존 설정"}</div>
      <div>폴더: {chat.cwd} · 사용 토큰: {state.tokens ?? "집계 전"}</div>
      <div>대화: {state.thread || "연결 중"}</div>
    </div>}
  </>;
  return <>
    <div className="pane-body stream-body" />
    <ChatPane agent="codex" root={chat.cwd} id={state.thread} paneId={id} slug={slug} name={name}
      live={ready && !dispatching} working={state.busy || dispatching} waiting={state.prompts.some(blockingPrompt)}
      fresh={!state.entries.length} transport={transport} content={rendered} toolbar={toolbar}
      extra={<>
        {state.prompts.map(p => <RequestCard key={p.id} prompt={p} item={state.entries.find(i => i.id === p.params.itemId && i._turn === p.params.turnId)} disabled={answering === p.id} answer={(result, error) => void answer(p, result, error)} />)}
        {(failure || state.error) && <div className="note bad" role="alert">{failure || state.error}</div>}
        {!ready && failure && <button className="ask-go" onClick={async () => {
          const token = run.current;
          try {
            if (token) await invoke("codex_stream_stop", { id, run: token });
            setBoot(n => n + 1);
          } catch (e) { report(e); }
        }}>다시 연결</button>}
      </>} />
  </>;
}

function RequestCard({ prompt: p, item, disabled, answer }: { prompt: Request; item?: Data; disabled: boolean; answer: (result?: Data, error?: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (p.method === "item/tool/requestUserInput") {
    const qs: Data[] = p.params.questions ?? [];
    return <div className="ask choose" role="group" aria-label="Codex의 질문">
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
  return <div className="ask perm" role="alertdialog" aria-label="Codex 실행 허락">
    <div className="ask-title">{approved ? "이 작업을 허락할까" : "이 요청은 아직 화면에서 처리할 수 없어"}</div>
    <pre className="perm-input">{p.params.command ?? p.params.reason ?? p.method}</pre>
    {p.params.command && p.params.reason && <div className="q">{p.params.reason}</div>}
    {p.params.cwd && <div className="q">폴더: {p.params.cwd}</div>}
    {item?.type === "fileChange" && <pre className="perm-input">{(item.changes ?? []).map((c: Data) => `${c.path}\n${c.diff ?? ""}`).join("\n")}</pre>}
    {p.params.grantRoot && <div className="q">대상: {p.params.grantRoot}</div>}
    {p.params.permissions && <pre className="perm-input">{JSON.stringify(p.params.permissions, null, 2)}</pre>}
    <div className="ask-row">{approved ? approvalOptions(p).map(o => <button key={o.label} className="ask-go" disabled={disabled} onClick={() => answer(o.result)}>{o.label}</button>)
      : <button className="ask-no" disabled={disabled} onClick={() => answer(undefined, "치이스페에서 지원하지 않는 요청")}>요청 거절</button>}</div>
  </div>;
}
