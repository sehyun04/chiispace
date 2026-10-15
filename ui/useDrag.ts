/** 배치를 손으로 바꾸는 두 가지 끌기 — 경계선 끌기(비율)와 칸을 머리줄째 끌어 옮기기. */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import * as L from "./layout";
import type { Tab } from "./saved";

/** 경계선 끌기. 기준 상자는 그 경계선이 속한 무대다 — 탭마다 무대가 따로 있어
 *  ref 하나로는 어느 무대인지 알 수 없다. */
export function useSeamDrag(active: number, setTabs: Dispatch<SetStateAction<Tab[]>>) {
  const drag = useRef<{ path: number[]; dir: L.Dir; parent: L.Rect; box: HTMLElement } | null>(null);

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
  }, [active, setTabs]);

  return useCallback((seam: { path: number[]; dir: L.Dir; parent: L.Rect }, box: HTMLElement) => {
    document.body.classList.add("dragging");
    drag.current = { path: seam.path, dir: seam.dir, parent: seam.parent, box };
  }, []);
}

/** pane 을 헤더째 끌어 옮기기. 가운데에 놓으면 자리 맞바꾸기, 가장자리에
 *  놓으면 그쪽으로 갈라 붙인다 — 배치를 한 번에 원하는 모양으로 만들려면
 *  맞바꾸기만으로는 모자란다. */
export function usePaneDrag(cur: Tab | undefined, patch: (fn: (t: Tab) => Tab) => void) {
  // 어디에 놓일지는 렌더에도 필요해 state 로 두고, mouseup 핸들러가 닫힌 값을
  // 보지 않도록 ref 에도 같이 들고 있는다.
  const paneDrag = useRef<{ from: string; box: HTMLElement } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; side: L.Side } | null>(null);
  const dropRef = useRef<{ id: string; side: L.Side } | null>(null);

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

  const start = useCallback((from: string, box: HTMLElement) => {
    paneDrag.current = { from, box };
    dropRef.current = null;
    document.body.classList.add("pane-dragging");
  }, []);

  return { dropAt, start };
}
