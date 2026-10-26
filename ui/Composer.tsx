/** 대화창의 입력바. 쓴 말은 칸이 준 통로(`Transport`)로 보낸다. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { choose, complete, paletteView, type PaletteAction, type PaletteChoice, type PaletteCommand, type PaletteView } from "./palette";

export type Transport = { send: (text: string) => Promise<void>; interrupt: () => void; isCommand?: (text: string) => boolean };

type ChatWin = { __chats?: Record<string, HTMLTextAreaElement | null> };

/** 입력바. 평범한 textarea 라 한글 조합은 브라우저가 그대로 처리한다 —
 *  xterm 에서 조합을 직접 떠받치던 일(결정 4번)이 여기서는 없다. */
export function Composer({
  paneId,
  live,
  busy,
  onSent,
  agent,
  waiting,
  transport,
  commands,
}: {
  paneId: string;
  live: boolean;
  busy: boolean;
  onSent: (text: string) => () => void;
  agent: "claude" | "codex";
  waiting: boolean;
  transport: Transport;
  /** `/` 를 치면 띄울 명령. 없으면 고르기 목록을 띄우지 않는다. */
  commands?: PaletteCommand[];
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pick, setPick] = useState(0);
  // Esc 로 닫은 그때의 글. 글이 바뀌면 다시 뜬다 — 닫은 채로 박히면 다음 명령도 못 고른다.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // 고르는 순간 불러온 목록(`load`). 명령을 쓰는 동안만 들고 있다 — 다음에 열 때는 새로 불러와야 방금 생긴 대화도 보인다.
  const [loaded, setLoaded] = useState<Record<string, PaletteChoice[]>>({});
  // 못 불러온 까닭. 빈 목록과 섞으면 "지난 대화가 없다"로 보여 엉뚱한 데를 찾게 된다(Codex 중계가 목록 요청을 막았을 때 그랬다).
  const [loadError, setLoadError] = useState<Record<string, string>>({});
  const merged = commands?.map((c) => (c.load && loaded[c.name] ? { ...c, choices: loaded[c.name] } : c));
  const view = merged && live && !waiting && dismissed !== text ? paletteView(text, merged) : null;
  const at = view ? Math.max(0, Math.min(pick, view.items.length - 1)) : 0;
  useEffect(() => setPick(0), [text]);
  const loading = view?.stage === "choices" && view.command.load && !loaded[view.command.name] ? view.command : null;
  useEffect(() => {
    if (!loading?.load) return;
    let alive = true;
    const name = loading.name;
    loading.load().then(
      (items) => alive && setLoaded((l) => ({ ...l, [name]: items })),
      (e) => {
        if (!alive) return;
        setLoadError((m) => ({ ...m, [name]: String(e instanceof Error ? e.message : e) }));
        setLoaded((l) => ({ ...l, [name]: [] }));
      },
    );
    return () => {
      alive = false;
    };
    // 명령이 바뀔 때만 다시 부른다. 거르려고 글자를 칠 때마다 부르면 같은 목록을 계속 다시 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading?.name]);
  useEffect(() => {
    if (text.startsWith("/") || !Object.keys(loaded).length) return;
    setLoaded({});
    setLoadError({});
  }, [text, loaded]);

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

  const interrupt = transport.interrupt;

  const send = (raw = text) => {
    const t = raw.trim();
    if (!t || !live || waiting) return;
    setText("");
    // 명령은 대화 파일에 내 말이 아니라 명령 줄로 적힌다. "보내는 중" 말풍선을 띄우면 짝이 안 맞아 오래 남는다.
    const undo = transport.isCommand?.(t) ? () => {} : onSent(t);
    // 못 보냈으면 쓴 말을 되살린다. 사라지면 다시 칠 방법이 없다.
    transport.send(t).catch(() => {
      undo();
      setText((current) => (current ? `${t}\n${current}` : t));
    });
  };

  const act = (a: PaletteAction | null) => {
    if (!a) return;
    if (a.kind === "fill") return setText(a.text);
    if (a.kind === "send") return send(a.text);
    setText("");
    a.run();
  };

  return (
    <div className="composer">
      {view && (
        <Palette
          view={view.stage === "choices" && loadError[view.command.name] ? { ...view, note: `목록을 못 불러왔다 — ${loadError[view.command.name]}` } : view}
          at={at}
          onHover={setPick}
          onPick={(i) => act(choose(view, i))}
        />
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={!live || waiting}
        placeholder={waiting ? "위의 승인·질문 카드에 답해 줘" : live ? `보낼 말 · Enter 보내기 · Shift+Enter 줄바꿈${commands ? " · / 명령" : ""} · 빈 칸에서 Esc 는 중단` : `${agent} 가 떠 있지 않다`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 조합 중인 Enter 는 글자를 확정하는 키지 보내는 키가 아니다.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (view) {
            const n = view.items.length;
            const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
            if (move) {
              e.preventDefault();
              return n && setPick((at + move + n) % n);
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
            </div>
          ))
        : view.items.map((c, i) => (
            <div key={`${c.value}:${i}`} role="option" aria-selected={i === at} className={i === at ? "palette-row pick on" : "palette-row pick"} onMouseEnter={() => onHover(i)} onClick={() => onPick(i)}>
              <span className="palette-name">{c.label}</span>
              {c.current ? <span className="palette-tag">지금</span> : null}
              <span className="palette-hint" title={c.hint}>{c.hint}</span>
            </div>
          ))}
      {view.stage === "choices" && view.note ? <div className="palette-note">{view.note}</div> : null}
    </div>
  );
}
