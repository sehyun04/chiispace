/** 터미널 칸이 무엇을 돌리고 있고, 껐다 켜면 그것을 어떻게 되살리는가.
 *
 *  셋이 한 묶음이다 — 프로세스 트리 폴링(`stat`), 거기서 누적한 복원 명령(`procs`·`seeds`),
 *  칸의 claude 가 자기 pid 명부에 써 둔 대화 id(`chatIds`). 터미널 없는 칸은 여기 섞지 않는다
 *  (CLAUDE.md "터미널 없는 칸은 PTY 폴링에 섞지 않는다"). */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isSessionId, restoreCmd, type PaneStat, type Seed } from "./session";
import { without } from "./records";

export function usePaneAgents() {
  const [stat, setStat] = useState<Record<string, PaneStat>>({});
  // 복원된 pane 이 앱을 끄기 전 돌리던 명령. 되살릴 수 있는 것은 여기까지다 —
  // 프로세스 자체는 앱과 함께 죽었고, 죽은 셸을 흉내 낸 화면을 복원하면
  // 사용자가 그게 살아 있다고 믿는다.
  const [seeds, setSeeds] = useState<Record<string, Seed>>({});
  // pane 이 무엇을 돌리고 있었는지를 누적해 둔다. 순간 스냅샷(stat)으로만
  // 계산하면 안 된다 — 앱을 끌 때 PTY 가 먼저 사라지면 pane_status 가 빈
  // 목록을 주고, 그 순간 저장이 돌면서 되살릴 정보가 통째로 지워진다.
  // 배치(tabs)는 그대로라 배치만 남고 명령만 날아간다.
  const procs = useRef<Record<string, Seed>>({});
  // 그 칸에서 무엇이든 돌고 있는 것을 본 적이 있는가. 복원 명령을 언제 놓아도
  // 되는지가 여기 달려 있다 — 켠 직후의 빈 셸은 "아직 안 떴다"이지 "끝났다"가 아니다.
  const sawRun = useRef<Record<string, boolean>>({});
  // 연달아 몇 번이나 비어 있었나. 끌 때는 에이전트가 PTY 보다 먼저 죽어서
  // 한 번의 스냅샷으로는 종료 중인지 명령이 끝난 것인지 가릴 수 없다.
  const idleRuns = useRef<Record<string, number>>({});
  /** 칸이 돌리는 claude 대화의 id. 그 칸의 claude 가 자기 pid 명부에 써 둔 값을 그대로 받는다 —
   *  대화 파일을 뒤져 고르지 않는다. 그렇게 고르다가 사용자가 쓰던 대화를 뺏은 적이 있다. */
  const sessionOf = useRef<Record<string, string>>({});
  /** `sessionOf` 를 화면이 따라가게 한 사본. ref 는 바뀌어도 다시 그리지 않아서
   *  대화 id 가 붙은 순간 대화창이 뜨려면 state 가 따로 있어야 한다. 값의 출처는
   *  `sessionOf` 와 같다 — 명부에서 읽은 id 뿐이다. */
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  /** 이미 물어본 pid. 같은 pid 를 800ms 폴링마다 다시 묻지 않는다. */
  const askedPid = useRef<Record<string, number>>({});
  /** 명부에서 답을 못 얻은 횟수(칸별, pid 가 바뀌면 새로 센다). */
  const rosterMiss = useRef<Record<string, { pid: number; n: number }>>({});
  /** 명부를 다시 물을 때가 됐다는 신호. 값 자체는 뜻이 없다. */
  const [rosterTick, setRosterTick] = useState(0);
  /** 칸마다 명부를 마지막으로 읽은 때. */
  const checkedAt = useRef<Record<string, number>>({});

  // pane 이 무엇을 돌리는지는 프로세스 트리를 봐야 알 수 있고, 그건 이벤트로
  // 오지 않는다. 엔진이 ps 호출을 500ms 로 캐시하므로 이보다 촘촘할 이유가 없다.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      invoke<PaneStat[]>("pane_status")
        .then((list) => {
          if (!alive) return;
          const m: Record<string, PaneStat> = {};
          for (const p of list) m[p.id] = p;
          setStat(m);
        })
        .catch(() => {});
    };
    tick();
    const h = setInterval(tick, 800);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  // 칸이 어느 대화인지는 claude 자신에게 묻는다. 답을 얻은 pid 는 캐시한다 —
  // 800ms 폴링마다 다시 물으면 같은 답에 파일을 계속 읽는다. 답이 없으면 그냥 두어
  // 복원이 예전처럼 `--continue` 로 떨어지게 한다(나빠지지 않는다).
  //
  // 못 얻었으면 잠시 뒤 다시 묻는다. 앱이 pid 를 보는 것이 claude 가 명부를 쓰는
  // 것보다 빠를 수 있어서, 첫 물음에 답이 없다고 "물어봤음"으로 찍어 두면 그 칸은
  // 영영 제 대화 id 를 못 얻는다 — 대화창이 안 뜨고 복원도 `--continue` 로 떨어진다.
  // 명부를 아예 안 쓰는 claude 도 있으니 칸마다 몇 번에서 멈춘다.
  //
  // 얻은 뒤에도 가끔(5초) 다시 본다. 칸 안에서 `/clear` 하면 같은 claude 가 새 대화로
  // 넘어가고 명부도 따라 바뀐다. 캐시만 믿으면 대화창은 지난 대화에 머물고 다음 복원도
  // 지난 대화로 열린다. 다시 볼 때 답이 없으면 붙여 둔 것은 그대로 둔다.
  const agentPids = Object.entries(stat)
    .filter(([, p]) => p.agent === "claude" && typeof p.agentPid === "number")
    .map(([id, p]) => `${id}:${p.agentPid}`)
    .sort()
    .join(",");
  useEffect(() => {
    if (!agentPids) return;
    let stop = false;
    let retry: number | undefined;
    void (async () => {
      let missed = false;
      for (const entry of agentPids.split(",")) {
        const [id, raw] = entry.split(":");
        const pid = Number(raw);
        if (stop) return;
        if (askedPid.current[id] === pid && Date.now() - (checkedAt.current[id] ?? 0) < 4500) continue;
        const miss = rosterMiss.current[id]?.pid === pid ? rosterMiss.current[id] : { pid, n: 0 };
        if (askedPid.current[id] !== pid && miss.n >= 30) continue;
        let sid: string | null = null;
        try {
          sid = await invoke<string | null>("claude_session_of_pid", { pid, cwd: stat[id]?.cwd ?? null });
        } catch { /* 못 읽으면 붙이지 않는다 */ }
        if (stop) return;
        checkedAt.current[id] = Date.now();
        if (isSessionId(sid)) {
          askedPid.current[id] = pid;
          sessionOf.current[id] = sid;
          setChatIds((c) => (c[id] === sid ? c : { ...c, [id]: sid }));
        } else if (askedPid.current[id] !== pid) {
          rosterMiss.current[id] = { pid, n: miss.n + 1 };
          missed = true;
        }
      }
      // 폴링과 무관한 값(rosterTick)으로 다시 돌린다. stat 을 deps 에 두면 800ms 마다
      // 취소돼 이 타이머가 영영 안 터진다.
      if (!stop) retry = window.setTimeout(() => setRosterTick((n) => n + 1), missed ? 2000 : 5000);
    })();
    return () => {
      stop = true;
      window.clearTimeout(retry);
    };
    // 값이 같으면 참조도 같은 문자열로 좁혀야 800ms 폴링에 effect 가 딸려 돌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentPids, rosterTick]);

  // 돌던 명령을 누적한다. stat 에 있는 pane 만 판단하고, 목록에서 사라진
  // pane 은 건드리지 않는다 — 사라진 것은 "명령이 끝났다"가 아니라 "PTY 가
  // 이미 죽었다"일 수 있고, 그 둘을 스냅샷만으로는 구별할 수 없다.
  useEffect(() => {
    for (const [id, p] of Object.entries(stat)) {
      const name = restoreCmd(p, sessionOf.current[id]);
      if (name) {
        // cmd 셸은 제 폴더를 알려 주지 않아 폴링의 cwd 가 빈다. 그때 앞서 알던 자리(칸을 연 명령의 폴더)를 지우면
        // 다음 복원과 [대화창] 옮기기가 탭 폴더로 떨어진다 — 폴더 칩으로 바꾼 대화가 원래 폴더로 돌아갔다.
        const known = procs.current[id]?.cwd;
        procs.current[id] = name.cwd || !known ? name : { ...name, cwd: known };
        sawRun.current[id] = true;
        idleRuns.current[id] = 0;
      } else {
        // 이 칸은 지금 빈 프롬프트다. 그런데 **아직 안 뜬 것**과 **끝난 것**이
        // 스냅샷에서는 똑같이 보인다.
        //
        // 복원한 칸은 셸이 뜨고 복원 명령이 들어가 claude 가 잡히기까지 십여 초가
        // 걸리는데, 폴링은 800ms 마다 돌고 저장은 400ms 뒤에 쓴다. 그래서 켠 지 1초
        // 만에 "이 칸은 아무것도 안 돌린다"가 저장되어 **방금 복원한 명령이 통째로
        // 지워진다.** 그 상태로 앱을 끄면 다음에 켤 때 그 칸은 그냥 셸로 뜬다 —
        // 사용자에게는 "세션이 또 안 불러와진다"이다. 실제로 그렇게 잃었다.
        //
        // 그러니 한 번이라도 무언가 돌던 것을 본 칸만 놓아 준다. 그리고 그마저도
        // 곧바로는 안 놓는다 — 끌 때는 claude 가 PTY 보다 먼저 죽어서, 종료 중에
        // 온 한두 번의 빈 스냅샷이 "명령이 끝났다"로 읽히면 같은 것을 잃는다.
        // 연달아 비어 있을 때만 진짜로 끝난 것이다.
        if (!sawRun.current[id]) continue;
        idleRuns.current[id] = (idleRuns.current[id] ?? 0) + 1;
        if (idleRuns.current[id] < 4) continue;
        delete procs.current[id];
        delete sawRun.current[id];
        delete idleRuns.current[id];
      }
    }
  }, [stat]);

  /** 켤 때 세션 파일에서 읽은 복원 명령을 건다. 폴링이 누적할 바탕도 그것이다. */
  const restore = useCallback((m: Record<string, Seed>) => {
    setSeeds(m);
    procs.current = { ...m };
  }, []);

  /** 칸을 같은 대화의 터미널로 다시 연다(터미널 없는 칸에서 되돌릴 때). */
  const seed = useCallback((id: string, s: Seed) => {
    procs.current[id] = s;
    setSeeds((sd) => ({ ...sd, [id]: s }));
  }, []);

  /** 칸에서 터미널을 걷을 때(터미널 없는 칸으로 옮길 때) 이 칸에 대해 알던 것을 놓는다.
   *  명부 캐시(askedPid 등)는 그대로 둔다 — 터미널이 닫히면 그 pid 는 폴링에 다시 안 잡힌다. */
  const forget = useCallback((id: string) => {
    setSeeds((sd) => without(sd, id));
    delete procs.current[id];
    delete sawRun.current[id];
    delete idleRuns.current[id];
    delete sessionOf.current[id];
    setChatIds((c) => without(c, id));
  }, []);

  return { stat, seeds, procs, chatIds, restore, seed, forget };
}
