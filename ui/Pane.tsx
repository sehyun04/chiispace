/** 칸 하나 — 머리줄과, 그 칸이 무엇이냐에 따라 터미널·터미널 없는 대화창·터미널 위 대화창 덮개.
 *
 *  그리기만 한다. 무엇을 그릴지와 눌렀을 때 무엇을 할지는 App 이 준다 — 칸 모양을 손보는 일과
 *  얼개(배치·세션·폴링)를 손보는 일이 같은 파일에서 부딪히지 않게 하려는 것이다.
 *  자리(`.slot`)와 키는 App 이 잡는다. 결정 1번 — 칸을 배치 트리대로 중첩하지 않는다. */
import { useRef } from "react";
import { bySlug, DanceFace, Face, faceUrl } from "./roster";
import { isAgentWorking, type PaneStat, type Seed } from "./session";
import type { StreamChat } from "./stream-session";
import { Term } from "./Term";
import { ChatPane } from "./Chat";
import { ClaudeStreamPane } from "./ClaudeStreamPane";
import { CodexStreamPane } from "./CodexStreamPane";
import { terminalCommands } from "./palette";
import { effortLabel } from "./StreamBar";

// TUI 에 무엇이 있는지 물을 길이 없어 고정 목록이다. 칸마다 새로 만들 까닭이 없다.
const TERMINAL_COMMANDS = terminalCommands(effortLabel);

type CodexChat = Extract<StreamChat, { agent: "codex" }>;

export type PaneProps = {
  id: string;
  /** 지금 보는 탭의 포커스 칸인가. */
  on: boolean;
  root: string | null;
  shell?: string;
  fontSize: number;
  /** 머리줄·옆칸이 보는 상태 — 터미널 없는 칸까지 채운 것. */
  view?: PaneStat;
  /** PTY 폴링 그대로. 터미널 위 대화창은 이것만 본다. */
  stat?: PaneStat;
  slug?: string;
  /** 사용자가 붙인 이름, 자동 이름, 둘 다 없을 때의 표시. */
  name?: string;
  autoName?: string;
  fallback: string;
  renaming: boolean;
  stream?: StreamChat;
  streamBusy: boolean;
  chatId?: string;
  termView?: boolean | "auto";
  chat: { mount: boolean; shown: boolean };
  seed?: Seed;
  onSelect: () => void;
  onDragStart: (stage: HTMLElement) => void;
  onRename: () => void;
  onCommitName: (value: string) => void;
  onCancelRename: () => void;
  onClose: () => void;
  onToTerminal: () => void;
  onToggleView: () => void;
  onToStream: () => void;
  onChatReady: (ready: boolean) => void;
  onShowTerm: (auto?: boolean) => void;
  onBack: () => void;
  // 아래는 칸 id 를 받는 안정적인 콜백이다 — 매번 새로 만들면 그 칸들이 통로를 다시 붙인다.
  onTermTitle: (id: string, title: string) => void;
  onStreamTitle: (id: string, title: string) => void;
  onStreamBusy: (id: string, busy: boolean) => void;
  onStreamSession: (id: string, session: string) => void;
  onCodexChange: (id: string, patch: Partial<CodexChat>) => void;
};

export function Pane(p: PaneProps) {
  const { id, view, stat, slug } = p;
  const working = isAgentWorking(view);
  const who = bySlug.get(slug ?? "")?.name;
  return (
    <section
      className={p.on ? "pane on" : "pane"}
      onMouseDown={p.onSelect}
    >
      <header
        className="pane-head"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          // 이걸 안 하면 헤더를 잡는 순간 포커스가 터미널에서
          // 헤더로 빠진다.
          e.preventDefault();
          const stage = e.currentTarget.closest(".stage");
          if (!stage) return;
          p.onDragStart(stage as HTMLElement);
        }}
      >
        <span className={working ? "pip work" : "pip"}>
          <Face slug={slug} agent={!!view?.agent} dancing={working} />
        </span>
        {p.renaming ? (
          <RenameInput name={p.name} onCommit={p.onCommitName} onCancel={p.onCancelRename} />
        ) : (
          <span
            className="title"
            title={
              p.name
                ? `${p.name} — 두 번 눌러 이름 고치기`
                : (p.autoName ?? "") || "두 번 눌러 이름 붙이기"
            }
            onDoubleClick={p.onRename}
          >
            {p.name || p.autoName || p.fallback}
          </span>
        )}
        {view?.agent ? <span className="chip">{view.agent}</span> : null}
        {p.stream?.agent === "claude" ? (
          <button
            className="view"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={p.onToTerminal}
            disabled={p.streamBusy}
            title="같은 대화를 터미널 칸으로 다시 연다 — /config 같은 터미널 메뉴가 필요할 때"
          >
            터미널로 열기
          </button>
        ) : null}
        {p.chatId && view?.agent === "claude" ? (
          <button
            className="view toggle"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={p.onToggleView}
          >
            {p.termView ? "대화로" : "터미널로"}
          </button>
        ) : null}
        {!p.stream && p.chatId && stat?.agent === "claude" ? (
          <button
            className="view"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={p.onToStream}
            disabled={isAgentWorking(stat)}
            title="같은 대화를 터미널 없이 다시 연다"
          >
            터미널 없이
          </button>
        ) : null}
        <button
          className="x"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={p.onClose}
        >
          ×
        </button>
      </header>
      {/* 진행 띠는 정말 일하는 중일 때만 흐른다. 에이전트는 프롬프트
          앞에 가만히 서 있어도 자기가 전경 작업이라 `busy` 가 내내
          참이고, 그대로 두면 띠가 영영 흘러 "일하는 중"이라는 뜻을
          잃는다. 셸은 스피너를 판정할 길이 없으니 전경 명령이 도는
          동안(=`busy`)이 곧 작업 중이다. */}
      {(view?.agent ? working : view?.busy) ? <div className="busy" /> : null}

      {/* 맡은 아이를 칸 안에 세워 둔다. 헤더의 작은 얼굴만으로는
          누가 일하는 중인지 눈에 잘 안 들어온다. 마우스는 통과시켜
          터미널을 고르고 끄는 데 걸리지 않게 한다. */}
      {view?.agent && faceUrl(slug) ? (
        working ? (
          <DanceFace slug={slug} className="buddy" />
        ) : (
          <img className="buddy" src={faceUrl(slug)} alt="" draggable={false} />
        )
      ) : null}
      {p.stream?.agent === "codex" ? (
        <CodexStreamPane id={id} chat={p.stream as CodexChat}
          slug={slug} name={who}
          focused={p.on}
          onTitle={p.onStreamTitle} onBusy={p.onStreamBusy} onChange={p.onCodexChange} />
      ) : p.stream ? (
        <ClaudeStreamPane
          id={id}
          cwd={p.stream.cwd}
          session={p.stream.session}
          slug={slug}
          name={who}
          focused={p.on}
          onTitle={p.onStreamTitle}
          onBusy={p.onStreamBusy}
          onSession={p.onStreamSession}
        />
      ) : (
        <Term
          id={id}
          focused={p.on}
          onTitle={p.onTermTitle}
          cwd={p.seed?.cwd ?? p.root ?? undefined}
          shell={p.shell}
          fontSize={p.fontSize}
          seed={p.seed}
        />
      )}
      {/* 터미널 위에 덮는다. 터미널은 그 아래서 크기를 지킨 채 살아 있다. */}
      {p.chat.mount ? (
        <ChatPane
          key={`claude:${p.chatId}`}
          agent="claude"
          shown={p.chat.shown}
          root={stat?.cwd ?? p.root ?? ""}
          id={p.chatId!}
          paneId={id}
          slug={slug}
          name={who}
          live={stat?.agent === "claude"}
          working={isAgentWorking(stat)}
          onReady={p.onChatReady}
          onShowTerm={p.onShowTerm}
          away={p.termView === "auto"}
          onBack={p.onBack}
          commands={TERMINAL_COMMANDS}
        />
      ) : null}
    </section>
  );
}

/** 칸 이름 고치기. Enter·Esc 로 끝냈으면 뒤따르는 blur 는 흘려보낸다 — 확정 뒤 input 이
 *  사라지며 blur 가 또 불리는데, 그대로 두면 claude 에 /rename 이 두 번 날아간다. */
function RenameInput({ name, onCommit, onCancel }: {
  name?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  return (
    <input
      className="rename"
      defaultValue={name ?? ""}
      placeholder="이 pane 의 이름"
      autoFocus
      // 헤더는 끌면 pane 이 옮겨진다. 글자를 고르는 중에 그게 걸리면 안 된다.
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (done.current) {
          done.current = false;
          return;
        }
        onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          done.current = true;
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}
