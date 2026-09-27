/** 본 대화가 부른 서브에이전트가 지금 무엇을 하는지.
 *
 *  서브에이전트의 대화는 본 대화 파일에 안 적힌다. 본 대화에는 "부름" 한 줄과, 다 끝난 뒤의
 *  결과만 남는다. 그 사이 몇 분 동안 대화창이 멈춘 것처럼 보이지 않게, 앱 프록시가 옆에서 읽은
 *  서브에이전트 스트림(`chat:sub`)으로 에이전트마다 한 줄씩 지금 하는 일을 보인다.
 *
 *  본 대화의 말풍선과는 채널부터 다르다 — 섞이면 서브에이전트의 생각이 본 대화의 답처럼 보인다. */
import { useContext, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { applySub, partialInput, pruneSubs, subFinished, subStreaming, type Sub, type SubEvent } from "./live";
import { shortToolName, toolSummary } from "./tools";
import { OpenSubContext } from "./SubagentView";

/** 이만큼 조용하면 걷는다. 서브에이전트가 긴 빌드를 돌리는 동안에는 몇 분씩 스트림이 없으므로
 *  짧게 잡으면 일하는 중에 사라진다. 보통은 마지막 답이 끝날 때(`subFinished`) 걷힌다. */
const QUIET_MS = 10 * 60_000;

function SubRow({ sub, onOpen }: { sub: Sub; onOpen?: () => void }) {
  const step = sub.step;
  let tool: string | null = null;
  let what: string;
  if (step?.kind === "tool") {
    tool = shortToolName(step.name);
    what = toolSummary(step.name, partialInput(step.json));
  } else if (step?.kind === "text") {
    what = step.text.replace(/\s+/g, " ").trim().slice(-90);
  } else if (step?.kind === "thinking") {
    what = "생각하는 중";
  } else {
    what = "시작하는 중";
  }
  // 요청이 흐르는 중이면 쓰는 중, 도구를 부른 뒤 조용하면 그 도구가 도는 중이다.
  const state = subStreaming(sub) ? "쓰는 중" : step?.kind === "tool" ? "도는 중" : "";
  const body = (
    <>
      <span className="sub-dot" aria-hidden="true" />
      <span className="sub-label">{sub.label}</span>
      {tool && <span className="tool-name">{tool}</span>}
      <span className="sub-what">{what}</span>
      {state && <span className="tool-stat">{state}</span>}
    </>
  );
  // 누르면 이 서브에이전트의 대화 전체를 연다(SubagentView).
  return onOpen ? (
    <button className="sub" onClick={onOpen} title="서브에이전트 대화 보기">
      {body}
    </button>
  ) : (
    <div className="sub">{body}</div>
  );
}

export function SubAgents({ session }: { session: string }) {
  const [subs, setSubs] = useState<Sub[]>([]);
  const open = useContext(OpenSubContext);

  useEffect(() => {
    setSubs([]);
    if (!session) return;
    const want = session.toLowerCase();
    let alive = true;
    const offs: (() => void)[] = [];
    const keep = (off: () => void) => {
      if (alive) offs.push(off);
      else off();
    };
    // 본 대화가 다시 말하는 것으로 걷지 않는다. 새 claude 는 서브에이전트를 백그라운드로 돌리며
    // 본 대화를 계속 진행하므로, 그러면 아직 일하는 서브에이전트가 사라진다.
    void listen<SubEvent>("chat:sub", (e) => {
      if (e.payload.session === want) setSubs((s) => applySub(s, e.payload, Date.now()).filter((x) => !subFinished(x)));
    }).then(keep);
    const timer = window.setInterval(() => setSubs((s) => pruneSubs(s, Date.now(), QUIET_MS)), 30_000);
    return () => {
      alive = false;
      offs.forEach((off) => off());
      window.clearInterval(timer);
    };
  }, [session]);

  if (!subs.length) return null;
  return (
    <div className="subs">
      {subs.map((s) => (
        <SubRow key={s.agent} sub={s} onOpen={open ? () => open({ agent: s.agent, label: s.label }) : undefined} />
      ))}
    </div>
  );
}
