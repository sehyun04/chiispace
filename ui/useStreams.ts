/** 터미널 없는 칸(Claude·Codex 대화창)과, 같은 대화를 터미널 칸과 그 칸 사이에서 옮기는 일.
 *
 *  이 칸들은 PTY 폴링에 안 잡힌다. 머리줄·옆칸이 보는 상태(`paneView`)는 여기서 채워 덧붙이고,
 *  폴링 결과(`stat`) 자체에는 섞지 않는다 — 그쪽은 복원 명령·명부를 판단하는 자리다. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isSessionId, type PaneStat, type Seed } from "./session";
import type { StreamChat } from "./stream-session";
import type { Tab } from "./saved";
import { without } from "./records";
import * as L from "./layout";

type CodexChat = Extract<StreamChat, { agent: "codex" }>;

export function useStreams(booted: boolean, tabs: Tab[], stat: Record<string, PaneStat>) {
  /** 새 대화의 명시적인 ID만 저장한다. Claude는 앱이 정한 UUID, Codex는 서버의 응답을 쓴다. */
  const [streams, setStreams] = useState<Record<string, StreamChat>>({});
  const [streamBusy, setStreamBusy] = useState<Record<string, boolean>>({});
  /** 사용자가 "터미널로 열기"로 되돌려 둔 칸. 켤 때 터미널 없는 칸으로 옮기지 않는다. */
  const [keepTerm, setKeepTerm] = useState<Record<string, true>>({});
  const streamsNow = useRef(streams);
  streamsNow.current = streams;

  // 닫힌 칸의 대화는 놓는다. 남겨 두면 다음에 같은 id 로 뜬 새 칸이 그 대화를 물려받는다.
  useEffect(() => {
    if (!booted) return;
    const live = new Set(tabs.flatMap((t) => (t.layout ? L.leaves(t.layout) : [])));
    setStreams((s) => {
      const gone = Object.keys(s).filter((id) => !live.has(id));
      if (!gone.length) return s;
      const next = { ...s };
      for (const id of gone) delete next[id];
      return next;
    });
  }, [tabs, booted]);

  const onSession = useCallback((id: string, session: string) => {
    if (!isSessionId(session)) return;
    setStreams((s) => (!s[id] || s[id].session === session ? s : { ...s, [id]: { ...s[id], session } }));
  }, []);
  const onBusy = useCallback((id: string, busy: boolean) => {
    setStreamBusy((b) => (!!b[id] === busy ? b : { ...b, [id]: busy }));
  }, []);
  const onCodexChange = useCallback((id: string, patch: Partial<CodexChat>) => {
    setStreams((s) => (s[id]?.agent === "codex" ? { ...s, [id]: { ...s[id], ...patch, agent: "codex" } } : s));
  }, []);

  /** 새 대화 목록에서 고른 상대로 칸을 연다. Codex의 ID는 새 대화를 연 서버가 발급한다 —
   *  첫 응답이 오기 전에도 칸은 저장한다. */
  const open = useCallback((id: string, agent: StreamChat["agent"], cwd: string) => {
    setStreams((s) => ({ ...s, [id]: { agent, session: agent === "claude" ? crypto.randomUUID() : "", cwd } }));
  }, []);

  /** 켤 때 터미널 칸에서 옮겨 온 Claude 칸을 얹는다. */
  const adopt = useCallback((moved: Record<string, StreamChat>) => {
    if (Object.keys(moved).length) setStreams((st) => ({ ...st, ...moved }));
  }, []);

  /** 터미널 없는 Claude 칸을 같은 대화의 터미널 칸으로 다시 연다. `/config` 같은 터미널 메뉴가 필요할 때의 길이다.
   *  같은 칸 자리에서 그리는 것만 바뀐다 — 통로는 그 칸이 내려가며 거두고, 터미널은 복원 명령으로 이어 연다.
   *  되돌린 칸은 다음에 켜도 터미널로 둔다. 어느 명령으로 열지는 부른 쪽(`seed`)이 건다. */
  const toTerminal = useCallback((id: string, seed: (id: string, s: Seed) => void) => {
    const c = streamsNow.current[id];
    if (!c || c.agent !== "claude") return;
    seed(id, { cmd: `claude --resume ${c.session}`, auto: true, cwd: c.cwd || undefined, claudeSession: c.session });
    setStreams((st) => without(st, id));
    setKeepTerm((k) => ({ ...k, [id]: true }));
  }, []);

  /** 터미널 Claude 칸을 같은 대화의 터미널 없는 칸으로 다시 연다. 대화 id 는 그 칸의 claude 가 명부에 쓴 값이고,
   *  대화 파일이 있을 때만 옮긴다. 터미널은 칸에서 내려가며 닫힌다(`pty_close` 는 칸 종료 신호를 내지 않는다).
   *  터미널 쪽에서 알던 것(복원 명령·명부 id·대화창 상태)은 `release` 가 같은 순간에 놓는다 — 한 번에
   *  바뀌어야 칸이 터미널과 대화창 사이의 반쯤 걸친 모양으로 그려지지 않는다. */
  const toStream = useCallback(async (id: string, session: string, cwd: string, release: (id: string) => void) => {
    const size = await invoke<number>("claude_transcript_size", { root: cwd, id: session }).catch(() => 0);
    if (!(size > 0)) return;
    release(id);
    setKeepTerm((k) => without(k, id));
    setStreams((st) => ({ ...st, [id]: { agent: "claude", session, cwd } }));
  }, []);

  const paneView = useMemo(() => {
    const extra: Record<string, PaneStat> = {};
    for (const [id, c] of Object.entries(streams)) {
      extra[id] = { id, proc: null, agent: c.agent, busy: !!streamBusy[id], working: !!streamBusy[id], cwd: c.cwd };
    }
    return { ...stat, ...extra };
  }, [stat, streams, streamBusy]);

  return {
    streams, streamBusy, keepTerm, setKeepTerm, paneView,
    open, adopt, onSession, onBusy, onCodexChange, toTerminal, toStream,
  };
}
