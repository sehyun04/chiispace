import type { LimitWindow, PlanUsage } from "./usage";

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;

export function codexLimitWindow(value: unknown): (LimitWindow & { minutes?: number }) | undefined {
  const window = object(value);
  if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return undefined;
  // 옛 CLI 와 설치된 CLI 의 두 필드 모두 사용 기간(분)이다.
  const duration = window.windowDurationMins ?? window.limitWindowMinutes;
  const reset = typeof window.resetsAt === "number" && window.resetsAt > 0 ? new Date(window.resetsAt * 1000) : undefined;
  return {
    used: Math.max(0, Math.min(100, window.usedPercent)),
    minutes: typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0 ? duration : undefined,
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined,
  };
}

function planOf(limits: Data | undefined): PlanUsage | undefined {
  if (!limits) return undefined;
  const usage: PlanUsage = {};
  for (const value of [limits.primary, limits.secondary]) {
    const window = codexLimitWindow(value);
    if (window?.minutes === 5 * 60) usage.fiveHour ??= { used: window.used, resetsAt: window.resetsAt };
    if (window?.minutes === 7 * 24 * 60) usage.sevenDay ??= { used: window.used, resetsAt: window.resetsAt };
  }
  return usage.fiveHour || usage.sevenDay ? usage : undefined;
}

export function codexPlanUsage(body: unknown): PlanUsage | undefined {
  const data = object(body);
  const codex = object(object(data?.rateLimitsByLimitId)?.codex);
  return codex ? planOf(codex) : codexRollingUsage(body);
}

export function codexRollingUsage(body: unknown): PlanUsage | undefined {
  const limits = object(object(body)?.rateLimits);
  // 모델별 한도를 계정의 기본 5시간·7일 한도로 덮어쓰지 않는다.
  return limits?.limitId == null || limits.limitId === "codex" ? planOf(limits) : undefined;
}
