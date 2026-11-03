/** 오케스트레이션할 때 본 대화가 부른 서브에이전트마다 옆에 칸을 열어, 그 대화를 실시간으로 보인다.
 *
 *  대화창의 진행 줄은 서브에이전트마다 한 줄이라 어디까지 했는지가 안 보였다(11월 3일 사용자). 칸은 읽기만 하고
 *  끝나도 남는다 — 무엇을 했는지 다 보고 닫는 것은 사람이다. 사용자가 닫은 서브에이전트는 다시 열지 않는다.
 *  Claude 대화창만이다. 프록시가 서브에이전트 스트림을 본 대화의 id 와 함께 알려 주는(`chat:sub`) 칸이다. */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { applySub, subFinished, type Sub, type SubEvent } from "./live";
import type { PaneStat } from "./session";
import type { StreamChat } from "./stream-session";
import type { SubPaneInfo, Tab } from "./saved";
import * as L from "./layout";

/** 이만큼 조용하면 끝난 것으로 본다. 끝 신호를 못 본 경우의 안전망이다(진행 줄과 같은 값). */
const QUIET_MS = 10 * 60_000;

export function useSubPanes({ streams, setTabs, nextPane, setPaneTitles }: {
  streams: Record<string, StreamChat>;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  nextPane: MutableRefObject<number>;
  setPaneTitles: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [subPanes, setSubPanes] = useState<Record<string, SubPaneInfo>>({});
  // 스트림 조각은 렌더보다 빨리 온다. 서브에이전트 둘이 같은 틈에 뜨면 state 로는 앞 칸을 못 봐 둘 다 본 칸을
  // 나누므로 칸 목록은 ref 가 주인이고 state 는 그리기용으로 따라간다.
  const panes = useRef<Record<string, SubPaneInfo>>({});
  // 본 서브에이전트(대화 id|에이전트 id). 칸을 닫아도 지우지 않는다 — 지우면 다음 조각에 칸이 다시 뜬다.
  const seen = useRef(new Map<string, { pane: string; sub: Sub }>());
  const streamsNow = useRef(streams);
  streamsNow.current = streams;

  const put = useCallback((id: string, info: SubPaneInfo) => {
    panes.current = { ...panes.current, [id]: info };
    setSubPanes(panes.current);
  }, []);

  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    const finish = (id: string) => {
      const p = panes.current[id];
      if (p && !p.done) put(id, { ...p, done: true });
    };
    void listen<SubEvent>("chat:sub", (e) => {
      const ev = e.payload;
      const key = `${ev.session}|${ev.agent}`;
      const now = Date.now();
      const known = seen.current.get(key);
      if (known) {
        known.sub = applySub([known.sub], ev, now)[0] ?? known.sub;
        if (subFinished(known.sub)) finish(known.pane);
        return;
      }
      if (ev.phase === "end") return;
      const all = streamsNow.current;
      const parent = Object.keys(all).find((id) => all[id].agent === "claude" && all[id].session.toLowerCase() === ev.session);
      const sub = applySub([], ev, now)[0];
      if (!parent || !sub) return;
      const chat = all[parent];
      const id = `%${nextPane.current++}`;
      seen.current.set(key, { pane: id, sub });
      const kin = Object.keys(panes.current).filter((p) => panes.current[p].parent === parent);
      put(id, { parent, root: chat.cwd, session: chat.session, agent: ev.agent, label: sub.label });
      setPaneTitles((t) => ({ ...t, [id]: sub.label }));
      // 포커스는 그대로 본 칸에 둔다. 지시하던 사람의 입력바를 빼앗지 않는다.
      setTabs((ts) => ts.map((t) => (t.layout && L.leaves(t.layout).includes(parent) ? { ...t, layout: L.attach(t.layout, parent, kin, id) } : t)));
    }).then((f) => {
      if (alive) off = f;
      else f();
    });
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const s of seen.current.values()) if (now - s.sub.at >= QUIET_MS) finish(s.pane);
    }, 30_000);
    return () => {
      alive = false;
      off?.();
      window.clearInterval(timer);
    };
  }, [put, setTabs, setPaneTitles, nextPane]);

  /** 켤 때 저장된 서브에이전트 칸을 얹는다. 그 서브에이전트들은 이미 내려갔다(`savedSubPanes` 가 끝난 것으로 읽는다). */
  const adopt = useCallback((saved: Record<string, SubPaneInfo>) => {
    panes.current = { ...panes.current, ...saved };
    setSubPanes(panes.current);
  }, []);

  /** 머리줄·옆칸이 보는 상태. 일하는 동안만 일하는 중이다 — 테두리와 춤추는 얼굴이 그것을 따른다. */
  const view = useMemo(() => {
    const out: Record<string, PaneStat> = {};
    for (const [id, s] of Object.entries(subPanes)) out[id] = { id, proc: null, agent: "claude", busy: !s.done, working: !s.done, cwd: s.root };
    return out;
  }, [subPanes]);

  return { subPanes, view, adopt };
}
