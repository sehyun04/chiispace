/** 칸 하나를 터미널 대신 대화로 그린다.
 *
 *  화면을 뜯지 않는다. `~/.claude/projects/<폴더>/<대화 id>.jsonl` 의 원문을
 *  그대로 받아 말풍선으로 편다 — 메시지 경계가 처음부터 데이터로 와 있으므로
 *  글자 모양에 기대어 경계를 찾던 일(`tailBlock`)이 여기서는 없다.
 *
 *  **보이는 것만 바뀐다.** claude 는 칸의 PTY 에서 여느 때처럼 돌고, 입력바에
 *  쓴 말도 그 PTY 로 들어간다. 헤드리스로 다시 띄우지 않으므로 이어가기·권한·
 *  슬래시 명령·MCP 가 전부 그대로다. 터미널은 이 화면 아래에 크기를 지킨 채
 *  살아 있어서 언제든 도로 볼 수 있다.
 *
 *  어느 대화를 그릴지는 부른 쪽이 준 id 다. 이 화면은 대화를 고르지 않는다. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Markdown } from "./Markdown";
import { faceUrl, bySlug } from "./roster";
import {
  parseJsonl,
  buildToolMap,
  toItems,
  turnDurations,
  turnTokens,
  fmtClock,
  fmtDuration,
  fmtTokens,
  resultText,
  type Item,
  type Bubble,
} from "./transcript";
import { shortToolName, toolSummary, toolStats, diffLines } from "./tools";
import { applyLive, caughtUp, partialInput, type Live, type LiveEvent } from "./live";
import "./chat.css";

function Caret() {
  return (
    <svg className="tool-caret" width="9" height="9" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 접었다 펴는 카드 한 장. 도구 호출과 생각이 같은 모양을 쓴다. */
function Card({
  kind,
  name,
  summary,
  stats,
  bad,
  children,
}: {
  kind: "tool" | "think";
  name: string;
  summary: string;
  stats?: { label: string; bad?: boolean }[];
  bad?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cls = [kind === "think" ? "think" : "tool", open ? "open" : "", bad ? "bad" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Caret />
        <span className="tool-name">{name}</span>
        <span className="tool-sum">{summary}</span>
        {!!stats?.length && (
          <span className="tool-stats">
            {stats.map((s, i) => (
              <span key={i} className={s.bad ? "tool-stat bad" : "tool-stat"}>
                {s.label}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && <div className="tool-body">{children}</div>}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const { name, input } = item.toolUse;
  const result = item.pair?.toolResult;
  const bad = result?.is_error === true;
  const diff = diffLines(item.pair?.toolUseResult);
  const text = resultText(result?.content);
  const stats = toolStats(name, item.pair?.toolUseResult);
  return (
    <Card
      kind="tool"
      name={shortToolName(name)}
      summary={toolSummary(name, input)}
      stats={bad ? [...stats, { label: "실패", bad: true }] : stats}
      bad={bad}
    >
      {/* 펼쳤을 때는 줄이지 않은 것을 보여준다. 한 줄로 줄인 것은 접힘용이다. */}
      <div className="tool-label">호출</div>
      <pre>{typeof input === "string" ? input : JSON.stringify(input, null, 2)}</pre>
      {diff.length > 0 && (
        <>
          <div className="tool-label">바뀐 줄</div>
          <div className="diff">
            {diff.map((l, i) => (
              <div key={i} className={l.sign === "+" ? "add" : l.sign === "-" ? "del" : undefined}>
                <span className="n">{l.n ?? ""}</span>
                <span>
                  {l.sign}
                  {l.text}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {!!text && (
        <>
          <div className="tool-label">결과</div>
          <pre className={bad ? "bad" : undefined}>{text}</pre>
        </>
      )}
      {!text && !diff.length && !result && <div className="tool-label">아직 결과가 없다</div>}
    </Card>
  );
}

function Face({ slug }: { slug?: string }) {
  const url = faceUrl(slug);
  const who = slug ? bySlug.get(slug) : undefined;
  if (!url) return <span className="msg-face" />;
  return (
    <span className="msg-face">
      <img src={url} alt={who?.name ?? ""} draggable={false} />
    </span>
  );
}

function Row({
  item,
  slug,
  name,
  showFace,
  grouped,
  durMs,
  tokens,
  onShowTerm,
}: {
  item: Item;
  slug?: string;
  name: string;
  showFace: boolean;
  grouped: boolean;
  durMs?: number;
  tokens?: number;
  onShowTerm?: () => void;
}) {
  switch (item.kind) {
    case "bubble": {
      const mine = item.role === "user";
      const clock = fmtClock(item.ts);
      return (
        <div className={`msg${mine ? " mine" : ""}${grouped ? " grouped" : ""}`}>
          {!mine && (showFace ? <Face slug={slug} /> : <span className="msg-face" />)}
          <div className="msg-col">
            {!mine && showFace && <span className="msg-who">{name}</span>}
            {mine && item.queued && <span className="msg-tag">예약 · 아직 안 들어감</span>}
            <div className="msg-row">
              <div className={`bubble${item.queued ? " queued" : ""}`}>
                {item.images?.map((src, i) => <img key={i} className="msg-img" src={src} alt="" />)}
                {/* 내가 친 말은 그대로 보인다 — 마크다운으로 해석하면 쓴 것과 달라진다. */}
                {item.text && (mine ? <span style={{ whiteSpace: "pre-wrap" }}>{item.text}</span> : <Markdown text={item.text} />)}
              </div>
              {clock && <span className="msg-clock">{clock}</span>}
            </div>
            {(durMs != null || tokens != null) && (
              <div className="msg-foot">
                {durMs != null && <span>{fmtDuration(durMs)}</span>}
                {tokens != null && <span>↓ {fmtTokens(tokens)}</span>}
              </div>
            )}
          </div>
        </div>
      );
    }
    case "tool":
      return <ToolCard item={item} />;
    case "thinking":
      return (
        <Card kind="think" name="생각" summary={item.text.slice(0, 90).replace(/\s+/g, " ")}>
          <Markdown text={item.text} />
        </Card>
      );
    case "launch":
      return <div className="note">{item.description ?? "서브에이전트"} 부름{item.agentType ? ` · ${item.agentType}` : ""}</div>;
    case "qa":
      return (
        <div className="qa">
          {item.qa.map((p, i) => (
            <div className="pair" key={i}>
              <div className="q">{p.q}</div>
              <div className="a">{p.a}</div>
            </div>
          ))}
        </div>
      );
    case "command":
      return (
        <div className="cmd">
          <span>
            {item.name}
            {item.args ? ` ${item.args}` : ""}
          </span>
        </div>
      );
    case "local-command":
      return (
        <Card kind="tool" name="출력" summary={item.stdout.slice(0, 90).replace(/\s+/g, " ")}>
          <pre>{item.stdout}</pre>
        </Card>
      );
    case "system":
      return (
        <Card kind="tool" name="시스템" summary={item.text.split("\n")[0].slice(0, 90)}>
          <pre>{item.text}</pre>
        </Card>
      );
    case "interrupted":
      return <div className="note mid">여기서 중단했다</div>;
    case "ask":
      return (
        <div className="ask">
          <div className="ask-title">고를 것이 있다</div>
          {item.questions.map((q, i) => (
            <div className="q" key={i}>
              {q}
            </div>
          ))}
          <button className="ask-go" onClick={onShowTerm}>
            터미널에서 고르기
          </button>
        </div>
      );
    default:
      return null;
  }
}

type ChatProps = {
  root: string;
  /** 어느 대화인지는 부른 쪽이 정한다. 이 화면은 고르지 않는다. */
  id: string;
  /** 입력이 들어갈 칸. 없으면 읽기만 한다. */
  paneId?: string;
  slug?: string;
  name?: string;
  refreshMs?: number;
  /** claude 가 지금 그 칸에서 돌고 있는가. 아니면 입력을 막는다. */
  live?: boolean;
  /** claude 가 일하는 중인가(칸의 작업 표시와 같은 판정). */
  working?: boolean;
  onShowTerm?: () => void;
  /** 대화 파일에 무엇이든 적혀 있는가. 부른 쪽은 그때부터 이 화면을 보여준다. */
  onReady?: (ready: boolean) => void;
};

type ChatWin = { __chats?: Record<string, HTMLTextAreaElement | null> };

/** 보내고 나서 머물러도 되는 슬래시 명령. 나머지(`/model`, `/resume`, `/config` …)는
 *  고르는 메뉴를 TUI 에 띄우는데 그 메뉴는 대화창에 없다. 보내고 곧바로 터미널을 보여준다. */
const STAY_IN_CHAT = new Set(["/clear", "/compact", "/cost", "/context", "/usage", "/exit", "/quit", "/rename"]);

/** 입력바. 평범한 textarea 라 한글 조합은 브라우저가 그대로 처리한다 —
 *  xterm 에서 조합을 직접 떠받치던 일(결정 4번)이 여기서는 없다. */
function Composer({
  paneId,
  live,
  busy,
  onSent,
  onShowTerm,
}: {
  paneId: string;
  live: boolean;
  busy: boolean;
  onSent: (text: string) => void;
  onShowTerm?: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // App 이 칸 포커스를 되돌릴 때(결정 5번) 터미널 대신 이 입력바를 잡을 수 있게
  // 자리를 알려 둔다. 칸 id 로 찾으므로 전역 하나를 들지 않는다(결정 6번).
  useEffect(() => {
    const w = window as unknown as ChatWin;
    const el = ref.current;
    (w.__chats ??= {})[paneId] = el;
    return () => {
      if (w.__chats?.[paneId] === el) delete w.__chats[paneId];
    };
  }, [paneId]);

  // 줄이 늘면 입력바도 는다. 여섯 줄을 넘기면 그 안에서 스크롤한다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const interrupt = () => void invoke("pty_write", { id: paneId, data: "\x1b" }).catch(() => {});

  const send = () => {
    const t = text.trim();
    if (!t || !live) return;
    setText("");
    const menu = /^\/[\w-]+$/.test(t) && !STAY_IN_CHAT.has(t);
    if (!menu) onSent(t);
    void invoke("pty_submit", { id: paneId, text: t })
      .then(() => {
        if (menu) onShowTerm?.();
      })
      // 못 보냈으면 쓴 말을 되살린다. 사라지면 다시 칠 방법이 없다.
      .catch(() => setText(t));
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={!live}
        placeholder={live ? "보낼 말 · Enter 보내기 · Shift+Enter 줄바꿈 · 빈 칸에서 Esc 는 중단" : "claude 가 떠 있지 않다"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 조합 중인 Enter 는 글자를 확정하는 키지 보내는 키가 아니다.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape" && !text && live) {
            // 터미널에서 Esc 로 멈추던 것을 여기서도 한다. 쓰던 글이 있으면 건드리지 않는다.
            e.preventDefault();
            interrupt();
          }
        }}
      />
      {busy && live ? (
        <button className="composer-stop" onMouseDown={(e) => e.preventDefault()} onClick={interrupt} title="중단 (Esc)">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      <button className="composer-term" onMouseDown={(e) => e.preventDefault()} onClick={onShowTerm} title="터미널 보기">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.2 4.4 L6.6 8 L3.2 11.6 M8.4 11.8 H12.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** 쓰이는 중인 답. 대화 파일에 적히기 전이라 여기서만 보인다. */
function LiveRows({ live, slug, name, showFace }: { live: Live; slug?: string; name: string; showFace: boolean }) {
  const blocks = live.blocks.filter(Boolean);
  const firstText = blocks.findIndex((b) => b.kind === "text");
  const head = (i: number) => showFace && i === firstText;
  const rows = blocks.map((b, i) => {
    if (b.kind === "thinking") {
      const tail = b.text.slice(-90).replace(/\s+/g, " ");
      return (
        <div className="think live" key={i}>
          <div className="tool-head">
            <span className="tool-name">생각{live.done ? "" : " 중"}</span>
            <span className="tool-sum">{tail}</span>
          </div>
        </div>
      );
    }
    if (b.kind === "tool") {
      return (
        <div className="tool live" key={i}>
          <div className="tool-head">
            <Caret />
            <span className="tool-name">{shortToolName(b.name)}</span>
            <span className="tool-sum">{toolSummary(b.name, partialInput(b.json))}</span>
            {!live.done && <span className="tool-stat">채우는 중</span>}
          </div>
        </div>
      );
    }
    return (
      <div className="msg live" key={i}>
        {head(i) ? <Face slug={slug} /> : <span className="msg-face" />}
        <div className="msg-col">
          {head(i) && <span className="msg-who">{name}</span>}
          <div className="msg-row">
            <div className={`bubble${live.done ? "" : " writing"}`}>
              <Markdown text={b.text || " "} />
            </div>
          </div>
        </div>
      </div>
    );
  });
  const waiting = !live.done && !blocks.some((b) => b.kind === "text" || b.kind === "tool");
  return (
    <>
      {rows}
      {/* 아직 글이 한 자도 안 왔을 때. 말풍선이 없으면 보낸 말이 허공에 뜬 것처럼 보인다. */}
      {waiting && (
        <div className="msg live">
          {showFace && firstText < 0 ? <Face slug={slug} /> : <span className="msg-face" />}
          <div className="msg-col">
            <div className="bubble typing" aria-label="쓰는 중">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      )}
      {live.error && <div className="note bad">{live.error}</div>}
    </>
  );
}

type Sent = { text: string; mine: number; at: number };

export function Chat({
  root,
  id,
  paneId,
  slug,
  name = "에이전트",
  refreshMs = 2000,
  live = true,
  working = false,
  onShowTerm,
  onReady,
}: ChatProps) {
  const [raw, setRaw] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // 맨 아래를 보고 있었는지. 위로 올려다보는 중이면 따라 내리지 않는다 —
  // 읽던 자리가 튀면 올려다보는 일 자체가 안 된다.
  const atEnd = useRef(true);
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!root || !id) return;
    let alive = true;
    setRaw(null);
    const load = () => {
      invoke<string>("claude_transcript_raw", { root, id })
        .then((t) => {
          if (alive) setRaw(t);
        })
        // 한 번 못 읽었다고 그리던 대화를 비우지 않는다.
        .catch(() => {
          if (alive) setRaw((r) => r ?? "");
        });
    };
    loadRef.current = load;
    load();
    const timer = window.setInterval(load, refreshMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
      loadRef.current = () => {};
    };
  }, [root, id, refreshMs]);

  // 새 대화는 첫 말을 보내기 전까지 파일이 없다. 그동안 claude 가 폴더 신뢰·API 키 같은
  // 대화상자를 띄울 수 있는데 그것들은 TUI 에만 있다. 이 화면이 덮으면 답할 길이 없으므로
  // 파일이 생길 때까지는 부른 쪽이 터미널을 보여주게 알린다.
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => {
    readyRef.current?.(!!raw);
  }, [raw]);

  // ── 쓰이는 중인 답(proxy.rs → chat:live) ──
  const [stream, setStream] = useState<Live | null>(null);
  const streamRef = useRef<Live | null>(null);
  const rawLen = useRef(0);
  rawLen.current = raw?.length ?? 0;
  // 스트림이 끝난 순간의 대화 파일 길이. 파일이 이보다 자라야 쓰이던 말풍선을 걷는다.
  const endLen = useRef<number | null>(null);
  const put = (next: Live | null) => {
    streamRef.current = next;
    setStream(next);
  };

  useEffect(() => {
    if (!id) return;
    put(null);
    endLen.current = null;
    const want = id.toLowerCase();
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<LiveEvent>("chat:live", (e) => {
      const ev = e.payload;
      if (ev.session !== want) return;
      const before = streamRef.current;
      const next = applyLive(before, ev);
      if (ev.phase === "begin") {
        endLen.current = null;
        // 새 요청이 나갔다는 것은 그 앞의 말(내가 보낸 것, 도구 결과)이 이미 파일에 있다는 뜻이다.
        loadRef.current();
      }
      if (next?.done && !before?.done) {
        endLen.current = rawLen.current;
        for (const ms of [150, 600, 1500]) window.setTimeout(() => loadRef.current(), ms);
      }
      put(next);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [id]);

  // 끝난 답은 파일이 따라잡으면 걷는다. 파일이 끝내 안 자라도(오류로 끊긴 답) 오래 남기지 않는다.
  useEffect(() => {
    if (caughtUp(streamRef.current, endLen.current, raw?.length ?? 0)) {
      endLen.current = null;
      put(null);
    }
  }, [raw]);
  useEffect(() => {
    if (!stream?.done) return;
    const t = window.setTimeout(() => {
      if (streamRef.current?.done) put(null);
    }, stream.error ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [stream?.done, stream?.req, stream?.error]);

  const { items, durs, toks } = useMemo(() => {
    if (!raw) return { items: [] as Item[], durs: new Map<string, number>(), toks: new Map<string, number>() };
    const events = parseJsonl(raw);
    return {
      items: toItems(events, buildToolMap(events)),
      durs: turnDurations(events),
      toks: turnTokens(events),
    };
  }, [raw]);

  // ── 보낸 말: 파일에 적히기 전에도 바로 보인다 ──
  const mineTexts = useMemo(
    () => items.filter((b): b is Bubble => b.kind === "bubble" && b.role === "user").map((b) => b.text.trim()),
    [items],
  );
  const [sent, setSent] = useState<Sent[]>([]);
  useEffect(() => {
    setSent((s) => {
      const keep = s.filter(
        (p) => Date.now() - p.at < 30000 && !mineTexts.slice(p.mine).some((t) => t === p.text),
      );
      return keep.length === s.length ? s : keep;
    });
  }, [mineTexts]);
  const onSent = (text: string) => {
    setSent((s) => [...s, { text, mine: mineTexts.length, at: Date.now() }]);
    window.setTimeout(() => loadRef.current(), 400);
  };

  // ── 터미널에서만 답할 수 있는 순간 ──
  // 도구 호출이 결과 없이 멈춰 있는데 claude 가 일하는 중도, 답을 쓰는 중도 아니면
  // 허락을 기다리는 것이다(권한 묻기는 TUI 에만 뜬다). 잠깐 멈춘 것과 가르려고 조금 기다린다.
  const last = items[items.length - 1];
  const pendingTool = last?.kind === "tool" && !last.pair?.toolResult ? last.toolUse.name : null;
  const streaming = !!stream && !stream.done;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    setStuck(false);
    if (!pendingTool || working || streaming) return;
    const t = window.setTimeout(() => setStuck(true), 3000);
    return () => window.clearTimeout(t);
  }, [pendingTool, working, streaming, items.length]);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [items, stream, sent, stuck]);

  const onScroll = () => {
    const el = scroll.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const lastIsAgent = last?.kind === "bubble" && last.role !== "user" && !sent.length;
  const empty = items.length === 0 && !sent.length && !stream;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroll} onScroll={onScroll}>
        {raw === null ? (
          <div className="chat-empty">대화를 여는 중</div>
        ) : empty ? (
          <div className="chat-empty">아직 주고받은 말이 없다</div>
        ) : (
          <>
            {items.map((item, i) => {
              // 같은 쪽 말풍선이 이어지면 얼굴과 이름을 한 번만 그린다. 매번
              // 그리면 한 사람이 여러 번 말한 것처럼 보인다.
              const prev = items[i - 1];
              const next = items[i + 1];
              const isB = item.kind === "bubble";
              const sameAs = (o?: Item) => o?.kind === "bubble" && isB && o.role === (item as Bubble).role;
              const uuid = isB ? (item as Bubble).uuid : undefined;
              return (
                <Row
                  key={i}
                  item={item}
                  slug={slug}
                  name={name}
                  showFace={!sameAs(prev)}
                  grouped={sameAs(next)}
                  durMs={uuid ? durs.get(uuid) : undefined}
                  tokens={uuid ? toks.get(uuid) : undefined}
                  onShowTerm={onShowTerm}
                />
              );
            })}
            {sent.map((p, i) => (
              <div className="msg mine sending" key={`s${i}`}>
                <div className="msg-col">
                  <span className="msg-tag">보내는 중</span>
                  <div className="msg-row">
                    <div className="bubble">
                      <span style={{ whiteSpace: "pre-wrap" }}>{p.text}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {stream && <LiveRows live={stream} slug={slug} name={name} showFace={!lastIsAgent} />}
            {stuck && !stream && (
              <div className="ask">
                <div className="ask-title">터미널에서 기다리는 것이 있다</div>
                <div className="q">claude 가 {shortToolName(pendingTool ?? undefined)} 실행 허락을 기다리는 것 같다.</div>
                <button className="ask-go" onClick={onShowTerm}>
                  터미널 보기
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {paneId && (
        <Composer
          paneId={paneId}
          live={live}
          busy={working || streaming}
          onSent={onSent}
          onShowTerm={onShowTerm}
        />
      )}
    </div>
  );
}

/** 칸 위에 대화창을 덮는다.
 *
 *  터미널을 걷어 내지 않고 그 위에 얹는다. 떼어 내면 PTY 가 죽고(결정 1번),
 *  숨기면 xterm 이 자기 칸 수를 잃는다(결정 2번). 그래서 터미널은 제 크기
 *  그대로 아래에 두고, 머리줄 아래부터를 이 화면이 덮는다. 머리줄 높이는
 *  작업 중 띠가 붙었다 떨어지며 바뀌므로 재서 따라간다. */
export function ChatPane({ shown = true, ...props }: ChatProps & { shown?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // 재기 전의 0 은 화면에 나가지 않는다 — layout effect 가 그리기 전에 고쳐 놓는다.
  // 그 사이를 visibility 로 숨기면 안 된다. 바로 그때 App 이 입력바에 포커스를 주는데
  // 숨은 요소는 포커스를 못 받아 키가 아래 터미널로 샌다.
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const pane = box.current?.parentElement;
    if (!pane) return;
    const body = pane.querySelector<HTMLElement>(":scope > .pane-body");
    const place = () => setTop(body ? body.offsetTop : 0);
    place();
    const ro = new ResizeObserver(place);
    ro.observe(pane);
    if (body) ro.observe(body);
    return () => ro.disconnect();
  }, []);
  return (
    // 보이지 않을 때도 걷지 않고 올려 둔다. 대화 파일을 계속 읽어야 첫 말이 적히는 순간을 안다.
    <div ref={box} className="chat-over" style={shown ? { top } : { top, visibility: "hidden", pointerEvents: "none" }}>
      <Chat {...props} />
    </div>
  );
}
