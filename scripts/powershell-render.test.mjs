import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/xterm";
import { powerShellOutput } from "../ui/powershell-render.ts";

const frame = "\x1b[?25l\x1b[1;1H\x1b[93mcodex\x1b[37m\x1b[40m a한글   \x1b[0m\x1b[1;8H\x1b[?25h";
const corrected = frame.replaceAll("\x1b[37m\x1b[40m", "\x1b[39m\x1b[49m");
const encode = s => new TextEncoder().encode(s);

test("PowerShell 기본색 재그리기의 모든 바이트 경계와 연속 묶음", () => {
  const input = encode("before한" + frame + frame + "after글");
  for (let split = 0; split <= input.length; split++) {
    const chunks = [];
    const filter = powerShellOutput(d => chunks.push(d), () => true);
    filter.write(input.subarray(0, split));
    filter.write(input.subarray(split));
    assert.equal(Buffer.concat(chunks).toString("utf8"), "before한" + corrected + corrected + "after글");
    filter.dispose();
  }
});

test("일반 프로그램·명시적 배경·선택 반전·OSC 출력 보존", () => {
  for (const [enabled, input] of [
    [false, frame], [true, "\x1b[37m\x1b[40m intentional \x1b[0m"],
    [true, frame.replace("\x1b[37m\x1b[40m", "\x1b[97;40m")],
    [true, frame.replace("\x1b[37m\x1b[40m", "\x1b[7m")],
    [true, frame.replace("\x1b[37m\x1b[40m", "\x1b[48;2;30;40;50m")],
    [true, frame.replace(" a한글", "\x1b]0;title\x07 a한글")],
  ]) {
    const chunks = [];
    const filter = powerShellOutput(d => chunks.push(d), () => enabled);
    filter.write(encode(input));
    assert.equal(Buffer.concat(chunks).toString("utf8"), input);
    filter.dispose();
  }
});

test("불완전·대용량 출력과 셸 전환에서 바이트 유실 없이 해제", async () => {
  const chunks = [];
  let enabled = true;
  const filter = powerShellOutput(d => chunks.push(d), () => enabled);
  const partial = encode("\x1b[?25l\x1b[1;1H한글");
  filter.write(partial);
  await new Promise(r => setTimeout(r, 70));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(partial));
  chunks.length = 0;
  filter.write(encode("\x1b[?25l"));
  enabled = false;
  filter.write(encode("child"));
  assert.equal(Buffer.concat(chunks).toString(), "\x1b[?25lchild");
  chunks.length = 0;
  enabled = true;
  const large = "\x1b[?25l" + "x".repeat(70000);
  filter.write(encode(large));
  assert.equal(Buffer.concat(chunks).toString(), large);
  filter.dispose();
});

test("보정된 xterm 셀의 기본 배경과 한글·커서 위치", async () => {
  const t = new xterm.Terminal({ allowProposedAPI: true, cols: 40, rows: 5 });
  const filter = powerShellOutput(d => t.write(d), () => true);
  try {
    for (const byte of encode(frame)) filter.write(new Uint8Array([byte]));
    await new Promise(r => t.write("", r));
    const line = t.buffer.active.getLine(0);
    assert.equal(line.translateToString(true).trimEnd(), "codex a한글");
    for (let x = 0; x < 40; x++) assert.equal(line.getCell(x).isBgDefault(), true);
    assert.equal(t.buffer.active.cursorX, 7);
  } finally { filter.dispose(); t.dispose(); }
});
