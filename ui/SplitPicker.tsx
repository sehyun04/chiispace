/** 칸 나누기(Ctrl+Shift+D·E)에서 새 칸에 누구를 부를지 고르는 창.
 *
 *  나누면 곧바로 셸이 뜨던 것을 옆칸의 새 대화처럼 상대부터 고르게 했다 — 대화창이 메인이 될 쪽이라
 *  셸을 연 뒤 명령을 치는 단계를 사용자에게 넘기지 않는다. 단축키로 연 창이라 손은 키보드에 있다:
 *  숫자·방향키·Enter 로 고르고 Esc 로 닫는다. */
import { useEffect, useState } from "react";
import type * as L from "./layout";
import { ShellMark } from "./roster";
import { ClaudeMark, CodexMark, type AgentKind } from "./Sidebar";

export type SplitChoice = AgentKind | "shell";

const CHOICES: { kind: SplitChoice; name: string; sub: string }[] = [
  { kind: "claude", name: "Claude", sub: "대화창" },
  { kind: "codex", name: "Codex", sub: "대화창" },
  { kind: "shell", name: "터미널", sub: "셸만" },
];

export function SplitPicker({
  dir,
  folder,
  onPick,
  onClose,
}: {
  dir: L.Dir;
  folder?: string;
  onPick: (kind: SplitChoice) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 나누기 단축키는 앱 단축키가 받아 방향만 바꾼다. 나머지 Ctrl+Shift 단축키도 그대로 둔다.
      if (e.ctrlKey && e.shiftKey) return;
      const n = Number(e.key);
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") onPick(CHOICES[at].kind);
      else if (n >= 1 && n <= CHOICES.length) onPick(CHOICES[n - 1].kind);
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey))
        setAt((a) => (a + 1) % CHOICES.length);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "Tab")
        setAt((a) => (a + CHOICES.length - 1) % CHOICES.length);
      // 고르는 동안 포커스는 아래 칸에 남아 있다. 키가 새면 claude 입력에 글자가 들어간다.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [at, onPick, onClose]);

  return (
    <div
      className="split-back"
      onMouseDown={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {/* 눌러도 포커스를 아래 칸에서 빼앗지 않는다 — 닫은 뒤 손으로 되돌릴 일이 없다. */}
      <div
        className="split-pick"
        role="dialog"
        aria-label="새 칸"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="split-head">
          <span>{dir === "h" ? "오른쪽" : "아래"}에 새 칸 · 누구랑 할까</span>
          {folder ? <span className="split-folder">{folder}</span> : null}
        </div>
        <div className="split-list">
          {CHOICES.map((c, i) => (
            <button
              key={c.kind}
              className={i === at ? "split-opt on" : "split-opt"}
              data-kind={c.kind}
              onMouseEnter={() => setAt(i)}
              onClick={() => onPick(c.kind)}
            >
              <kbd>{i + 1}</kbd>
              <span className={`ct-ico ${c.kind}`}>
                {c.kind === "claude" ? <ClaudeMark /> : c.kind === "codex" ? <CodexMark /> : <ShellMark />}
              </span>
              <span className="split-name">{c.name}</span>
              <span className="split-sub">{c.sub}</span>
            </button>
          ))}
        </div>
        <div className="split-foot">방향키로 고르고 Enter · Esc 닫기</div>
      </div>
    </div>
  );
}
