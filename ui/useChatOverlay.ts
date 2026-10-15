/** 터미널 Claude 칸 위에 덮는 대화창(`ChatPane`)을 언제 올리고 언제 보이는가, 그리고 포커스를 어디에 주는가.
 *
 *  대화창은 터미널 위에 덮기만 한다 — 터미널을 걷거나 숨기면 결정 1·2번이 깨진다. 그래서 키가
 *  어디로 갈지가 늘 둘 중 하나이고, 그 판단을 이 파일 한 곳에 둔다. */
import { useCallback, useRef, useState } from "react";
import type { PaneStat } from "./session";
import { without } from "./records";
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

export function useChatOverlay(
  streams: Record<string, StreamChat>,
  stat: Record<string, PaneStat>,
  chatIds: Record<string, string>,
) {
  /** 대화창 대신 터미널을 보이는 칸. 권한 묻기·선택지처럼 TUI 에만 있는 화면을 다뤄야
   *  할 때 쓴다. `true` 는 사용자가 직접 고른 것이라 그대로 두고, `"auto"` 는 메뉴 명령·
   *  선택지 카드 때문에 잠깐 간 것이라 그 일이 끝나면(대화 파일이 자라면) 돌아온다.
   *  둘을 가르지 않으면 `/model` 을 닫고 나서도 터미널에 눌러앉는다. */
  const [termView, setTermView] = useState<Record<string, boolean | "auto">>({});
  /** 대화 파일에 무엇이든 적힌 칸. 그 전에는 대화창을 올려만 두고 터미널을 보인다(Chat.tsx). */
  const [chatReady, setChatReady] = useState<Record<string, boolean>>({});
  /** claude 를 마지막으로 본 때. 800ms 폴링이 한 번 비었다고 대화창을 걷었다
   *  다시 덮으면 칸이 깜박인다. */
  const lastClaude = useRef<Record<string, number>>({});
  /** 지금 대화창을 덮고 있는 칸. 그리는 중에 채우고, 포커스를 줄 곳을 고를 때 읽는다.
   *  ref 로 두는 것은 `selectPane` 처럼 deps 가 빈 콜백에서도 낡지 않게 하려는 것이다. */
  const showsChat = useRef<Record<string, boolean>>({});

  /** 칸에 포커스를 준다. 대화창이 덮고 있으면 그 입력바에, 아니면 터미널에.
   *
   *  결정 5번 때문에 App 은 배치·포커스가 바뀔 때마다 포커스를 손으로 되돌린다.
   *  그걸 터미널에만 주면 대화창 아래 숨은 xterm 이 키를 먹어, 보이지도 않는
   *  곳에 글자가 쳐진다. */
  const focusPane = useCallback((id?: string) => {
    if (!id) return;
    const input = (window as unknown as { __chats?: Record<string, HTMLTextAreaElement | null> }).__chats?.[id];
    if (showsChat.current[id] && input) input.focus();
    else termOf(id)?.focus();
  }, []);

  /** 이 칸에 대화창을 올릴까(mount), 보일까(shown).
   *
   *  올리는 것은 claude 가 돌고, 그 대화 id 를 명부에서 읽었고, 사용자가 터미널을
   *  고르지 않았을 때다. claude 가 내려가면 걷는다 — 셸 위에 대화창이 남아 있으면
   *  입력바에 쓴 말이 셸 명령으로 실행된다. 보이는 것은 대화 파일이 생긴 뒤다.
   *  그리는 중에 부른다 — `showsChat` 을 그때 채워 두어야 포커스·단축키가 같은 판단을 본다. */
  const chatState = (id?: string) => {
    if (!id) return { mount: false, shown: false };
    if (streams[id]) {
      showsChat.current[id] = true;
      return { mount: false, shown: true };
    }
    if (stat[id]?.agent === "codex") {
      showsChat.current[id] = false;
      return { mount: false, shown: false };
    }
    if (stat[id]?.agent === "claude") lastClaude.current[id] = Date.now();
    // 잠깐 터미널로 간 동안에도 대화창은 걷지 않고 숨겨 둔다. 대화 파일을 계속 재야
    // 메뉴가 끝난 것을 안다.
    const mount =
      !!chatIds[id] && termView[id] !== true && Date.now() - (lastClaude.current[id] ?? 0) < 5000;
    const shown = mount && !!chatReady[id] && !termView[id];
    showsChat.current[id] = shown;
    return { mount, shown };
  };

  /** 머리줄의 "터미널로"·"대화로". 사용자가 직접 고른 것이라 돌아오지 않는다. */
  const toggleView = useCallback((id: string) => {
    setTermView((v) => {
      if (!v[id]) return { ...v, [id]: true };
      const next = { ...v };
      delete next[id];
      return next;
    });
  }, []);
  /** 대화창이 터미널 메뉴로 보낼 때. `auto` 면 그 일이 끝나는 대로 돌아온다. */
  const showTerm = useCallback((id: string, auto?: boolean) => {
    setTermView((v) => ({ ...v, [id]: auto ? "auto" : true }));
    showsChat.current[id] = false;
    termOf(id)?.focus();
  }, []);
  /** 메뉴가 끝나 대화창으로 돌아올 때. 그 사이 사용자가 직접 터미널을 골랐으면 그 뜻이 이긴다. */
  const back = useCallback((id: string) => {
    setTermView((v) => {
      if (v[id] !== "auto") return v;
      const next = { ...v };
      delete next[id];
      return next;
    });
  }, []);
  const ready = useCallback((id: string, r: boolean) => {
    setChatReady((m) => (m[id] === r ? m : { ...m, [id]: r }));
  }, []);
  /** 칸에서 터미널을 걷을 때(터미널 없는 칸으로 옮길 때). */
  const forget = useCallback((id: string) => setTermView((v) => without(v, id)), []);

  return { termView, showsChat, focusPane, chatState, toggleView, showTerm, back, ready, forget };
}
