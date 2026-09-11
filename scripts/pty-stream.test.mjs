import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import xterm from "@xterm/xterm";
import { delegateTerminalQueries } from "../ui/terminal-queries.ts";

// 테스트용 초기화 순서가 제품의 바이트와 달라지면 파서 복구를 검증한 셈이 아니다.
const source = readFileSync(new URL("../src-tauri/src/pty_stream.rs", import.meta.url), "utf8");
const literal = source.match(/const RESYNC: &\[u8\] = b"([^"]+)";/)?.[1];
assert.ok(literal, "PTY 재연결 바이트 상수 누락");
const resync = literal.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
assert.ok(!resync.includes("\\"), "검증하지 않은 Rust 바이트 이스케이프");
const write = (t, data) => new Promise((resolve) => t.write(data, resolve));

test("끊긴 VT·UTF-8 및 대체 화면을 스냅샷으로 복구", async () => {
  for (const partial of ["\x1b]0;unfinished", "\x1bPunfinished", "\x1b[12;", new Uint8Array([0xeb, 0x82])]) {
    const t = new xterm.Terminal({ allowProposedAPI: true, cols: 80, rows: 20 });
    try {
      await write(t, "STALE-HISTORY\r\n\x1b[?1049h\x1b[?2026h");
      await write(t, partial);
      const lines = Array.from({ length: 60 }, (_, i) => `RESTORED-${i}-한글`);
      await write(t, new TextEncoder().encode(resync + lines.join("\r\n") + "\r\n"));
      const b = t.buffer.active;
      const actual = Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true)).filter(Boolean);
      assert.equal(b.type, "normal");
      assert.deepEqual(actual, lines, "이전 화면 중복이나 스냅샷 유실");
      assert.ok(b.baseY > 0);
    } finally { t.dispose(); }
  }
});

test("화면 복구 후에도 터미널 조회 응답의 중복 차단 유지", async () => {
  const t = new xterm.Terminal({ allowProposedAPI: true });
  try {
    const input = [];
    delegateTerminalQueries(t);
    t.onData((data) => input.push(data));
    await write(t, resync + "\x1b[c\x1b[6n\x1b]11;?\x1b\\");
    assert.deepEqual(input, []);
  } finally { t.dispose(); }
});
