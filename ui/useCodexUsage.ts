import { useEffect, useRef, useState } from "react";
import { codexPlanUsage, codexRollingUsage } from "./codex-usage";
import type { PlanUsage } from "./usage";

let usage: PlanUsage | undefined;
let askedAt = 0;
let revision = 0;
const subscribers = new Set<(value: PlanUsage | undefined) => void>();

const EVERY = 60_000;
const AFTER_TURN = 10_000;

function publish(value: PlanUsage | undefined) {
  usage = value;
  for (const subscriber of subscribers) subscriber(usage);
}

export function updateCodexUsage(params: unknown) {
  const update = codexRollingUsage(params);
  if (!update) return;
  revision++;
  // 알림에는 한 창만 실릴 수 있다. 안 온 창은 마지막으로 읽은 값을 보존한다.
  publish({ ...usage, ...update });
}

export function useCodexUsage(ask: () => Promise<unknown>, ready: boolean, busy: boolean): PlanUsage | undefined {
  const [value, setValue] = useState(usage);
  const askRef = useRef(ask);
  askRef.current = ask;

  const refresh = (gap: number) => {
    if (Date.now() - askedAt < gap) return;
    askedAt = Date.now();
    const requestRevision = ++revision;
    void askRef.current().then(body => {
      if (revision === requestRevision) publish(codexPlanUsage(body));
    }, () => {});
  };

  useEffect(() => {
    subscribers.add(setValue);
    setValue(usage);
    return () => {
      subscribers.delete(setValue);
      if (!subscribers.size) {
        usage = undefined;
        askedAt = 0;
        revision++;
      }
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => refresh(EVERY - 5_000), EVERY);
    return () => window.clearInterval(timer);
  }, [ready]);

  useEffect(() => {
    if (ready && !busy) refresh(AFTER_TURN);
  }, [ready, busy]);

  return value;
}
