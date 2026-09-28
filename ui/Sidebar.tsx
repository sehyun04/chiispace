/** 옆칸 — 탭과 칸을 한 목록으로.
 *
 *  탭을 위에 따로 두면 같은 것을 두 군데서 고르게 되고, 정작 "어느 칸에서 무엇이
 *  돌고 있나"는 어디에도 안 보인다. 탭은 묶음의 제목이고 그 아래가 그 탭의 칸이다.
 *
 *  이 파일은 그리기만 한다. 무엇을 그릴지와 눌렀을 때 무엇을 할지는 App 이 준다 —
 *  그래야 옆칸 모양을 손보는 일과 얼개를 손보는 일이 서로를 건드리지 않는다. */
import { useEffect, useState } from "react";
import * as L from "./layout";
import { cast, Face, leader, members, Row } from "./roster";
import {
  isAgentWorking,
  label,
  shortPath,
  type PaneStat,
  type ShellKind,
} from "./session";
import type { GitInfo } from "./git";

type Tab = { key: string; layout: L.Node | null; root: string | null; focus: string; shell?: string };

/** 새 대화로 부를 수 있는 에이전트. 칸 셸의 `claude`·`codex` 는 앱의 래퍼로 이어진다(launchers.rs). */
export type AgentKind = "claude" | "codex";

const CONTACTS: { agent: AgentKind; name: string; sub: string }[] = [
  { agent: "claude", name: "Claude", sub: "Claude Code · 새 대화" },
  { agent: "codex", name: "Codex", sub: "Codex CLI · 새 대화" },
];

export function Sidebar({
  tabs,
  active,
  git,
  dirty,
  stat,
  titles,
  names,
  paneTitles,
  casting,
  picking,
  renaming,
  curRoot,
  shells,
  onPickFolder,
  onNewTab,
  onCloseTab,
  onClosePane,
  onSelectPane,
  onSetPicking,
  onSetRenaming,
  onSetCasting,
  onCommitName,
}: {
  tabs: Tab[];
  active: number;
  git: GitInfo;
  dirty: number;
  stat: Record<string, PaneStat>;
  titles: Record<string, string>;
  names: Record<string, string>;
  paneTitles: Record<string, string>;
  casting: Record<string, string>;
  picking: string | null;
  renaming: string | null;
  curRoot: string | null;
  /** 이 컴퓨터에 있는 셸. 맨 앞의 것이 기본이다. */
  shells: ShellKind[];
  onPickFolder: () => void;
  /** 셸을 안 주면 지금 탭과 같은 것으로 연다. 에이전트를 주면 셸이 뜨자마자 그것을 켠다. */
  onNewTab: (shell?: string, agent?: AgentKind) => void;
  onCloseTab: (i: number) => void;
  onClosePane: (id: string) => void;
  /** 그 탭으로 건너간다. 칸까지 주면 그 칸을 잡는다. */
  onSelectPane: (tab: number, pane?: string) => void;
  onSetPicking: (v: string | null | ((p: string | null) => string | null)) => void;
  onSetRenaming: (v: string | null) => void;
  onSetCasting: (v: (c: Record<string, string>) => Record<string, string>) => void;
  onCommitName: (id: string, raw: string) => void;
}) {
  // 이름을 고치다 키로 끝냈으면 뒤따르는 blur 는 흘려보낸다. 그러지 않으면 확정이
  // 두 번 일어나 claude 에 /rename 이 두 번 날아간다.
  const renameDone = { current: false };
  // 새 대화 상대를 고르는 칸이 열려 있는가. 이건 그리기에만 쓰이고 아무 데도 안 남으므로
  // App 까지 올리지 않는다 — 저기는 여러 작업이 만나는 자리라 얇게 둔다.
  const [picker, setPicker] = useState(false);
  // 열린 동안 Esc 는 이 칸만 닫는다. 포커스는 대개 칸의 claude 에 있어서, 새면 하던 일을 끊는다.
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setPicker(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picker]);
  const folder = curRoot?.split(/[\\/]/).filter(Boolean).pop();
  // 저장된 것은 경로다. 이름은 그때그때 목록에서 되찾는다 — 이름까지 저장해 두면
  // 목록의 이름을 고쳤을 때 옛 탭만 옛 이름으로 남는다.
  const shellName = (p?: string) =>
    p ? (shells.find((sh) => sh.path === p)?.name ?? p.split(/[\\/]/).pop()) : null;

  return (
    <aside className="side">
        <div className="side-section">
          <button
            className="folderbtn"
            onClick={onPickFolder}
            title={curRoot ? "폴더 바꾸기" : "폴더 열기"}
          >
            <FolderMark />
          </button>
        </div>

        {/* 탭과 pane 을 한 목록으로 둔다. 위에 탭 줄을 따로 두면 같은 것을 두 군데서
            고르게 되고, 정작 "어느 칸에서 무엇이 돌고 있나"는 어디에도 안 보인다.
            탭은 묶음의 제목이고 그 아래가 그 탭의 pane 이다. */}
        <div className="sessions">
          {tabs.map((t, ti) => {
            const slots = t.layout ? L.rects(t.layout) : [];
            return (
              <div key={t.key} className={ti === active ? "tgroup on" : "tgroup"}>
                <div className="tg-head" onMouseDown={() => onSelectPane(ti)}>
                  <span className="tg-name">{t.root?.split("/").pop() ?? "shell"}</span>
                  {t.shell ? <span className="tg-shell">{shellName(t.shell)}</span> : null}
                  {ti === active && git.branch ? (
                    <span className="tg-branch">
                      {git.branch}
                      {dirty ? <i>~{dirty}</i> : null}
                    </span>
                  ) : null}
                  {tabs.length > 1 ? (
                    <button
                      className="x"
                      title="탭 닫기"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onCloseTab(ti)}
                    >
                      ×
                    </button>
                  ) : null}
                </div>

                {slots.map((sl) => {
                  const st = stat[sl.id];
                  const here = ti === active;
                  const nm = names[sl.id] || paneTitles[sl.id] || label(sl.id, stat, titles);
                  return (
                    <div
                      key={sl.id}
                      className={here && t.focus === sl.id ? "prow on" : "prow"}
                      title={nm}
                      onMouseDown={() => onSelectPane(ti, sl.id)}
                    >
                      <button
                        className="ico"
                        title="누가 맡을지 고르기"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetPicking((v) => (v === sl.id ? null : sl.id));
                        }}
                      >
                        <Face
                          slug={casting[sl.id]}
                          agent={!!st?.agent}
                          dancing={isAgentWorking(st)}
                        />
                      </button>
                      <span className="pmeta">
                        <span className="nm">{nm}</span>
                        <span className="sub">{shortPath(t.root)}</span>
                      </span>
                      {st?.busy ? <span className="work" /> : null}
                      <button
                        className="x"
                        title="닫기"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => onClosePane(sl.id)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}

                {/* 고르는 칸이 이 탭에 있으면 그 아래에 펼친다. 목록 밖에 띄우면
                    어느 칸의 것인지 흐려지고 자리도 계산해야 한다. */}
                {picking && slots.some((sl) => sl.id === picking) ? (
                  <div className="castpick">
                    {cast.map((m) => (
                      <button
                        key={m.slug}
                        className={casting[picking] === m.slug ? "cp on" : "cp"}
                        title={`${m.name} · ${m.school}`}
                        onClick={() => {
                          onSetCasting((c) => ({ ...c, [picking]: m.slug }));
                          onSetPicking(null);
                        }}
                      >
                        <Face slug={m.slug} />
                        <span>{m.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* 새 탭은 대화 상대를 고르고 나서 열린다. 연락처에서 고르듯 누르면 그 탭에서
              바로 에이전트가 켜진다 — 셸을 연 뒤 명령을 치는 단계를 사용자에게 넘기지 않는다.
              셸만 여는 길은 아래에 작게 남긴다. 단축키(Ctrl+Shift+T)는 안 묻고 지금 탭과
              같은 셸로 연다. */}
          {picker ? (
            <div className="contacts" role="menu" aria-label="새 대화 상대">
              <div className="ct-head">
                누구랑 할까
                {folder ? <span title={curRoot ?? undefined}>{folder}</span> : null}
              </div>
              {CONTACTS.map((c) => (
                <button
                  key={c.agent}
                  className="ct"
                  role="menuitem"
                  data-agent={c.agent}
                  onClick={() => {
                    setPicker(false);
                    onNewTab(undefined, c.agent);
                  }}
                >
                  <span className={`ct-ico ${c.agent}`}>
                    {c.agent === "claude" ? <ClaudeMark /> : <CodexMark />}
                  </span>
                  <span className="ct-meta">
                    <span className="ct-name">{c.name}</span>
                    <span className="ct-sub">{c.sub}</span>
                  </span>
                </button>
              ))}
              {shells.length ? (
                <div className="ct-shells">
                  <span>셸만</span>
                  {shells.map((sh) => (
                    <button
                      key={sh.id}
                      className="sp"
                      role="menuitem"
                      title={sh.path}
                      onClick={() => {
                        setPicker(false);
                        onNewTab(sh.path);
                      }}
                    >
                      {sh.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            className={picker ? "newtab on" : "newtab"}
            onClick={() => setPicker((v) => !v)}
            title="새 대화 (Ctrl+Shift+T 는 지금 셸 그대로)"
            aria-expanded={picker}
          >
            {picker ? "닫기" : "새 대화"}
          </button>
        </div>

        {/* 이 목록은 참고용이다 — 칸을 맡기는 것은 세션 줄의 얼굴을 눌러서 한다.
            그래서 옆칸의 주인공은 위의 세션 목록이고, 여기는 밑에서 자리를 조금만
            쓴다. "치이카와 · 대장" 같은 제목은 무엇을 보는 칸인지 알려 주지 않는다. */}
        <div className="side-section roster-head">아이들</div>
        <div className="roster">
          <Row m={leader} lead />
          {members.map((m) => (
            <Row key={m.slug} m={m} />
          ))}
        </div>

    </aside>
  );
}

/** Claude 표시(Simple Icons). 연락처 줄에서 누구를 부르는지 글자보다 먼저 알아보게 한다. */
function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** Codex 표시(Simple Icons 의 OpenAI). */
function CodexMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/** 폴더를 여는 자리. 글자로 "폴더 바꾸기"라고 적어 두면 옆칸 맨 윗줄에서 제일
 *  눈에 띄는 것이 정작 제일 안 쓰는 단추가 된다 — 폴더는 한 번 열면 그만이다. */
function FolderMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 9V7a2 2 0 0 0-2-2h-5.5l-1.7-2.1A2 2 0 0 0 9.2 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14.2a2 2 0 0 0 1.94-1.5l1.55-6A2 2 0 0 0 19.75 10H8.24a2 2 0 0 0-1.79 1.1L4 16" />
    </svg>
  );
}
