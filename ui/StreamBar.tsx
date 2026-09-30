/** 터미널 없는 칸의 입력바 위 줄 — Claude·Codex 가 같이 쓴다.
 *
 *  두 칸이 따로 그리면 같은 자리에 다른 모양·다른 순서가 서고, 한쪽에만 단추가 생긴다(실제로 그랬다).
 *  무엇을 고를 수 있는지는 에이전트마다 다르므로 항목은 부른 쪽이 주고, 모양과 순서는 여기서 정한다:
 *  모델 · 추론 · 권한 · [상태] [새 대화], 상태를 펴면 그 아래에 같은 항목의 표. */
import type { ReactNode, Ref } from "react";

export type BarChoice = { value: string; label: string; title?: string };
export type BarField = {
  label: string;
  value: string;
  choices: BarChoice[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 검증이 찾는 이름. 없으면 라벨을 쓴다. */
  aria?: string;
  title?: string;
  /** 입력바의 `/model` 처럼 선택 상자로 포커스를 옮길 때. */
  selectRef?: Ref<HTMLSelectElement>;
};

/** 추론 수준의 이름. Claude(`effortLevel`)와 Codex(`reasoningEffort`)가 같은 낱말을 쓴다. */
const EFFORT: Record<string, string> = {
  none: "끔",
  minimal: "최소",
  low: "낮게",
  medium: "보통",
  high: "높게",
  xhigh: "아주 높게",
  max: "최대",
};
export const effortLabel = (v: string) => EFFORT[v] ?? v;

/** 상태 표의 모델. 표시 이름만 두면 실제로 어느 모델인지 모르고, ID 만 두면 줄의 이름과 안 맞는다. */
export const modelLabel = (display?: string, id?: string) =>
  display && id && display !== id ? `${display} · ${id}` : (display ?? id ?? "연결 중");

/** 상태 표의 폴더. 두 칸이 같은 표기로 보이게 Windows 경로로 쓴다. */
export const folderLabel = (p: string) => (p ? p.replace(/\//g, "\\") : "홈");

export function StreamBar({
  model,
  effort,
  permission,
  statusOpen,
  onStatus,
  onNew,
  busy,
  status,
  statusClass,
}: {
  model: BarField;
  /** 고를 수 있는 수준이 없는 모델이면 비운다. */
  effort?: BarField;
  permission: BarField;
  statusOpen: boolean;
  onStatus: () => void;
  onNew: () => void;
  /** 일하는 중이면 새 대화를 막는다 — 하던 턴이 끊긴다. */
  busy: boolean;
  status: [string, ReactNode][];
  statusClass?: string;
}) {
  return (
    <>
      <div className="stream-bar">
        {/* 칸이 좁으면 선택 상자만 줄을 넘긴다. 단추는 한 묶음으로 오른쪽 위에 둬야 두 칸에서 같은 자리에 선다. */}
        <div className="stream-bar-fields">
        {[model, effort, permission].map((f) =>
          f ? (
            <label key={f.label}>
              <span>{f.label}</span>
              <select
                ref={f.selectRef}
                aria-label={f.aria ?? f.label}
                value={f.value}
                disabled={f.disabled || !f.choices.length}
                title={f.title}
                onChange={(e) => f.onChange(e.target.value)}
              >
                {f.choices.map((c) => (
                  <option key={c.value} value={c.value} title={c.title}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null,
        )}
        </div>
        <div className="stream-bar-acts">
        <button type="button" className={statusOpen ? "on" : undefined} aria-expanded={statusOpen} onClick={onStatus}>
          상태
        </button>
        <button type="button" disabled={busy} onClick={onNew} title="이 칸에서 새 대화를 시작한다">
          새 대화
        </button>
        </div>
      </div>
      {statusOpen && (
        <div className={["stream-status", statusClass].filter(Boolean).join(" ")} role="status">
          {status.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
