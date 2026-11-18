import assert from "node:assert/strict";
import test from "node:test";
import { codexInput, codexUserImages } from "../ui/codex-images.ts";
import { codexPlanUsage, codexRollingUsage } from "../ui/codex-usage.ts";

const picture = { mediaType: "image/png", data: "cGlj", url: "data:image/png;base64,cGlj" };

test("Codex 그림만 있는 전송과 글·그림을 섞은 전송", () => {
  const image = { type: "image", url: picture.url };
  assert.deepEqual(codexInput("", [picture]), [image]);
  assert.deepEqual(codexInput("스크린샷 보기", [picture]), [
    { type: "text", text: "스크린샷 보기", text_elements: [] },
    image,
  ]);
  assert.deepEqual(codexInput("한 줄"), [{ type: "text", text: "한 줄", text_elements: [] }]);
});

test("Codex 대화 이력은 내장 그림만 렌더링", () => {
  assert.deepEqual(codexUserImages([
    { type: "text", text: "그림 확인" },
    { type: "image", url: picture.url },
    { type: "image", url: "https://example.invalid/picture.png" },
    { type: "localImage", path: "C:/private/picture.png" },
    { type: "image", url: "data:image/svg+xml;base64,cGlj" },
  ]), [picture.url]);
  assert.equal(codexUserImages([{ type: "image", url: "file:///C:/private/picture.png" }]), undefined);
  assert.equal(codexUserImages(undefined), undefined);
});

test("Codex 계정 한도는 필드 순서 대신 5시간·7일 기간으로 찾음", () => {
  const primary = { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1795000000 };
  const secondary = { usedPercent: 0, windowDurationMins: 300 };
  const usage = codexPlanUsage({
    rateLimits: { primary: { usedPercent: 95, windowDurationMins: 300 } },
    rateLimitsByLimitId: { codex: { primary, secondary }, codex_other: { secondary } },
  });
  assert.deepEqual(usage?.fiveHour, { used: 0, resetsAt: undefined });
  assert.deepEqual(usage?.sevenDay, { used: 31, resetsAt: new Date(primary.resetsAt * 1000).toISOString() });
  assert.equal(codexPlanUsage({ rateLimits: { secondary: { usedPercent: 14, limitWindowMinutes: 10080 } } })?.sevenDay?.used, 14);
});

test("Codex 다른 한도와 확인되지 않은 기간은 계정 게이지에서 생략", () => {
  assert.equal(codexPlanUsage({ rateLimits: { primary: { windowDurationMins: 300 }, secondary: { usedPercent: 12 } } }), undefined);
  assert.equal(codexPlanUsage({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 60 } } }), undefined);
  assert.equal(codexRollingUsage({ rateLimits: { limitId: "codex_other", primary: { usedPercent: 12, windowDurationMins: 300 } } }), undefined);
  const update = codexRollingUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 63, windowDurationMins: 300 } } });
  assert.equal(update?.fiveHour?.used, 63);
  assert.ok(!("sevenDay" in update));
});
