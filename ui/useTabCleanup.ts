/** 칸이 사라질 때 배치를 정리한다 — 셸이 끝난 칸 지우기, 빈 탭 치우기, 사라진 칸에서 포커스 옮기기. */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import * as L from "./layout";
import type { Tab } from "./saved";

export function useTabCleanup(
  tabs: Tab[],
  tabsNow: MutableRefObject<Tab[]>,
  setTabs: Dispatch<SetStateAction<Tab[]>>,
  setActive: Dispatch<SetStateAction<number>>,
) {
  // 셸이 끝나면 그 pane 은 사라진다 — 터미널에서 exit 을 친 사람이 기대하는
  // 동작이다. 어느 탭에 있든 지워야 한다.
  useEffect(() => {
    // 부고가 오면 곧바로 지우지 않고 잠깐 모은다(결정 7번).
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
  }, [tabsNow, setTabs]);

  // 칸이 하나도 없는 탭은 치운다. "셸이 다 닫혔어"만 남은 탭이 목록에 쌓이면
  // 켤 때마다 어느 탭이 살아 있는지 세어 봐야 한다. 마지막 하나는 남긴다 —
  // 전부 닫혔을 때 새 셸을 여는 자리가 있어야 한다.
  useEffect(() => {
    setTabs((ts) => {
      if (ts.length <= 1) return ts;
      const live = ts.filter((t) => t.layout);
      if (!live.length || live.length === ts.length) return ts;
      setActive((a) => Math.min(a, live.length - 1));
      return live;
    });
  }, [tabs, setTabs, setActive]);

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
  }, [tabs, setTabs]);
}
