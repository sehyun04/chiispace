import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PaneStat } from "./session";
import type { Terminal } from "@xterm/xterm";
import { emptyAgentPrompt } from "./agent-input";

export type Surface = {
  id: string;
  workspace_id: string;
  title: string | null;
  cwd: string | null;
  character: string | null;
};

export type BridgeSnapshot = {
  workspaces: { id: string; name: string }[];
  surfaces: Surface[];
  current: string | null;
  focused: string | null;
  neighbors: Record<string, Record<string, string>>;
};

export type BridgeAction = {
  request: number;
  expires: number;
  action: "focus" | "split" | "close" | "peek";
  surface: string;
  direction: "left" | "right" | "up" | "down" | "auto" | null;
  focus: boolean;
  lines: number;
};

export function usePaneBridge(
  booted: boolean,
  snapshot: BridgeSnapshot,
  act: (action: BridgeAction) => string,
) {
  const latest = useRef({ snapshot, act });
  latest.current = { snapshot, act };
  const serialized = JSON.stringify(snapshot);

  useEffect(() => {
    if (!booted) return;
    let alive = true;
    let checking = false;
    const tick = async () => {
      if (checking) return;
      checking = true;
      try {
        const pending = await invoke<{ task_id: string; pane: string; revision: number }[]>("collab_pending");
        for (const task of pending) {
          if (!alive) break;
          const term = (window as unknown as { __terms?: Record<string, Terminal> }).__terms?.[task.pane];
          if (!term) continue;
          const buffer = term.buffer.active;
          const row = buffer.getLine(buffer.baseY + buffer.cursorY);
          const screen = Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").join("\n");
          if (!row || !emptyAgentPrompt(row.translateToString(true), row.translateToString(false, 0, buffer.cursorX), screen)) continue;
          await invoke("collab_deliver", { taskId: task.task_id, revision: task.revision });
        }
      } catch (error) { console.error(error); }
      finally { checking = false; }
    };
    const timer = setInterval(() => { void tick(); }, 800);
    return () => { alive = false; clearInterval(timer); };
  }, [booted]);

  useEffect(() => {
    if (booted) void invoke("bridge_sync", { snapshot: JSON.parse(serialized) }).catch(console.error);
  }, [booted, serialized]);

  useEffect(() => {
    if (!booted) return;
    let alive = true;
    const off = listen<BridgeAction>("bridge:action", async ({ payload }) => {
      if (!alive || Date.now() >= payload.expires) return;
      try {
        if (payload.action === "peek") {
          const term = (window as unknown as { __terms?: Record<string, Terminal> }).__terms?.[payload.surface];
          if (!term) throw new Error("칸이 준비되지 않았습니다");
          // 엔진의 plain-text 추출은 한글 뒤의 보조 셀까지 공백으로 만든다.
          // 실제 표시를 소유한 xterm에서 읽어야 두 칸 글자와 결합 문자가 보존된다.
          const buffer = term.buffer.active;
          const end = buffer.baseY + term.rows;
          const rows: string[] = [];
          for (let y = Math.max(buffer.baseY, end - payload.lines); y < end; y++) {
            rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
          }
          await invoke("bridge_reply", { request: payload.request, result: rows.join("\n") });
          return;
        }
        let id = "";
        // Rust 쪽 목록과 React 배치를 같은 렌더 기준으로 맞춘 뒤에만 성공을 답한다.
        flushSync(() => { id = latest.current.act(payload); });
        const snapshot = latest.current.snapshot;
        await invoke("bridge_sync", { snapshot });
        const surface = snapshot.surfaces.find((s) => s.id === id);
        if (payload.action === "split" && !surface) throw new Error("새 칸이 배치에 없습니다");
        if (payload.action === "split" || payload.action === "close") {
          let ready = false;
          while (alive && Date.now() < payload.expires - 200) {
            const panes = await invoke<PaneStat[]>("pane_status");
            const exists = panes.some((p) => p.id === id);
            if (exists === (payload.action === "split")) { ready = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!ready) throw new Error("칸 상태 확인 시간 초과; 목록을 확인하세요");
        }
        await invoke("bridge_reply", { request: payload.request, result: surface ?? null });
      } catch (error) {
        await invoke("bridge_reply", { request: payload.request, error: String(error) }).catch(console.error);
      }
    });
    return () => { alive = false; void off.then((unlisten) => unlisten()); };
  }, [booted]);
}
