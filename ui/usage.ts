/** 구독 사용 한도와 문맥 창 — 입력바 위 게이지와 상태 표가 쓰는 값. React 없이 단위 검증한다.
 *
 *  한도는 claude 의 `get_usage` 가 claude.ai 의 /usage 화면과 같은 값으로 준다. 응답 헤더를 프록시에서 엿보는 길도
 *  있지만 그건 첫 요청이 나가야 보이고, 켜자마자 줄에 띄우려면 claude 에게 묻는 쪽이 맞다.
 *  API 키·Bedrock 처럼 구독 한도가 없는 계정은 `rate_limits` 가 비어 오고, 그때는 게이지를 띄우지 않는다. */

export type LimitWindow = { used: number; resetsAt?: string };
export type PlanUsage = { fiveHour?: LimitWindow; sevenDay?: LimitWindow; plan?: string };
/** 게이지 한 줄. `used` 는 0~100. */
export type Meter = { label: string; used: number; detail?: string; title?: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const pct = (v: number) => Math.max(0, Math.min(100, v));

function windowOf(v: unknown): LimitWindow | undefined {
  const w = obj(v);
  return typeof w.utilization === "number" && Number.isFinite(w.utilization)
    ? { used: pct(w.utilization), resetsAt: str(w.resets_at) }
    : undefined;
}

/** `get_usage` 답에서 5시간·7일 창. 둘 다 없으면 구독 한도가 없는 것이다. */
export function planUsage(body: unknown): PlanUsage | undefined {
  const b = obj(body);
  const r = obj(b.rate_limits);
  // 이름 붙은 창이 없는 판에서는 `limits[]` 를 `kind` 로 고른다(claude 가 표시 이름 말고 이것으로 가르라고 적어 둔 값).
  const limits = (Array.isArray(r.limits) ? r.limits : []).map(obj);
  const byKind = (kind: string) => {
    const l = limits.find((x) => x.kind === kind);
    return l ? windowOf({ utilization: l.percent, resets_at: l.resets_at }) : undefined;
  };
  const fiveHour = windowOf(r.five_hour) ?? byKind("session");
  const sevenDay = windowOf(r.seven_day) ?? byKind("weekly_all");
  if (!fiveHour && !sevenDay) return undefined;
  return { fiveHour, sevenDay, plan: str(b.subscription_type) };
}

const PLANS: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
export const planLabel = (plan?: string) => (plan ? `${PLANS[plan] ?? plan} 구독` : undefined);

const clock = (t: Date) => `${t.getHours() < 12 ? "오전" : "오후"} ${t.getHours() % 12 || 12}:${String(t.getMinutes()).padStart(2, "0")}`;

/** 초기화 시각. 오늘이면 시각만, 아니면 날짜를 붙인다. */
export function resetLabel(iso: string | undefined, now = new Date()): string | undefined {
  const t = iso ? new Date(iso) : undefined;
  if (!t || Number.isNaN(t.getTime())) return undefined;
  return t.toDateString() === now.toDateString() ? clock(t) : `${t.getMonth() + 1}월 ${t.getDate()}일 ${clock(t)}`;
}

/** 초기화까지 남은 시간. 지났으면 비운다 — 다음 조회가 새 창의 값을 준다. */
export function untilLabel(iso: string | undefined, now = new Date()): string | undefined {
  const t = iso ? new Date(iso).getTime() : NaN;
  const m = Math.ceil((t - now.getTime()) / 60000);
  if (!Number.isFinite(m) || m <= 0) return undefined;
  if (m < 60) return `${m}분 뒤`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}시간 ${m % 60}분 뒤` : `${h}시간 뒤`;
  return `${Math.round(h / 24)}일 뒤`;
}

/** 줄과 표의 게이지. */
export function limitMeter(label: string, w: LimitWindow, now = new Date()): Meter {
  const at = resetLabel(w.resetsAt, now);
  const left = untilLabel(w.resetsAt, now);
  const used = Math.round(w.used);
  return {
    label,
    used: w.used,
    detail: at ? `${at} 초기화` : undefined,
    title: `${label} 한도의 ${used}% 사용${at ? ` · ${at}에 초기화${left ? `(${left})` : ""}` : ""}`,
  };
}

/** 문맥 조회(`get_context_usage`) 답의 게이지. */
export function contextMeter(body: unknown): Meter | undefined {
  const b = obj(body);
  if (typeof b.totalTokens !== "number") return undefined;
  const n = (v: number) => v.toLocaleString("en-US");
  const max = typeof b.maxTokens === "number" && b.maxTokens > 0 ? b.maxTokens : undefined;
  const used = typeof b.percentage === "number" ? b.percentage : max ? (b.totalTokens / max) * 100 : 0;
  return { label: "문맥", used: pct(used), detail: `${n(b.totalTokens)}${max ? ` / ${n(max)}` : ""} 토큰` };
}

export const meterLevel = (used: number) => (used >= 90 ? "bad" : used >= 70 ? "warn" : "ok");
