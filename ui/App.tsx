import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// 웹뷰의 navigator.clipboard 가 아니라 OS 클립보드로 간다. 그쪽은 창이
// 포커스를 갖고 있어야 하고 읽기에는 권한이 따로 걸려, WebView2 에서
// NotAllowedError 로 조용히 거부되는 때가 있다.
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import roster from "./roster.json";
import { Term } from "./Term";
import { EMPTY_GIT, type GitInfo } from "./git";
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

type XTerm = { getSelection(): string; paste(t: string): void; focus(): void };

/** pane id 로 그 터미널을 찾는다.
 *
 *  전역 `__term` 하나로 "지금 터미널"을 들고 있었는데, 그 값은 Term 의
 *  focused effect 에서만 갱신된다. pane 을 옮기면 focus 는 그대로라 effect 가
 *  돌지 않아 값이 낡고, 복사·붙여넣기가 엉뚱한 pane 을 보거나 아무 일도 안
 *  하게 된다. 어느 pane 이 포커스인지는 App 이 이미 알고 있으니 그것으로 찾는다. */
const termOf = (id?: string): XTerm | undefined =>
  id ? (window as unknown as { __terms?: Record<string, XTerm> }).__terms?.[id] : undefined;

/** 이 pane 을 되살리려면 무엇을 쳐야 하는가.
 *
 *  `proc` 만 보면 안 된다. 엔진은 전경 프로세스 이름과 에이전트를 따로 판정하는데,
 *  claude 처럼 자기 프로세스 트리를 여러 겹 두는 것은 이름 쪽이 비고 에이전트 쪽만
 *  잡히는 때가 있다. 그때 `proc` 만 보면 claude 를 켜 둔 채로 껐는데도 아무것도
 *  기억하지 못한다.
 *
 *  claude 는 이전 대화를 이어 여는 방법이 따로 있다. 세션을 되돌리려는 참이니
 *  그쪽을 얹는다 — 실행하지는 않으므로 원치 않으면 지우면 된다. */
type Seed = { cmd: string; auto?: boolean };

function restoreCmd(p: PaneStat, sid?: string): Seed | null {
  // 에이전트는 이어 열어 준다. 이건 대화를 불러오는 것뿐이라 부작용이 없고,
  // 명령만 쳐 놓아서는 사용자가 말하는 "세션 복원"이 되지 않는다.
  //
  // 세션 ID 를 알면 그것을 짚는다. --continue 는 "그 폴더의 가장 최근" 이라
  // pane 이 여럿이면 전부 같은 대화로 몰리고, 다른 창에서 claude 를 돌리면
  // 엉뚱한 것이 열린다. 못 찾았을 때만 --continue 로 물러선다.
  if (p.agent === "claude")
    return { cmd: sid ? `claude --resume ${sid}` : "claude --continue", auto: true };
  if (p.agent) return { cmd: p.agent, auto: true };
  // 그 밖의 명령은 쳐 놓기만 한다. 빌드나 배포가 저 혼자 다시 도는 건 곤란하다.
  if (p.proc && !SHELLS.has(p.proc.toLowerCase())) return { cmd: p.proc };
  return null;
}

/** 예전 세션은 명령을 문자열로만 적어 두었다. */
const asSeed = (v: unknown): Seed | null =>
  typeof v === "string" ? { cmd: v } : v && typeof v === "object" ? (v as Seed) : null;

/** 셸 자신은 "돌리던 명령"이 아니다. 이 이름들이 전경에 있으면 그냥 빈 프롬프트다. */
const SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "fish"]);

const leader = roster.leader as Member;
const members = roster.members as Member[];

/** 배정할 수 있는 사람들. 대장(하치와레)이 앞에 서서 첫 칸을 맡는다. */
const cast: Member[] = [leader, ...members];
const bySlug = new Map(cast.map((m) => [m.slug, m]));

/** `ui/assets/faces/<slug>.png` 를 넣으면 그때부터 그 얼굴이 붙는다.
 *  vite 가 빌드 때 모아 주므로 파일을 넣는 것 말고 할 일이 없다. */
const faces = import.meta.glob("./assets/faces/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
/** `<slug>.png` 가 기본, `<slug>-work.png` 가 있으면 일하는 중에는 그걸 쓴다.
 *  APNG·GIF 를 그 이름으로 넣어도 된다 — `<img>` 가 알아서 돌린다. */
const faceUrl = (slug?: string, state?: "work") => {
  if (!slug) return undefined;
  if (state) {
    const alt = faces[`./assets/faces/${slug}-${state}.png`];
    if (alt) return alt;
  }
  return faces[`./assets/faces/${slug}.png`];
};
/** 그 사람의 일하는 중 그림이 따로 있는지. 있으면 그림이 알아서 움직이므로
 *  우리가 통통 뛰게 만들지 않는다 — 두 움직임이 겹치면 산만하다. */
const hasWorkFace = (slug?: string) =>
  !!slug && !!faces[`./assets/faces/${slug}-work.png`];

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
  const [seeds, setSeeds] = useState<Record<string, Seed>>({});
  // pane 이 무엇을 돌리고 있었는지를 누적해 둔다. 순간 스냅샷(stat)으로만
  // 계산하면 안 된다 — 앱을 끌 때 PTY 가 먼저 사라지면 pane_status 가 빈
  // 목록을 주고, 그 순간 저장이 돌면서 되살릴 정보가 통째로 지워진다.
  // 배치(tabs)는 그대로라 배치만 남고 명령만 날아간다.
  const procs = useRef<Record<string, Seed>>({});
  // pane 이 어느 claude 대화를 붙들고 있는지. 한 번 정해지면 그대로 둔다 —
  // 그 pane 의 claude 가 계속 같은 파일에 쓰고 있으므로 다시 고를 이유가 없다.
  const sessionOf = useRef<Record<string, string>>({});
  // 그 대화에서 마지막으로 시킨 일. 여러 pane 에 claude 를 띄워 두면 헤더가
  // 전부 "claude" 라 어느 쪽이 무슨 작업이었는지 알 수 없다.
  const [sessionTitle, setSessionTitle] = useState<Record<string, string>>({});
  // 사용자가 직접 붙인 pane 이름. 자동으로 알아낸 것(돌고 있는 명령, claude 대화의
  // 마지막 프롬프트)은 어디까지나 추측이라, 직접 붙인 이름이 있으면 그것이 이긴다.
  const [names, setNames] = useState<Record<string, string>>({});
  // 칸마다 누가 맡았는지(paneId -> slug). 세션에 남아 다시 켜도 같은 얼굴이
  // 같은 칸에 붙는다.
  const [casting, setCasting] = useState<Record<string, string>>({});
  // 지금 사람을 고르고 있는 칸. 자동으로 붙여 준 사람이 마음에 안 들 수 있다.
  const [picking, setPicking] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Enter 로 이미 확정했는지. 확정 뒤 input 이 사라지며 blur 가 또 불리는데,
  // 그대로 두면 claude 에 /rename 이 두 번 날아간다.
  const renameDone = useRef(false);
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
  // 이벤트 핸들러가 최신 배치를 봐야 한다. state 를 그대로 닫아 두면 등록 시점의
  // 낡은 값을 보게 되고, 그렇다고 deps 에 넣으면 매번 다시 구독한다.
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const paneCount = tabs.reduce((n, t) => n + (t.layout ? L.leaves(t.layout).length : 0), 0);
  // 트리가 없어졌으니 바뀐 파일 수만이라도 여기 남긴다.
  const dirty = Object.keys(git.files).length;
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

  const commitName = useCallback(
    (id: string, raw: string) => {
      const v = raw.trim();
      // claude 가 도는 pane 이면 그 대화의 이름도 같이 바꾼다. claude 에는
      // 세션에 이름을 붙이는 /rename 이 있고, 그 이름은 대화에 남아 나중에
      // --resume 목록과 프롬프트 박스에도 그대로 나온다. pane 이름과 대화
      // 이름이 따로 놀면 정작 세션을 고를 때 아무 도움이 안 된다.
      if (v && stat[id]?.agent === "claude") {
        void invoke("pty_write", { id, data: `/rename ${v}
` }).catch(() => {});
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
      termOf(id)?.focus();
    },
    [stat],
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
            procs?: Record<string, unknown>;
            names?: Record<string, string>;
            casting?: Record<string, string>;
          };
          if (s.fontSize) setFontSize(s.fontSize);
          if (s.names) setNames(s.names);
          if (s.casting) setCasting(s.casting);
          if (s.procs) {
            const m: Record<string, Seed> = {};
            for (const [id, v] of Object.entries(s.procs)) {
              const seed = asSeed(v);
              if (seed) {
                m[id] = seed;
                // 복원으로 여는 pane 은 어느 대화인지 이미 안다. 미리 붙여 두어야
                // 아래의 "새로 생긴 것 찾기"가 이 pane 을 건드리지 않는다.
                const hit = /--resume\s+([0-9a-f-]{36})/.exec(seed.cmd);
                if (hit) sessionOf.current[id] = hit[1];
              }
            }
            setSeeds(m);
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
  }, []);

  // 배치가 바뀔 때마다 저장. 경계선을 끄는 동안 초당 수십 번 바뀌므로 묶어서 쓴다.
  useEffect(() => {
    if (!booted) return;
    // pane 이 하나도 안 남은 상태는 저장하지 않는다. 앱을 끌 때 PTY 가 줄줄이
    // 죽으며 그 부고가 pane 을 다 지우는 경로가 있는데, 그것이 저장되면 다음에
    // 켤 때 배치가 통째로 날아간다. Rust 쪽에서 종료 중 부고를 막고 있지만,
    // 저장은 되돌릴 수 없는 쪽이라 여기서도 막는다.
    if (tabs.every((t) => !t.layout)) return;
    void names;
    const h = setTimeout(() => {
      const live = new Set(tabs.flatMap((t) => (t.layout ? L.leaves(t.layout) : [])));
      const saved: Record<string, Seed> = {};
      for (const [id, cmd] of Object.entries(procs.current)) {
        if (live.has(id)) saved[id] = cmd;
      }
      const json = JSON.stringify({
        tabs,
        active,
        nextPane: nextPane.current,
        nextTab: nextTab.current,
        fontSize,
        procs: saved,
        names,
        casting,
      });
      invoke("state_save", { json }).catch(() => {});
    }, 400);
    return () => clearTimeout(h);
    // stat 은 800ms 마다 새로 오지만 여기 쓰이는 것은 이름뿐이라 저장이
    // 그 주기로 덩달아 돌지는 않는다 — 디바운스가 묶어 준다.
  }, [tabs, active, fontSize, booted, stat, names, casting]);

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

  // claude 가 도는 pane 의 목록. 문자열로 좁혀 두는 이유는 바로 아래 있다.
  const claudePanes = Object.entries(stat)
    .filter(([, p]) => p.agent === "claude")
    .map(([id]) => id)
    .sort()
    .join(",");

  // claude 가 도는 pane 에 그 대화를 붙여 둔다. claude 는 대화를 프로젝트 폴더
  // 아래 <세션 UUID>.jsonl 로 쌓으므로, 방금 뜬 claude 의 것은 가장 최근에 쓰인
  // 파일이다. 이미 다른 pane 이 가져간 것은 건너뛴다 — 두 pane 이 같은 대화를
  // 가리키면 복원할 때 둘 다 같은 자리로 열린다.
  //
  // deps 에 stat 을 그대로 두면 안 된다. stat 은 800ms 마다 새 객체로 오므로
  // 그보다 긴 타이머는 매번 취소되고 다시 걸려 영영 터지지 않는다. 값이 같으면
  // 참조도 같은 문자열로 좁혀서 목록이 실제로 바뀔 때만 다시 돈다.
  useEffect(() => {
    if (!curRoot || !claudePanes) return;
    const want = claudePanes.split(",").filter((id) => !sessionOf.current[id]);
    if (!want.length) return;
    let alive = true;
    let before: Set<string> | null = null;
    // 먼저 지금 있는 대화를 찍어 둔다. 그 뒤에 새로 생긴 것만 이 pane 의 것으로
    // 본다 — 그냥 "가장 최근"을 집으면 다른 창에서 돌고 있는 남의 대화를 집고,
    // 나중에 그것을 --resume 으로 열려다 충돌해서 pane 이 뜨자마자 죽는다.
    invoke<{ id: string; mtime: number; title: string }[]>("claude_sessions", { root: curRoot })
      .then((list) => {
        if (alive) before = new Set(list.map((c) => c.id));
      })
      .catch(() => {});
    // 파일이 만들어질 틈을 준다. claude 가 뜨자마자 첫 줄을 쓰지는 않는다.
    const h = setTimeout(() => {
      if (!before) return;
      const seen = before;
      invoke<{ id: string; mtime: number; title: string }[]>("claude_sessions", {
        root: curRoot,
      })
        .then((list) => {
          if (!alive) return;
          const taken = new Set(Object.values(sessionOf.current));
          const titles: Record<string, string> = {};
          for (const paneId of want) {
            const fresh = list.find((c) => !seen.has(c.id) && !taken.has(c.id));
            // 새로 생긴 대화가 없으면 아무것도 붙이지 않는다. 그러면 복원할 때
            // --continue 로 물러서는데, 남의 대화를 여는 것보다 그편이 낫다.
            if (!fresh) break;
            sessionOf.current[paneId] = fresh.id;
            taken.add(fresh.id);
            if (fresh.title) titles[paneId] = fresh.title;
          }
          if (Object.keys(titles).length) setSessionTitle((t) => ({ ...t, ...titles }));
          // 제목은 아래 effect 가 이어서 계속 맞춘다.
        })
        .catch(() => {});
    }, 4000);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [claudePanes, curRoot]);

  // 붙여 둔 대화의 제목을 헤더에 맞춰 둔다.
  //
  // 세션을 처음 붙일 때 한 번만 가져오면, 복원으로 연 pane 은 이미 어느
  // 대화인지 알아서 그 경로를 타지 않아 제목이 영영 비고 헤더가 "claude" 로
  // 떨어진다. 그리고 대화가 진행되면 마지막으로 시킨 일도 바뀌므로, 한 번
  // 가져온 값을 붙들고 있으면 곧 옛날 것이 된다. 주기적으로 다시 맞춘다.
  useEffect(() => {
    if (!curRoot || !claudePanes) return;
    let alive = true;
    const tick = () => {
      invoke<{ id: string; mtime: number; title: string }[]>("claude_sessions", { root: curRoot })
        .then((list) => {
          if (!alive) return;
          const byId = new Map(list.map((c) => [c.id, c.title]));
          const next: Record<string, string> = {};
          for (const paneId of claudePanes.split(",")) {
            const sid = sessionOf.current[paneId];
            const title = sid ? byId.get(sid) : undefined;
            if (title) next[paneId] = title;
          }
          setSessionTitle((prev) => {
            const changed = Object.keys(next).some((k) => prev[k] !== next[k]);
            return changed ? { ...prev, ...next } : prev;
          });
        })
        .catch(() => {});
    };
    tick();
    const h = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [claudePanes, curRoot]);

  // 새로 생긴 칸에 사람을 붙인다. 이미 나간 사람은 피하고, 스무 명을 다 쓰면
  // 처음부터 다시 돈다. 칸이 사라져도 배정은 지우지 않는다 — 같은 칸이 되살아날
  // 때 얼굴이 바뀌면 그게 더 낯설다.
  useEffect(() => {
    const live = tabs.flatMap((t) => (t.layout ? L.leaves(t.layout) : []));
    const need = live.filter((id) => !casting[id]);
    if (!need.length) return;
    setCasting((c) => {
      const used = new Set(Object.values(c));
      const next = { ...c };
      for (const id of need) {
        const free = cast.find((m) => !used.has(m.slug)) ?? cast[used.size % cast.length];
        next[id] = free.slug;
        used.add(free.slug);
      }
      return next;
    });
  }, [tabs, casting]);

  // 돌던 명령을 누적한다. stat 에 있는 pane 만 판단하고, 목록에서 사라진
  // pane 은 건드리지 않는다 — 사라진 것은 "명령이 끝났다"가 아니라 "PTY 가
  // 이미 죽었다"일 수 있고, 그 둘을 스냅샷만으로는 구별할 수 없다.
  useEffect(() => {
    for (const [id, p] of Object.entries(stat)) {
      const name = restoreCmd(p, sessionOf.current[id]);
      if (name) procs.current[id] = name;
      else {
        delete procs.current[id];
        // claude 가 내려갔으면 붙여 둔 대화도 놓는다. 그 pane 에서 다음에
        // 띄우는 것은 다른 대화일 수 있다.
        delete sessionOf.current[id];
        setSessionTitle((t) => (id in t ? { ...t, [id]: "" } : t));
      }
    }
  }, [stat]);

  // 셸이 끝나면 그 pane 은 사라진다 — 터미널에서 exit 을 친 사람이 기대하는
  // 동작이다. 어느 탭에 있든 지워야 한다.
  useEffect(() => {
    // 짧은 사이에 부고가 몰려 오면 그것은 사용자가 exit 을 친 것이 아니라 앱이나
    // 셸이 한꺼번에 무너지는 중이다(강제 종료가 그렇다). 그 부고를 곧이곧대로
    // 받으면 배치가 통째로 지워지고, 그 빈 배치가 세션에 저장돼 다음에 켤 때도
    // 사라진 채로 뜬다 — 되돌릴 방법이 없다. 하나씩 닫는 것만 받아들인다.
    // 부고가 오면 곧바로 지우지 않고 잠깐 모은다.
    //
    // 하나만 왔으면 사용자가 그 칸에서 exit 을 친 것이다. 여럿이 한꺼번에 오면
    // 셸들이 함께 무너지는 중이고(앱이 강제로 죽을 때가 그렇다), 그것까지
    // 받아들이면 배치가 통째로 지워진 뒤 그 빈 배치가 세션에 저장돼 다음에 켤
    // 때도 사라진 채로 뜬다 — 되돌릴 방법이 없다. 그때는 아무것도 하지 않는다.
    // 화면에는 멈춘 터미널이 남지만, 잃는 것보다 낫다.
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const un = listen<string>("pty:exit", (ev) => {
      // 이미 배치에 없는 칸의 부고는 세지 않는다. 그것까지 세면 진짜 exit 이
      // "여럿 중 하나"가 되어 함께 묻힌다.
      const live = tabsNow.current.some(
        (t) => t.layout && L.leaves(t.layout).includes(ev.payload),
      );
      if (!live) return;
      pending.push(ev.payload);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const ids = pending;
        pending = [];
        if (ids.length !== 1) return;
        setTabs((ts) =>
          ts.map((t) => (t.layout ? { ...t, layout: L.removeLeaf(t.layout, ids[0]) } : t)),
        );
      }, 350);
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
        const sel = termOf(cur.focus)?.getSelection();
        if (sel) void writeText(sel).catch(() => {});
      } else if (k === "v") {
        // term.paste 를 거쳐야 한다. 셸이 bracketed paste 를 켰으면 앞뒤에
        // ESC[200~ / ESC[201~ 를 붙여야 하고, 그 판단은 xterm 이 들고 있다.
        void readText()
          .then((txt) => txt && termOf(cur.focus)?.paste(txt))
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

  // 배치가 바뀌면 React 가 slot DOM 을 실제로 옮기고(insertBefore), 그때 xterm 의
  // 숨은 textarea 가 포커스를 잃는다. Term 쪽 effect 는 focused prop 이 그대로라
  // 다시 돌지 않으므로 여기서 되돌린다. 이걸 안 하면 pane 을 옮긴 뒤 그 pane 에
  // 아무것도 못 친다 — 한글도 영문도 백스페이스도.
  useEffect(() => {
    if (!booted) return;
    termOf(cur?.focus)?.focus();
  }, [cur?.layout, cur?.focus, active, booted]);

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
          <span>작업</span>
          <button className="mini" onClick={pick}>
            {curRoot ? "폴더 바꾸기" : "폴더 열기"}
          </button>
        </div>

        {/* 탭과 pane 을 한 목록으로 둔다. 위에 탭 줄을 따로 두면 같은 것을 두 군데서
            고르게 되고, 정작 "어느 칸에서 무엇이 돌고 있나"는 어디에도 안 보인다.
            탭은 묶음의 제목이고 그 아래가 그 탭의 pane 이다. */}
        <div className="sessions">
          {tabs.map((t, ti) => {
            const slots = t.layout ? L.rects(t.layout) : [];
            return (
              <div key={t.key} className={ti === active ? "tgroup on" : "tgroup"}>
                <div className="tg-head" onMouseDown={() => setActive(ti)}>
                  <span className="tg-name">{t.root?.split("/").pop() ?? "shell"}</span>
                  {ti === active && git.branch ? (
                    <span className="tg-branch">
                      {git.branch}
                      {dirty ? <i>~{dirty}</i> : null}
                    </span>
                  ) : null}
                  {tabs.length > 1 ? (
                    <button
                      className="x"
                      title="탭 닫기"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => closeTab(ti)}
                    >
                      ×
                    </button>
                  ) : null}
                </div>

                {slots.map((sl) => {
                  const st = stat[sl.id];
                  const here = ti === active;
                  const nm = names[sl.id] || sessionTitle[sl.id] || label(sl.id, stat, titles);
                  return (
                    <div
                      key={sl.id}
                      className={here && t.focus === sl.id ? "prow on" : "prow"}
                      title={nm}
                      onMouseDown={() => {
                        setActive(ti);
                        setTabs((ts) => ts.map((x, i) => (i === ti ? { ...x, focus: sl.id } : x)));
                        termOf(sl.id)?.focus();
                      }}
                    >
                      <button
                        className="ico"
                        title="누가 맡을지 고르기"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPicking((v) => (v === sl.id ? null : sl.id));
                        }}
                      >
                        <Face slug={casting[sl.id]} agent={!!st?.agent} />
                      </button>
                      <span className="pmeta">
                        <span className="nm">{nm}</span>
                        <span className="sub">{shortPath(t.root)}</span>
                      </span>
                      {st?.busy ? <span className="work" /> : null}
                      <button
                        className="x"
                        title="닫기"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => closePane(sl.id)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}

                {/* 고르는 칸이 이 탭에 있으면 그 아래에 펼친다. 목록 밖에 띄우면
                    어느 칸의 것인지 흐려지고 자리도 계산해야 한다. */}
                {picking && slots.some((sl) => sl.id === picking) ? (
                  <div className="castpick">
                    {cast.map((m) => (
                      <button
                        key={m.slug}
                        className={casting[picking] === m.slug ? "cp on" : "cp"}
                        title={`${m.name} · ${m.school}`}
                        onClick={() => {
                          setCasting((c) => ({ ...c, [picking]: m.slug }));
                          setPicking(null);
                        }}
                      >
                        <Face slug={m.slug} />
                        <span>{m.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          <button className="newtab" onClick={newTab} title="새 탭 (Ctrl+Shift+T)">
            새 탭
          </button>
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

      </aside>

      <div className="main">
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
                    <div
                      key={s.id}
                      data-pane={s.id}
                      data-proc={stat[s.id]?.proc ?? ""}
                      data-agent={stat[s.id]?.agent ?? ""}
                      data-title={titles[s.id] ?? ""}
                      className="slot"
                      style={pct(s.rect)}
                    >
                      <section
                        className={ti === active && t.focus === s.id ? "pane on" : "pane"}
                        onMouseDown={() => {
                          setTabs((ts) =>
                            ts.map((x, i) => (i === ti ? { ...x, focus: s.id } : x)),
                          );
                          // 이미 focus 인 pane 을 다시 누르면 state 가 안 바뀌어
                          // Term 의 effect 가 돌지 않는다. 포커스를 잃은 채였다면
                          // 클릭해도 안 살아나므로 여기서 직접 준다.
                          termOf(s.id)?.focus();
                        }}
                      >
                        <header
                          className="pane-head"
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            // 이걸 안 하면 헤더를 잡는 순간 포커스가 터미널에서
                            // 헤더로 빠진다.
                            e.preventDefault();
                            const stage = e.currentTarget.closest(".stage");
                            if (!stage) return;
                            paneDrag.current = { from: s.id, box: stage as HTMLElement };
                            dropRef.current = null;
                            document.body.classList.add("pane-dragging");
                          }}
                        >
                          <span className={stat[s.id]?.busy ? "pip work" : "pip"}>
                            <Face slug={casting[s.id]} agent={!!stat[s.id]?.agent} />
                          </span>
                          {renaming === s.id ? (
                            <input
                              className="rename"
                              defaultValue={names[s.id] ?? ""}
                              placeholder="이 pane 의 이름"
                              autoFocus
                              // 헤더는 끌면 pane 이 옮겨진다. 글자를 고르는 중에
                              // 그게 걸리면 안 된다.
                              onMouseDown={(e) => e.stopPropagation()}
                              // 키로 끝냈으면 뒤따르는 blur 는 흘려보낸다. 그러지
                              // 않으면 확정이 두 번 일어나 claude 에 /rename 이
                              // 두 번 날아간다.
                              onBlur={(e) => {
                                if (renameDone.current) {
                                  renameDone.current = false;
                                  return;
                                }
                                commitName(s.id, e.currentTarget.value);
                              }}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") {
                                  renameDone.current = true;
                                  commitName(s.id, e.currentTarget.value);
                                } else if (e.key === "Escape") {
                                  renameDone.current = true;
                                  setRenaming(null);
                                  termOf(s.id)?.focus();
                                }
                              }}
                            />
                          ) : (
                            <span
                              className="title"
                              title={
                                names[s.id]
                                  ? `${names[s.id]} — 두 번 눌러 이름 고치기`
                                  : (sessionTitle[s.id] ?? "") || "두 번 눌러 이름 붙이기"
                              }
                              onDoubleClick={() => setRenaming(s.id)}
                            >
                              {names[s.id] || sessionTitle[s.id] || label(s.id, stat, titles)}
                            </span>
                          )}
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

                        {/* 맡은 아이를 칸 안에 세워 둔다. 헤더의 작은 얼굴만으로는
                            누가 일하는 중인지 눈에 잘 안 들어온다. 마우스는 통과시켜
                            터미널을 고르고 끄는 데 걸리지 않게 한다. */}
                        {stat[s.id]?.agent && faceUrl(casting[s.id]) ? (
                          <img
                            className={
                              stat[s.id]?.busy && !hasWorkFace(casting[s.id])
                                ? "buddy bob"
                                : "buddy"
                            }
                            src={faceUrl(casting[s.id], stat[s.id]?.busy ? "work" : undefined)}
                            alt=""
                            draggable={false}
                          />
                        ) : null}
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
  const t = titles[id];
  const tail = t ? t.split(/[\\/]/).pop() || t : "";
  // 에이전트는 자기 세션 이름을 터미널 타이틀에 실어 보낸다(claude 의 --name
  // 설명에 그렇게 적혀 있다). 그 이름이 "claude" 라는 프로세스 이름보다 훨씬
  // 쓸모 있다 — 여러 개를 띄워 놓으면 헤더가 전부 "claude" 라 구별이 안 된다.
  // claude 는 일하는 중이면 타이틀 앞에 표시를 하나 붙인다(✱ 따위). 그것까지
  // 헤더에 들이면 이름이 밀려 보이므로 앞머리의 기호는 떼고 쓴다.
  const named = tail.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (stat[id]?.agent && named) return named;
  const p = stat[id]?.proc;
  if (p) return p;
  return tail || "shell";
}

/** 홈 아래는 `~` 로 접는다. 목록에서 알고 싶은 것은 어느 프로젝트인지지 전체 경로가 아니다. */
function shortPath(p: string | null): string {
  if (!p) return "셸";
  return p.replace(/^[A-Za-z]:\/Users\/[^/]+/, "~").replace(/\//g, "\\");
}

/** 그 칸을 맡은 캐릭터의 얼굴.
 *
 *  그림이 아직 없으면 그 사람의 색으로 칠한 원에 역할 기호(에이전트=별,
 *  셸=프롬프트)를 얹는다 — 그림이 들어오기 전에도 칸끼리는 구별되어야 한다. */
function Face({ slug, agent }: { slug?: string; agent?: boolean }) {
  const url = faceUrl(slug);
  const who = slug ? bySlug.get(slug) : undefined;
  if (url) return <img className="face" src={url} alt={who?.name ?? ""} draggable={false} />;
  return (
    <span className="face ph" style={who ? { background: who.header_color } : undefined}>
      {agent ? <AgentMark /> : <ShellMark />}
    </span>
  );
}

/** 에이전트가 도는 칸. 무엇이 특별한지 한눈에 보이도록 채운 별로 둔다. */
function AgentMark() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M8 1.6 L9.5 6.3 L14.2 8 L9.5 9.7 L8 14.4 L6.5 9.7 L1.8 8 L6.5 6.3 Z" fill="currentColor" />
    </svg>
  );
}

/** 그냥 셸인 칸. 프롬프트 기호가 곧 그 뜻이다. */
function ShellMark() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M3.2 4.4 L6.6 8 L3.2 11.6 M8.4 11.8 H12.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
