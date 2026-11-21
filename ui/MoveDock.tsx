/** 옆칸 맨 아래의 "다른 PC" — 이은 PC 를 늘 보이고, 칸(머리줄 또는 옆칸의 칸 줄)을 거기에 끌어 놓으면 그 칸이 이사를
 *  보낸다(useDrag `onDropOut` → session-move.ts `dropMove` → ClaudeStreamPane 의 카드). 끌 때만 띄우면 이 길이 있는 줄도
 *  모른다(11월 21일 사용자 — "왼쪽 세션칸에 떠야 할 거 아니야"). 짝지은 PC 가 없으면 잇는 길을 대신 둔다.
 *  묶인 PC 는 늘 붙어 있어(usePeers) 켜짐/꺼짐과 그 PC 에 열린 칸을 같이 보인다 — 세 기기를 한 묶음으로 보이게 한다(11월 22일). */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Face } from "./roster";
import { movableOf, pcNote, pcState, type Peer } from "./session-move";
import { usePeers } from "./usePeers";
import "./remote.css";

export function MoveDock({ from, over, reload, onLink }: {
  /** 끄는 중인 칸. */
  from: string | null;
  /** 지금 마우스 아래의 PC. */
  over: string | null;
  /** 바뀌면 짝지은 PC 를 다시 읽는다 — [폰 연결] 창에서 잇거나 이름을 바꾸거나 잊었을 수 있다. */
  reload: unknown;
  /** [폰 연결] 창을 연다. */
  onLink: () => void;
}) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  // 다른 PC 가 이 PC 와 묶으면(그 PC 에서 [PC 잇기]) 이 PC 의 목록도 바뀐다.
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    const off = listen("remote:peers", () => setChanged((n) => n + 1));
    return () => void off.then((f) => f());
  }, []);
  useEffect(() => {
    let live = true;
    invoke<{ peers: Peer[] }>("remote_status").then(
      (s) => live && setPeers(s.peers),
      () => live && setPeers([]),
    );
    return () => {
      live = false;
    };
  }, [reload, from, changed]);
  const live = usePeers(peers);
  if (peers === null) return null;
  const m = from ? movableOf(from) : undefined;
  return (
    <div className={from ? "side-pcs dragging" : "side-pcs"} data-drop-dock="" role="group" aria-label="다른 PC">
      <div className="side-dev">다른 PC</div>
      {peers.length ? (
        peers.map((p) => {
          const state = pcState(live[p.id]?.status);
          const note = pcNote({ dragging: !!from, movable: !!m, lock: m?.lock ?? null, over: over === p.id, state });
          const panes = live[p.id]?.panes ?? [];
          return (
            <div
              key={p.id}
              className={note.lock ? "pc-row off" : over === p.id ? "pc-row on" : "pc-row"}
              data-drop-out={p.id}
              data-locked={note.lock ? "" : undefined}
              data-state={state}
              title={p.name}
            >
              <div className="pc-line">
                <span className="pc-ico">
                  <PcIcon />
                  <i className={`pc-dot ${state}`} />
                </span>
                <span className="pmeta">
                  <span className="nm">{p.name}</span>
                  <span className="sub">{note.text}</span>
                </span>
              </div>
              {panes.length ? (
                <div className="pc-panes">
                  {panes.map((x) => (
                    <div key={x.id} className="pc-pane" title={x.title || x.name || undefined}>
                      <Face slug={x.slug ?? undefined} agent />
                      <span className="pc-pane-nm">{x.title || x.name || (x.agent === "codex" ? "Codex" : "Claude")}</span>
                      {x.busy || x.tasks ? <span className="work" /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <button className="pc-row pc-link" onClick={onLink}>
          <span className="pc-line">
            <span className="pc-ico">
              <PlusIcon />
            </span>
            <span className="pmeta">
              <span className="nm">다른 PC 잇기</span>
              <span className="sub">한 번 이으면 두 PC 와 폰이 묶인다</span>
            </span>
          </span>
        </button>
      )}
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

/** Lucide plus. */
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
