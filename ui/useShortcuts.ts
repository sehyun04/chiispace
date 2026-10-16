/** 앱 단축키. 표는 README "단축키" 절에 있다.
 *
 *  캡처 단계로 잡아야 한다(결정 3번). xterm 은 숨은 textarea 에서 키를 받으므로
 *  버블 단계에서는 이미 셸로 흘러간 뒤다. */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as L from "./layout";
import type { Tab } from "./saved";
import { termOf } from "./focus";

export function useShortcuts(
  cur: Tab,
  tabCount: number,
  /** 대화창 칸. 키를 입력바가 받는다. */
  chats: MutableRefObject<Record<string, unknown>>,
  act: {
    split: (dir: L.Dir) => void;
    closePane: (id: string) => void;
    newTab: () => void;
    pick: () => Promise<void>;
    patch: (fn: (t: Tab) => Tab) => void;
    setFontSize: Dispatch<SetStateAction<number>>;
    setSideOpen: Dispatch<SetStateAction<boolean>>;
    setActive: Dispatch<SetStateAction<number>>;
  },
) {
  const { split, closePane, newTab, pick, patch, setFontSize, setSideOpen, setActive } = act;
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
      // 대화창 칸에서는 복사·붙여넣기를 브라우저에 맡긴다. 그 칸에는 가로채 건넬 터미널이 없다.
      if ((k === "c" || k === "v") && chats.current[cur.focus]) return;
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
      else if (k === "b") setSideOpen((v) => !v);
      else if (k === "pageup") setActive((a) => (a - 1 + tabCount) % tabCount);
      else if (k === "pagedown") setActive((a) => (a + 1) % tabCount);
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
  }, [cur, tabCount, split, closePane, newTab, pick, patch, chats, setFontSize, setSideOpen, setActive]);
}
