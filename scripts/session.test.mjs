import assert from "node:assert/strict";
import test from "node:test";
import { asSeed, codexContinue, continuePlan, nativeSeed, restoreCmd, paneTitle, savedPaneTitles, label } from "../ui/session.ts";

const sid = "12345678-2222-4222-8222-222222222222";
const launch = { home: "C:\\한글 & state", cwd: "C:\\project space", args: ["--profile", "review", "--sandbox", "read-only"] };

test("자동 pane 이름은 상태 표시만 제거하고 제목의 경로 구분자를 보존", () => {
  assert.equal(paneTitle("  \u2731 결제 / API 검토  "), "결제 / API 검토");
  assert.equal(paneTitle("\u280b 한글 이름"), "한글 이름");
  assert.equal(paneTitle("한글\n이름\u0007"), "한글 이름");
  assert.equal(paneTitle("가".repeat(200)).length, 160);
  assert.equal(label("%0", { "%0": { agent: "claude" } }, { "%0": "서버 / 인증" }), "서버 / 인증");
});

test("셸·CLI 기본 제목과 실행 명령은 복원할 pane 이름으로 저장하지 않음", () => {
  for (const value of [null, 1, {}, "", "  ", "---", "shell", "Claude Code", "Codex", "codex.cmd", "claude.exe",
    "Windows PowerShell", "powershell.exe", "pwsh -NoExit", "cmd /c work", "node agent.js",
    "C:\\Windows\\System32\\cmd.exe - claude --continue", '"C:/Program Files/PowerShell/7/pwsh.exe"',
    "/usr/bin/bash", "\\\\server\\folder", "claude --continue", "codex resume --last", "작업 이름 - title  Codex",
    "작업 이름 - cmd /c build", "작업 이름 - chiispace-cli.exe agent claude", "작업 이름 - claude --continue"]) assert.equal(paneTitle(value), null, String(value));
  assert.equal(label("%0", { "%0": { agent: "codex", proc: "node" } }, { "%0": "C:/Windows/System32/cmd.exe" }), "codex");
});

test("위임 알림에서 지어진 대화 이름은 칸 이름으로 저장하지 않음", () => {
  // 알림 한 통이 /rename 으로 붙여 둔 이름을 밀어내면 칸을 구별할 수 없다.
  for (const value of ["Chiispace task-42488-6", "chiispace task-1-2",
    "Chiispace task-42488-6: use chiispace_claim, then chiispace_complete.",
    "chiispace_claim 으로 받은 작업", "✳ chiispace_complete 보고"]) assert.equal(paneTitle(value), null, value);
  // 같은 낱말이 들어가도 사람이 붙인 이름은 남는다.
  assert.equal(paneTitle("치이스페 칸 이름 수정"), "치이스페 칸 이름 수정");
  assert.equal(paneTitle("chiispace 배포 준비"), "chiispace 배포 준비");
  assert.deepEqual(savedPaneTitles({ "%0": "Chiispace task-42488-6", "%1": "옆 칸 연동" }, ["%0", "%1"]),
    { "%1": "옆 칸 연동" });
});

test("저장 이름은 살아 있는 칸만 복원하고 구형·깨진 이름 필드는 안전하게 무시", () => {
  const value = { "%0": "\u2731 이어갈 작업", "%1": "codex", "%2": 3, "%3": "닫힌 칸" };
  assert.deepEqual(savedPaneTitles(value, ["%0", "%1", "%2"]), { "%0": "이어갈 작업" });
  for (const old of [undefined, null, [], "old", 3]) assert.deepEqual(savedPaneTitles(old, ["%0"]), {});
  const original = { "%0": "서버 / 인증" };
  assert.deepEqual(savedPaneTitles(JSON.parse(JSON.stringify(original)), ["%0"]), original);
  assert.deepEqual(value, { "%0": "\u2731 이어갈 작업", "%1": "codex", "%2": 3, "%3": "닫힌 칸" });
});

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

test("같은 폴더의 여러 칸도 저장된 대로 이어간다", () => {
  // 둘째 칸부터 선택 목록으로 돌리던 가드를 뺐다. 사용자가 칸마다 그냥 이어 열리기를 원한다.
  const result = continuePlan({ a: "claude --continue", b: "claude --continue", c: "codex", d: "codex" }, true);
  assert.equal(result.a.cmd, "claude --continue");
  assert.equal(result.b.cmd, "claude --continue");
  assert.equal(result.c.cmd, "codex resume --last");
  assert.equal(result.d.cmd, "codex resume --last");
  assert.ok(Object.values(result).every(s => s.auto === true && !s.notice && !s.cmd.includes("--session-id")));
});

test("옵션 있는 Codex 칸도 중복 여부와 무관하게 같은 명령", () => {
  const result = continuePlan({ a: codexContinue(launch), b: codexContinue(launch), c: "codex" });
  assert.ok(!result.a.cmd.endsWith("--picker"));
  assert.ok(!result.b.cmd.endsWith("--picker"));
  assert.equal(result.a.cmd, result.b.cmd);
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
