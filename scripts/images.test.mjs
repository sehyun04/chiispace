import assert from "node:assert/strict";
import test from "node:test";
import { fitSize, keepsOriginal, imageBlock, MAX_SIDE, MAX_BYTES } from "../ui/images.ts";

test("한도는 claude 가 터미널에서 붙인 그림에 거는 값과 같다", () => {
  // claude 2.1.319 바이너리: {maxWidth:2000, maxHeight:2000, maxBase64Size:5242880, targetRawSize:3932160}
  assert.equal(MAX_SIDE, 2000);
  assert.equal(MAX_BYTES, 3932160);
  // 원본 한도를 base64 로 늘려도 API 의 한 장 한도(5MB) 안이다.
  assert.ok(Math.ceil(MAX_BYTES / 3) * 4 <= 5242880);
});

test("긴 변을 2000 에 맞추고 비율은 지킨다", () => {
  assert.deepEqual(fitSize(3000, 1000), { width: 2000, height: 667 });
  assert.deepEqual(fitSize(1000, 4000), { width: 500, height: 2000 });
  // 이미 작으면 키우지 않는다.
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
  // 아주 가는 그림도 0 픽셀이 되지 않는다(캔버스가 빈 그림을 굽는다).
  assert.deepEqual(fitSize(20000, 1), { width: 2000, height: 1 });
});

test("한도 안의 보낼 수 있는 형식만 원본을 그대로 보낸다", () => {
  const ok = { type: "image/png", size: 500_000, width: 1920, height: 1080 };
  assert.equal(keepsOriginal(ok), true);
  assert.equal(keepsOriginal({ ...ok, type: "image/webp" }), true);
  assert.equal(keepsOriginal({ ...ok, width: 2560, height: 1440 }), false, "큰 화면 캡처");
  assert.equal(keepsOriginal({ ...ok, size: MAX_BYTES + 1 }), false, "무거운 그림");
  assert.equal(keepsOriginal({ ...ok, type: "image/bmp" }), false, "API 가 받지 않는 형식");
});

test("API 의 base64 그림 블록 모양", () => {
  assert.deepEqual(imageBlock({ mediaType: "image/jpeg", data: "QUJD", url: "data:image/jpeg;base64,QUJD" }), {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
  });
});
