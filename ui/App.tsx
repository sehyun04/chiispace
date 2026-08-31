import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import roster from "./roster.json";
import { Term } from "./Term";
import { Tree, EMPTY_GIT, type GitInfo } from "./Tree";
import * as L from "./layout";

type Member = { name: string; slug: string; school: string; header_color: string };

type PaneStat = {
  id: string;
  proc: string | null;
  agent: string | null;
  busy: boolean;
  cwd: string | null;
};

/** 탭 하나 = 작업 하나. 자기 배치와 자기 폴더를 갖는다. */
type Tab = { key: string; layout: L.Node | null; root: string | null; focus: string };

/** 지금 포커스된 터미널. Term 이 포커스를 받을 때 window 에 올려 둔다. */
type XTerm = { getSelection(): string; paste(t: string): void; focus(): void };
const termOf = (): XTerm | undefined => (window as unknown as { __term?: XTerm }).__term;

/** 셸 자신은 "돌리던 명령"이 아니다. 이 이름들이 전경에 있으면 그냥 빈 프롬프트다. */
const SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "fish"]);

const leader = roster.leader as Member;
const members = roster.members as Member[];

const pct = (r: L.Rect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([
    { key: "t0", layout: L.leaf("%0"), root: null, focus: "%0" },
  ]);
  const [active, setActive] = useState(0);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [git, setGit] = useState<GitInfo>(EMPTY_GIT);
  const [fontSize, setFontSize] = useState(13);
  const [stat, setStat] = useState<Record<string, PaneStat>>({});
  // 첫 pane 은 열 폴더가 정해진 뒤에 띄운다. 먼저 띄우면 셸이 홈에서 시작해
  // 버리고, 이미 뜬 셸의 cwd 는 뒤늦게 바꿔 줄 수 없다.
  const [booted, setBooted] = useState(false);
  // 복원된 pane 이 앱을 끄기 전 돌리던 명령. 되살릴 수 있는 것은 여기까지다 —
  // 프로세스 자체는 앱과 함께 죽었고, 죽은 셸을 흉내 낸 화면을 복원하면
  // 사용자가 그게 살아 있다고 믿는다.
  const [seeds, setSeeds] = useState<Record<string, string>>({});
  const nextPane = useRef(1);
  const nextTab = useRef(1);
  const drag = useRef<{ path: number[]; dir: L.Dir; parent: L.Rect; box: HTMLElement } | null>(
    null,
  );
  // pane 을 헤더째 끌어 옮기는 중. 어디에 놓일지는 렌더에도 필요해 state 로
  // 두고, mouseup 핸들러가 닫힌 값을 보지 않도록 ref 에도 같이 들고 있는다.
  const paneDrag = useRef<{ from: string; box: HTMLElement } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; side: L.Side } | null>(null);
  const dropRef = useRef<{ id: string; side: L.Side } | null>(null);

  const cur = tabs[active] ?? tabs[0];
  const patch = useCallback(
    (fn: (t: Tab) => Tab) => setTabs((ts) => ts.map((t, i) => (i === active ? fn(t) : t))),
    [active],
  );

  const onTitle = useCallback((id: string, title: string) => {
    setTitles((t) => (t[id] === title ? t : { ...t, [id]: title }));
  }, []);

  const split = useCallback(
    (dir: L.Dir) => {
      const id = `%${nextPane.current++}`;
      patch((t) => ({
        ...t,
        layout: t.layout ? L.splitLeaf(t.layout, t.focus, dir, id) : L.leaf(id),
        focus: id,
      }));
    },
    [patch],
  );

  const closePane = useCallback(
    (id: string) => {
      setTabs((ts) => ts.map((t) => (t.layout ? { ...t, layout: L.removeLeaf(t.layout, id) } : t)));
    },
    [],
  );

  const newTab = useCallback(() => {
    const id = `%${nextPane.current++}`;
    const root = cur?.root ?? null;
    setTabs((ts) => {
      setActive(ts.length);
      return [...ts, { key: `t${nextTab.current++}`, layout: L.leaf(id), root, focus: id }];
    });
  }, [cur]);

  const closeTab = useCallback((i: number) => {
    setTabs((ts) => (ts.length <= 1 ? ts : ts.filter((_, k) => k !== i)));
    setActive((a) => (a >= i && a > 0 ? a - 1 : a));
  }, []);

  // 파일을 클릭하면 그 경로를 지금 보고 있는 셸에 넣는다. 여는 게 아니라 넣는
  // 이유: 여기서 열 앱을 우리가 고르면 .tsx 가 메모장으로 뜬다. 경로만 들어오면
  // 앞에 vim 이든 code 든 사용자가 이미 치고 있던 것을 그대로 쓴다.
  const insertPath = useCallback(
    (p: string) => {
      // 셸이 지금 서 있는 곳 아래라면 상대 경로가 짧고 읽힌다. cwd 는 엔진이
      // 알려주는 값이라 사용자가 cd 로 옮겨 다녀도 따라간다.
      //
      // cmd.exe 는 cwd 를 보고하지 않아 그 값이 비는 때가 많다. 그때는 셸을
      // 띄운 폴더로 친다 — cd 를 했다면 어긋나지만, 매번 절대 경로가 통째로
      // 들어오는 것보다 낫다. 틀리면 셸이 바로 없다고 말해 준다.
      const cwd = stat[cur.focus]?.cwd ?? cur.root;
      const rel = cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
      // 구분자는 슬래시로 둔다 — cmd·PowerShell·bash 가 다 받는다. 백슬래시는
      // bash 에서 이스케이프가 되어 경로가 깨진다.
      const t = termOf();
      if (!t) return;
      t.paste(/\s/.test(rel) ? `"${rel}"` : rel);
      t.focus();
    },
    [stat, cur],
  );

  const pick = useCallback(async () => {
    const picked = await invoke<string | null>("fs_pick");
    if (picked) patch((t) => ({ ...t, root: picked }));
  }, [patch]);

  // 부팅. 저장된 세션을 되살리되, 명령줄로 폴더를 지정했으면 그쪽이 이긴다 —
  // 사용자가 방금 말한 것이 지난번 기억보다 우선이다.
  useEffect(() => {
    (async () => {
      const cli = await invoke<string | null>("initial_root").catch(() => null);
      const saved = await invoke<string | null>("state_load").catch(() => null);
      if (saved) {
        try {
          const s = JSON.parse(saved) as {
            tabs?: Tab[];
            active?: number;
            nextPane?: number;
            nextTab?: number;
            fontSize?: number;
            procs?: Record<string, string>;
          };
          if (s.fontSize) setFontSize(s.fontSize);
          if (s.procs) setSeeds(s.procs);
          // 복원한 pane 이름과 새로 만들 이름이 겹치면 두 pane 이 같은 PTY 를 본다.
          if (typeof s.nextPane === "number") nextPane.current = s.nextPane;
          if (typeof s.nextTab === "number") nextTab.current = s.nextTab;
          if (s.tabs?.length) {
            setTabs(s.tabs);
            setActive(Math.min(s.active ?? 0, s.tabs.length - 1));
          }
        } catch {
          /* 깨진 세션 파일은 무시하고 기본값으로 시작한다 */
        }
      }
      if (cli) {
        setTabs((ts) => ts.map((t, i) => (i === 0 ? { ...t, root: cli } : t)));
        setActive(0);
      }
      setBooted(true);
    })();
  }, []);

  // 배치가 바뀔 때마다 저장. 경계선을 끄는 동안 초당 수십 번 바뀌므로 묶어서 쓴다.
  useEffect(() => {
    if (!booted) return;
    const h = setTimeout(() => {
      const procs: Record<string, string> = {};
      for (const [id, p] of Object.entries(stat)) {
        if (p.proc && !SHELLS.has(p.proc.toLowerCase())) procs[id] = p.proc;
      }
      const json = JSON.stringify({
        tabs,
        active,
        nextPane: nextPane.current,
        nextTab: nextTab.current,
        fontSize,
        procs,
      });
      invoke("state_save", { json }).catch(() => {});
    }, 400);
    return () => clearTimeout(h);
    // stat 은 800ms 마다 새로 오지만 여기 쓰이는 것은 이름뿐이라 저장이
    // 그 주기로 덩달아 돌지는 않는다 — 디바운스가 묶어 준다.
  }, [tabs, active, fontSize, booted, stat]);

  // git 은 지금 보고 있는 탭의 폴더에 대해서만 묻는다. 안 보이는 탭까지 4초마다
  // git 을 돌리면 탭이 늘수록 그대로 비용이 는다.
  const curRoot = cur?.root ?? null;
  useEffect(() => {
    if (!curRoot) {
      setGit(EMPTY_GIT);
      return;
    }
    let alive = true;
    const tick = () => {
      invoke<GitInfo>("git_status", { root: curRoot })
        .then((g) => alive && setGit(g))
        .catch(() => {});
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [curRoot]);

  // pane 이 무엇을 돌리는지는 프로세스 트리를 봐야 알 수 있고, 그건 이벤트로
  // 오지 않는다. 엔진이 ps 호출을 500ms 로 캐시하므로 이보다 촘촘할 이유가 없다.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      invoke<PaneStat[]>("pane_status")
        .then((list) => {
          if (!alive) return;
          const m: Record<string, PaneStat> = {};
          for (const p of list) m[p.id] = p;
          setStat(m);
        })
        .catch(() => {});
    };
    tick();
    const h = setInterval(tick, 800);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  // 셸이 끝나면 그 pane 은 사라진다 — 터미널에서 exit 을 친 사람이 기대하는
  // 동작이다. 어느 탭에 있든 지워야 한다.
  useEffect(() => {
    const un = listen<string>("pty:exit", (ev) => {
      setTabs((ts) =>
        ts.map((t) => (t.layout ? { ...t, layout: L.removeLeaf(t.layout, ev.payload) } : t)),
      );
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 포커스가 있던 pane 이 사라졌으면 아무 데나가 아니라 남은 첫 pane 으로.
  useEffect(() => {
    setTabs((ts) => {
      let moved = false;
      const next = ts.map((t) => {
        if (!t.layout) return t;
        const ids = L.leaves(t.layout);
        if (ids.includes(t.focus)) return t;
        moved = true;
        return { ...t, focus: ids[0] };
      });
      return moved ? next : ts;
    });
  }, [tabs]);

  // 캡처 단계로 잡아야 한다. xterm 은 숨은 textarea 에서 키를 받으므로
  // 버블 단계에서는 이미 셸로 흘러간 뒤다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 글자 크기는 Shift 없이. 브라우저·에디터가 다 Ctrl +/-/0 이라 손이 그리 간다.
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const z: Record<string, number> = { "=": 1, "+": 1, "-": -1, _: -1 };
        if (e.key in z) setFontSize((f) => Math.min(28, Math.max(8, f + z[e.key])));
        else if (e.key === "0") setFontSize(13);
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!e.ctrlKey || !e.shiftKey) return;
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
      else if (k === "w") closePane(cur.focus);
      else if (k === "t") newTab();
      else if (k === "o") void pick();
      else if (k === "pageup") setActive((a) => (a - 1 + tabs.length) % tabs.length);
      else if (k === "pagedown") setActive((a) => (a + 1) % tabs.length);
      else if (k === "c") {
        // 선택이 없으면 아무 일도 안 한다. 터미널에서 Ctrl+Shift+C 는 복사지
        // 인터럽트가 아니다 — 그건 Ctrl+C 고, 그쪽은 셸로 그냥 흘려보낸다.
        const sel = termOf()?.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      } else if (k === "v") {
        // term.paste 를 거쳐야 한다. 셸이 bracketed paste 를 켰으면 앞뒤에
        // ESC[200~ / ESC[201~ 를 붙여야 하고, 그 판단은 xterm 이 들고 있다.
        void navigator.clipboard
          .readText()
          .then((txt) => txt && termOf()?.paste(txt))
          .catch(() => {});
      } else if (dirs[k] && cur.layout) {
        const next = L.neighbor(cur.layout, cur.focus, dirs[k]);
        if (next) patch((t) => ({ ...t, focus: next }));
      } else handled = false;

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cur, tabs.length, split, closePane, newTab, pick, patch]);

  // 경계선 드래그. 기준 상자는 그 경계선이 속한 무대다 — 탭마다 무대가 따로 있어
  // ref 하나로는 어느 무대인지 알 수 없다.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      // 버튼을 놓은 것을 못 본 채로 남았다면 여기서 끝낸다. 창 밖에서 놓으면
      // mouseup 이 오지 않아, 누르지도 않은 마우스를 경계선이 따라다니고
      // .slot 의 pointer-events:none 이 남아 pane 클릭까지 죽는다.
      if (e.buttons === 0) {
        up();
        return;
      }
      const box = d.box.getBoundingClientRect();
      const f =
        d.dir === "h"
          ? ((e.clientX - box.left) / box.width - d.parent.x) / d.parent.w
          : ((e.clientY - box.top) / box.height - d.parent.y) / d.parent.h;
      setTabs((ts) =>
        ts.map((t, i) =>
          i === active && t.layout ? { ...t, layout: L.setRatio(t.layout, d.path, f) } : t,
        ),
      );
    };
    const up = () => {
      if (drag.current) document.body.classList.remove("dragging");
      drag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // 창이 포커스를 잃는 사이 버튼을 놓으면 mouseup 은 영영 오지 않는다.
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
  }, [active]);

  // pane 을 헤더째 끌어 옮기기. 가운데에 놓으면 자리 맞바꾸기, 가장자리에
  // 놓으면 그쪽으로 갈라 붙인다 — 배치를 한 번에 원하는 모양으로 만들려면
  // 맞바꾸기만으로는 모자란다.
  useEffect(() => {
    const finish = () => {
      if (!paneDrag.current) return;
      const from = paneDrag.current.from;
      const at = dropRef.current;
      paneDrag.current = null;
      dropRef.current = null;
      setDropAt(null);
      document.body.classList.remove("pane-dragging");
      if (!at || at.id === from) return;
      patch((t) => {
        if (!t.layout) return t;
        const next = L.moveLeaf(t.layout, from, at.id, at.side);
        // 옮긴 pane 을 계속 보고 있어야 이어서 손댈 수 있다.
        return next ? { ...t, layout: next, focus: from } : t;
      });
    };
    const move = (e: MouseEvent) => {
      const d = paneDrag.current;
      if (!d) return;
      if (e.buttons === 0) {
        finish();
        return;
      }
      const layout = cur?.layout;
      if (!layout) return;
      const box = d.box.getBoundingClientRect();
      const at = L.dropTarget(
        layout,
        (e.clientX - box.left) / box.width,
        (e.clientY - box.top) / box.height,
      );
      const next = at && at.id !== d.from ? at : null;
      dropRef.current = next;
      setDropAt((prev) =>
        prev?.id === next?.id && prev?.side === next?.side ? prev : next,
      );
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
    };
  }, [cur, patch]);

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

        <div className="side-section">
          <span>폴더</span>
          <button className="mini" onClick={pick}>
            {curRoot ? "바꾸기" : "열기"}
          </button>
        </div>

        {curRoot ? (
          <>
            <div className="repo">
              <span className="repo-name">{curRoot.split("/").pop()}</span>
              {git.branch ? (
                <span className="branch">
                  {git.branch}
                  {git.ahead ? <b>↑{git.ahead}</b> : null}
                  {git.behind ? <b>↓{git.behind}</b> : null}
                </span>
              ) : null}
            </div>
            <Tree root={curRoot} git={git} onFile={insertPath} />
          </>
        ) : (
          <div className="tree">
            <div className="empty">
              아직 연 폴더가 없어
              <br />
              <b>Ctrl+Shift+O</b>
            </div>
          </div>
        )}

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
<b>Ctrl+Shift</b> 로
          <br />
          <b>D</b>/<b>E</b> 분할 · <b>W</b> 닫기 · <b>←↑↓→</b> 포커스
          <br />
          pane 은 <b>헤더를 끌어</b> 옮긴다
          <br />
          <b>T</b> 새 탭 · <b>PgUp</b>/<b>PgDn</b> 탭
          <br />
          <b>C</b>/<b>V</b> 복사·붙여넣기 · <b>O</b> 폴더
          <br />
          <b>Ctrl</b> <b>+</b>/<b>-</b>/<b>0</b> 글자 크기
        </div>
      </aside>

      <div className="main">
        <div className="tabbar">
          {tabs.map((t, i) => (
            <div
              key={t.key}
              className={i === active ? "tab on" : "tab"}
              onMouseDown={() => setActive(i)}
            >
              <span className="tab-name">{t.root?.split("/").pop() ?? "shell"}</span>
              {tabs.length > 1 ? (
                <button
                  className="x"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeTab(i)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <button className="tab add" onClick={newTab} title="새 탭 (Ctrl+Shift+T)">
            +
          </button>
        </div>

        {/* 안 보이는 탭도 계속 그려 둔다. 떼어 내면 그 탭의 PTY 가 다 죽는다.
            display:none 이 아니라 visibility:hidden 인 것이 핵심 — 상자 크기가
            남아 있어야 xterm 이 자기 칸 수를 옳게 재고, 탭으로 돌아왔을 때
            화면이 멀쩡하다. */}
        <div className="pages">
          {booted &&
            tabs.map((t, ti) => (
              <div key={t.key} className={ti === active ? "page" : "page off"}>
                <div className="stage">
                  {(t.layout ? L.rects(t.layout) : []).map((s) => (
                    <div key={s.id} data-pane={s.id} className="slot" style={pct(s.rect)}>
                      <section
                        className={ti === active && t.focus === s.id ? "pane on" : "pane"}
                        onMouseDown={() =>
                          setTabs((ts) => ts.map((x, i) => (i === ti ? { ...x, focus: s.id } : x)))
                        }
                      >
                        <header
                          className="pane-head"
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            const stage = e.currentTarget.closest(".stage");
                            if (!stage) return;
                            paneDrag.current = { from: s.id, box: stage as HTMLElement };
                            dropRef.current = null;
                            document.body.classList.add("pane-dragging");
                          }}
                        >
                          <span className={stat[s.id]?.agent ? "pip agent" : "pip"} />
                          <span className="title">{label(s.id, stat, titles)}</span>
                          {stat[s.id]?.agent ? <span className="chip">{stat[s.id]?.agent}</span> : null}
                          <button
                            className="x"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => closePane(s.id)}
                          >
                            ×
                          </button>
                        </header>
                        {stat[s.id]?.busy ? <div className="busy" /> : null}
                        <Term
                          id={s.id}
                          focused={ti === active && t.focus === s.id}
                          onTitle={onTitle}
                          cwd={t.root ?? undefined}
                          fontSize={fontSize}
                          seed={seeds[s.id]}
                        />
                      </section>
                    </div>
                  ))}

                  {ti === active && dropAt && t.layout
                    ? (() => {
                        const r = L.dropRect(t.layout, dropAt);
                        return r ? (
                          <div className={`drop-hint ${dropAt.side}`} style={pct(r)} />
                        ) : null;
                      })()
                    : null}

                  {(t.layout ? L.seams(t.layout) : []).map((sm) => (
                    <div
                      key={sm.path.join("-") || "root"}
                      className={sm.dir === "h" ? "seam vert" : "seam horz"}
                      style={pct(sm.rect)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        document.body.classList.add("dragging");
                        drag.current = {
                          path: sm.path,
                          dir: sm.dir,
                          parent: sm.parent,
                          box: e.currentTarget.parentElement as HTMLElement,
                        };
                      }}
                    />
                  ))}

                  {!t.layout && (
                    <div className="stage-empty">
                      <p>셸이 다 닫혔어</p>
                      <button
                        onClick={() => {
                          const id = `%${nextPane.current++}`;
                          setTabs((ts) =>
                            ts.map((x, i) => (i === ti ? { ...x, layout: L.leaf(id), focus: id } : x)),
                          );
                        }}
                      >
                        새 셸 열기
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/** 헤더에 쓸 이름. 돌고 있는 명령이 있으면 그게 제일 쓸모 있다 —
 *  OSC 타이틀은 cmd.exe 가 자기 전체 경로를 넣어 버려 읽히지 않는다. */
function label(
  id: string,
  stat: Record<string, PaneStat>,
  titles: Record<string, string>,
): string {
  const p = stat[id]?.proc;
  if (p) return p;
  const t = titles[id];
  if (!t) return "shell";
  return t.split(/[\\/]/).pop() || t;
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
