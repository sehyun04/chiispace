import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatPane, type Transport } from "./Chat";
import { StreamBar, effortLabel, folderLabel, modelLabel } from "./StreamBar";
import { titleFrom } from "./claude-stream";
import { agentActive, approvalOptions, blockingPrompt, codexItems, hydrateCodexAgent, initialCodex, questionAnswer, reduceCodex, resumedCodex, type CodexStream, type Data, type Request } from "./codex-stream";
import { CodexSubagents, CodexSubagentView } from "./CodexSubagents";
import { missingUnstarted, type StreamChat } from "./stream-session";
import { ago, barCommands, mergeCommands, type PaletteCommand } from "./palette";

type Session = Extract<StreamChat, { agent: "codex" }>;
type Event = { id: string; run: string; message: Data };
export function CodexStreamPane({ id, chat, slug, name, focused, onTitle, onBusy, onChange, onFolder, onResume, onTerminal }: {
  id: string; chat: Session; slug?: string; name?: string; focused: boolean;
  onTitle: (id: string, title: string) => void;
  onBusy: (id: string, busy: boolean) => void;
  onChange: (id: string, patch: Partial<Session>) => void;
  /** 폴더 칩에서 다른 폴더를 골랐다. 부른 쪽이 그 폴더의 새 대화로 칸을 다시 연다. */
  onFolder: (id: string, agent: "codex", cwd: string) => void;
  /** `/resume` 에서 사용자가 고른 지난 대화로 이 칸을 다시 연다. */
  onResume: (id: string, session: string) => void;
  /** 로그인처럼 터미널이 꼭 필요한 일을 새 탭의 터미널에서 돌린다. */
  onTerminal: (cmd: string, title: string) => void;
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
  const agentsBusy = state.agents.some(agentActive);
  useEffect(() => { onBusy(id, state.busy || dispatching || agentsBusy); }, [id, state.busy, dispatching, agentsBusy, onBusy]);
  const unknownAgents = state.agents.filter(a => a.status === "unknown").map(a => a.thread).join(",");
  useEffect(() => {
    let active = true;
    for (const threadId of unknownAgents.split(",").filter(Boolean)) {
      void request("thread/read", { threadId, includeTurns: true }).then(r => {
        if (active && r.thread) put(hydrateCodexAgent(latest.current, r.thread));
      }).catch(() => {});
    }
    return () => { active = false; };
    // 목록이 같으면 다시 읽지 않는다. 폴링이나 답 조각마다 이력을 다시 읽으면 요청이 계속 취소된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownAgents]);
  useEffect(() => {
    if (ready && focused) (window as unknown as { __chats?: Record<string, HTMLTextAreaElement | null> }).__chats?.[id]?.focus();
  }, [ready, focused, id]);

  const fresh = async () => {
    if (latest.current.busy || latest.current.agents.some(agentActive)) throw new Error("진행 중인 답과 서브에이전트가 끝난 뒤 새 대화를 열어 줘");
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
          // 첫 턴 전에는 Codex의 rollout이 비어 있어 서버 메타데이터 갱신이 실패할 수 있다.
          titled.current = true;
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
          if (title) { titled.current = true; onTitle(id, title); }
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
  const disabled = !ready || state.busy || dispatching || agentsBusy;
  const rendered = codexItems(state.entries);
  // 입력바 위 줄은 Claude 칸과 같은 부품(StreamBar)이다. 항목·순서·상태 표가 두 칸에서 같아야 한다.
  const policy = typeof settings.approvalPolicy === "string" ? settings.approvalPolicy : "custom";
  const policyName = APPROVALS.find(([v]) => v === policy)?.[1] ?? "기존 설정";
  const efforts: string[] = (selected?.supportedReasoningEfforts ?? []).map((e: Data) => e.reasoningEffort);
  const effort = settings.effort ?? selected?.defaultReasoningEffort;
  // 줄과 `/` 명령이 같은 항목에서 나온다(Claude 칸과 같다).
  const bar: Parameters<typeof StreamBar>[0] = {
    model: {
      label: "모델", aria: "Codex 모델", selectRef: modelSelect, value: settings.model ?? "", disabled,
      choices: [...(selected ? [] : [{ value: settings.model ?? "", label: settings.model ?? "기본" }]), ...models.map(m => ({ value: m.model, label: m.displayName ?? m.model }))],
      onChange: v => { const m = models.find(m => m.model === v); configure({ model: v, effort: m?.defaultReasoningEffort }); },
    },
    effort: efforts.length ? {
      label: "추론", aria: "Codex 추론", value: effort ?? "", disabled,
      choices: efforts.map(v => ({ value: v, label: effortLabel(v) })),
      onChange: v => configure({ effort: v }),
    } : undefined,
    permission: {
      label: "권한", aria: "Codex 승인", value: policy, disabled,
      choices: [...(policy === "custom" ? [{ value: "custom", label: "기존 설정" }] : []), ...APPROVALS.map(([value, label]) => ({ value, label }))],
      onChange: v => configure({ approvalPolicy: v }),
    },
    statusOpen: status,
    onStatus: () => setStatus(v => !v),
    folder: { path: chat.cwd, fresh: !state.entries.length, disabled, onPick: to => onFolder(id, "codex", to) },
    statusClass: "codex-status",
    status: [
      ["모델", modelLabel(selected?.displayName, settings.model)],
      ["추론", effort ? effortLabel(effort) : "기본"],
      ["권한", `${policyName} · 샌드박스 ${settings.sandbox?.type ?? "기존 설정"}`],
      ["폴더", folderLabel(chat.cwd)],
      ["사용 토큰", state.tokens ?? "집계 전"],
      ["대화", state.thread || "연결 중"],
    ],
  };
  const toolbar = <StreamBar {...bar} />;
  // 지난 대화는 서버가 준 목록에서 사용자가 고른다. 서버가 준 id 라 그대로 thread/resume 한다(CLAUDE.md "새 Codex 칸은 서버가 준 ID만").
  const titles = useRef(new Map<string, string>());
  const folderKey = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const same = (a: string, b: string) => folderKey(a) === folderKey(b);
  const paneCommands: PaletteCommand[] = [
    ...(disabled ? [] : [{
      name: "resume",
      hint: "지난 대화 고르기 — 이 폴더",
      empty: "이 폴더에 지난 대화가 없다",
      // 서버의 폴더 거르기는 경로 표기(빗금 방향)가 같아야 맞으므로 받아서 여기서 거른다. 출처를 안 주면 서버는
      // 대화형(CLI)만 돌려줘 이 칸들(app-server)에서 한 대화가 빠진다.
      load: async () => {
        const page = await request("thread/list", { limit: 100, sortKey: "updated_at", sourceKinds: ["cli", "vscode", "appServer"] });
        return (page.data ?? [] as Data[])
          .filter((t: Data) => !t.parentThreadId && (!chat.cwd || same(String(t.cwd ?? ""), chat.cwd)))
          .slice(0, 30)
          .map((t: Data) => {
            const title = String(t.name || t.preview || "").split(/\r?\n/)[0].slice(0, 60);
            titles.current.set(t.id, title);
            return { value: t.id, label: title || "이름 없는 대화", hint: ago(Number(t.updatedAt) * 1000), current: t.id === state.thread };
          });
      },
      run: (v?: string) => {
        if (!v || v === state.thread) return;
        onTitle(id, titles.current.get(v) || "지난 대화");
        onResume(id, v);
      },
    }]),
    { name: "login", hint: "로그인 — 새 탭의 터미널에서 codex login", run: () => onTerminal("codex login", "로그인") },
    { name: "logout", hint: "로그아웃 — 새 탭의 터미널에서 codex logout", run: () => onTerminal("codex logout", "로그아웃") },
  ];
  const commands = mergeCommands(barCommands({ ...bar, onNew: () => { void transport.send("/new").catch(() => {}); }, busy: disabled }), [...paneCommands, ...CODEX_COMMANDS]);
  return <>
    <div className="pane-body stream-body" />
    <ChatPane agent="codex" root={chat.cwd} id={state.thread} paneId={id} slug={slug} name={name}
      live={ready && !dispatching} working={state.busy || dispatching} waiting={state.prompts.some(blockingPrompt)}
      fresh={!state.entries.length} transport={transport} content={rendered} toolbar={toolbar} commands={commands}
      activity={<CodexSubagents agents={state.agents} />}
      subagentView={(target, close) => <CodexSubagentView target={target} entries={state.entries} agents={state.agents} request={request} onClose={close} slug={slug} />}
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

/** 줄에 없는데 이 칸이 받는 명령(위 `transport.send` 가 맡는다). */
const CODEX_COMMANDS: PaletteCommand[] = [
  { name: "compact", hint: "지난 대화를 줄여 문맥 비우기" },
  { name: "rename", hint: "대화 이름 바꾸기", args: "<이름>" },
];

/** Codex 승인 정책. 줄에서는 Claude 의 권한 모드와 같은 "권한" 자리에 선다. */
const APPROVALS: [string, string][] = [
  ["untrusted", "신뢰한 명령만 자동"],
  ["on-request", "요청 시 묻기"],
  ["on-failure", "실패 시 묻기"],
  ["never", "승인 요청 안 함"],
];

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
