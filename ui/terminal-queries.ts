import type { Terminal } from "@xterm/xterm";

export function delegateTerminalQueries(t: Pick<Terminal, "parser">): void {
  // kasa-pty가 먼저 답한 조회에 xterm까지 답하면 늦은 응답이 셸·Codex의 초안이 된다.
  // 색 변경 등 출력 명령은 통과시키고, 엔진이 소유한 조회만 여기서 끝낸다.
  t.parser.registerCsiHandler({ final: "c" }, () => true);
  t.parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true);
  t.parser.registerCsiHandler({ final: "n" }, (p) => p[0] === 5 || p[0] === 6);
  t.parser.registerCsiHandler({ prefix: "?", final: "n" }, (p) => p[0] === 6);
  for (const code of [10, 11, 12]) {
    t.parser.registerOscHandler(code, (data) => /^\?(;\?)*$/.test(data));
  }
  t.parser.registerOscHandler(4, (data) => /^\d+;\?(;\d+;\?)*$/.test(data));
}
