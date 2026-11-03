/** 세션 파일 — 끄기 전 배치와 칸마다 되살릴 것을 적고 읽는다.
 *
 *  React 도 Tauri 도 모르는 순수 함수만 둔다. 저장 모양이 바뀌면 옛 파일이 그대로 열리는지가
 *  깨지기 쉬운 자리라, 앱을 띄우지 않고 단위 검증(saved.test.mjs)으로 잡는다. */
import * as L from "./layout.ts";
import { savedPaneTitles, streamCandidates, type Seed } from "./session.ts";
import type { StreamChat } from "./stream-session.ts";

/** 탭 하나 = 작업 하나. 자기 배치와 자기 폴더와 자기 셸을 갖는다.
 *
 *  셸이 탭에 붙는 이유: 칸을 나누면(Ctrl+Shift+D) 새 칸은 옆 칸과 같은 일을 하려고
 *  나눈 것이지 다른 셸을 쓰려는 게 아니다. 다른 셸이 필요하면 탭을 새로 연다.
 *  없으면 엔진 기본이고, 그것이 지금까지의 동작이라 옛 세션 파일도 그대로 열린다. */
export type Tab = { key: string; layout: L.Node | null; root: string | null; focus: string; shell?: string };

/** 파일에 적힌 그대로의 모양. 판마다 붙은 필드가 달라 전부 없을 수 있다고 본다. */
export type SavedSession = {
  tabs?: Tab[];
  active?: number;
  nextPane?: number;
  nextTab?: number;
  fontSize?: number;
  procs?: Record<string, unknown>;
  restoreMode?: string;
  names?: Record<string, string>;
  paneTitles?: unknown;
  casting?: Record<string, string>;
  sideOpen?: boolean;
  streams?: unknown;
  keepTerminal?: unknown;
  subPanes?: unknown;
};

/** 본 대화가 부른 서브에이전트를 옆에서 보이는 칸. 읽기만 한다 — 그 서브에이전트의 대화 파일을 그린다. */
export type SubPaneInfo = { parent: string; root: string; session: string; agent: string; label: string; done?: boolean };

/** 저장된 서브에이전트 칸. 다시 켤 때는 그 서브에이전트가 이미 내려갔으므로 모두 끝난 것으로 읽는다.
 *  대화 id 와 에이전트 id 는 파일 경로가 되므로 모양이 맞는 것만 받는다. */
export function savedSubPanes(value: unknown): Record<string, SubPaneInfo> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap<[string, SubPaneInfo]>(([id, raw]) => {
    const s = raw as Record<string, unknown> | null;
    if (!/^%\d+$/.test(id) || !s || typeof s.root !== "string" || typeof s.parent !== "string" || !/^%\d+$/.test(s.parent)) return [];
    if (typeof s.session !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s.session)) return [];
    if (typeof s.agent !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s.agent)) return [];
    const label = typeof s.label === "string" ? s.label.slice(0, 200) : "서브에이전트";
    return [[id, { parent: s.parent, root: s.root, session: s.session, agent: s.agent, label, done: true }]];
  }));
}

/** 깨진 세션 파일은 없는 것으로 본다 — 기본값으로 켜는 편이 못 켜는 것보다 낫다. */
export function readSaved(raw: string | null): SavedSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === "object" && !Array.isArray(s) ? (s as SavedSession) : null;
  } catch {
    return null;
  }
}

export const leavesOf = (tabs: Tab[]): string[] => tabs.flatMap((t) => (t.layout ? L.leaves(t.layout) : []));

/** 켤 때 터미널 없는 칸으로 옮길 Claude 칸을 고른다. 대화 파일이 그 폴더에 실제로 있는 것만 —
 *  다른 폴더에서 열었던 대화라 못 찾으면 새 대화로 덮게 되므로 예전처럼 터미널로 연다.
 *  `transcriptSize` 는 앱에서는 `claude_transcript_size` 이고, 검증에서는 흉내 낸다. */
export async function bootStreams(
  seeds: Record<string, Seed>,
  keep: Record<string, true>,
  tabs: Tab[] | undefined,
  transcriptSize: (root: string, id: string) => Promise<number>,
): Promise<{ seeds: Record<string, Seed>; moved: Record<string, StreamChat> }> {
  const rest = { ...seeds };
  const moved: Record<string, StreamChat> = {};
  const rootOf = (id: string) => tabs?.find((t) => t.layout && L.leaves(t.layout).includes(id))?.root;
  for (const c of streamCandidates(rest, keep, rootOf)) {
    const size = await transcriptSize(c.cwd, c.session).catch(() => 0);
    if (size > 0) {
      moved[c.id] = { agent: "claude", session: c.session, cwd: c.cwd };
      delete rest[c.id];
    }
  }
  return { seeds: rest, moved };
}

/** 저장할 것. 닫힌 칸의 것은 빼고 적는다 — 남겨 두면 다음에 같은 id 로 뜬 새 칸이 그것을 물려받는다. */
export function savedJson(s: {
  tabs: Tab[];
  active: number;
  nextPane: number;
  nextTab: number;
  fontSize: number;
  procs: Record<string, Seed>;
  names: Record<string, string>;
  paneTitles: Record<string, string>;
  casting: Record<string, string>;
  sideOpen: boolean;
  streams: Record<string, StreamChat>;
  keepTerm: Record<string, true>;
  subPanes: Record<string, SubPaneInfo>;
}): string {
  const live = new Set(leavesOf(s.tabs));
  const procs: Record<string, Seed> = {};
  for (const [id, cmd] of Object.entries(s.procs)) {
    if (live.has(id)) procs[id] = cmd;
  }
  return JSON.stringify({
    tabs: s.tabs,
    active: s.active,
    nextPane: s.nextPane,
    nextTab: s.nextTab,
    fontSize: s.fontSize,
    procs,
    restoreMode: "native-continue",
    names: s.names,
    paneTitles: savedPaneTitles(s.paneTitles, live),
    casting: s.casting,
    sideOpen: s.sideOpen,
    streams: Object.fromEntries(Object.entries(s.streams).filter(([id]) => live.has(id))),
    keepTerminal: Object.keys(s.keepTerm).filter((id) => live.has(id)),
    subPanes: Object.fromEntries(Object.entries(s.subPanes).filter(([id]) => live.has(id))),
  });
}
