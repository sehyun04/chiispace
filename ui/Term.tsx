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

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type W = Record<string, unknown>;

export function Term({
  id,
  focused,
  onTitle,
  cwd,
  fontSize,
  seed,
}: {
  id: string;
  focused: boolean;
  onTitle: (id: string, title: string) => void;
  /** 연 폴더가 있으면 새 셸은 거기서 시작한다 — 매번 cd 를 치게 하지 않으려고. */
  cwd?: string;
  fontSize: number;
  /** 세션을 복원할 때, 이 pane 이 앱을 끄기 전 돌리고 있던 명령. 쳐 놓기만
   *  하고 실행하지는 않는다 — 빌드나 배포가 저 혼자 다시 도는 건 곤란하다. */
  seed?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  // 최초 마운트 때의 값만 쓴다. deps 에 넣으면 이 값이 바뀔 때마다 PTY 가 다시 열린다.
  const seedOnce = useRef(seed);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const t = new Terminal({
      theme: THEME,
      fontFamily: '"Consolas", "D2Coding", monospace',
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

    let alive = true;
    const unlisteners: Array<() => void> = [];

    // PTY 는 fit 이 끝난 뒤에 연다. 먼저 열면 기본 80x24 로 뜬 셸이 곧바로
    // 리사이즈를 맞으며 첫 화면을 다시 그린다 — 좁은 pane 일수록 눈에 띈다.
    invoke("pty_open", { id, cols: t.cols, rows: t.rows, cwd }).catch((e) =>
      t.writeln(`\x1b[31m셸을 못 띄웠다: ${e}\x1b[0m`),
    );

    let seeded = false;
    listen<{ id: string; b64: string }>("pty:data", (ev) => {
      if (!alive || ev.payload.id !== id) return;
      t.write(decode(ev.payload.b64));
      // 셸이 첫 출력을 낸 뒤에 얹는다. 프롬프트가 그려지기 전에 넣으면 글자가
      // 그 뒤에 오는 출력에 묻혀 안 보인다.
      if (seedOnce.current && !seeded) {
        seeded = true;
        const cmd = seedOnce.current;
        setTimeout(() => alive && t.paste(cmd), 300);
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
    }

    t.onData((data) => {
      if (composing) return;
      // 우리가 방금 보낸 확정분을 xterm 이 한 틱 늦게 또 보낸다. 그 창 안에서
      // 같은 값이면 그것이다. 한글은 조합을 거치므로 사용자가 이 창 안에
      // 같은 값을 직접 쳐 넣을 길은 없다.
      if (commit && data === commit && performance.now() - commitAt < 150) return;
      send(data);
    });

    // 헤드리스 검증용 손잡이. Rust 의 KASASPACE_AUTOSEND 가 이걸 통해 입력을
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
      ro.disconnect();
      unlisteners.forEach((un) => un());
      delete ((w.__terms ??= {}) as Record<string, Terminal>)[id];
      invoke("pty_close", { id }).catch(() => {});
      t.dispose();
      term.current = null;
    };
    // cwd 는 셸을 띄울 때 한 번만 쓰인다. 폴더를 바꿔도 이미 뜬 pane 은
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
  useEffect(() => {
    if (!focused) return;
    term.current?.focus();
    (window as unknown as W).__term = term.current;
  }, [focused]);

  return (
    <div className="pane-body">
      <div className="term-host" ref={host} />
    </div>
  );
}
