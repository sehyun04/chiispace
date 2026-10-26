/** 얼개 — 탭·배치와 세션 저장·복원을 쥐고, 나머지는 제 파일에 맡겨 조립한다.
 *
 *  칸 하나를 그리는 일은 `Pane`, 터미널 칸의 상태 폴링·복원 명령·명부는 `usePaneAgents`,
 *  터미널 없는 칸(대화창)은 `useStreams`, 포커스는 `focus`,
 *  단축키·끌기·칸 정리는 각 `use*` 가 맡는다. 여기를 고칠 일이 줄어야 동시에 일하는 세션끼리 덜 부딪힌다. */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bySlug, useCasting } from "./roster";
import {
  label,
  continuePlan,
  savedKeep,
  paneTitle,
  savedPaneTitles,
  type ShellKind,
} from "./session";
import { Pane } from "./Pane";
import { savedStreams } from "./stream-session";
import { Sidebar, type AgentKind } from "./Sidebar";
import { useGit } from "./git";
import * as L from "./layout";
import { usePaneBridge } from "./bridge";
import { bootStreams, leavesOf, readSaved, savedJson, type Tab } from "./saved";
import { usePaneAgents } from "./usePaneAgents";
import { useStreams } from "./useStreams";
import { useFocus } from "./focus";
import { useShortcuts } from "./useShortcuts";
import { usePaneDrag, useSeamDrag } from "./useDrag";
import { useTabCleanup } from "./useTabCleanup";

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
  const [fontSize, setFontSize] = useState(13);
  // 이 컴퓨터에 실제로 있는 셸. 목록을 박아 두면 없는 것을 골라 칸이 뜨자마자
  // 죽는데, 그때 화면에는 빈 칸만 남아 왜 안 되는지 알 수 없다.
  const [shellList, setShellList] = useState<ShellKind[]>([]);
  // 첫 pane 은 열 폴더가 정해진 뒤에 띄운다. 먼저 띄우면 셸이 홈에서 시작해
  // 버리고, 이미 뜬 셸의 cwd 는 뒤늦게 바꿔 줄 수 없다.
  const [booted, setBooted] = useState(false);
  // CLI가 제목을 다시 보내기 전에도 칸을 구별할 수 있게 마지막 표시 이름을 별도로 보존한다.
  const [paneTitles, setPaneTitles] = useState<Record<string, string>>({});
  // 사용자가 직접 붙인 pane 이름. 자동으로 알아낸 것(돌고 있는 명령, claude 대화의
  // 마지막 프롬프트)은 어디까지나 추측이라, 직접 붙인 이름이 있으면 그것이 이긴다.
  const [names, setNames] = useState<Record<string, string>>({});
  // 지금 사람을 고르고 있는 칸. 자동으로 붙여 준 사람이 마음에 안 들 수 있다.
  const [picking, setPicking] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // 옆칸을 접어 두면 터미널이 창을 다 쓴다. 접은 채로 두는 사람도 있으니 세션에 남긴다.
  const [sideOpen, setSideOpen] = useState(true);
  const nextPane = useRef(1);
  const nextTab = useRef(1);

  const cur = tabs[active] ?? tabs[0];
  // 이벤트 핸들러가 최신 배치를 봐야 한다. state 를 그대로 닫아 두면 등록 시점의
  // 낡은 값을 보게 되고, 그렇다고 deps 에 넣으면 매번 다시 구독한다.
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const live = leavesOf(tabs);

  const agents = usePaneAgents();
  const { stat, procs, chatIds } = agents;
  const streams = useStreams(booted, tabs, stat);
  const { focusPane, chats } = useFocus(streams.streams);
  const [casting, setCasting] = useCasting(live);
  const curRoot = cur?.root ?? null;
  const git = useGit(curRoot);
  // 트리가 없어졌으니 바뀐 파일 수만이라도 여기 남긴다.
  const dirty = Object.keys(git.files).length;

  const patch = useCallback(
    (fn: (t: Tab) => Tab) => setTabs((ts) => ts.map((t, i) => (i === active ? fn(t) : t))),
    [active],
  );

  const onTitle = useCallback((id: string, title: string) => {
    setTitles((t) => (t[id] === title ? t : { ...t, [id]: title }));
    const name = paneTitle(title);
    if (name) setPaneTitles((t) => (t[id] === name ? t : { ...t, [id]: name }));
  }, []);
  const onStreamTitle = useCallback((id: string, title: string) => {
    setPaneTitles((t) => (t[id] === title ? t : { ...t, [id]: title }));
  }, []);

  const split = useCallback(
    (dir: L.Dir) => {
      const id = `%${nextPane.current++}`;
      patch((t) => ({
        ...t,
        // 나눈 뒤 전체를 고르게 편다. 안 그러면 새 칸에 포커스가 가고 거기서
        // 또 나누게 되어 그 자리만 반씩 줄어든다 — 몇 번이면 못 쓸 만큼 좁아진다.
        layout: t.layout ? L.balance(L.splitLeaf(t.layout, t.focus, dir, id)) : L.leaf(id),
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

  /** 셸을 안 주면 지금 탭과 같은 것으로 연다. 단축키(Ctrl+Shift+T)가 그 길로 오는데,
   *  거기서 매번 고르게 하면 손이 키보드에서 떨어져 단축키를 쓰는 뜻이 없어진다. */
  const openStream = streams.open;
  const newTab = useCallback(
    (shell?: string, agent?: AgentKind) => {
      const id = `%${nextPane.current++}`;
      const root = cur?.root ?? null;
      if (agent) {
        openStream(id, agent, root ?? "");
        setPaneTitles((t) => ({ ...t, [id]: "새 대화" }));
      }
      // 터미널 없는 칸만 든 탭은 셸이 없다. 그 탭에서 칸을 나누면 기본 셸로 연다.
      const sh = agent ? undefined : (shell ?? cur?.shell);
      setTabs((ts) => {
        setActive(ts.length);
        return [...ts, { key: `t${nextTab.current++}`, layout: L.leaf(id), root, focus: id, shell: sh }];
      });
    },
    [cur, openStream],
  );

  const closeTab = useCallback((i: number) => {
    setTabs((ts) => (ts.length <= 1 ? ts : ts.filter((_, k) => k !== i)));
    setActive((a) => (a >= i && a > 0 ? a - 1 : a));
  }, []);

  const commitName = useCallback(
    (id: string, raw: string) => {
      const v = raw.trim();
      // claude 가 도는 pane 이면 그 대화의 이름도 같이 바꾼다. claude 에는
      // 세션에 이름을 붙이는 /rename 이 있고, 그 이름은 대화에 남아 나중에
      // --resume 목록과 프롬프트 박스에도 그대로 나온다. pane 이름과 대화
      // 이름이 따로 놀면 정작 세션을 고를 때 아무 도움이 안 된다.
      if (v && stat[id]?.agent === "claude") {
        void invoke("pty_write", { id, data: `/rename ${v}\n` }).catch(() => {});
      }
      setNames((n) => {
        if (!v) {
          if (!(id in n)) return n;
          // 비우면 이름을 떼고 다시 자동 표시로 돌아간다.
          const next = { ...n };
          delete next[id];
          return next;
        }
        return n[id] === v ? n : { ...n, [id]: v };
      });
      setRenaming(null);
      focusPane(id);
    },
    [stat, focusPane],
  );

  /** 그 탭으로 건너간다. 칸까지 주면 그 칸을 잡는다. 옆칸 목록이 부른다. */
  const selectPane = useCallback((ti: number, pane?: string) => {
    setActive(ti);
    if (!pane) return;
    setTabs((ts) => ts.map((x, i) => (i === ti ? { ...x, focus: pane } : x)));
    focusPane(pane);
  }, [focusPane]);

  const pick = useCallback(async () => {
    const picked = await invoke<string | null>("fs_pick");
    if (picked) patch((t) => ({ ...t, root: picked }));
  }, [patch]);

  usePaneBridge(booted, {
    workspaces: tabs.map((t) => ({ id: t.key, name: t.root?.split(/[\\/]/).pop() || "셸" })),
    surfaces: tabs.flatMap((t) => (t.layout ? L.leaves(t.layout) : []).map((id) => ({
      id, workspace_id: t.key, cwd: stat[id]?.cwd ?? t.root,
      title: names[id] || paneTitles[id] || label(id, stat, titles),
      character: bySlug.get(casting[id])?.name ?? null,
    }))),
    current: cur?.key ?? null,
    focused: cur?.focus ?? null,
    neighbors: Object.fromEntries(tabs.flatMap((t) => (t.layout ? L.leaves(t.layout) : []).map((id) => [
      id, Object.fromEntries((["left", "right", "up", "down"] as const)
        .map((dir) => [dir, t.layout ? L.neighbor(t.layout, id, dir) : null]).filter(([, id]) => id)),
    ]))),
  }, (request) => {
    const ti = tabsNow.current.findIndex((t) => t.layout && L.leaves(t.layout).includes(request.surface));
    if (ti < 0) throw new Error(`없는 칸: ${request.surface}`);
    if (request.action === "focus") {
      selectPane(ti, request.surface);
      return request.surface;
    }
    if (request.action === "close") {
      closePane(request.surface);
      return request.surface;
    }
    if (request.action !== "split") throw new Error("지원하지 않는 칸 작업");
    const id = `%${nextPane.current++}`;
    let direction = request.direction;
    if (!direction || direction === "auto") {
      const box = document.querySelector(`[data-pane="${CSS.escape(request.surface)}"]`)?.getBoundingClientRect();
      direction = box && box.height > box.width ? "down" : "right";
    }
    const dir = direction === "left" || direction === "right" ? "h" : "v";
    const before = direction === "left" || direction === "up";
    setTabs((ts) => ts.map((t, i) => {
      if (i !== ti || !t.layout) return t;
      let layout = L.splitLeaf(t.layout, request.surface, dir, id);
      if (before) layout = L.swapLeaves(layout, request.surface, id);
      return { ...t, layout: L.balance(layout), focus: request.focus ? id : t.focus };
    }));
    if (request.focus) setActive(ti);
    return id;
  });

  // 부팅. 저장된 세션을 되살리되, 명령줄로 폴더를 지정했으면 그쪽이 이긴다 —
  // 사용자가 방금 말한 것이 지난번 기억보다 우선이다.
  const { restore } = agents;
  const { adopt, setKeepTerm } = streams;
  useEffect(() => {
    (async () => {
      const cli = await invoke<string | null>("initial_root").catch(() => null);
      // 셸 목록은 첫 칸이 뜨기 **전에** 있어야 한다. 목록의 맨 앞이 기본 셸인데,
      // 늦게 받으면 그 사이에 뜬 칸이 엔진 기본(cmd)으로 열려 버리고 이미 뜬
      // 셸은 나중에 바꿔 끼울 수 없다. 설치가 바뀌지 않는 한 그대로라 한 번만 묻는다.
      setShellList(await invoke<ShellKind[]>("shells").catch(() => [] as ShellKind[]));
      const s = readSaved(await invoke<string | null>("state_load").catch(() => null));
      if (s) {
        try {
          if (s.fontSize) setFontSize(s.fontSize);
          if (s.names) setNames(s.names);
          setPaneTitles(savedPaneTitles(s.paneTitles, leavesOf(s.tabs ?? [])));
          if (s.casting) setCasting(s.casting);
          adopt(savedStreams(s.streams));
          if (typeof s.sideOpen === "boolean") setSideOpen(s.sideOpen);
          if (s.procs) {
            // 대화 id 가 확실한 Claude 칸은 터미널 없는 칸으로 연다(saved.ts `bootStreams`).
            const keep = savedKeep(s.keepTerminal);
            setKeepTerm(keep);
            const boot = await bootStreams(
              continuePlan(s.procs, s.restoreMode !== "native-continue"), keep, s.tabs,
              (root, id) => invoke<number>("claude_transcript_size", { root, id }),
            );
            adopt(boot.moved);
            restore(boot.seeds);
            (window as unknown as { __restore?: unknown }).__restore = { seeds: boot.seeds };
          }
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
    // 켤 때 한 번만 돈다. 아래 콜백들은 모두 안정적인 참조다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 배치가 바뀔 때마다 저장. 경계선을 끄는 동안 초당 수십 번 바뀌므로 묶어서 쓴다.
  const { streams: streamMap, keepTerm } = streams;
  useEffect(() => {
    if (!booted) return;
    // pane 이 하나도 안 남은 상태는 저장하지 않는다. 앱을 끌 때 PTY 가 줄줄이
    // 죽으며 그 부고가 pane 을 다 지우는 경로가 있는데, 그것이 저장되면 다음에
    // 켤 때 배치가 통째로 날아간다(결정 7번). 저장은 되돌릴 수 없는 쪽이라 여기서도 막는다.
    if (tabs.every((t) => !t.layout)) return;
    const h = setTimeout(() => {
      const json = savedJson({
        tabs, active, nextPane: nextPane.current, nextTab: nextTab.current, fontSize,
        procs: procs.current, names, paneTitles, casting, sideOpen, streams: streamMap, keepTerm,
      });
      invoke("state_save", { json }).catch(() => {});
    }, 400);
    return () => clearTimeout(h);
    // stat 은 800ms 마다 새로 오지만 디바운스가 묶어 준다. 넣어 두는 것은 누적한 복원 명령(procs,
    // ref 라 바뀌어도 다시 그리지 않는다)이 폴링을 따라 저장되게 하려는 것이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, active, fontSize, booted, stat, names, paneTitles, casting, sideOpen, streamMap, keepTerm]);

  useTabCleanup(tabs, tabsNow, setTabs, setActive);
  useShortcuts(cur, tabs.length, chats, {
    split, closePane, newTab, pick, patch, setFontSize, setSideOpen, setActive,
  });
  const startSeam = useSeamDrag(active, setTabs);

  // 배치가 바뀌면 React 가 slot DOM 을 실제로 옮기고(insertBefore), 그때 xterm 의
  // 숨은 textarea 가 포커스를 잃는다(결정 5번). Term 쪽 effect 는 focused prop 이 그대로라
  // 다시 돌지 않으므로 여기서 되돌린다. 이걸 안 하면 pane 을 옮긴 뒤 그 pane 에
  // 아무것도 못 친다 — 한글도 영문도 백스페이스도.
  // 칸이 터미널과 대화창 사이를 오갈 때도 다시 준다. 안 그러면 키가 걷힌 쪽에 남는다.
  const focusChat = !!streamMap[cur?.focus ?? ""];
  useEffect(() => {
    if (!booted) return;
    focusPane(cur?.focus);
  }, [cur?.layout, cur?.focus, active, booted, focusChat, focusPane]);

  const paneDrag = usePaneDrag(cur, patch);

  /** 대화창 칸의 폴더를 바꾼다. claude 는 대화를 폴더별로 적어 같은 대화를 다른 폴더로 옮길 수 없으므로
   *  그 폴더에서 새 대화로 연다. 지금 대화 파일은 지우지 않는다. */
  const changeFolder = useCallback((id: string, agent: AgentKind, cwd: string) => {
    openStream(id, agent, cwd);
    setPaneTitles((t) => ({ ...t, [id]: "새 대화" }));
  }, [openStream]);

  /** 대화창에서 터미널이 꼭 필요한 일(로그인·로그아웃)을 새 탭의 터미널에서 한 번 돌린다. 대화창 칸은 그대로 둔다 —
   *  그 칸을 터미널로 바꾸면 하던 대화가 내려간다. 브라우저 인증을 앱이 대신 받으면 인증 정보를 앱이 다뤄야 하므로
   *  CLI 의 로그인 화면에 맡긴다. */
  const { seed } = agents;
  const openTerminal = useCallback((cmd: string, title: string) => {
    const id = `%${nextPane.current++}`;
    const root = cur?.root ?? null;
    seed(id, { cmd, auto: true, cwd: root ?? undefined });
    setPaneTitles((t) => ({ ...t, [id]: title }));
    setTabs((ts) => {
      setActive(ts.length);
      return [...ts, { key: `t${nextTab.current++}`, layout: L.leaf(id), root, focus: id, shell: cur?.shell }];
    });
  }, [cur, seed]);

  const { paneView } = streams;
  return (
    <div className={sideOpen ? "app" : "app closed"}>
      <button
        className="sidetoggle"
        title={sideOpen ? "옆칸 접기 (Ctrl+Shift+B)" : "옆칸 펴기 (Ctrl+Shift+B)"}
        onClick={() => setSideOpen((v) => !v)}
      >
        <SideMark open={sideOpen} />
      </button>

      <Sidebar
        tabs={tabs}
        active={active}
        git={git}
        dirty={dirty}
        stat={paneView}
        titles={titles}
        names={names}
        paneTitles={paneTitles}
        casting={casting}
        picking={picking}
        renaming={renaming}
        curRoot={curRoot}
        onPickFolder={pick}
        shells={shellList}
        onNewTab={newTab}
        onCloseTab={closeTab}
        onClosePane={closePane}
        onSelectPane={selectPane}
        onSetPicking={setPicking}
        onSetRenaming={setRenaming}
        onSetCasting={setCasting}
        onCommitName={commitName}
      />

      <div className="main">
        {/* 안 보이는 탭도 계속 그려 둔다. 떼어 내면 그 탭의 PTY 가 다 죽는다.
            display:none 이 아니라 visibility:hidden 인 것이 핵심 — 상자 크기가
            남아 있어야 xterm 이 자기 칸 수를 옳게 재고, 탭으로 돌아왔을 때
            화면이 멀쩡하다(결정 2번). */}
        <div className="pages">
          {booted &&
            tabs.map((t, ti) => (
              <div key={t.key} className={ti === active ? "page" : "page off"}>
                <div className="stage">
                  {(t.layout ? L.rects(t.layout) : []).map((s) => (
                    <div
                      key={s.id}
                      data-pane={s.id}
                      data-proc={stat[s.id]?.proc ?? ""}
                      data-agent={stat[s.id]?.agent ?? ""}
                      data-title={titles[s.id] ?? ""}
                      className="slot"
                      style={pct(s.rect)}
                    >
                      <Pane
                        id={s.id}
                        on={ti === active && t.focus === s.id}
                        root={t.root}
                        shell={t.shell ?? shellList[0]?.path}
                        fontSize={fontSize}
                        view={paneView[s.id]}
                        stat={stat[s.id]}
                        slug={casting[s.id]}
                        name={names[s.id]}
                        autoName={paneTitles[s.id]}
                        fallback={label(s.id, paneView, titles)}
                        renaming={renaming === s.id}
                        stream={streamMap[s.id]}
                        streamBusy={!!streams.streamBusy[s.id]}
                        streamEpoch={streams.epoch[s.id] ?? 0}
                        chatId={chatIds[s.id]}
                        seed={agents.seeds[s.id]}
                        onSelect={() => {
                          setTabs((ts) =>
                            ts.map((x, i) => (i === ti ? { ...x, focus: s.id } : x)),
                          );
                          // 이미 focus 인 pane 을 다시 누르면 state 가 안 바뀌어
                          // Term 의 effect 가 돌지 않는다. 포커스를 잃은 채였다면
                          // 클릭해도 안 살아나므로 여기서 직접 준다.
                          focusPane(s.id);
                        }}
                        onDragStart={(stage) => paneDrag.start(s.id, stage)}
                        onRename={() => setRenaming(s.id)}
                        onCommitName={(v) => commitName(s.id, v)}
                        onCancelRename={() => {
                          setRenaming(null);
                          focusPane(s.id);
                        }}
                        onClose={() => closePane(s.id)}
                        onToTerminal={() => streams.toTerminal(s.id, agents.seed)}
                        onToStream={() =>
                          // 터미널 쪽에서 알던 것(복원 명령·명부 id)은 옮기는 순간 같이 놓는다.
                          void streams.toStream(
                            s.id, chatIds[s.id], stat[s.id]?.cwd ?? procs.current[s.id]?.cwd ?? t.root ?? "", agents.forget,
                          )
                        }
                        onFolder={changeFolder}
                        onResume={streams.resume}
                        onTerminal={openTerminal}
                        onTermTitle={onTitle}
                        onStreamTitle={onStreamTitle}
                        onStreamBusy={streams.onBusy}
                        onStreamSession={streams.onSession}
                        onCodexChange={streams.onCodexChange}
                      />
                    </div>
                  ))}

                  {ti === active && paneDrag.dropAt && t.layout
                    ? (() => {
                        const r = L.dropRect(t.layout, paneDrag.dropAt);
                        return r ? (
                          <div className={`drop-hint ${paneDrag.dropAt.side}`} style={pct(r)} />
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
                        startSeam(sm, e.currentTarget.parentElement as HTMLElement);
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


/** 옆칸 접기·펴기. 왼쪽 칸이 채워졌는지로 지금 상태를 말한다. */
function SideMark({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="1.6"
        y="2.6"
        width="12.8"
        height="10.8"
        rx="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M6.4 2.6 V13.4"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      {open ? <rect x="1.6" y="2.6" width="4.8" height="10.8" rx="2.4" fill="currentColor" /> : null}
    </svg>
  );
}
