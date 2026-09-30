/** 터미널 없는 claude 칸 — 새 대화 목록에서 연 대화.
 *
 *  claude 는 칸 셸의 TUI 가 아니라 `claude -p` 의 stream-json 통로로 돈다(claude_chat.rs).
 *  그래서 권한 묻기·선택지 질문이 화면 글자가 아니라 데이터로 오고, 여기서 카드로 받는다.
 *  터미널로 넘어갈 일이 없으므로 터미널을 두지 않는다.
 *
 *  말풍선·쓰이는 중인 답·서브에이전트는 PTY 칸과 같은 대화창(ChatPane)이 그린다. 대화 파일도
 *  같은 자리에 쓰이고 API 도 같은 프록시를 지나므로, 이 파일은 보내는 길과 카드만 맡는다.
 *
 *  어느 대화인지는 앱이 정한 id 다. 새 대화는 그 id 로 시작하고(`--session-id`), 다시 켤 때는
 *  대화 파일이 있으면 그 id 로 이어 연다(`--resume`). 대화 파일을 뒤져 고르지 않는다. */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatPane, type Transport } from "./Chat";
import { StreamBar, effortLabel, folderLabel, modelLabel } from "./StreamBar";
import { shortToolName, toolSummary } from "./tools";
import {
  answerLine,
  answeredStream,
  allowLine,
  appliedEffort,
  contextLine,
  controlLine,
  currentModel,
  denyLine,
  effortChoices,
  effortRequest,
  initialStream,
  initLine,
  interruptLine,
  reduceStream,
  sentStream,
  suggestionLabel,
  titleFrom,
  userLine,
  type Prompt,
  type StreamState,
} from "./claude-stream";

type Reply = { ok: boolean; body: unknown; error?: string };

type LineEvent = { id: string; line: string };
type ExitEvent = { id: string; code: number | null; error: string };

export function ClaudeStreamPane({
  id,
  cwd,
  session,
  slug,
  name,
  focused,
  onTitle,
  onBusy,
  onSession,
}: {
  id: string;
  cwd: string;
  session: string;
  slug?: string;
  name?: string;
  /** 지금 잡힌 칸인가. */
  focused: boolean;
  /** 첫 말을 칸 이름으로 준다. 통로에는 터미널 제목이 없다. */
  onTitle: (id: string, title: string) => void;
  onBusy: (id: string, busy: boolean) => void;
  /** claude 가 다른 대화로 넘어갔다(`/clear`). 부른 쪽은 그 id 를 이 칸의 대화로 적는다. */
  onSession: (id: string, session: string) => void;
}) {
  const [st, setSt] = useState<StreamState>(initialStream);
  const [alive, setAlive] = useState(false);
  // 대화 파일이 아직 없는 새 대화인가. "여는 중" 대신 "새 대화"를 보여 준다.
  const [fresh, setFresh] = useState(false);
  // 다시 켜기를 누르면 바뀐다. 이 값이 바뀌면 통로를 새로 연다.
  const [boot, setBoot] = useState(0);
  const titled = useRef(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [context, setContext] = useState<string>();
  // 답을 기다리는 요청(설정·문맥 조회, 모델 바꾸기 …). 답이 오면 request_id 로 짝짓는다.
  const pending = useRef(new Map<string, (r: Reply) => void>());

  const send = (msg: unknown) => invoke("claude_chat_send", { id, line: JSON.stringify(msg) });
  const control = (request: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const line = controlLine(request);
      const timer = window.setTimeout(() => {
        pending.current.delete(line.request_id);
        reject(new Error("claude 가 답하지 않았다"));
      }, 15000);
      pending.current.set(line.request_id, (r) => {
        window.clearTimeout(timer);
        if (r.ok) resolve(r.body);
        else reject(new Error(r.error ?? "claude 가 거절했다"));
      });
      send(line).catch((e) => {
        window.clearTimeout(timer);
        pending.current.delete(line.request_id);
        reject(e);
      });
    });

  useEffect(() => {
    let live = true;
    const unlisten: (() => void)[] = [];
    setSt(initialStream);
    setAlive(false);
    const onLine = listen<LineEvent>("claude:chat", (e) => {
      if (e.payload.id !== id) return;
      let msg: unknown;
      try {
        msg = JSON.parse(e.payload.line);
      } catch {
        return;
      }
      const m = msg as { type?: string; response?: { request_id?: string; subtype?: string; response?: unknown; error?: string } };
      const waiting = m.type === "control_response" && m.response?.request_id ? pending.current.get(m.response.request_id) : undefined;
      if (waiting && m.response?.request_id) {
        pending.current.delete(m.response.request_id);
        waiting({ ok: m.response.subtype === "success", body: m.response.response, error: m.response.error });
      }
      setSt((s) => reduceStream(s, msg));
    });
    const onExit = listen<ExitEvent>("claude:chat-exit", (e) => {
      if (e.payload.id !== id) return;
      setAlive(false);
      setSt((s) => ({ ...s, busy: false, prompts: [], exited: { code: e.payload.code, error: e.payload.error } }));
    });
    void (async () => {
      const offs = await Promise.all([onLine, onExit]);
      if (!live) return offs.forEach((f) => f());
      unlisten.push(...offs);
      // 대화 파일이 있으면 이어 열고, 없으면 그 id 로 새로 시작한다.
      // 크기 조회는 파일이 없으면 0 을 준다.
      const resume = await invoke<number>("claude_transcript_size", { root: cwd, id: session }).then((n) => n > 0, () => false);
      if (!live) return;
      setFresh(!resume);
      titled.current = resume;
      try {
        await invoke("claude_chat_start", { id, cwd, session, resume });
        if (!live) return;
        setAlive(true);
        await send(initLine());
        // 지금 걸린 추론 수준은 초기화 답에 없다. 설정을 한 번 물어 줄에 채운다.
        void control({ subtype: "get_settings" })
          .then((b) => live && setSt((s) => ({ ...s, effort: appliedEffort(b) ?? s.effort })))
          .catch(() => {});
      } catch (err) {
        if (live) setSt((s) => ({ ...s, exited: { code: null, error: String(err) } }));
      }
    })();
    return () => {
      live = false;
      unlisten.forEach((f) => f());
      void invoke("claude_chat_stop", { id }).catch(() => {});
    };
    // 대화 id 는 deps 에 두지 않는다. `/clear` 로 claude 가 스스로 새 대화로 넘어가면 그 id 가 여기로
    // 돌아오는데, 그때 다시 띄우면 하던 claude 를 끊는다. 다시 켤 때(boot)는 그때의 id 로 연다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd, boot]);

  // claude 가 알려 주는 대화 id 를 따라간다. 대화창은 그 파일을 그리고, 다음에 켤 때 그 대화로 이어 연다.
  useEffect(() => {
    if (st.session && st.session !== session) onSession(id, st.session);
  }, [st.session, session, id, onSession]);

  // 칸을 막 열었을 때는 claude 가 아직 안 떠 입력바가 꺼져 있어 App 이 준 포커스를 못 받는다.
  // 켜지는 순간 잡힌 칸이면 다시 준다 — 안 그러면 새 대화를 열고도 한 번 더 눌러야 친다.
  useEffect(() => {
    if (!alive || !focused) return;
    (window as unknown as { __chats?: Record<string, HTMLTextAreaElement | null> }).__chats?.[id]?.focus();
  }, [alive, focused, id]);

  useEffect(() => {
    onBusy(id, st.busy);
  }, [id, st.busy, onBusy]);

  const transport = useMemo<Transport>(
    () => ({
      // `/clear` 같은 명령은 대화 파일에 명령 줄로 적힌다. "보내는 중" 말풍선으로 남기면 짝이 안 맞아 오래 남는다.
      isCommand: (text) => /^\/[\w-]+/.test(text.trim()),
      send: async (text) => {
        await send(userLine(text));
        setSt(sentStream);
        const title = titled.current ? null : titleFrom(text);
        if (title) {
          titled.current = true;
          onTitle(id, title);
        }
      },
      interrupt: () => void send(interruptLine()).catch(() => {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, onTitle],
  );

  const reply = (p: Prompt, msg: unknown) => {
    setSt((s) => answeredStream(s, p.requestId));
    void send(msg).catch(() => {});
  };

  // 줄에서 바꾼 것은 claude 가 받았다고 답한 뒤에 반영한다. 못 받았으면 대화 끝에 까닭을 남긴다.
  const setting = (request: Record<string, unknown>, apply: (s: StreamState) => StreamState) =>
    void control(request).then(
      () => setSt(apply),
      (e) => setSt((s) => ({ ...s, error: `설정을 못 바꿨다: ${e instanceof Error ? e.message : e}` })),
    );
  const toggleStatus = () => {
    const open = !statusOpen;
    setStatusOpen(open);
    if (open && alive) void control({ subtype: "get_context_usage" }).then((b) => setContext(contextLine(b)), () => {});
  };
  const model = currentModel(st);
  const efforts = effortChoices(model);
  const modeName = MODES.find(([v]) => v === (st.mode ?? "default"))?.[1] ?? st.mode ?? "매번 묻기";
  const toolbar = (
    <StreamBar
      model={{
        label: "모델",
        aria: "Claude 모델",
        value: model?.value ?? "",
        title: model?.description ?? st.model,
        disabled: !alive,
        choices: [
          ...(model ? [] : [{ value: "", label: st.model ?? "기본" }]),
          ...st.models.map((m) => ({ value: m.value, label: m.displayName ?? m.value, title: m.description })),
        ],
        onChange: (v) => setting({ subtype: "set_model", model: v }, (s) => ({ ...s, model: v })),
      }}
      effort={
        efforts.length
          ? {
              label: "추론",
              aria: "Claude 추론",
              value: st.effort && efforts.includes(st.effort) ? st.effort : "",
              disabled: !alive,
              choices: [
                ...(st.effort && efforts.includes(st.effort) ? [] : [{ value: "", label: st.effort ? effortLabel(st.effort) : "기본" }]),
                ...efforts.map((v) => ({ value: v, label: effortLabel(v) })),
              ],
              onChange: (v) => setting(effortRequest(v), (s) => ({ ...s, effort: v })),
            }
          : undefined
      }
      permission={{
        label: "권한",
        aria: "Claude 권한",
        value: st.mode ?? "default",
        disabled: !alive,
        choices: MODES.map(([value, label]) => ({ value, label })),
        onChange: (v) => setting({ subtype: "set_permission_mode", mode: v }, (s) => ({ ...s, mode: v })),
      }}
      statusOpen={statusOpen}
      onStatus={toggleStatus}
      onNew={() =>
        void transport.send("/clear").then(() => {
          // Codex 칸과 같다 — 새 대화는 이름도 새로 시작하고, 다음 첫 말이 이름이 된다.
          titled.current = false;
          onTitle(id, "새 대화");
        }, () => {})
      }
      busy={!alive || st.busy}
      status={[
        ["모델", modelLabel(model?.displayName, st.model ?? model?.resolvedModel)],
        ["추론", st.effort ? effortLabel(st.effort) : "기본"],
        ["권한", modeName],
        ["폴더", folderLabel(cwd)],
        ["사용 토큰", context ?? "집계 전"],
        ["대화", st.session ?? session],
      ]}
    />
  );

  const extra = (
    <>
      {st.prompts.map((p) =>
        p.kind === "ask" ? (
          <AskCard key={p.requestId} prompt={p} onAnswer={(a) => reply(p, answerLine(p, a))} onSkip={() => reply(p, denyLine(p, "사용자가 답하지 않고 넘겼다"))} />
        ) : (
          <PermissionCard key={p.requestId} prompt={p} cwd={cwd} onAllow={(always) => reply(p, allowLine(p, { always }))} onDeny={() => reply(p, denyLine(p))} />
        ),
      )}
      {st.error && <div className="note bad">{st.error}</div>}
      {st.exited && (
        <div className="ask stream-exit">
          <div className="ask-title">claude 가 멈췄다</div>
          {st.exited.error ? <pre className="perm-input">{st.exited.error.trim().split("\n").slice(-4).join("\n")}</pre> : null}
          <button className="ask-go" onClick={() => setBoot((n) => n + 1)}>
            다시 켜기
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* 대화창은 칸 몸통 자리를 재서 그 위에 선다. 터미널이 없으니 빈 자리만 둔다. */}
      <div className="pane-body stream-body" />
      <ChatPane
        agent="claude"
        root={cwd}
        id={session}
        paneId={id}
        slug={slug}
        name={name}
        live={alive}
        working={st.busy}
        fresh={fresh}
        transport={transport}
        extra={extra}
        toolbar={toolbar}
      />
    </>
  );
}

/** 권한 모드. TUI 의 Shift+Tab 자리다. */
const MODES: [string, string][] = [
  ["default", "매번 묻기"],
  ["acceptEdits", "편집은 묻지 않기"],
  ["plan", "계획만"],
  ["bypassPermissions", "묻지 않기"],
];

function PermissionCard({
  prompt,
  cwd,
  onAllow,
  onDeny,
}: {
  prompt: Extract<Prompt, { kind: "permission" }>;
  cwd: string;
  onAllow: (always?: Record<string, unknown>) => void;
  onDeny: () => void;
}) {
  const command = typeof prompt.input.command === "string" ? prompt.input.command : null;
  const what = command ?? toolSummary(prompt.tool, prompt.input);
  const always = prompt.suggestions.flatMap((s) => {
    // 폴더를 더해 주겠다는 갈래가 이미 작업 폴더 안을 가리키면 고를 이유가 없다.
    if (s.type === "addDirectories" && Array.isArray(s.directories) && s.directories.every((d) => typeof d === "string" && inside(d, cwd))) return [];
    const label = suggestionLabel(s);
    return label ? [{ s, label }] : [];
  });
  return (
    <div className="ask perm" role="alertdialog" aria-label={`${shortToolName(prompt.tool)} 허락`}>
      <div className="ask-title">{shortToolName(prompt.tool)} 실행을 허락할까</div>
      {prompt.description && prompt.description !== what ? <div className="q">{prompt.description}</div> : null}
      {what ? <pre className="perm-input">{what}</pre> : null}
      {prompt.blockedPath ? <div className="q">대상: {prompt.blockedPath}</div> : null}
      <div className="ask-row">
        <button className="ask-go" onClick={() => onAllow()}>
          허락
        </button>
        {always.map(({ s, label }) => (
          <button key={label} className="ask-alt" onClick={() => onAllow(s)} title={label}>
            {label}
          </button>
        ))}
        <button className="ask-no" onClick={onDeny}>
          거절
        </button>
      </div>
    </div>
  );
}

const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const inside = (dir: string, root: string) => !!root && (norm(dir) === norm(root) || norm(dir).startsWith(norm(root) + "/"));

function AskCard({
  prompt,
  onAnswer,
  onSkip,
}: {
  prompt: Extract<Prompt, { kind: "ask" }>;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const answerOf = (q: string) => (typed[q]?.trim() ? typed[q].trim() : (picked[q] ?? []).join(", "));
  const complete = prompt.questions.every((q) => answerOf(q.question));
  const submit = (over?: Record<string, string>) => {
    const answers = Object.fromEntries(prompt.questions.map((q) => [q.question, over?.[q.question] ?? answerOf(q.question)]));
    onAnswer(answers);
  };
  // 한 번 고르면 끝나는 질문 하나라면 누르는 것으로 바로 답한다.
  const oneTap = prompt.questions.length === 1 && !prompt.questions[0].multiSelect;
  return (
    <div className="ask choose" role="group" aria-label="claude 의 질문">
      {prompt.questions.map((q) => (
        <div className="ask-q" key={q.question}>
          {q.header ? <span className="ask-chip">{q.header}</span> : null}
          <div className="ask-title">{q.question}</div>
          <div className="ask-opts">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  className={on ? "ask-opt on" : "ask-opt"}
                  aria-pressed={on}
                  onClick={() => {
                    if (oneTap) return submit({ [q.question]: o.label });
                    setPicked((p) => {
                      const cur = p[q.question] ?? [];
                      const next = q.multiSelect ? (on ? cur.filter((l) => l !== o.label) : [...cur, o.label]) : [o.label];
                      return { ...p, [q.question]: next };
                    });
                  }}
                >
                  <span className="ask-opt-label">{o.label}</span>
                  {o.description ? <span className="ask-opt-desc">{o.description}</span> : null}
                </button>
              );
            })}
          </div>
          <input
            className="ask-typed"
            placeholder="직접 쓰기"
            value={typed[q.question] ?? ""}
            onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && complete) submit();
            }}
          />
        </div>
      ))}
      <div className="ask-row">
        {!oneTap || Object.values(typed).some((t) => t.trim()) ? (
          <button className="ask-go" disabled={!complete} onClick={() => submit()}>
            보내기
          </button>
        ) : null}
        <button className="ask-no" onClick={onSkip}>
          넘기기
        </button>
      </div>
    </div>
  );
}
