/** 칸 하나 — 머리줄과, 그 칸이 무엇이냐에 따라 터미널 또는 대화창(터미널 없는 칸).
 *
 *  그리기만 한다. 무엇을 그릴지와 눌렀을 때 무엇을 할지는 App 이 준다 — 칸 모양을 손보는 일과
 *  얼개(배치·세션·폴링)를 손보는 일이 같은 파일에서 부딪히지 않게 하려는 것이다.
 *  자리(`.slot`)와 키는 App 이 잡는다. 결정 1번 — 칸을 배치 트리대로 중첩하지 않는다. */
import { useRef } from "react";
import { bySlug, DanceFace, Face, faceUrl } from "./roster";
import { isAgentWorking, type PaneStat, type Seed } from "./session";
import type { StreamChat } from "./stream-session";
import { Term } from "./Term";
import { ClaudeStreamPane } from "./ClaudeStreamPane";
import { CodexStreamPane } from "./CodexStreamPane";

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
  /** PTY 폴링 그대로. 터미널 칸의 claude 를 보는 판단은 이것만 본다. */
  stat?: PaneStat;
  slug?: string;
  /** 사용자가 붙인 이름, 자동 이름, 둘 다 없을 때의 표시. */
  name?: string;
  autoName?: string;
  fallback: string;
  renaming: boolean;
  stream?: StreamChat;
  streamBusy: boolean;
  /** 같은 폴더의 다른 대화로 다시 연 횟수(`/resume`). 칸 키에 넣어 통로를 새로 연다. */
  streamEpoch: number;
  /** 명부가 알려 준 이 칸 claude 의 대화 id. 있어야 같은 대화를 대화창으로 옮길 수 있다. */
  chatId?: string;
  seed?: Seed;
  onSelect: () => void;
  onDragStart: (stage: HTMLElement) => void;
  onRename: () => void;
  onCommitName: (value: string) => void;
  onCancelRename: () => void;
  onClose: () => void;
  onToTerminal: () => void;
  onToStream: () => void;
  // 아래는 칸 id 를 받는 안정적인 콜백이다 — 매번 새로 만들면 그 칸들이 통로를 다시 붙인다.
  onTermTitle: (id: string, title: string) => void;
  onStreamTitle: (id: string, title: string) => void;
  onStreamBusy: (id: string, busy: boolean) => void;
  onStreamSession: (id: string, session: string) => void;
  onCodexChange: (id: string, patch: Partial<CodexChat>) => void;
  onFolder: (id: string, agent: StreamChat["agent"], cwd: string) => void;
  onResume: (id: string, session: string) => void;
  onTerminal: (cmd: string, title: string) => void;
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
        {p.stream?.agent === "claude" || (!p.stream && stat?.agent === "claude") ? (
          <ModeSwitch
            chat={!!p.stream}
            toTerminal={p.streamBusy ? "일하는 중에는 옮기지 않는다 — 하던 답이 끊긴다" : null}
            toChat={
              !p.chatId
                ? "claude 가 이 대화를 아직 알려 주지 않았다 — 첫 말을 주고받으면 옮길 수 있다"
                : isAgentWorking(stat)
                  ? "일하는 중에는 옮기지 않는다 — 하던 답이 끊긴다"
                  : null
            }
            onTerminal={p.onToTerminal}
            onChat={p.onToStream}
          />
        ) : null}
        <button
          className="x"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={p.onClose}
        >
          ×
        </button>
      </header>
      {/* 일하는 동안 칸 테두리를 따라 3인방 색(하치와레·치이카와·우사기)이 줄지어 돈다. 머리줄 밑의
          가는 띠는 여러 칸을 띄워 두면 곁눈으로 잘 안 보였다 — 테두리는 칸 어디를 보고 있어도 눈에 걸린다.
          정말 일하는 중일 때만 돈다. 에이전트는 프롬프트 앞에 가만히 서 있어도 자기가 전경 작업이라
          `busy` 가 내내 참이고, 그대로 두면 영영 돌아 "일하는 중"이라는 뜻을 잃는다. 셸은 스피너를
          판정할 길이 없으니 전경 명령이 도는 동안(=`busy`)이 곧 작업 중이다. */}
      {(view?.agent ? working : view?.busy) ? <WorkRing /> : null}

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
        // 폴더를 바꾸거나(새 대화) /resume 으로 다른 대화를 고르면 칸을 새로 그려 통로도 새로 연다.
        <CodexStreamPane key={`${p.stream.cwd}#${p.streamEpoch}`} id={id} chat={p.stream as CodexChat}
          slug={slug} name={who}
          focused={p.on}
          onTitle={p.onStreamTitle} onBusy={p.onStreamBusy} onChange={p.onCodexChange} onFolder={p.onFolder}
          onResume={p.onResume} onTerminal={p.onTerminal} />
      ) : p.stream ? (
        <ClaudeStreamPane
          key={`${p.stream.cwd}#${p.streamEpoch}`}
          id={id}
          cwd={p.stream.cwd}
          session={p.stream.session}
          slug={slug}
          name={who}
          focused={p.on}
          onTitle={p.onStreamTitle}
          onBusy={p.onStreamBusy}
          onSession={p.onStreamSession}
          onFolder={p.onFolder}
          onResume={p.onResume}
          onTerminal={p.onTerminal}
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

/** 일하는 중 테두리. 둘레를 100 으로 재고(`pathLength`) 세 빛깔 조각과 반짝이를 돌린다 — 칸이 넓든 좁든 같은
 *  빠르기로 둘레를 탄다. 원뿔 그라데이션을 돌리는 흔한 방식은 긴 변 가운데서 느려지고 모서리에서 튄다. */
function WorkRing() {
  return (
    <svg className="work-ring" aria-hidden="true">
      <rect className="base" />
      <rect className="run spark" pathLength={100} />
      <rect className="run spark" pathLength={100} />
      <rect className="run usagi" pathLength={100} />
      <rect className="run chiikawa" pathLength={100} />
      <rect className="run hachiware" pathLength={100} />
      <rect className="run core" pathLength={100} />
    </svg>
  );
}

/** 머리줄의 [터미널][대화창]. 같은 대화를 두 방식 사이에서 옮긴다 — 터미널은 TUI 그대로, 대화창은
 *  터미널 없는 칸. 지금 방식이 눌린 쪽이다. 못 옮길 때는 그 까닭을 단추 풀이에 둔다(`null` 이면 옮길 수 있다). */
function ModeSwitch({ chat, toTerminal, toChat, onTerminal, onChat }: {
  chat: boolean;
  toTerminal: string | null;
  toChat: string | null;
  onTerminal: () => void;
  onChat: () => void;
}) {
  const side = (label: string, on: boolean, why: string | null, go: () => void, hint: string) => (
    <button
      aria-pressed={on}
      className={on ? "on" : undefined}
      disabled={!on && !!why}
      title={on ? `지금 ${label}` : (why ?? hint)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={on ? undefined : go}
    >
      {label}
    </button>
  );
  return (
    <span className="mode" role="group" aria-label="보는 방식">
      {side("터미널", !chat, toTerminal, onTerminal, "같은 대화를 터미널로 연다 — /config 같은 터미널 메뉴가 필요할 때")}
      {side("대화창", chat, toChat, onChat, "같은 대화를 대화창으로 연다")}
    </span>
  );
}
