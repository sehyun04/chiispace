const hide = "\x1b[?25l";
const show = "\x1b[?25h";
const redraw = /^\x1b\[\?25l\x1b\[\d+;\d+H(?:[^\x1b]|\x1b\[[\d;]*m|\x1b\[\d+;\d+H)*\x1b\[0m(?:\x1b\[\d+;\d+H)?\x1b\[\?25h$/;

// PSReadLine 2.0은 기본색 복귀에도 37m/40m을 써서 밝은 테마에서 삭제 자리가 어두워진다.
// 프로그램의 명시적 배경색까지 지우지 않도록 PowerShell 입력줄 재그리기 묶음만 보정한다.
export function powerShellOutput(write: (data: Uint8Array) => void, isPowerShell: () => boolean) {
  let pending = "";
  let frame = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
  const flush = () => {
    clearTimeout(timer);
    if (pending) write(bytes(pending));
    pending = "";
    frame = false;
  };
  return {
    write(data: Uint8Array) {
      clearTimeout(timer);
      if (!isPowerShell()) { flush(); write(data); return; }
      let out = "";
      for (const byte of data) {
        pending += String.fromCharCode(byte);
        if (frame) {
          if (pending.endsWith(show)) {
            out += redraw.test(pending)
              ? pending.replace(/\x1b\[37m\x1b\[40m/g, "\x1b[39m\x1b[49m")
              : pending;
            pending = "";
            frame = false;
          } else if (pending.length >= 65536) {
            out += pending;
            pending = "";
            frame = false;
          }
        } else {
          while (pending && !hide.startsWith(pending)) {
            out += pending[0];
            pending = pending.slice(1);
          }
          if (pending === hide) frame = true;
        }
      }
      if (out) write(bytes(out));
      // 닫는 커서 명령이 없는 출력도 멈추지 않는다. UTF-8은 디코딩하지 않아 청크 경계가 보존된다.
      if (pending) timer = setTimeout(flush, 40);
    },
    dispose() { clearTimeout(timer); pending = ""; },
  };
}
