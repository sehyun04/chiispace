/** 옆칸 — 탭과 칸을 한 목록으로.
 *
 *  탭을 위에 따로 두면 같은 것을 두 군데서 고르게 되고, 정작 "어느 칸에서 무엇이
 *  돌고 있나"는 어디에도 안 보인다. 탭은 묶음의 제목이고 그 아래가 그 탭의 칸이다.
 *
 *  이 파일은 그리기만 한다. 무엇을 그릴지와 눌렀을 때 무엇을 할지는 App 이 준다 —
 *  그래야 옆칸 모양을 손보는 일과 얼개를 손보는 일이 서로를 건드리지 않는다. */
import * as L from "./layout";
import { cast, Face, leader, members, rosterLabel, Row, userTitle } from "./roster";
import { label, shortPath, type PaneStat } from "./session";
import type { GitInfo } from "./git";

type Tab = { key: string; layout: L.Node | null; root: string | null; focus: string };

export function Sidebar({
  tabs,
  active,
  git,
  dirty,
  stat,
  titles,
  names,
  sessionTitle,
  casting,
  picking,
  renaming,
  curRoot,
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
  sessionTitle: Record<string, string>;
  casting: Record<string, string>;
  picking: string | null;
  renaming: string | null;
  curRoot: string | null;
  onPickFolder: () => void;
  onNewTab: () => void;
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

  return (
    <aside className="side">
        <div className="side-section">
          <span>작업</span>
          <button className="mini" onClick={onPickFolder}>
            {curRoot ? "폴더 바꾸기" : "폴더 열기"}
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
                  const nm = names[sl.id] || sessionTitle[sl.id] || label(sl.id, stat, titles);
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
                        <Face slug={casting[sl.id]} agent={!!st?.agent} />
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

          <button className="newtab" onClick={onNewTab} title="새 탭 (Ctrl+Shift+T)">
            새 탭
          </button>
        </div>

        <div className="side-section">
          {rosterLabel} · {userTitle}
        </div>
        <div className="roster">
          <Row m={leader} lead />
          {members.map((m) => (
            <Row key={m.slug} m={m} />
          ))}
        </div>

    </aside>
  );
}
