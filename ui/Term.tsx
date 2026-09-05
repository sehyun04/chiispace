import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

/** 치이카와 팔레트로 맞춘 xterm 테마. 밝은 바탕이라 ANSI 색은 채도를 낮춰야
 *  글자가 종이 위에서 튀지 않는다 — 원색 그대로 쓰면 크림 배경에서 눈이 아프다. */
const THEME = {
  background: "#fbf5ea",
  foreground: "#5b4433",
  cursor: "#6b5442",
  cursorAccent: "#fbf5ea",
  selectionBackground: "#f3bfc355",
  black: "#5b4433",
  red: "#d98a86",
  green: "#7fae7d",
  yellow: "#c9a03c",
  blue: "#4f9ecb",
  magenta: "#a08bb6",
  cyan: "#5aa8bd",
  white: "#8b7460",
  brightBlack: "#b5a18c",
  brightRed: "#e79d99",
  brightGreen: "#93c191",
  brightYellow: "#f2ce5b",
  brightBlue: "#6fb7e0",
  brightMagenta: "#b8a7c9",
  brightCyan: "#8fcfe0",
  brightWhite: "#5b4433",
};

/** ANSI 16색을 테마 순서대로. 팔레트 번호를 색으로 바꿀 때 쓴다. */
const P16 = [
  THEME.black, THEME.red, THEME.green, THEME.yellow,
  THEME.blue, THEME.magenta, THEME.cyan, THEME.white,
  THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow,
  THEME.brightBlue, THEME.brightMagenta, THEME.brightCyan, THEME.brightWhite,
];

/** xterm 256 팔레트. 16~231 은 6x6x6 정육면체, 232~255 는 회색 계단이다. */
function palette(n: number): string {
  if (n < 16) return P16[n];
  if (n < 232) {
    const step = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return rgb(step[Math.floor(i / 36) % 6], step[Math.floor(i / 6) % 6], step[i % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return rgb(g, g, g);
}

const rgb = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 버퍼 한 줄을 색까지 살려 HTML 로 옮긴다.
 *
 *  글자만 뽑는 `translateToString` 으로는 claude 의 입력 상자와 상태줄이
 *  흑백이 되어, 정작 눈으로 찾으려던 표시(모델·브랜치·경고)가 안 보인다. */
function lineHtml(line: import("@xterm/xterm").IBufferLine): string {
  let out = "";
  let open = "";
  let buf = "";
  const flush = () => {
    if (!buf) return;
    out += open ? `<span style="${open}">${esc(buf)}</span>` : esc(buf);
    buf = "";
  };
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x);
    if (!c) continue;
    // 넓은 글자의 뒤쪽 반 칸은 폭 0 으로 온다. 그대로 넣으면 글자가 겹친다.
    if (c.getWidth() === 0) continue;
    let fg = c.isFgDefault() ? "" : c.isFgRGB() ? rgbOf(c.getFgColor()) : palette(c.getFgColor());
    let bg = c.isBgDefault() ? "" : c.isBgRGB() ? rgbOf(c.getBgColor()) : palette(c.getBgColor());
    if (c.isInverse()) [fg, bg] = [bg || THEME.background, fg || THEME.foreground];
    const style =
      (fg ? `color:${fg};` : "") +
      (bg ? `background:${bg};` : "") +
      (c.isBold() ? "font-weight:700;" : "") +
      (c.isDim() ? "opacity:.7;" : "") +
      (c.isUnderline() ? "text-decoration:underline;" : "");
    if (style !== open) {
      flush();
      open = style;
    }
    buf += c.getChars() || " ";
  }
  flush();
  return `<div>${out || "&nbsp;"}</div>`;
}

const rgbOf = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;

/** 맨 아래에 붙여 둘 줄들. claude 의 입력 상자 윗변부터 마지막 글자까지다.
 *
 *  상자를 못 찾으면 빈 배열이다 — 아무 줄이나 몇 개 떠서 붙이면 문맥 없는
 *  글자 조각이 칸 아래에 박혀 오히려 방해가 된다. */
function tailBlock(t: Terminal): string[] {
  const buf = t.buffer.active;
  let last = buf.length - 1;
  while (last >= 0 && !(buf.getLine(last)?.translateToString(true) ?? "").trim()) last--;
  if (last < 0) return [];
  // 상자 윗변(╭ ┌)을 위로 훑는다. 입력이 여러 줄이어도 상자째 다 담기게.
  const floor = Math.max(0, last - 16);
  for (let i = last; i >= floor; i--) {
    const head = (buf.getLine(i)?.translateToString(true) ?? "").trimStart()[0];
    if (head === "╭" || head === "┌") {
      const rows: string[] = [];
      for (let y = i; y <= last; y++) {
        const ln = buf.getLine(y);
        if (ln) rows.push(lineHtml(ln));
      }
      return rows;
    }
  }
  return [];
}

type W = Record<string, unknown>;

export function Term({
  id,
  focused,
  onTitle,
  cwd,
  shell,
  fontSize,
  seed,
}: {
  id: string;
  focused: boolean;
  onTitle: (id: string, title: string) => void;
  /** 연 폴더가 있으면 새 셸은 거기서 시작한다 — 매번 cd 를 치게 하지 않으려고. */
  cwd?: string;
  /** 띄울 셸의 실행 파일 경로. 없으면 엔진 기본(%ComSpec%).
   *
   *  cwd 와 같이 셸을 띄울 때 한 번만 쓰인다 — 돌고 있는 셸을 나중에 바꿔
   *  끼울 수는 없다. 그래서 아래 effect 의 deps 에도 넣지 않는다. */
  shell?: string;
  fontSize: number;
  /** 세션을 복원할 때, 이 pane 이 앱을 끄기 전 돌리고 있던 것.
   *
   *  `auto` 면 실행까지 한다. 에이전트를 이어 여는 것은 부작용이 없고, 명령만
   *  쳐 놓아서는 사용자가 말하는 "세션 복원"이 되지 않는다. 그 밖의 명령은
   *  쳐 놓기만 한다 — 빌드나 배포가 저 혼자 다시 도는 건 곤란하다. */
  seed?: { cmd: string; auto?: boolean };
}) {
  const host = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  // 최초 마운트 때의 값만 쓴다. deps 에 넣으면 이 값이 바뀔 때마다 PTY 가 다시 열린다.
  const seedOnce = useRef(seed);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const t = new Terminal({
      theme: THEME,
      // "Mono" 붙은 변형을 쓰면 안 된다 — 한글까지 한 칸에 욱여넣어 글자가 겹친다.
      fontFamily: '"D2KodingLigature Nerd Font", "Cascadia Code", "D2Coding", monospace',
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      // 기본값 1000 은 빌드 로그 한 번에 날아간다. 위로 올려 본 것이 이미
      // 사라진 뒤라면 스크롤백이 있으나 마나다.
      scrollback: 10000,
    });
    term.current = t;
    const fit = new FitAddon();
    t.loadAddon(fit);
    fitter.current = fit;
    // 링크는 웹뷰가 아니라 OS 기본 브라우저로 보낸다. 웹뷰 안에서 열면 앱이
    // 그 페이지로 통째로 바뀌고 돌아올 방법이 없다.
    t.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri).catch(() => {})));
    t.open(el);
    fit.fit();

    // 스크롤백이 없으면 xterm 은 휠을 위/아래 화살표로 바꿔 앱에 보낸다. claude 는
    // 그 화살표를 프롬프트 히스토리로 받으므로, 아무 데서나 휠만 굴려도 이전에
    // 친 것들이 줄줄이 튀어나온다. 스크롤할 것이 없으면 휠도 아무 일을 하지
    // 않는 편이 맞다. false 를 주면 xterm 은 그 변환까지 건너뛴다.
    t.attachCustomWheelEventHandler(() => (t.options.scrollback ?? 0) > 0);

    // 위로 스크롤하면 claude 의 입력 상자와 상태줄도 같이 밀려 올라간다. 지난
    // 대화를 되짚어 보는 동안에도 지금 무엇을 치는 자리인지는 보여야 하므로,
    // 올려다보는 동안만 그 몇 줄을 떠서 칸 밑에 붙여 둔다.
    //
    // 터미널을 건드려 붙잡아 둘 수는 없다 — 스크롤백은 셸이 쓴 그대로여야 하고,
    // 거기에 손을 대면 위로 올린 내용이 어긋난다. 그래서 붙잡는 대신 **베껴서
    // 덧그린다.** 맨 아래에 붙어 있으면 그릴 이유가 없으니 그때는 감춘다.
    const paintPin = () => {
      const el = pin.current;
      if (!el) return;
      const buf = t.buffer.active;
      const rows = buf.viewportY < buf.baseY ? tailBlock(t) : [];
      if (!rows.length) {
        if (!el.hidden) {
          el.hidden = true;
          el.innerHTML = "";
        }
        return;
      }
      const html = rows.join("");
      if (el.innerHTML !== html) el.innerHTML = html;
      el.hidden = false;
    };
    t.onScroll(paintPin);
    // 스크롤을 올려 둔 채로 claude 가 다시 그릴 때가 있다(일하는 중 표시가
    // 돈다). 그때도 띠가 따라가야 멈춘 화면처럼 보이지 않는다.
    t.onRender(paintPin);

    // 첫 줄부터 그리면 내용이 화면 위쪽에 몰리고 아래가 텅 빈다. 셸이든
    // claude 든 마찬가지다 — 대체 화면을 안 쓰므로 늘 커서가 있는 자리부터
    // 그린다. 미리 화면 높이만큼 빈 줄을 깔아 두면 커서가 맨 아래로 내려가서,
    // 프롬프트가 눈이 가는 자리에서 시작하고 출력은 위로 밀려 올라간다.
    if (t.rows > 1) t.write("\n".repeat(t.rows - 1));

    let alive = true;
    const unlisteners: Array<() => void> = [];

    // PTY 는 fit 이 끝난 뒤에 연다. 먼저 열면 기본 80x24 로 뜬 셸이 곧바로
    // 리사이즈를 맞으며 첫 화면을 다시 그린다 — 좁은 pane 일수록 눈에 띈다.
    invoke("pty_open", { id, cols: t.cols, rows: t.rows, cwd, shell }).catch((e) =>
      t.writeln(`\x1b[31m셸을 못 띄웠다: ${e}\x1b[0m`),
    );

    // 복원 명령은 **셸이 조용해진 뒤에** 넣는다.
    //
    // "첫 출력이 오면 500ms 뒤"로 두었더니 PowerShell 에서 첫 글자가 먹혔다
    // (`claude ...` 가 `laude ...` 로 들어가 "laude 를 인식할 수 없습니다"가 떴다).
    // cmd 는 즉시 뜨지만 PowerShell 은 배너를 뿌리고 프로필과 프롬프트 심을 얹는
    // 동안 아직 입력을 받을 준비가 안 돼 있다. 정해진 시간을 늘려 잡으면 느린
    // 컴퓨터에서 또 깨지므로 **출력이 멎는 것**을 신호로 삼는다. 그래도 끝없이
    // 무언가 뿌리는 셸이 있을 수 있으니 상한을 둔다.
    let seeded = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      if (!alive || seeded || !seedOnce.current) return;
      seeded = true;
      clearTimeout(quiet);
      const { cmd, auto } = seedOnce.current;
      if (!auto) {
        // paste 는 bracketed paste 로 감싸서 셸이 그것을 명령으로 실행하지
        // 않고 입력으로만 받는다. 쳐 놓기만 할 것은 이쪽이다.
        t.paste(cmd);
        return;
      }
      // 빈 줄을 하나 먼저 던지고 나서 명령을 보낸다.
      //
      // PowerShell 은 시작할 때 `-NoExit -Command <프롬프트 심>` 을 먼저 도는데,
      // 그게 끝나고 대화형 입력으로 넘어가는 사이에 **먼저 온 한 바이트를 먹는다.**
      // 그래서 `claude ...` 가 `laude ...` 로 들어가 "laude 를 인식할 수 없습니다"
      // 로 끝났다. 출력이 멎기를 기다려 봐도 그대로였다 — 시간 문제가 아니라 그
      // 전환에서 한 번 삼키는 것이다.
      //
      // 그러니 삼켜도 되는 것을 먼저 준다. 빈 줄은 어느 셸에서든 프롬프트만 한 번
      // 더 그리고 만다. 삼키지 않는 셸(cmd)에서도 손해가 그것뿐이다.
      send("\r");
      setTimeout(() => alive && send(cmd + "\r"), 250);
    };
    const hardStop = setTimeout(fire, 6000);
    listen<{ id: string; b64: string }>("pty:data", (ev) => {
      if (!alive || ev.payload.id !== id) return;
      t.write(decode(ev.payload.b64));
      if (seedOnce.current && !seeded) {
        clearTimeout(quiet);
        quiet = setTimeout(fire, 600);
      }
    }).then((un) => (alive ? unlisteners.push(un) : un()));

    t.onTitleChange((title) => onTitle(id, title));

    // 한글 IME.
    //
    // xterm 의 조합 처리에 기대지 않는다. 그쪽은 확정분을 자기 경로로 한 번
    // 보내고 브라우저의 input 이벤트로도 받는데, 둘 다 setTimeout(0) 뒤에
    // 도착해서 언제 어떤 모양으로 나올지가 정해져 있지 않다. WebView2 에서는
    // 둘 다 살아 나와 같은 글자가 두 번 들어가고, 조합 중인 자모까지 샌다.
    //
    // 그래서 조합이 열려 있는 동안은 xterm 이 무엇을 보내든 전부 버리고,
    // 확정된 문자열은 compositionend 에서 우리가 직접 한 번만 보낸다.
    // 확정분을 우리가 쥐고 있으므로 "확정분이 도착할 때는 이미 다음 조합이
    // 시작돼 있다"는 한글 특유의 순서 문제도 사라진다 — 받침이 다음 글자의
    // 초성으로 넘어가며 앞 글자가 확정되는 그 경로다.
    let composing = false;
    let commit = "";
    let commitAt = 0;
    const send = (data: string) => void invoke("pty_write", { id, data }).catch(() => {});

    const ta = t.textarea;
    if (ta) {
      ta.addEventListener("compositionstart", () => {
        composing = true;
      });
      ta.addEventListener("compositionend", (e) => {
        composing = false;
        const text = (e as CompositionEvent).data ?? "";
        commit = text;
        commitAt = performance.now();
        // 조합을 물러서 취소하면 빈 문자열로 끝난다. 보낼 것이 없다.
        if (text) send(text);
      });

      // compositionend 는 안 오는 때가 있다 — 조합 도중에 다른 pane 을
      // 누르거나, 탭을 바꾸거나, pane 을 끌어 옮겨 DOM 이 움직이거나, 창이
      // 포커스를 잃거나. 그러면 composing 이 true 로 박혀 그 pane 이 통째로
      // 먹통이 된다: 한글도 영문도 백스페이스도 안 먹는다. 조합을 여는 쪽만
      // 있고 닫는 쪽이 하나뿐이면 언젠가 반드시 이렇게 된다.
      ta.addEventListener("blur", () => {
        composing = false;
      });
      // 브라우저가 키 이벤트에 실어 주는 조합 상태가 진실이다. 무슨 이유로
      // compositionend 를 놓쳤든 다음 키 한 번에 풀린다. keyCode 229 는
      // IME 가 그 키를 삼키는 중이라는 표시라 조합으로 친다.
      ta.addEventListener(
        "keydown",
        (e) => {
          // keyCode 229 를 예외로 두면 안 된다. 한글 IME 는 조합을 여는 첫 키도
          // 229 로 주는데 그 시점의 isComposing 은 아직 false 다. 예외를 두면
          // 플래그가 잘못 켜져 있을 때 한글로는 영영 못 푼다 — 치면 칠수록
          // 229 만 오니 계속 먹통이다. isComposing 하나만 본다. 조합이 진짜로
          // 열리는 것은 이 keydown 바로 뒤의 compositionstart 다.
          if (!e.isComposing) composing = false;
        },
        true,
      );
    }

    t.onData((data) => {
      if (composing) return;
      // 우리가 방금 보낸 확정분을 xterm 이 한 틱 늦게 또 보낸다. 그 창 안에서
      // 같은 값이면 그것이다. 한글은 조합을 거치므로 사용자가 이 창 안에
      // 같은 값을 직접 쳐 넣을 길은 없다.
      if (commit && data === commit && performance.now() - commitAt < 150) return;
      send(data);
    });

    // 헤드리스 검증용 손잡이. Rust 의 CHIISPACE_AUTOSEND 가 이걸 통해 입력을
    // 넣는다 — term.input() 은 사용자가 친 것과 같은 경로(onData)를 타므로 키
    // 배선까지 실제로 검증된다. OS 로 키를 쏘면 포커스가 다른 창에 있을 때
    // 엉뚱한 앱에 타이핑된다.
    const w = window as unknown as W;
    ((w.__terms ??= {}) as Record<string, Terminal>)[id] = t;

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      invoke("pty_resize", { id, cols: t.cols, rows: t.rows }).catch(() => {});
    });
    ro.observe(el);

    return () => {
      alive = false;
      clearTimeout(quiet);
      clearTimeout(hardStop);
      ro.disconnect();
      unlisteners.forEach((un) => un());
      delete ((w.__terms ??= {}) as Record<string, Terminal>)[id];
      invoke("pty_close", { id }).catch(() => {});
      t.dispose();
      term.current = null;
    };
    // cwd·shell 은 셸을 띄울 때 한 번만 쓰인다. 폴더를 바꿔도 이미 뜬 pane 은
    // 그대로 두는 게 맞다 — 남이 쓰던 셸의 cwd 를 말없이 바꾸면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, onTitle]);

  // 글자 크기가 바뀌면 셀 크기가 바뀌고, 곧 셸이 아는 폭·높이도 바뀐다.
  // fit 만 하고 PTY 에 안 알리면 줄바꿈이 옛 폭 기준으로 들어온다.
  useEffect(() => {
    const t = term.current;
    if (!t || t.options.fontSize === fontSize) return;
    t.options.fontSize = fontSize;
    try {
      fitter.current?.fit();
    } catch {
      return;
    }
    invoke("pty_resize", { id, cols: t.cols, rows: t.rows }).catch(() => {});
  }, [fontSize, id]);

  // 포커스는 xterm 의 숨은 textarea 가 갖는다. 분할 직후 새 pane 으로 바로
  // 칠 수 있어야 하므로 여기서 옮겨 준다.
  //
  // 이것만으로는 모자란다. focused 값이 그대로인 채로 포커스를 잃는 경로가
  // 있어서다 — 배치가 바뀌면 React 가 slot DOM 을 실제로 옮기고(insertBefore),
  // DOM 이 움직이면 그 안의 textarea 는 blur 된다. 그때는 prop 이 안 변하니
  // 이 effect 가 다시 돌지 않는다. 그래서 App 이 `__terms[id].focus()` 로
  // 직접 되돌릴 수 있게 열어 둔다.
  useEffect(() => {
    if (!focused) return;
    term.current?.focus();
    (window as unknown as W).__term = term.current;
  }, [focused]);

  return (
    <div className="pane-body">
      <div className="term-host" ref={host} />
      {/* 위로 올려다보는 동안만 뜬다. 누르면 맨 아래로 돌아간다 — 그게 이
          띠를 보고 나서 하고 싶은 유일한 일이다. */}
      <div
        className="pinned"
        ref={pin}
        hidden
        style={{ fontSize, lineHeight: 1.25 }}
        onMouseDown={(e) => {
          e.preventDefault();
          term.current?.scrollToBottom();
          term.current?.focus();
        }}
      />
    </div>
  );
}
