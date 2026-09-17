import assert from "node:assert/strict";
import test from "node:test";
import { asSeed, codexContinue, continuePlan, nativeSeed, restoreCmd } from "../ui/session.ts";

const sid = "12345678-2222-4222-8222-222222222222";
const launch = { home: "C:\\한글 & state", cwd: "C:\\project space", args: ["--profile", "review", "--sandbox", "read-only"] };

test("Codex 이어가기는 ID 없이 폴더와 명시 옵션만 전달", () => {
  const seed = codexContinue({ ...launch, id: sid });
  const decoded = JSON.parse(Buffer.from(seed.cmd.split(" ")[2], "base64url").toString());
  assert.deepEqual(decoded, launch);
  assert.equal("id" in decoded, false);
  assert.equal(seed.auto, true);
  assert.match(codexContinue(launch, true, true).cmd, / --picker$/);
});

test("Claude와 Codex 모두 자체 최근 대화 이어가기를 저장", () => {
  assert.equal(restoreCmd({ agent: "claude" }).cmd, "claude --continue");
  assert.equal(restoreCmd({ agent: "codex" }).cmd, "codex resume --last");
  assert.equal(restoreCmd({ agent: null, proc: "claude.exe" }).cmd, "claude --continue");
  assert.equal(restoreCmd({ agent: null, proc: "codex.exe" }).cmd, "codex resume --last");
  assert.equal(restoreCmd({ agent: null, proc: "powershell" }), null);
  assert.deepEqual(restoreCmd({ agent: null, proc: "npm" }), { cmd: "npm" });
});

test("현재 Codex 실행 옵션과 실패 상태 유지, 외부 원격 실행 자동 복원 금지", () => {
  const binding = { run: "a", launch, failed: false };
  assert.deepEqual(restoreCmd({ agent: "codex", codex: binding }).codexLaunch, launch);
  assert.equal(restoreCmd({ agent: null, codex: { ...binding, failed: true } }).auto, false);
  assert.equal(restoreCmd({ agent: "claude", codex: binding }).cmd, "claude --continue");
  assert.equal(restoreCmd({ agent: "codex", codex: { run: "b", failed: false } }).auto, false);
});

test("구형 ID 복원을 continue로 일회성 전환하고 임의 명령은 보존", () => {
  for (const cmd of ["claude", "claude --continue", `claude --resume ${sid}`, `claude --session-id ${sid}`])
    assert.equal(nativeSeed({ cmd, auto: false }, true).cmd, "claude --continue");
  assert.equal(nativeSeed({ cmd: "claude --continue", auto: false }, true).auto, true);
  assert.equal(nativeSeed({ cmd: "claude --continue", auto: false }).auto, false);
  const seed = nativeSeed({ cmd: "old", auto: false, codex: { ...launch, id: sid, resumable: false } }, true);
  assert.deepEqual(seed.codexLaunch, launch);
  assert.equal(seed.auto, true);
  assert.equal(nativeSeed({ cmd: "codex" }, true).cmd, "codex resume --last");
  for (const cmd of ["claude attach abcd1234", "claude --model special", "npm run deploy"]) {
    const original = { cmd, auto: false };
    assert.deepEqual(nativeSeed(original, true), original);
  }
});

test("같은 폴더의 중복 이어가기는 새 대화 대신 선택 목록", () => {
  const result = continuePlan({ a: "claude --continue", b: "claude --continue", c: "codex", d: "codex" },
    { a: "C:/Repo", b: "c:\\repo\\", c: "C:/Repo", d: "c:/repo" }, true);
  assert.equal(result.a.cmd, "claude --continue");
  assert.equal(result.b.cmd, "claude --resume");
  assert.equal(result.c.cmd, "codex resume --last");
  assert.equal(result.d.cmd, "codex resume");
  assert.match(result.b.notice, /선택/);
  assert.ok(Object.values(result).every(s => s.auto === true && !s.cmd.includes("--session-id")));
});

test("다른 작업 폴더는 각각 continue, 옵션 있는 중복 칸도 picker", () => {
  const result = continuePlan({ a: codexContinue(launch), b: codexContinue(launch), c: "codex" },
    { a: null, b: null, c: "C:/other" });
  assert.ok(!result.a.cmd.endsWith("--picker"));
  assert.match(result.b.cmd, /--picker$/);
  assert.equal(result.c.cmd, "codex resume --last");
  assert.deepEqual(result.b.codexLaunch.args, launch.args);
});

test("깨진 폴더·인자와 구형 불완전 메타데이터는 자동 실행하지 않음", () => {
  assert.throws(() => codexContinue({ ...launch, cwd: "relative" }));
  assert.throws(() => codexContinue({ ...launch, args: ["line\nbreak"] }));
  assert.equal(nativeSeed({ cmd: "old", codex: { ...launch, home: "bad" } }, true).auto, false);
  assert.equal(nativeSeed({ cmd: "chiispace-cli.exe codex-resume invalid" }, true).auto, false);
  for (const value of [null, 1, {}, { cmd: false }]) assert.equal(asSeed(value), null);
});
