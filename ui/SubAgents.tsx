/** 본 대화가 부른 서브에이전트가 지금 무엇을 하는지.
 *
 *  서브에이전트의 대화는 본 대화 파일에 안 적힌다. 본 대화에는 "부름" 한 줄과, 다 끝난 뒤의
 *  결과만 남는다. 그 사이 몇 분 동안 대화창이 멈춘 것처럼 보이지 않게, 앱 프록시가 옆에서 읽은
 *  서브에이전트 스트림(`chat:sub`)으로 에이전트마다 한 줄씩 지금 하는 일을 보인다.
 *
 *  본 대화의 말풍선과는 채널부터 다르다 — 섞이면 서브에이전트의 생각이 본 대화의 답처럼 보인다. */
import { useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AgentTask } from "./claude-stream";
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
  return <SubAgentRow label={sub.label} tool={tool ?? undefined} what={what} state={state} onOpen={onOpen} />;
}

export function SubAgentRow({ label, tool, what, state, onOpen }: {
  label: string; tool?: string; what: string; state?: string; onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="sub-dot" aria-hidden="true" />
      <span className="sub-label">{label}</span>
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

/** `running` 은 통로가 알려 준 지금 도는 서브에이전트(`StreamState.tasks`)다. 뒤늦게 붙은 화면(폰)은 그 서브에이전트의 조각을
 *  처음부터 못 봤고, 서브에이전트가 긴 도구를 도는 동안에는 새 조각도 안 온다. 그 사이에도 줄이 보이게 이것으로 채운다. */
export function SubAgents({ session, running }: { session: string; running?: AgentTask[] }) {
  const [subs, setSubs] = useState<Sub[]>([]);
  // 조각으로 끝을 본 서브에이전트. 통로의 목록은 조금 늦게 비므로 그 사이에 "일하는 중"으로 되살리지 않는다.
  const done = useRef(new Set<string>());
  const open = useContext(OpenSubContext);

  useEffect(() => {
    setSubs([]);
    done.current = new Set();
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
      if (e.payload.session !== want) return;
      setSubs((s) =>
        applySub(s, e.payload, Date.now()).filter((x) => {
          if (!subFinished(x)) return true;
          done.current.add(x.agent);
          return false;
        }),
      );
    }).then(keep);
    const timer = window.setInterval(() => setSubs((s) => pruneSubs(s, Date.now(), QUIET_MS)), 30_000);
    return () => {
      alive = false;
      offs.forEach((off) => off());
      window.clearInterval(timer);
    };
  }, [session]);

  const tasks = running ?? [];
  // 이름은 claude 가 적은 짧은 설명이 앞선다(서브에이전트 칸 이름과 같다). 조각의 이름은 맡긴 일의 첫 줄이다.
  const named = subs.map((s) => ({ ...s, label: tasks.find((t) => t.id === s.agent)?.label ?? s.label }));
  const quiet = tasks.filter((t) => !subs.some((s) => s.agent === t.id) && !done.current.has(t.id));
  if (!named.length && !quiet.length) return null;
  return (
    <div className="subs">
      {named.map((s) => (
        <SubRow key={s.agent} sub={s} onOpen={open ? () => open({ agent: s.agent, label: s.label }) : undefined} />
      ))}
      {quiet.map((t) => (
        <SubAgentRow key={t.id} label={t.label} what="일하는 중" onOpen={open ? () => open({ agent: t.id, label: t.label }) : undefined} />
      ))}
    </div>
  );
}
