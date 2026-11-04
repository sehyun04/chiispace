/** 서브에이전트 칸 — 본 대화가 부른 서브에이전트의 대화를 옆 칸에서 실시간으로 보인다. 읽기만 한다.
 *  칸을 여닫는 일은 `useSubPanes`, 대화 원문을 찾아 따라 읽는 일은 대화 보기 화면과 같은 `useSubagentTranscript` 다. */
import { useEffect } from "react";
import { Row } from "./ChatRows";
import { SubagentLog, useSubagentTranscript } from "./SubagentView";
import type { SubPaneInfo } from "./saved";
import "./chat.css";

export function SubPane({ id, sub, slug, onTitle }: {
  id: string;
  sub: SubPaneInfo;
  slug?: string;
  onTitle: (id: string, title: string) => void;
}) {
  const { info, items, loading } = useSubagentTranscript(sub.root, sub.session, { agent: sub.agent, label: sub.label });
  // 칸을 열 때 붙인 이름은 맡긴 일의 첫 줄이라 길다. claude 가 서브에이전트 기록에 적는 짧은 설명("로그 찾기")이
  // 보이면 그것으로 바꾼다 — 옆칸 목록에서 칸을 가르는 것은 그쪽이다. 사용자가 붙인 이름은 이것보다 이긴다(App 의 names).
  const short = info?.description?.trim();
  useEffect(() => {
    if (short) onTitle(id, short);
  }, [id, short, onTitle]);
  return (
    <div className="pane-body sub-body">
      <div className="chat">
        <SubagentLog
          items={items}
          loading={loading}
          name={info?.agentType ?? "서브에이전트"}
          taskLabel="claude 가 맡긴 일"
          renderRow={(item, o) => <Row key={o.key} item={item} slug={slug} name={o.name} showFace={o.showFace} grouped={o.grouped} />}
        />
        {sub.done ? <div className="sub-done" role="status">다 했어 — 다 봤으면 이 칸은 닫아도 돼</div> : null}
      </div>
    </div>
  );
}
