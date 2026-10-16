/** 대화창의 입력바. 터미널 칸 위 덮개에서는 칸의 PTY 로, 터미널 없는 칸에서는 통로(`Transport`)로 보낸다. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { choose, complete, paletteView, type PaletteAction, type PaletteCommand, type PaletteView } from "./palette";

export type Transport = { send: (text: string) => Promise<void>; interrupt: () => void; isCommand?: (text: string) => boolean };

type ChatWin = { __chats?: Record<string, HTMLTextAreaElement | null> };

/** 보내고 나서 머물러도 되는 슬래시 명령. 나머지(`/model`, `/resume`, `/config` …)는
 *  고르는 메뉴를 TUI 에 띄우는데 그 메뉴는 대화창에 없다. 보내고 곧바로 터미널을 보여준다. */
const STAY_IN_CHAT = new Set(["/clear", "/compact", "/cost", "/context", "/usage", "/exit", "/quit", "/rename"]);

/** 입력바. 평범한 textarea 라 한글 조합은 브라우저가 그대로 처리한다 —
 *  xterm 에서 조합을 직접 떠받치던 일(결정 4번)이 여기서는 없다. */
export function Composer({
  paneId,
  live,
  busy,
  onSent,
  onShowTerm,
  beforeMenu,
  agent,
  waiting,
  transport,
  commands,
}: {
  paneId: string;
  live: boolean;
  busy: boolean;
  onSent: (text: string) => () => void;
  onShowTerm?: (auto?: boolean) => void;
  /** 메뉴 명령을 보내기 직전에 부른다. 끝났는지 잴 기준을 잡는다. */
  beforeMenu?: () => Promise<void>;
  agent: "claude" | "codex";
  waiting: boolean;
  transport?: Transport;
  /** `/` 를 치면 띄울 명령. 없으면 고르기 목록을 띄우지 않는다. */
  commands?: PaletteCommand[];
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pick, setPick] = useState(0);
  // Esc 로 닫은 그때의 글. 글이 바뀌면 다시 뜬다 — 닫은 채로 박히면 다음 명령도 못 고른다.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const view = commands && live && !waiting && dismissed !== text ? paletteView(text, commands) : null;
  const at = view ? Math.min(pick, view.items.length - 1) : 0;
  useEffect(() => setPick(0), [text]);

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

  const interrupt = transport
    ? transport.interrupt
    : () => void invoke("pty_write", { id: paneId, data: "\x1b" }).catch(() => {});

  const send = (raw = text) => {
    const t = raw.trim();
    if (!t || !live || waiting) return;
    setText("");
    if (transport) {
      // 로컬 메뉴 명령은 모델에 보낸 말풍선으로 남기지 않는다.
      const undo = transport.isCommand?.(t) ? () => {} : onSent(t);
      transport.send(t).catch(() => {
        undo();
        setText((current) => (current ? `${t}\n${current}` : t));
      });
      return;
    }
    const menu = /^\/[\w-]+$/.test(t) && !STAY_IN_CHAT.has(t);
    // 명령은 대화 파일에 내 말이 아니라 명령 줄로 적힌다. "보내는 중" 말풍선을 띄우면 짝이 안 맞아 30초를 남는다.
    const undo = /^\/[\w-]+/.test(t) ? () => {} : onSent(t);
    void (menu && beforeMenu ? beforeMenu() : Promise.resolve())
      .then(() => invoke("pty_submit", { id: paneId, text: t, agent }))
      .then(() => {
        // 메뉴가 닫히면 대화창으로 돌아온다. 닫힌 것은 대화 파일이 알려 준다.
        if (menu) onShowTerm?.(true);
      })
      // 못 보냈으면 쓴 말을 되살린다. 사라지면 다시 칠 방법이 없다.
      .catch(() => {
        undo();
        setText(current => current ? `${t}\n${current}` : t);
      });
  };

  const act = (a: PaletteAction) => {
    if (a.kind === "fill") return setText(a.text);
    if (a.kind === "send") return send(a.text);
    setText("");
    a.run();
  };

  return (
    <div className="composer">
      {view && <Palette view={view} at={at} onHover={setPick} onPick={(i) => act(choose(view, i))} />}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={!live || waiting}
        placeholder={waiting ? transport ? "위의 승인·질문 카드에 답해 줘" : "터미널에서 실행 허락을 확인해 줘" : live ? `보낼 말 · Enter 보내기 · Shift+Enter 줄바꿈${commands ? " · / 명령" : ""} · 빈 칸에서 Esc 는 중단` : `${agent} 가 떠 있지 않다`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 조합 중인 Enter 는 글자를 확정하는 키지 보내는 키가 아니다.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (view) {
            const n = view.items.length;
            const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
            if (move) {
              e.preventDefault();
              return setPick((at + move + n) % n);
            }
            if (e.key === "Tab") {
              e.preventDefault();
              return setText(complete(view, at));
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              return act(choose(view, at));
            }
            if (e.key === "Escape") {
              // 목록만 닫고 쓰던 글은 둔다. 목록에 없는 명령을 그대로 보내고 싶을 때다.
              e.preventDefault();
              return setDismissed(text);
            }
          }
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
      {!transport && (
        <button className="composer-term" onMouseDown={(e) => e.preventDefault()} onClick={() => onShowTerm?.(false)} title="터미널 보기">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.2 4.4 L6.6 8 L3.2 11.6 M8.4 11.8 H12.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** 입력바 위에 뜨는 명령 목록. 누르는 동안 입력바가 포커스를 잃으면 한글 조합과 Enter 가 엉키므로 막는다. */
function Palette({ view, at, onHover, onPick }: { view: PaletteView; at: number; onHover: (i: number) => void; onPick: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.children[at + (view.stage === "choices" ? 1 : 0)]?.scrollIntoView({ block: "nearest" });
  }, [at, view.stage]);
  return (
    <div className="palette" role="listbox" aria-label="명령" ref={list} onMouseDown={(e) => e.preventDefault()}>
      {view.stage === "choices" && (
        <div className="palette-head">
          /{view.command.name}
          {view.command.hint ? ` · ${view.command.hint}` : ""}
        </div>
      )}
      {view.stage === "commands"
        ? view.items.map((c, i) => (
            <div key={`${c.name}:${i}`} role="option" aria-selected={i === at} className={i === at ? "palette-row on" : "palette-row"} onMouseEnter={() => onHover(i)} onClick={() => onPick(i)}>
              <span className="palette-name">/{c.name}</span>
              {c.args ? <span className="palette-args">{c.args}</span> : null}
              <span className="palette-hint" title={c.hint}>{c.hint}</span>
              {c.terminal ? <span className="palette-tag">터미널</span> : null}
            </div>
          ))
        : view.items.map((c, i) => (
            <div key={`${c.value}:${i}`} role="option" aria-selected={i === at} className={i === at ? "palette-row pick on" : "palette-row pick"} onMouseEnter={() => onHover(i)} onClick={() => onPick(i)}>
              <span className="palette-name">{c.label}</span>
              {c.current ? <span className="palette-tag">지금</span> : null}
              <span className="palette-hint" title={c.hint}>{c.hint}</span>
            </div>
          ))}
    </div>
  );
}
