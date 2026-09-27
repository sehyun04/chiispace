/** 서브에이전트 한 명의 대화 전체.
 *
 *  대화창에는 서브에이전트마다 "지금 하는 일" 한 줄만 보인다. 그 줄이나 본 대화의 "… 부름" 줄을
 *  누르면 여기서 그 서브에이전트가 무엇을 읽고 무엇을 돌렸는지 전부 본다. 원문은 claude 가 본 대화
 *  옆에 따로 쓰는 `<대화 id>/subagents/agent-<id>.jsonl` 이다(workspace.rs). 누른 줄이 가리키는
 *  것만 연다 — 고르지 않는다.
 *
 *  말풍선은 본 대화와 같은 모양으로 그린다(Chat.tsx 의 Row 를 받아 쓴다). 다만 서브에이전트의
 *  첫 말은 사용자가 아니라 본 대화의 claude 가 맡긴 일이라 "맡긴 일" 로 따로 보인다. */
import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Markdown } from "./Markdown";
import { buildToolMap, parseJsonl, toItems, type Bubble, type Item } from "./transcript";

/** 열어 볼 서브에이전트. 진행 줄은 에이전트 id 를, "… 부름" 줄은 부른 호출 id 를 안다. */
export type SubTarget = { agent?: string; toolUseId?: string; label: string };

/** 누르는 자리(진행 줄·"부름" 줄)가 이것으로 연다. 칸 위 덮개(ChatPane)가 채운다. */
export const OpenSubContext = createContext<((t: SubTarget) => void) | null>(null);

type Info = { agent: string; agentType?: string; description?: string; toolUseId?: string };
export type RowOpts = { key: number; showFace: boolean; grouped: boolean; name: string };

export function SubagentView({
  root,
  session,
  target,
  onClose,
  renderRow,
}: {
  root: string;
  session: string;
  target: SubTarget;
  onClose: () => void;
  renderRow: (item: Item, o: RowOpts) => ReactNode;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const back = useRef<HTMLButtonElement>(null);

  // 어느 파일인지 찾는다. 막 불린 서브에이전트는 파일이 조금 늦게 생기므로 찾을 때까지 다시 본다.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const find = () => {
      invoke<Info[]>("claude_subagents", { root, id: session })
        .then((list) => {
          if (!alive) return;
          const hit = list.find((s) =>
            target.agent ? s.agent === target.agent : !!target.toolUseId && s.toolUseId === target.toolUseId,
          );
          if (hit) setInfo(hit);
          else timer = window.setTimeout(find, 1000);
        })
        .catch(() => {
          if (alive) timer = window.setTimeout(find, 1000);
        });
    };
    find();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [root, session, target.agent, target.toolUseId]);

  // 원문은 크기가 바뀔 때만 다시 받는다. 일하는 중이면 계속 자란다.
  useEffect(() => {
    if (!info) return;
    let alive = true;
    let size = -1;
    const args = { root, id: session, agent: info.agent };
    const tick = () => {
      invoke<number>("claude_subagent_size", args)
        .then((n) => {
          if (!alive || n === size) return;
          size = n;
          return invoke<string>("claude_subagent_raw", args).then((t) => {
            if (alive) setRaw(t);
          });
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [root, session, info]);

  // Esc 는 이 화면만 닫는다. 입력바가 아래에 깔려 있어 그대로 두면 Esc 가 claude 로 가서
  // 하던 일을 멈춘다 — 보려고 연 화면을 닫다가 작업을 끊으면 안 된다.
  // 한 번만 건다. 부른 쪽이 그릴 때마다 새 onClose 를 주는데, 그때마다 다시 걸면 포커스도
  // 매번 여기로 끌려온다.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    back.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const items = useMemo(() => {
    if (!raw) return [] as Item[];
    const events = parseJsonl(raw);
    // 서브에이전트 원문은 레코드가 전부 사이드체인이다. 기본 규칙대로 거르면 통째로 빈다.
    return toItems(events, buildToolMap(events), true);
  }, [raw]);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const name = info?.agentType ?? "서브에이전트";
  const title = info?.description ?? target.label;
  // 첫 사용자 말은 맡긴 일이다. 그 뒤의 사용자 말(드물다)은 그대로 둔다.
  const task = items.findIndex((it) => it.kind === "bubble" && it.role === "user");

  return (
    <div className="subview" role="dialog" aria-label={`서브에이전트 대화 · ${title}`}>
      <div className="subview-head">
        <button ref={back} className="subview-back" onClick={onClose} title="본 대화로 (Esc)">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          본 대화로
        </button>
        <span className="subview-title">{title}</span>
        <span className="subview-kind">{name}</span>
      </div>
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!info || raw === null ? (
          <div className="chat-empty">서브에이전트 기록을 찾는 중</div>
        ) : items.length === 0 ? (
          <div className="chat-empty">아직 적힌 것이 없다</div>
        ) : (
          items.map((item, i) => {
            if (i === task) {
              return (
                <div className="subview-task" key={i}>
                  <div className="tool-label">claude 가 맡긴 일</div>
                  <Markdown text={(item as Bubble).text} />
                </div>
              );
            }
            const prev = items[i - 1];
            const next = items[i + 1];
            const isB = item.kind === "bubble";
            const same = (o?: Item) => o?.kind === "bubble" && isB && o.role === (item as Bubble).role;
            return renderRow(item, { key: i, showFace: !same(prev), grouped: same(next), name });
          })
        )}
      </div>
    </div>
  );
}
