/** 폰 화면이 PC 대화창 부품을 그대로 쓰게 하는 바꿔 끼우기.
 *
 *  부품은 `@tauri-apps/api` 의 `invoke`·`listen` 을 부르고, 둘 다 `window.__TAURI_INTERNALS__` 를 거친다. 폰에는 Tauri 가
 *  없으므로 그 자리에 이 PC 의 폰 서버(remote.rs)로 가는 길을 놓는다 — 명령은 POST /api/invoke, 이벤트는 GET /api/events(SSE).
 *  무엇을 부를 수 있는지는 서버가 정한다. 여기서는 길만 놓는다.
 *
 *  iOS 는 홈 화면 앱을 뒤로 보내면 연결을 끊는다. 다시 이어지면 `remote:resync` 를 내어 화면이 지금 상태를 다시 받게 한다 —
 *  끊긴 사이에 지나간 이벤트는 돌아오지 않는다. */

export type RemoteStatus = "connecting" | "open" | "retrying";

type Frame = { event: string; payload: unknown };

/** SSE 조각을 이벤트로. 덜 온 끝은 다음 조각과 잇는다. 숨 쉬는 줄(`: ping`)은 버린다. */
export function takeFrames(buf: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  let rest = buf.replace(/\r\n/g, "\n");
  for (let at = rest.indexOf("\n\n"); at >= 0; at = rest.indexOf("\n\n")) {
    const block = rest.slice(0, at);
    rest = rest.slice(at + 2);
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const f = JSON.parse(data) as { event?: unknown; payload?: unknown };
      if (typeof f.event === "string") frames.push({ event: f.event, payload: f.payload });
    } catch {
      // 한 덩이가 깨져도 다음 덩이는 읽는다.
    }
  }
  return { frames, rest };
}

/** 이벤트 귀 목록. `listen` 이 준 처리기(콜백 번호)를 이벤트 이름별로 든다. */
export function listenerTable() {
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, Map<number, number>>();
  let next = 1;
  return {
    callback(fn: (data: unknown) => void, once = false) {
      const id = next++;
      callbacks.set(id, (d) => {
        if (once) callbacks.delete(id);
        fn(d);
      });
      return id;
    },
    drop(id: number) {
      callbacks.delete(id);
    },
    listen(event: string, handler: number) {
      const id = next++;
      let m = listeners.get(event);
      if (!m) listeners.set(event, (m = new Map()));
      m.set(id, handler);
      return id;
    },
    unlisten(event: string, id: number) {
      listeners.get(event)?.delete(id);
    },
    emit(event: string, payload: unknown) {
      for (const [id, handler] of [...(listeners.get(event) ?? [])]) callbacks.get(handler)?.({ event, id, payload });
    },
  };
}

type Options = {
  token: () => string | null;
  /** 서버가 이 폰을 모른다(잊었거나 토큰이 없다). */
  onUnpaired: () => void;
  onStatus: (s: RemoteStatus) => void;
};

export function installRemote({ token, onUnpaired, onStatus }: Options) {
  const table = listenerTable();
  const w = window as unknown as Record<string, unknown>;

  const call = async (cmd: string, args: unknown) => {
    const t = token();
    if (!t) throw "짝지은 폰이 아니다";
    const res = await fetch("/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ cmd, args: args ?? {} }),
      cache: "no-store",
    });
    if (res.status === 401) {
      onUnpaired();
      throw "짝지은 폰이 아니다";
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    // Tauri 의 invoke 는 Rust 가 준 오류 글을 그대로 거절값으로 준다. 부품이 그 모양을 기대한다.
    if (!res.ok) throw body?.error ?? `요청 실패 (${res.status})`;
    return body;
  };

  w.__TAURI_INTERNALS__ = {
    transformCallback: (fn: (d: unknown) => void, once?: boolean) => table.callback(fn, once),
    unregisterCallback: (id: number) => table.drop(id),
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "plugin:event|listen") return table.listen(String(args.event), Number(args.handler));
      if (cmd === "plugin:event|unlisten") return table.unlisten(String(args.event), Number(args.eventId));
      if (cmd === "plugin:event|emit") return table.emit(String(args.event), args.payload);
      // 클립보드는 폰의 것이다(`/copy` 같은 PC 클립보드 쓰기를 폰으로 보내지 않는다).
      if (cmd === "plugin:clipboard-manager|write_text") return navigator.clipboard.writeText(String(args.text ?? ""));
      if (cmd.startsWith("plugin:")) throw "폰에서는 할 수 없는 일이다";
      return call(cmd, args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string, id: number) => table.unlisten(event, id) };

  let ctrl: AbortController | null = null;
  let wait = 1000;
  let opened = false;
  let last = Date.now();
  let timer: number | undefined;

  const connect = async () => {
    window.clearTimeout(timer);
    const t = token();
    if (!t) return;
    ctrl?.abort();
    const c = new AbortController();
    ctrl = c;
    onStatus(opened ? "retrying" : "connecting");
    try {
      const res = await fetch("/api/events", { headers: { Authorization: `Bearer ${t}` }, signal: c.signal, cache: "no-store" });
      if (res.status === 401) {
        ctrl = null;
        onUnpaired();
        return;
      }
      if (!res.ok || !res.body) throw new Error(String(res.status));
      wait = 1000;
      last = Date.now();
      onStatus("open");
      if (opened) table.emit("remote:resync", null);
      opened = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        last = Date.now();
        const { frames, rest } = takeFrames(buf + dec.decode(value, { stream: true }));
        buf = rest;
        for (const f of frames) table.emit(f.event, f.payload);
      }
    } catch {
      // 끊긴 것이다. 아래에서 다시 잇는다 — 이 연결을 다른 것이 갈아 끼웠거나 멈췄으면 그쪽이 맡는다.
    }
    if (ctrl !== c) return;
    ctrl = null;
    onStatus("retrying");
    timer = window.setTimeout(connect, wait);
    wait = Math.min(wait * 2, 15000);
  };

  // 서버는 15초마다 숨 쉬는 줄을 보낸다. 40초 넘게 아무것도 없으면 겉으로만 열린 연결이다(뒤로 갔다 온 iOS 가 그렇다).
  window.setInterval(() => {
    if (ctrl && Date.now() - last > 40000) {
      wait = 1000;
      void connect();
    }
  }, 10000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!ctrl || Date.now() - last > 20000) {
      wait = 1000;
      void connect();
    }
  });

  return {
    /** 짝지은 뒤나 앱을 연 때. */
    start: () => void connect(),
    stop: () => {
      window.clearTimeout(timer);
      ctrl?.abort();
      ctrl = null;
    },
  };
}
