/** 대화창 칸을 머리줄째 끄는 동안 옆칸 아래에 뜨는 놓을 곳 — 짝지은 PC. 거기에 놓으면 그 칸이 이사를 보낸다
 *  (useDrag `onDropOut` → session-move.ts `dropMove` → ClaudeStreamPane 의 카드). 이사할 수 없는 칸이면 흐리게 두고 까닭을 보인다. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { movableOf, type Peer } from "./session-move";
import "./remote.css";

export function MoveDock({ from, over }: {
  /** 끄는 중인 칸. */
  from: string | null;
  /** 지금 마우스 아래의 PC. */
  over: string | null;
}) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const m = from ? movableOf(from) : undefined;
  const movable = !!m;
  useEffect(() => {
    setPeers(null);
    if (!from || !movable) return;
    let live = true;
    invoke<{ peers: Peer[] }>("remote_status").then(
      (s) => live && setPeers(s.peers),
      () => live && setPeers([]),
    );
    return () => {
      live = false;
    };
  }, [from, movable]);
  // 짝지은 PC 가 없으면 띄우지 않는다. 칸 자리만 바꾸려고 끌 때마다 빈 상자가 뜨면 방해다.
  if (!m || !peers?.length) return null;
  return (
    <div className="move-dock" data-drop-dock="" role="group" aria-label="다른 PC 로 이사">
      <div className="move-dock-title">다른 PC 로 이사</div>
      {peers.map((p) => (
        <div
          key={p.id}
          className={m.lock ? "move-dock-pc off" : over === p.id ? "move-dock-pc on" : "move-dock-pc"}
          data-drop-out={p.id}
          data-locked={m.lock ? "" : undefined}
        >
          <PcIcon />
          <span>{p.name}</span>
        </div>
      ))}
      <div className={m.lock ? "move-dock-note bad" : "move-dock-note"}>{m.lock ?? "놓으면 그 PC 로 옮기고 이 칸은 닫는다"}</div>
    </div>
  );
}

/** Lucide monitor. */
function PcIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}
