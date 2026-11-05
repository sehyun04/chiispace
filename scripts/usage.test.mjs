import assert from "node:assert/strict";
import test from "node:test";
import { planUsage, planLabel, resetLabel, untilLabel, limitMeter, contextMeter, meterLevel } from "../ui/usage.ts";

// claude 2.1.318 `get_usage`(skip_behaviors) 의 실제 답에서 쓰는 부분.
const REAL = {
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 6, resets_at: "2026-11-05T17:10:00.257909+00:00" },
    seven_day: { utilization: 1, resets_at: "2026-11-11T15:00:00.257927+00:00" },
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 6, resets_at: "2026-11-05T17:10:00.257909+00:00" },
      { kind: "weekly_all", group: "weekly", percent: 1, resets_at: "2026-11-11T15:00:00.257927+00:00" },
    ],
  },
  behaviors: null,
};

test("get_usage 답에서 5시간·7일 한도를 읽는다", () => {
  const u = planUsage(REAL);
  assert.deepEqual(u.fiveHour, { used: 6, resetsAt: "2026-11-05T17:10:00.257909+00:00" });
  assert.equal(u.sevenDay.used, 1);
  assert.equal(u.plan, "pro");
  assert.equal(planLabel(u.plan), "Pro 구독");
  assert.equal(planLabel("enterprise"), "Enterprise 구독");
  assert.equal(planLabel(undefined), undefined);
  // 이름 붙은 창이 없으면 limits[] 를 kind 로 고른다.
  const byKind = planUsage({ rate_limits: { limits: REAL.rate_limits.limits } });
  assert.equal(byKind.fiveHour.used, 6);
  assert.equal(byKind.sevenDay.used, 1);
  // 0~100 밖은 자른다.
  assert.equal(planUsage({ rate_limits: { five_hour: { utilization: 130 } } }).fiveHour.used, 100);
});

test("구독 한도가 없는 계정(API 키·Bedrock)은 게이지를 띄우지 않는다", () => {
  assert.equal(planUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }), undefined);
  assert.equal(planUsage({ rate_limits: { five_hour: { utilization: null, resets_at: null } } }), undefined);
  for (const v of [null, undefined, "x", 3, []]) assert.equal(planUsage(v), undefined);
});

test("초기화 시각과 남은 시간은 사람이 읽는 말로", () => {
  const now = new Date(2026, 10, 5, 12, 0);
  const at = (h, m, day = 5) => new Date(2026, 10, day, h, m).toISOString();
  assert.equal(resetLabel(at(14, 10), now), "오후 2:10");
  assert.equal(resetLabel(at(9, 5), now), "오전 9:05");
  assert.equal(resetLabel(at(0, 0, 12), now), "11월 12일 오전 12:00");
  assert.equal(resetLabel(undefined, now), undefined);
  assert.equal(resetLabel("아님", now), undefined);
  assert.equal(untilLabel(at(14, 10), now), "2시간 10분 뒤");
  assert.equal(untilLabel(at(15, 0), now), "3시간 뒤");
  assert.equal(untilLabel(at(12, 35), now), "35분 뒤");
  assert.equal(untilLabel(at(0, 0, 12), now), "7일 뒤");
  assert.equal(untilLabel(at(11, 0), now), undefined);
});

test("게이지 한 줄: 줄의 풀이와 상태 표의 설명", () => {
  const now = new Date(2026, 10, 5, 12, 0);
  const m = limitMeter("5시간", { used: 42.4, resetsAt: new Date(2026, 10, 5, 14, 10).toISOString() }, now);
  assert.equal(m.used, 42.4);
  assert.equal(m.detail, "오후 2:10 초기화");
  assert.equal(m.title, "5시간 한도의 42% 사용 · 오후 2:10에 초기화(2시간 10분 뒤)");
  assert.equal(limitMeter("7일", { used: 1 }, now).title, "7일 한도의 1% 사용");
  assert.deepEqual(contextMeter({ totalTokens: 33644, maxTokens: 1000000, percentage: 3 }), { label: "문맥", used: 3, detail: "33,644 / 1,000,000 토큰" });
  assert.equal(contextMeter({ totalTokens: 50000, maxTokens: 200000 }).used, 25);
  assert.equal(contextMeter({}), undefined);
  assert.deepEqual([0, 69, 70, 89, 90, 100].map(meterLevel), ["ok", "ok", "warn", "warn", "bad", "bad"]);
});
