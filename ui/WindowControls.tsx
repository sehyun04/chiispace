import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 창 단추(내리기·키우기·닫기). OS 제목줄을 걷어 낸 대신 창 오른쪽 위, 맨 위 오른쪽 칸의 머리줄 끝에 붙는다.
 *  제목줄은 "chiispace" 한 줄로 세로 한 칸을 늘 먹었는데, 칸마다 머리줄이 이미 있어 같은 자리에 줄이 둘이었다. */
export function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    let off: (() => void) | undefined;
    let gone = false;
    const sync = () => w.isMaximized().then((m) => !gone && setMax(m)).catch(() => {});
    sync();
    w.onResized(sync).then((u) => (gone ? u() : (off = u))).catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  const w = () => getCurrentWindow();
  return (
    // 단추 사이 틈과 왼쪽 여백은 창을 끌어 옮기는 손잡이다. 칸 머리줄은 칸 끌기에 쓰여 창 끌기를 줄 수 없고,
    // 옆칸을 접으면 옆칸 맨 윗줄도 사라져 여기만 남는다.
    <div className="winctl" data-tauri-drag-region>
      <button title="내리기" onClick={() => w().minimize()}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2 6.5 H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button title={max ? "원래 크기로" : "키우기"} onClick={() => w().toggleMaximize()}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
          {max ? (
            <>
              <rect x="2" y="4" width="6" height="6" rx="1.4" />
              <path d="M4 4 V3.4 A1.4 1.4 0 0 1 5.4 2 H8.6 A1.4 1.4 0 0 1 10 3.4 V6.6 A1.4 1.4 0 0 1 8.6 8 H8" />
            </>
          ) : (
            <rect x="2" y="2" width="8" height="8" rx="1.6" />
          )}
        </svg>
      </button>
      <button className="close" title="닫기" onClick={() => w().close()}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
