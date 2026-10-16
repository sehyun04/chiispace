/** 대화창 — 터미널 없는 칸(ClaudeStreamPane·CodexStreamPane)의 말풍선과 입력바.
 *
 *  화면을 뜯지 않는다. Claude 는 `~/.claude/projects/<폴더>/<대화 id>.jsonl` 의 원문을
 *  그대로 받아 말풍선으로 편다 — 메시지 경계가 처음부터 데이터로 와 있으므로
 *  글자 모양에 기대어 경계를 찾던 일(`tailBlock`)이 여기서는 없다. Codex 는 서버가 준 항목을 그대로 받는다.
 *  입력바에 쓴 말은 칸이 준 통로(`transport`)로 간다.
 *
 *  10월 17일까지는 터미널 칸 위에도 이 화면을 덮어(덮개) 입력을 PTY 로 보냈다. 대화로 보는 길이 둘이면 기능 차이가
 *  계속 나서 걷었다 — 같은 대화를 머리줄의 [터미널][대화창]으로 옮긴다.
 *
 *  어느 대화를 그릴지는 부른 쪽이 준 id 다. 이 화면은 대화를 고르지 않는다. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  parseJsonl,
  buildToolMap,
  toItems,
  turnDurations,
  turnTokens,
  type Item,
  type Bubble,
} from "./transcript";
import { applyLive, caughtUp, type Live, type LiveEvent } from "./live";
import { SubAgents } from "./SubAgents";
import { OpenSubContext, SubagentView, type SubTarget } from "./SubagentView";
import { LiveRows, Row } from "./ChatRows";
import { Composer, type Transport } from "./Composer";
import type { PaletteCommand } from "./palette";
import "./chat.css";

export type { Transport };

type ChatProps = {
  agent?: "claude" | "codex";
  waiting?: boolean;
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
  /** 일하는 중인가. */
  working?: boolean;
  /** 입력바에 쓴 말을 보낼 길. */
  transport: Transport;
  /** 대화 끝에 붙는 것 — 통로로 온 권한 묻기·질문 카드. */
  extra?: ReactNode;
  /** 입력바 위에 붙는 것 — 모델·권한 모드. */
  toolbar?: ReactNode;
  /** 입력바에서 `/` 를 치면 띄울 명령. */
  commands?: PaletteCommand[];
  /** 아직 한 마디도 없는 새 대화. */
  fresh?: boolean;
  /** app-server는 파일을 거치지 않고 이력과 현재 메시지를 같은 항목으로 준다. */
  content?: Item[];
};

type Sent = { text: string; mine: number; at: number };

export function Chat({
  agent = "claude",
  waiting = false,
  root,
  id,
  paneId,
  slug,
  name = "에이전트",
  refreshMs = 1000,
  live = true,
  working = false,
  transport,
  extra,
  toolbar,
  commands,
  fresh = false,
  content,
}: ChatProps) {
  const direct = content !== undefined;
  const transcriptArgs = () => ({ root, id });
  const [raw, setRaw] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // 맨 아래를 보고 있었는지. 위로 올려다보는 중이면 따라 내리지 않는다 —
  // 읽던 자리가 튀면 올려다보는 일 자체가 안 된다.
  const atEnd = useRef(true);
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (direct) return;
    if ((!root && agent === "claude") || !id) return;
    let alive = true;
    setRaw(null);
    const load = () => {
      invoke<string>("claude_transcript_raw", transcriptArgs())
        .then((t) => {
          if (alive) setRaw(t);
        })
        // 한 번 못 읽었다고 그리던 대화를 비우지 않는다.
        .catch(() => {
          if (alive) setRaw((r) => r ?? "");
        });
    };
    // 원문은 크기가 바뀔 때만 다시 받는다. 긴 대화는 수 MB 라 매번 통째로 넘기면 칸이
    // 여럿일 때 앱이 무거워진다.
    let size = -1;
    const tick = () => {
      invoke<number>("claude_transcript_size", transcriptArgs())
        .then((n) => {
          if (!alive) return;
          if (n !== size) {
            size = n;
            load();
          }
        })
        .catch(() => {});
    };
    loadRef.current = load;
    tick();
    const timer = window.setInterval(tick, refreshMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
      loadRef.current = () => {};
    };
  }, [root, id, refreshMs, direct]);

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
    if (!id || agent !== "claude") return;
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
  }, [id, agent]);

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
    if (content !== undefined) return { items: content, durs: new Map<string, number>(), toks: new Map<string, number>() };
    if (!raw) return { items: [] as Item[], durs: new Map<string, number>(), toks: new Map<string, number>() };
    const events = parseJsonl(raw);
    return {
      items: toItems(events, buildToolMap(events)),
      durs: turnDurations(events),
      toks: turnTokens(events),
    };
  }, [raw, agent, content]);

  // ── 보낸 말: 파일에 적히기 전에도 바로 보인다 ──
  const mineTexts = useMemo(
    () => items.filter((b): b is Bubble => b.kind === "bubble" && b.role === "user").map((b) => b.text.trim()),
    [items],
  );
  const [sent, setSent] = useState<Sent[]>([]);
  useEffect(() => { setSent([]); }, [id]);
  useEffect(() => {
    setSent((s) => {
      const keep = s.filter(
        (p) => Date.now() - p.at < 30000 && !mineTexts.slice(p.mine).some((t) => t === p.text),
      );
      return keep.length === s.length ? s : keep;
    });
  }, [mineTexts]);
  const onSent = (text: string) => {
    const pending = { text, mine: mineTexts.length, at: Date.now() };
    setSent((s) => [...s, pending]);
    window.setTimeout(() => loadRef.current(), 400);
    return () => setSent(s => s.filter(p => p !== pending));
  };

  const last = items[items.length - 1];
  const streaming = !!stream && !stream.done;

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [items, stream, sent, extra]);

  const onScroll = () => {
    const el = scroll.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const lastIsAgent = last?.kind === "bubble" && last.role !== "user" && !sent.length;
  const empty = items.length === 0 && !sent.length && !stream;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroll} onScroll={onScroll}>
        {raw === null && !fresh && !direct ? (
          <div className="chat-empty">대화를 여는 중</div>
        ) : empty ? (
          <div className="chat-empty">{fresh ? "새 대화 · 하고 싶은 말을 보내 봐" : "아직 주고받은 말이 없다"}</div>
        ) : (
          <>
            {items.map((item, i) => {
              // 답을 기다리는 질문은 통로가 카드로 준다. 대화 파일 쪽의 질문은 이미 지난 것이다.
              if (item.kind === "ask") return null;
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
            {agent === "claude" && <SubAgents session={id} />}
            {agent === "codex" && working && !waiting && <div className="note" role="status">Codex 작업 중</div>}
          </>
        )}
        {extra}
      </div>
      {toolbar}
      {paneId && (
        <Composer
          paneId={paneId}
          agent={agent}
          waiting={waiting}
          live={live}
          busy={working || streaming}
          onSent={onSent}
          transport={transport}
          commands={commands}
        />
      )}
    </div>
  );
}

/** 칸의 몸통 자리(`.pane-body`)에 대화창을 세운다. 머리줄 높이는 작업 중 띠가 붙었다 떨어지며 바뀌므로 재서 따라간다. */
export function ChatPane(props: ChatProps) {
  const box = useRef<HTMLDivElement>(null);
  // 열어 본 서브에이전트 대화. 칸의 대화가 바뀌면(/clear 등) 닫는다 — 다른 대화의 서브에이전트다.
  const [openSub, setOpenSub] = useState<SubTarget | null>(null);
  useEffect(() => {
    setOpenSub(null);
  }, [props.id]);
  // 재기 전의 0 은 화면에 나가지 않는다 — layout effect 가 그리기 전에 고쳐 놓는다.
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
    <div ref={box} className="chat-over" style={{ top }}>
      <OpenSubContext.Provider value={setOpenSub}>
        <Chat {...props} />
        {openSub && (
          <SubagentView
            root={props.root}
            session={props.id}
            target={openSub}
            onClose={() => setOpenSub(null)}
            renderRow={(item, o) => (
              <Row key={o.key} item={item} slug={props.slug} name={o.name} showFace={o.showFace} grouped={o.grouped} />
            )}
          />
        )}
      </OpenSubContext.Provider>
    </div>
  );
}
