/** 서브에이전트 칸 — 본 대화가 부른 서브에이전트의 대화를 옆 칸에서 실시간으로 보인다. 읽기만 한다.
 *  대화 원문은 상세 화면과 같은 조회 경로를 쓴다. */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Row } from "./ChatRows";
import { useCodexChild } from "./CodexSubagents";
import type { Data } from "./codex-stream";
import { SubagentLog, useSubagentTranscript } from "./SubagentView";
import type { SubPaneInfo } from "./saved";
import "./chat.css";

type Props = {
  id: string;
  sub: SubPaneInfo;
  slug?: string;
  onTitle: (id: string, title: string) => void;
  codexRun?: string;
};

export function SubPane(props: Props) {
  return props.sub.harness === "codex" ? <CodexSubPane {...props} /> : <ClaudeSubPane {...props} />;
}

function ClaudeSubPane({ id, sub, slug, onTitle }: Props) {
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

function CodexSubPane({ id, sub, slug, onTitle, codexRun }: Props) {
  const request = codexRun
    ? (method: string, params: Data) => invoke<Data>("codex_stream_request", { id: sub.parent, run: codexRun, method, params })
    : undefined;
  const { name, items, loading, error, hasTranscript } = useCodexChild(sub.agent, request, !sub.done, codexRun);
  useEffect(() => {
    onTitle(id, name || sub.label);
  }, [id, name, sub.label, onTitle]);

  return (
    <div className="pane-body sub-body">
      <div className="chat">
        <SubagentLog
          items={items}
          loading={loading}
          error={error}
          name={name || sub.label}
          taskLabel="Codex가 맡긴 일"
          renderRow={(item, o) => <Row key={o.key} item={item} slug={slug} name={o.name} showFace={o.showFace} grouped={o.grouped} />}
        />
        {!codexRun && !hasTranscript ? <div className="sub-done" role="status">본 칸에서 원래 대화를 열면 기록을 볼 수 있어</div>
          : sub.done ? <div className="sub-done" role="status">다 했어 — 다 봤으면 이 칸은 닫아도 돼</div> : null}
      </div>
    </div>
  );
}
