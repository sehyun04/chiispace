/** 폰 화면 — 이 PC 에 떠 있는 대화창 칸을 고르고, 그 칸에서 말하고 권한에 답한다.
 *
 *  칸을 새로 띄우지 않는다. PC 에서 연 칸에 붙어 같은 대화를 본다 — 밖에서 하던 일을 이어 보려는
 *  것이지 폰에서 따로 일을 벌이려는 것이 아니다. 말풍선·쓰이는 중인 답·카드는 PC 대화창 부품 그대로다(Chat·ChatPane·
 *  PermissionCard·AskCard). 다른 것은 칸의 지금 상태를 처음에 통로에서 한 번 받아 온다는 것뿐이다(`claude_chat_snapshot`).
 *  시작점은 phone-main.tsx 다. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatPane, type Transport } from "./Chat";
import { AskCard, PermissionCard } from "./ClaudeStreamPane";
import { CodexRequestCards } from "./CodexRequestCards";
import { CodexSubagents, CodexSubagentView } from "./CodexSubagents";
import { agentActive, blockingPrompt, codexItems, initialCodex, type Data, type Request } from "./codex-stream";
import { codexPhoneEvent, type CodexPhoneAction, type CodexPhoneEvent, type CodexPhoneSnapshot } from "./codex-phone";
import { Face } from "./roster";
import { SubAgents } from "./SubAgents";
import { answerLine, answeredStream, allowLine, denyLine, initialStream, interruptLine, reduceStream, sentStream, userLine, type Prompt, type StreamState } from "./claude-stream";
import { folderName, fromSnapshot, paneFromHash, paneHash, paneState, pcLabel, roomFromHash, type PhonePane, type Snapshot } from "./phone";
import type { LinkStatus } from "./phone-link";

type LineEvent = { id: string; line: string };
type ExitEvent = { id: string; code: number | null; error: string };
type AnsweredEvent = { id: string; request_id: string };

export function Pair({ connect }: { connect: (onSas: (sas: string) => void) => Promise<void> }) {
  const [sas, setSas] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr(null);
    setSas(null);
    try {
      await connect(setSas);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSas(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="m-pair">
      <div className="m-pair-face">
        <Face slug="hachiware" />
      </div>
      <h1>chiispace</h1>
      {sas ? (
        <>
          <p>PC 화면에도 이 숫자가 보이면 PC 에서 [맞다]를 눌러 줘.</p>
          <div className="m-sas" aria-label="짝짓기 숫자" data-sas={sas}>
            {sas.slice(0, 3)} {sas.slice(3)}
          </div>
          <p className="m-hint">숫자가 다르면 PC 에서 [아니다]를 눌러. 누가 가운데서 끼어든 것이다.</p>
        </>
      ) : (
        <>
          <p>PC 의 chiispace 옆칸 아래 폰 단추 → [폰 짝짓기]를 누른 뒤 여기서 [연결]을 눌러 줘.</p>
          {/* iOS 홈 화면 앱은 사파리와 저장소가 따로다. 사파리에서 짝지으면 홈 화면에서 또 짝지어야 하고 PC 목록에 폰이 둘 남는다. */}
          {(navigator as { standalone?: boolean }).standalone === false ? (
            <p className="m-hint">먼저 공유 → 홈 화면에 추가를 누르고, 홈 화면의 chiispace 에서 짝지으면 앱처럼 쓴다.</p>
          ) : null}
          <button className="m-go" disabled={busy} onClick={() => void go()}>
            {busy ? "PC 에 묻는 중" : "연결"}
          </button>
        </>
      )}
      {err ? <p className="m-bad" role="alert">{err}</p> : null}
    </main>
  );
}

const Back = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const LINK_TEXT: Record<LinkStatus, string> = {
  open: "",
  connecting: "PC 에 잇는 중",
  retrying: "PC 와 끊겼다 · 다시 잇는 중",
  "pc-offline": "PC 가 안 보인다 · chiispace 와 [폰 연결]이 켜져 있어야 한다",
};

function Link({ status, stale }: { status: LinkStatus; stale: boolean }) {
  return (
    <>
      {stale ? (
        <button className="m-update" onClick={() => location.reload()}>
          새 판이 있다 · 눌러서 새로고침
        </button>
      ) : null}
      {status === "open" ? null : <div className={status === "pc-offline" ? "m-link off" : "m-link"} role="status">{LINK_TEXT[status]}</div>}
    </>
  );
}

/** 폰이 붙은 PC 하나. 이 페이지를 내준 PC(`own`)와 묶인 다른 PC 들이다(phone-main.tsx). */
export type PhonePc = { room: string; name: string | null; status: LinkStatus; own: boolean };

/** 칸 목록과 고른 칸. 목록은 계속 새로 받아 둔다 — 칸 화면에서도 대화 id 가 바뀌면(`/clear`) 따라가야 한다.
 *  묶인 PC 가 여럿이면 PC 마다 묶어 보인다. 칸 id 는 PC 마다 겹치므로 주소에 PC 를 같이 적는다(`paneHash`). */
export function Phone({ pcs, stale, call, on, onForget }: {
  pcs: PhonePc[];
  stale: boolean;
  call: (room: string, cmd: string, args: unknown) => Promise<unknown>;
  on: (room: string, fn: (event: string) => void) => () => void;
  onForget: () => void;
}) {
  const [panes, setPanes] = useState<Record<string, PhonePane[]>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // 붙어 있는 PC 만 묻는다. 꺼진 PC 에 3초마다 물으면 답 없는 요청만 쌓인다.
  const openRooms = pcs.filter((p) => p.status === "open").map((p) => p.room).join(",");
  useEffect(() => {
    let alive = true;
    const offs = (openRooms ? openRooms.split(",") : []).map((room) => {
      const load = () =>
        call(room, "remote_panes", {}).then(
          (p) => {
            if (!alive) return;
            setPanes((x) => ({ ...x, [room]: p as PhonePane[] }));
            setErrs(({ [room]: _, ...rest }) => rest);
          },
          (e) => alive && setErrs((x) => ({ ...x, [room]: String(e) })),
        );
      void load();
      const timer = window.setInterval(() => document.visibilityState === "visible" && void load(), 3000);
      const off = on(room, (e) => (e === "remote:panes" || e === "remote:resync") && void load());
      return () => {
        window.clearInterval(timer);
        off();
      };
    });
    return () => {
      alive = false;
      offs.forEach((f) => f());
    };
  }, [openRooms, call, on]);

  const ownRoom = pcs.find((p) => p.own)?.room;
  const openId = paneFromHash(hash);
  const openRoom = roomFromHash(hash) ?? ownRoom;
  const openPc = pcs.find((p) => p.room === openRoom);
  const list = openRoom ? panes[openRoom] : undefined;
  const open = openId ? list?.find((p) => p.id === openId) : undefined;
  if (openId && (!openPc || list) && !open) {
    return (
      <main className="m-app">
        <header className="m-head">
          <a className="m-back" href="#/" aria-label="칸 목록">
            <Back />
          </a>
          <div className="m-head-text">
            <div className="m-title">닫힌 칸</div>
          </div>
        </header>
        <p className="m-empty">{openPc ? "PC 에서 이 칸을 닫았다." : "이 폰과 묶이지 않은 PC 의 칸이다."}</p>
      </main>
    );
  }
  const status = openPc?.status ?? "connecting";
  if (open?.agent === "codex") return <MobileCodexPane key={`${openRoom}:${open.id}:${open.session}`} pane={open} status={status} stale={stale} />;
  if (open) return <MobileClaudePane key={`${openRoom}:${open.id}`} pane={open} status={status} stale={stale} />;
  const many = pcs.length > 1;
  return (
    <main className="m-app">
      <header className="m-head">
        <div className="m-head-text">
          <div className="m-title">chiispace</div>
          <div className="m-sub">{many ? `묶인 PC ${pcs.length}대의 대화창` : "PC 의 대화창"}</div>
        </div>
      </header>
      {many ? <Link status="open" stale={stale} /> : <Link status={pcs[0]?.status ?? "connecting"} stale={stale} />}
      <div className="m-list">
        {pcs.map((pc) => {
          const rows = panes[pc.room];
          const err = errs[pc.room];
          return (
            <section key={pc.room} className="m-pc" aria-label={pc.name ?? "PC"}>
              {many ? (
                <div className="m-pc-head">
                  <span className="m-pc-name">{pc.name ?? "PC"}</span>
                  <span className={`m-pc-state ${pc.status === "open" ? "on" : pc.status === "pc-offline" ? "off" : "wait"}`}>{pcLabel(pc.status)}</span>
                </div>
              ) : null}
              {err ? <p className="m-bad">{err}</p> : null}
              {many && pc.status === "pc-offline" ? (
                <p className="m-empty">그 PC 의 chiispace 와 [폰 연결]이 켜지면 여기 뜬다.</p>
              ) : !rows ? (
                <p className="m-empty">칸을 받는 중</p>
              ) : rows.length === 0 ? (
                <p className="m-empty">PC 에 열린 대화창이 없다. PC 에서 Claude나 Codex 대화창을 열면 여기 뜬다.</p>
              ) : (
                rows.map((p) => {
                  const st = paneState(p);
                  return (
                    <a key={p.id} className="m-row" href={paneHash(p.id, pc.own ? null : pc.room)}>
                      <span className="m-row-face">
                        <Face slug={p.slug ?? undefined} agent />
                      </span>
                      <span className="m-row-text">
                        <span className="m-row-title">{p.title || p.name || agentName(p)}</span>
                        <span className="m-row-sub" title={p.cwd}>{folderName(p.cwd)} · {agentName(p)}</span>
                      </span>
                      <span className={`m-chip ${st.tone}`}>{st.text}</span>
                    </a>
                  );
                })
              )}
            </section>
          );
        })}
      </div>
      <footer className="m-foot">
        <button
          className="m-forget"
          onClick={() => {
            if (confirm(many ? "이 폰의 연결을 다 지울까? 다시 쓰려면 PC 에서 새 번호를 받아야 한다." : "이 폰의 연결을 지울까? 다시 쓰려면 PC 에서 새 번호를 받아야 한다.")) onForget();
          }}
        >
          이 폰 연결 지우기
        </button>
      </footer>
    </main>
  );
}

type PaneProps = { pane: PhonePane; status: LinkStatus; stale: boolean };
const agentName = (p: PhonePane) => p.agent === "codex" ? "Codex" : "Claude";

function MobileClaudePane({ pane, status, stale }: PaneProps) {
  const { id } = pane;
  const [st, setSt] = useState<StreamState>(initialStream);
  const [alive, setAlive] = useState(pane.alive);
  // 끊겼다 다시 이어지면 늘린다. 그 사이에 지나간 줄은 오지 않으므로 지금 상태를 다시 받는다.
  const [sync, setSync] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    let live = true;
    loaded.current = false;
    // 지금 상태를 받는 사이에 온 줄. 받은 뒤에 얹는다.
    const queued: unknown[] = [];
    const offs = [
      listen<LineEvent>("claude:chat", (e) => {
        if (e.payload.id !== id) return;
        let msg: unknown;
        try {
          msg = JSON.parse(e.payload.line);
        } catch {
          return;
        }
        if (!loaded.current) queued.push(msg);
        else setSt((s) => reduceStream(s, msg));
      }),
      listen<ExitEvent>("claude:chat-exit", (e) => {
        if (e.payload.id !== id) return;
        setAlive(false);
        setSt((s) => ({ ...s, busy: false, tasks: [], prompts: [], exited: { code: e.payload.code, error: e.payload.error } }));
      }),
      listen<AnsweredEvent>("claude:chat-answered", (e) => {
        if (e.payload.id === id) setSt((s) => answeredStream(s, e.payload.request_id));
      }),
      listen("remote:resync", () => setSync((n) => n + 1)),
    ];
    void Promise.all(offs).then(() =>
      invoke<Snapshot>("claude_chat_snapshot", { id }).then(
        (snap) => {
          if (!live) return;
          loaded.current = true;
          setAlive(snap.alive);
          setSt(fromSnapshot(snap, queued.splice(0)));
        },
        (e) => live && setSt((s) => ({ ...s, error: String(e) })),
      ),
    );
    return () => {
      live = false;
      offs.forEach((o) => void o.then((f) => f()));
    };
  }, [id, sync]);

  const send = (msg: unknown) => invoke("claude_chat_send", { id, line: JSON.stringify(msg) });
  const transport = useMemo<Transport>(
    () => ({
      isCommand: (text) => /^\/[\w-]+/.test(text.trim()),
      images: true,
      send: async (text, images) => {
        await send(userLine(text, images));
        setSt(sentStream);
      },
      interrupt: () => void send(interruptLine()).catch(() => {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  const reply = (p: Prompt, msg: unknown) => {
    setSt((s) => answeredStream(s, p.requestId));
    // PC 에서 먼저 답했으면 서버가 거절한다. 카드는 이미 걷혔으니 따로 알릴 것이 없다.
    void send(msg).catch(() => {});
  };
  // 지금 상태를 받기 전에는 칸 목록이 준 상태를 쓴다. 빈 상태로 그리면 일하는 칸이 잠깐 쉬는 중으로 보인다.
  const s = loaded.current ? paneState({ alive, busy: st.busy, tasks: st.tasks.length, waiting: st.prompts.length }) : paneState(pane);
  const session = st.session ?? pane.session;

  const extra = (
    <>
      {st.prompts.map((p) =>
        p.kind === "ask" ? (
          <AskCard key={p.requestId} prompt={p} onAnswer={(a) => reply(p, answerLine(p, a))} onSkip={() => reply(p, denyLine(p, "사용자가 답하지 않고 넘겼다"))} />
        ) : (
          <PermissionCard key={p.requestId} prompt={p} cwd={pane.cwd} onAllow={(always) => reply(p, allowLine(p, { always }))} onDeny={() => reply(p, denyLine(p))} />
        ),
      )}
      {st.error ? <div className="note bad">{st.error}</div> : null}
      {st.exited || !alive ? <div className="note">PC 에서 이 칸의 claude 가 멈췄다. PC 에서 다시 켜면 이어진다.</div> : null}
    </>
  );

  return <MobilePaneFrame pane={pane} status={status} stale={stale} state={s}>
    <ChatPane
      key={session}
      agent="claude"
      root={pane.cwd}
      id={session}
      paneId={`phone:${id}`}
      slug={pane.slug ?? undefined}
      name={pane.name ?? "Claude"}
      live={alive && status === "open"}
      unavailable={alive ? LINK_TEXT[status] || "PC 와 잇는 중" : "PC 에서 이 칸의 claude 가 멈췄다"}
      working={st.busy}
      transport={transport}
      extra={extra}
      // 폰은 뒤늦게 붙는다. 붙기 전부터 돌던 서브에이전트는 통로가 알려 준 목록으로 채운다.
      activity={<SubAgents session={session} running={st.tasks} />}
      touch
    />
  </MobilePaneFrame>;
}

function MobilePaneFrame({ pane, status, stale, state: s, children }: PaneProps & { state: ReturnType<typeof paneState>; children: ReactNode }) {
  return (
    <main className="m-app m-pane">
      <header className="m-head">
        <a className="m-back" href="#/" aria-label="칸 목록">
          <Back />
        </a>
        <span className="m-head-face">
          <Face slug={pane.slug ?? undefined} agent />
        </span>
        <div className="m-head-text">
          <div className="m-title">{pane.title || pane.name || agentName(pane)}</div>
          <div className="m-sub">
            {folderName(pane.cwd)} · {agentName(pane)} · <span className={`m-state ${s.tone}`}>{s.text}</span>
          </div>
        </div>
      </header>
      <Link status={status} stale={stale} />
      <div className="m-body">
        {/* 대화창은 칸 몸통 자리를 재서 그 위에 선다(ChatPane). 폰에서는 몸통이 곧 이 자리다. */}
        <div className="pane-body" />
        {children}
      </div>
    </main>
  );
}

function MobileCodexPane({ pane, status, stale }: PaneProps) {
  const { id, session } = pane;
  const [snapshot, setSnapshot] = useState<CodexPhoneSnapshot>();
  const [sync, setSync] = useState(0);
  const [synced, setSynced] = useState(false);
  const [failure, setFailure] = useState("");
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  useEffect(() => {
    setSynced(false);
    if (!pane.alive || status !== "open") return;
    let active = true;
    let current: CodexPhoneSnapshot | undefined;
    let queued: CodexPhoneEvent[] = [];
    let timer: number | undefined;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      window.clearTimeout(timer);
      try {
        const snap = await invoke<CodexPhoneSnapshot>("codex_phone", { id, session, action: { kind: "snapshot" } });
        if (!active) return;
        // PC가 이미 반영한 조각은 빼야 재연결 순간 답변이 두 번 붙지 않는다.
        current = queued.reduce(codexPhoneEvent, snap);
        queued = [];
        setSnapshot(current);
        setSynced(true);
        if (!current.ready) timer = window.setTimeout(load, 1000);
      } catch {
        if (active) timer = window.setTimeout(load, 1500);
      } finally { loading = false; }
    };
    const off = listen<CodexPhoneEvent>("remote:codex", ({ payload: event }) => {
      if (!active || event.id !== id || event.session !== session) return;
      if (!current || loading) {
        queued.push(event);
      } else if (event.run !== current.run && event.seq > current.seq) {
        queued.push(event);
        setSynced(false);
        void load();
      } else {
        current = codexPhoneEvent(current, event);
        setSnapshot(current);
      }
    });
    void off.then(() => { if (active) void load(); });
    return () => { active = false; window.clearTimeout(timer); void off.then(fn => fn()); };
  }, [id, session, pane.alive, status, sync]);

  const state = snapshot?.state ?? initialCodex;
  const live = pane.alive && status === "open" && synced && !!snapshot?.ready;
  const call = <T,>(action: CodexPhoneAction) => invoke<T>("codex_phone", { id, session, action });
  const updateFailure = (e: unknown) => {
    setFailure(String(e));
    setSync(n => n + 1);
  };
  const transport: Transport = {
    images: true,
    send: async (text, images) => {
      if (!live || !snapshot || sending) throw new Error("PC와 연결을 기다려 줘");
      setSending(true);
      setFailure("");
      try {
        await call({ kind: "send", run: snapshot.run, turn: state.turn, text, images: images?.map(p => p.url) ?? [] });
      } catch (e) { updateFailure(e); throw e; }
      finally { setSending(false); }
    },
    interrupt: () => {
      if (live && snapshot && state.turn) void call({ kind: "interrupt", run: snapshot.run, turn: state.turn }).catch(updateFailure);
    },
  };
  const answer = async (p: Request, result?: Data) => {
    if (!live || !snapshot || !result || answering) return;
    setAnswering(true);
    setFailure("");
    try {
      await call({ kind: "answer", run: snapshot.run, requestId: p.id, threadId: p.params.threadId, result });
    } catch (e) { updateFailure(e); }
    finally { setAnswering(false); }
  };
  const summary = snapshot && synced
    ? paneState({ alive: pane.alive && snapshot.ready, busy: state.busy, waiting: state.prompts.length, tasks: state.agents.filter(agentActive).length })
    : paneState(pane);
  return <MobilePaneFrame pane={pane} status={status} stale={stale} state={summary}>
    <ChatPane agent="codex" root={pane.cwd} id={session} paneId={`phone:${id}`} slug={pane.slug ?? undefined} name={pane.name ?? "Codex"}
      live={live && !sending} working={state.busy || sending} waiting={state.prompts.some(p => p.params.threadId === session && blockingPrompt(p))}
      unavailable={sending ? "메시지 보내는 중" : pane.alive ? LINK_TEXT[status] || "PC의 Codex 대화창에 연결 중" : "PC에서 이 칸의 Codex가 멈췄다"}
      transport={transport} content={codexItems(state.entries)} touch
      activity={<CodexSubagents agents={state.agents} prompts={state.prompts} />}
      subagentView={(target, close) => <CodexSubagentView target={target} entries={state.entries} agents={state.agents}
        slug={pane.slug ?? undefined} onClose={close} request={async (_method, params) => {
          if (!live || !snapshot) throw new Error("PC와 연결을 기다려 줘");
          return call<Data>({ kind: "child", run: snapshot.run, threadId: params.threadId });
        }} />}
      extra={<>
        <CodexRequestCards state={state} disabled={!live || answering} answer={(p, result) => void answer(p, result)} />
        {(failure || state.error) && <div className="note bad" role="alert">{failure || state.error}</div>}
      </>} />
  </MobilePaneFrame>;
}
