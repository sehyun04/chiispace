/** 칸에 포커스를 어디로 주는가 — 터미널 칸은 그 xterm, 대화창 칸(터미널 없는 칸)은 입력바.
 *
 *  결정 5번 때문에 App 은 배치·포커스가 바뀔 때마다 포커스를 손으로 되돌린다. 칸마다 키를 받는 곳이
 *  하나뿐이라 칸 종류만 보면 된다. 10월 17일 터미널 위에 덮던 대화창을 걷기 전에는 같은 칸 안에서도
 *  둘 중 하나를 골라야 했다. */
import { useCallback, useRef } from "react";
import type { StreamChat } from "./stream-session";

type XTerm = { getSelection(): string; paste(t: string): void; focus(): void };

/** pane id 로 그 터미널을 찾는다.
 *
 *  전역 `__term` 하나로 "지금 터미널"을 들고 있었는데, 그 값은 Term 의
 *  focused effect 에서만 갱신된다. pane 을 옮기면 focus 는 그대로라 effect 가
 *  돌지 않아 값이 낡고, 복사·붙여넣기가 엉뚱한 pane 을 보거나 아무 일도 안
 *  하게 된다. 어느 pane 이 포커스인지는 App 이 이미 알고 있으니 그것으로 찾는다. */
export const termOf = (id?: string): XTerm | undefined =>
  id ? (window as unknown as { __terms?: Record<string, XTerm> }).__terms?.[id] : undefined;

export function useFocus(streams: Record<string, StreamChat>) {
  // ref 로 두는 것은 `selectPane` 처럼 deps 가 빈 콜백에서도 낡지 않게 하려는 것이다.
  const chats = useRef(streams);
  chats.current = streams;
  const focusPane = useCallback((id?: string) => {
    if (!id) return;
    if (chats.current[id]) (window as unknown as { __chats?: Record<string, HTMLTextAreaElement | null> }).__chats?.[id]?.focus();
    else termOf(id)?.focus();
  }, []);
  return { focusPane, chats };
}
