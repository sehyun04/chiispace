/** 폰 화면 — 이 PC 에 떠 있는 Claude 대화창 칸을 고르고, 그 칸에서 말하고 권한에 답한다.
 *
 *  칸을 새로 띄우지 않는다. PC 에서 연 칸에 붙어 같은 claude 와 같은 대화 파일을 본다 — 밖에서 하던 일을 이어 보려는
 *  것이지 폰에서 따로 일을 벌이려는 것이 아니다. 말풍선·쓰이는 중인 답·카드는 PC 대화창 부품 그대로다(Chat·ChatPane·
 *  PermissionCard·AskCard). 다른 것은 칸의 지금 상태를 처음에 통로에서 한 번 받아 온다는 것뿐이다(`claude_chat_snapshot`).
 *  시작점은 phone-main.tsx 다. */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatPane, type Transport } from "./Chat";
import { AskCard, PermissionCard } from "./ClaudeStreamPane";
import { Face } from "./roster";
import { answerLine, answeredStream, allowLine, denyLine, initialStream, interruptLine, reduceStream, sentStream, userLine, type Prompt, type StreamState } from "./claude-stream";
import { deviceName, folderName, fromSnapshot, paneFromHash, paneHash, paneState, type PhonePane, type Snapshot } from "./phone";
import type { RemoteStatus } from "./remote-shim";

type LineEvent = { id: string; line: string };
type ExitEvent = { id: string; code: number | null; error: string };
type AnsweredEvent = { id: string; request_id: string };

export function Pair({ onToken }: { onToken: (token: string) => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true);
    setErr(null);
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name: deviceName(navigator.userAgent) }),
      });
      const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
      if (!res.ok || !body?.token) throw new Error(body?.error ?? `연결하지 못했다 (${res.status})`);
      onToken(body.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setCode("");
    } finally {
      setSending(false);
    }
  };
  return (
    <main className="m-pair">
      <div className="m-pair-face">
        <Face slug="hachiware" />
      </div>
      <h1>chiispace</h1>
      <p>PC 의 chiispace 옆칸 아래 [폰 연결]에서 받은 여섯 자리 번호를 넣어 줘.</p>
      {/* iOS 홈 화면 앱은 사파리와 저장소가 따로다. 사파리에서 짝지으면 홈 화면에서 또 짝지어야 하고 PC 목록에 폰이 둘 남는다. */}
      {(navigator as { standalone?: boolean }).standalone === false ? (
        <p className="m-hint">먼저 공유 → 홈 화면에 추가를 누르고, 홈 화면의 chiispace 에서 번호를 넣으면 앱처럼 쓴다.</p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6 && !sending) void submit();
        }}
      >
        <input
          className="m-code"
          aria-label="짝짓기 번호"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <button className="m-go" type="submit" disabled={code.length !== 6 || sending}>
          {sending ? "잇는 중" : "연결"}
        </button>
      </form>
      {err ? <p className="m-bad" role="alert">{err}</p> : null}
    </main>
  );
}

const Back = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

function Link({ status }: { status: RemoteStatus }) {
  if (status === "open") return null;
  return <div className="m-link" role="status">{status === "connecting" ? "PC 에 잇는 중" : "PC 와 끊겼다 · 다시 잇는 중"}</div>;
}

/** 칸 목록과 고른 칸. 목록은 계속 새로 받아 둔다 — 칸 화면에서도 대화 id 가 바뀌면(`/clear`) 따라가야 한다. */
export function Phone({ status, onForget }: { status: RemoteStatus; onForget: () => void }) {
  const [panes, setPanes] = useState<PhonePane[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      invoke<PhonePane[]>("remote_panes").then(
        (p) => {
          if (!alive) return;
          setPanes(p);
          setErr(null);
        },
        (e) => alive && setErr(String(e)),
      );
    void load();
    const timer = window.setInterval(() => document.visibilityState === "visible" && void load(), 3000);
    const offs = [listen("remote:panes", () => void load()), listen("remote:resync", () => void load())];
    return () => {
      alive = false;
      window.clearInterval(timer);
      offs.forEach((o) => void o.then((f) => f()));
    };
  }, []);

  const openId = paneFromHash(hash);
  const open = openId ? panes?.find((p) => p.id === openId) : undefined;
  if (openId && panes && !open) {
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
        <p className="m-empty">PC 에서 이 칸을 닫았다.</p>
      </main>
    );
  }
  if (open) return <MobilePane key={open.id} pane={open} status={status} />;
  return (
    <main className="m-app">
      <header className="m-head">
        <div className="m-head-text">
          <div className="m-title">chiispace</div>
          <div className="m-sub">PC 의 Claude 대화창</div>
        </div>
      </header>
      <Link status={status} />
      <div className="m-list">
        {err ? <p className="m-bad">{err}</p> : null}
        {panes === null ? (
          <p className="m-empty">칸을 받는 중</p>
        ) : panes.length === 0 ? (
          <p className="m-empty">PC 에 열린 Claude 대화창이 없다. PC 에서 새 대화 → Claude 로 열면 여기 뜬다.</p>
        ) : (
          panes.map((p) => {
            const s = paneState(p);
            return (
              <a key={p.id} className="m-row" href={paneHash(p.id)}>
                <span className="m-row-face">
                  <Face slug={p.slug ?? undefined} agent />
                </span>
                <span className="m-row-text">
                  <span className="m-row-title">{p.title || p.name || "Claude"}</span>
                  <span className="m-row-sub" title={p.cwd}>{folderName(p.cwd)}</span>
                </span>
                <span className={`m-chip ${s.tone}`}>{s.text}</span>
              </a>
            );
          })
        )}
      </div>
      <footer className="m-foot">
        <button
          className="m-forget"
          onClick={() => {
            if (confirm("이 폰의 연결을 지울까? 다시 쓰려면 PC 에서 새 번호를 받아야 한다.")) onForget();
          }}
        >
          이 폰 연결 지우기
        </button>
      </footer>
    </main>
  );
}

function MobilePane({ pane, status }: { pane: PhonePane; status: RemoteStatus }) {
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
        setSt((s) => ({ ...s, busy: false, prompts: [], exited: { code: e.payload.code, error: e.payload.error } }));
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
  const s = paneState({ alive, busy: st.busy, waiting: st.prompts.length });
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
          <div className="m-title">{pane.title || pane.name || "Claude"}</div>
          <div className="m-sub">
            {folderName(pane.cwd)} · <span className={`m-state ${s.tone}`}>{s.text}</span>
          </div>
        </div>
      </header>
      <Link status={status} />
      <div className="m-body">
        {/* 대화창은 칸 몸통 자리를 재서 그 위에 선다(ChatPane). 폰에서는 몸통이 곧 이 자리다. */}
        <div className="pane-body" />
        <ChatPane
          key={session}
          agent="claude"
          root={pane.cwd}
          id={session}
          paneId={`phone:${id}`}
          slug={pane.slug ?? undefined}
          name={pane.name ?? "Claude"}
          live={alive && status === "open"}
          unavailable={alive ? "PC 와 다시 잇는 중" : "PC 에서 이 칸의 claude 가 멈췄다"}
          working={st.busy}
          transport={transport}
          extra={extra}
          touch
        />
      </div>
    </main>
  );
}
