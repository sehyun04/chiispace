import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import roster from "./roster.json";
import { Term } from "./Term";
import * as L from "./layout";

type Member = { name: string; slug: string; school: string; header_color: string };

const leader = roster.leader as Member;
const members = roster.members as Member[];

const pct = (r: L.Rect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

export default function App() {
  const [layout, setLayout] = useState<L.Node | null>(() => L.leaf("%0"));
  const [focus, setFocus] = useState("%0");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const nextId = useRef(1);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ path: number[]; dir: L.Dir; parent: L.Rect } | null>(null);

  const onTitle = useCallback((id: string, title: string) => {
    setTitles((t) => (t[id] === title ? t : { ...t, [id]: title }));
  }, []);

  const split = useCallback(
    (dir: L.Dir) => {
      const id = `%${nextId.current++}`;
      setLayout((cur) => (cur ? L.splitLeaf(cur, focus, dir, id) : L.leaf(id)));
      setFocus(id);
    },
    [focus],
  );

  const close = useCallback((id: string) => {
    setLayout((cur) => (cur ? L.removeLeaf(cur, id) : cur));
  }, []);

  // 셸이 끝나면 그 pane 은 사라진다 — 터미널에서 exit 을 친 사람이 기대하는 동작.
  useEffect(() => {
    const un = listen<string>("pty:exit", (ev) => {
      setLayout((cur) => (cur ? L.removeLeaf(cur, ev.payload) : cur));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 포커스가 있던 pane 이 사라졌으면 아무 데나가 아니라 남은 첫 pane 으로.
  useEffect(() => {
    if (!layout) return;
    const ids = L.leaves(layout);
    if (!ids.includes(focus)) setFocus(ids[0]);
  }, [layout, focus]);

  // 캡처 단계로 잡아야 한다. xterm 은 숨은 textarea 에서 키를 받으므로
  // 버블 단계에서는 이미 셸로 흘러간 뒤다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || !layout) return;
      const k = e.key.toLowerCase();
      const dirs: Record<string, "left" | "right" | "up" | "down"> = {
        arrowleft: "left",
        arrowright: "right",
        arrowup: "up",
        arrowdown: "down",
      };
      let handled = true;
      if (k === "d") split("h");
      else if (k === "e") split("v");
      else if (k === "w") close(focus);
      else if (dirs[k]) {
        const next = L.neighbor(layout, focus, dirs[k]);
        if (next) setFocus(next);
      } else handled = false;

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [layout, focus, split, close]);

  // 경계선 드래그. 무대 전체를 기준으로 비율을 다시 계산한다.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      const box = stage.current?.getBoundingClientRect();
      if (!d || !box) return;
      const f =
        d.dir === "h"
          ? ((e.clientX - box.left) / box.width - d.parent.x) / d.parent.w
          : ((e.clientY - box.top) / box.height - d.parent.y) / d.parent.h;
      setLayout((cur) => (cur ? L.setRatio(cur, d.path, f) : cur));
    };
    const up = () => {
      if (drag.current) document.body.classList.remove("dragging");
      drag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const slots = layout ? L.rects(layout) : [];
  const seams = layout ? L.seams(layout) : [];

  return (
    <div className="app">
      <aside className="side">
        <div className="side-head">
          <span>kasaspace</span>
          <span className="cheeks">
            <i />
            <i />
          </span>
        </div>

        <div className="side-section">폴더</div>
        <div className="tree">
          <div className="empty">
            아직 연 폴더가 없어
            <br />
            (파일트리는 다음 차례)
          </div>
        </div>

        <div className="side-section">
          {roster.label} · {roster.user_title}
        </div>
        <div className="roster">
          <Row m={leader} lead />
          {members.map((m) => (
            <Row key={m.slug} m={m} />
          ))}
        </div>

        <div className="keys">
          <b>Ctrl+Shift+D</b> 좌우 분할
          <br />
          <b>Ctrl+Shift+E</b> 상하 분할
          <br />
          <b>Ctrl+Shift+W</b> pane 닫기
          <br />
          <b>Ctrl+Shift+←↑↓→</b> 이동
        </div>
      </aside>

      <main className="stage" ref={stage}>
        {slots.map((s) => (
          <div key={s.id} className="slot" style={pct(s.rect)}>
            <section
              className={focus === s.id ? "pane on" : "pane"}
              onMouseDown={() => setFocus(s.id)}
            >
              <header className="pane-head">
                <span className="pip" />
                <span className="title">{titles[s.id] ?? "shell"}</span>
                <button className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => close(s.id)}>
                  ×
                </button>
              </header>
              <Term id={s.id} focused={focus === s.id} onTitle={onTitle} />
            </section>
          </div>
        ))}

        {seams.map((sm) => (
          <div
            key={sm.path.join("-") || "root"}
            className={sm.dir === "h" ? "seam vert" : "seam horz"}
            style={pct(sm.rect)}
            onMouseDown={(e) => {
              e.preventDefault();
              document.body.classList.add("dragging");
              drag.current = { path: sm.path, dir: sm.dir, parent: sm.parent };
            }}
          />
        ))}

        {!layout && (
          <div className="stage-empty">
            <p>셸이 다 닫혔어</p>
            <button
              onClick={() => {
                const id = `%${nextId.current++}`;
                setLayout(L.leaf(id));
                setFocus(id);
              }}
            >
              새 셸 열기
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function Row({ m, lead }: { m: Member; lead?: boolean }) {
  return (
    <div className={lead ? "member lead" : "member"}>
      <span className="pip" style={{ background: m.header_color }} />
      <span className="who">{m.name}</span>
      <span className="school">{m.school}</span>
    </div>
  );
}
