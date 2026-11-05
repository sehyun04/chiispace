/** 구독 사용 한도를 claude 에게 물어 들고 있는다(`get_usage`).
 *
 *  한도는 칸이 아니라 계정에 걸린다. 칸마다 따로 물으면 같은 값을 칸 수만큼 묻게 되므로 마지막 답을
 *  모듈 하나에 두고 모든 칸이 같이 본다 — 새로 연 칸도 묻기 전에 바로 게이지를 띄운다.
 *  다른 터미널의 claude 도 같은 한도를 쓰므로 가만히 있어도 값이 오른다. 그래서 턴이 끝날 때만이 아니라
 *  주기적으로도 묻는다. */
import { useEffect, useRef, useState } from "react";
import { planUsage, type PlanUsage } from "./usage";

let shared: PlanUsage | undefined;
let askedAt = 0;
const subs = new Set<(u: PlanUsage) => void>();

/** 주기 조회 간격. 여러 칸의 타이머가 엇갈려도 이 안에서는 한 번만 묻는다. */
const EVERY = 60_000;
/** 턴이 끝났을 때의 조회 간격. 짧은 턴을 연달아 보내도 몰아 묻지 않는다. */
const AFTER_TURN = 10_000;

export function usePlanUsage(ask: () => Promise<unknown>, alive: boolean, busy: boolean): PlanUsage | undefined {
  const [usage, setUsage] = useState(shared);
  const askRef = useRef(ask);
  askRef.current = ask;

  const refresh = (gap: number) => {
    if (Date.now() - askedAt < gap) return;
    askedAt = Date.now();
    askRef.current().then(
      (body) => {
        const u = planUsage(body);
        if (!u) return;
        shared = u;
        subs.forEach((f) => f(u));
      },
      () => {},
    );
  };

  useEffect(() => {
    subs.add(setUsage);
    return () => {
      subs.delete(setUsage);
    };
  }, []);

  useEffect(() => {
    if (!alive) return;
    const t = window.setInterval(() => refresh(EVERY - 5_000), EVERY);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive]);

  // 켜졌을 때와 턴이 끝났을 때. 일하는 중에는 묻지 않는다 — 끝난 뒤의 값이 그 턴까지 반영한 값이다.
  useEffect(() => {
    if (alive && !busy) refresh(AFTER_TURN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, busy]);

  return usage;
}
