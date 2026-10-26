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
  /** 칸을 같은 폴더의 다른 대화로 다시 연 횟수. 칸이 이것을 키에 넣어 통로를 새로 연다 — 대화 id 만 바뀌는 것은
   *  `/clear` 처럼 claude 가 스스로 넘어간 것이라 다시 띄우면 안 되므로, 다시 열 때를 따로 센다. */
  const [epoch, setEpoch] = useState<Record<string, number>>({});
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

  /** `/resume` 으로 사용자가 고른 지난 대화를 이 칸에서 연다. 고르는 것은 사람이다 — 앱이 목록에서 고르지 않는다.
   *  Codex 는 서버가 준 대화 id 라 그대로 `thread/resume` 하고, 이미 보낸 대화라 빈 칸 표시를 끈다. */
  const resume = useCallback((id: string, session: string) => {
    const c = streamsNow.current[id];
    if (!c) return;
    setStreams((st) => ({ ...st, [id]: c.agent === "codex" ? { ...c, session, unstarted: false } : { ...c, session } }));
    setEpoch((e) => ({ ...e, [id]: (e[id] ?? 0) + 1 }));
  }, []);

  /** 켤 때 터미널 칸에서 옮겨 온 Claude 칸을 얹는다. */
  const adopt = useCallback((moved: Record<string, StreamChat>) => {
    if (Object.keys(moved).length) setStreams((st) => ({ ...st, ...moved }));
  }, []);

  /** 터미널 없는 Claude 칸을 같은 대화의 터미널 칸으로 다시 연다. `/config` 같은 터미널 메뉴가 필요할 때의 길이다.
   *  같은 칸 자리에서 그리는 것만 바뀐다 — 통로는 그 칸이 내려가며 거두고, 터미널은 복원 명령으로 이어 연다.
   *  되돌린 칸은 다음에 켜도 터미널로 둔다. 어느 명령으로 열지는 부른 쪽(`seed`)이 건다. */
  const toTerminal = useCallback(async (id: string, seed: (id: string, s: Seed) => void) => {
    const c = streamsNow.current[id];
    if (!c || c.agent !== "claude") return;
    // 폴더 없이 연 대화창의 claude 는 홈에서 돈다(claude_chat.rs). 터미널도 거기서 열어야 같은 자리에서 일한다.
    const cwd = c.cwd || ((await invoke<string | null>("home_dir").catch(() => null)) ?? "");
    const size = await invoke<number>("claude_transcript_size", { root: c.cwd, id: c.session }).catch(() => 0);
    if (streamsNow.current[id] !== c) return;
    // 한 마디도 없는 대화는 파일이 아직 없어 `--resume` 이 "No conversation found" 로 끝나고, 칸은 빈 셸로 남아
    // [대화창]으로 돌아갈 길도 없어진다(폴더 칩으로 바꾼 직후가 늘 그렇다). 옮길 말이 없으니 터미널에서 새로 연다 —
    // 그 대화의 id 는 터미널 claude 가 명부로 알려 준다.
    seed(id, size > 0
      ? { cmd: `claude --resume ${c.session}`, auto: true, cwd: cwd || undefined, claudeSession: c.session }
      : { cmd: "claude", auto: true, cwd: cwd || undefined });
    setStreams((st) => without(st, id));
    setKeepTerm((k) => ({ ...k, [id]: true }));
  }, []);

  /** 터미널 Claude 칸을 같은 대화의 터미널 없는 칸으로 다시 연다. 대화 id 는 그 칸의 claude 가 명부에 쓴 값이다.
   *  터미널은 칸에서 내려가며 닫힌다(`pty_close` 는 칸 종료 신호를 내지 않는다).
   *  터미널 쪽에서 알던 것(복원 명령·명부 id)은 `release` 가 같은 순간에 놓는다 — 한 번에
   *  바뀌어야 칸이 터미널과 대화창 사이의 반쯤 걸친 모양으로 그려지지 않는다. */
  const toStream = useCallback(async (id: string, session: string, cwd: string, release: (id: string) => void) => {
    const size = await invoke<number>("claude_transcript_size", { root: cwd, id: session }).catch(() => 0);
    release(id);
    setKeepTerm((k) => without(k, id));
    // 대화 파일은 모든 프로젝트 폴더에서 id 로 찾는다(claude_files.rs). 어디에도 없으면 아직 한 마디도 없는 대화라
    // 옮길 말이 없다 — 그 폴더의 새 대화창으로 연다. 전에는 아무 일도 안 해 단추가 먹통처럼 보였다.
    // 켤 때 저절로 옮기는 것은 다르다(saved.ts) — 사용자가 고르지 않았으니 파일이 있을 때만 옮긴다.
    setStreams((st) => ({ ...st, [id]: { agent: "claude", session: size > 0 ? session : crypto.randomUUID(), cwd } }));
  }, []);

  const paneView = useMemo(() => {
    const extra: Record<string, PaneStat> = {};
    for (const [id, c] of Object.entries(streams)) {
      extra[id] = { id, proc: null, agent: c.agent, busy: !!streamBusy[id], working: !!streamBusy[id], cwd: c.cwd };
    }
    return { ...stat, ...extra };
  }, [stat, streams, streamBusy]);

  return {
    streams, streamBusy, keepTerm, setKeepTerm, paneView, epoch,
    open, adopt, resume, onSession, onBusy, onCodexChange, toTerminal, toStream,
  };
}
