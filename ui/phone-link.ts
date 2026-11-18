/** 폰과 PC 사이의 통로 — 중계(relay/)를 지나는 웹소켓 하나에 암호화한 말을 싣는다. PC 쪽 짝은 src-tauri/src/remote.rs.
 *
 *  짝짓기(`pair`)와 평소 연결(`Link`) 둘이다. 짝짓기는 키를 바꾸고 두 화면에 같은 여섯 자리를 보인다. 평소 연결은 연결마다
 *  인사(hello/hi)로 이번 연결의 키를 만들고, 그 뒤로는 명령 부르기(invoke)와 이벤트(ev)를 암호문으로만 주고받는다.
 *  React·DOM 에 기대지 않는다(브라우저와 Node 의 WebSocket·WebCrypto 만 쓴다) — 검증이 Node 에서도 폰 노릇을 한다. */
import { b64u, commitOf, loadKey, newKey, open, openRaw, random, sasOf, seal, sessionKeys, unb64u } from "./phone-crypto.ts";

/** 짝지은 결과. 폰에만 둔다. */
export type Paired = { dev: string; jwk: JsonWebKey; pc: string };
export type LinkStatus = "connecting" | "open" | "retrying" | "pc-offline";

/** 웹소켓 한 통에 싣는 암호문 조각. PC 쪽(remote.rs `CHUNK`)과 같다. Cloudflare 웹소켓 한 통의 한도(1MiB) 안이다. */
const CHUNK = 240_000;

/** 지금 페이지 옆의 `ws` — 중계에서는 `/r/<방>/ws` 다. */
export const socketUrl = (href: string) => {
  const u = new URL("ws", href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
};

type Msg = Record<string, unknown>;

/** 받은 줄을 하나씩 기다릴 수 있게 모은다. */
function inbox(ws: WebSocket) {
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string" || e.data === "pong") return;
    let m: Msg;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.addEventListener("close", () => waiters.splice(0).forEach((w) => w({ closed: true })));
  return (ms: number) =>
    new Promise<Msg>((resolve) => {
      const m = queue.shift();
      if (m) return resolve(m);
      const t = setTimeout(() => resolve({ timeout: true }), ms);
      waiters.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("중계에 못 붙었다")), { once: true });
  });

/** 짝짓기. PC 의 [폰 연결]에서 [폰 짝짓기]를 누른 동안만 된다. 두 화면에 같은 여섯 자리가 뜨면 PC 에서 허락한다. */
export async function pair(url: string, name: string, onSas: (sas: string) => void): Promise<Paired> {
  const ws = new WebSocket(url);
  const next = inbox(ws);
  await opened(ws);
  try {
    // 먼저 중계가 PC 가 있는지 알려 준다.
    let m = await next(10000);
    if (m.relay === "pc-offline") throw new Error("PC 가 안 보인다 — PC 의 chiispace 와 [폰 연결]이 켜져 있어야 한다");
    if (m.relay !== "pc-online") throw new Error("중계가 답하지 않는다");
    const key = await newKey();
    const nA = random(16);
    // 키를 바로 내지 않고 먼저 약속한다. 그래야 중계가 PC 의 난수를 본 뒤 제 키를 골라 여섯 자리를 맞추지 못한다.
    ws.send(JSON.stringify({ k: "pair1", c: b64u(await commitOf(key.pub, nA)), name }));
    m = await next(15000);
    if (m.k === "no") throw new Error(String(m.why));
    if (m.k !== "pair2") throw new Error("PC 가 답하지 않는다");
    const pc = unb64u(String(m.pc));
    const nB = unb64u(String(m.nb));
    ws.send(JSON.stringify({ k: "pair3", pub: b64u(key.pub), na: b64u(nA) }));
    m = await next(15000);
    if (m.k === "no") throw new Error(String(m.why));
    if (m.k !== "sas") throw new Error("PC 가 답하지 않는다");
    onSas(await sasOf(key.pub, pc, nA, nB));
    // 사람이 PC 에서 두 숫자를 견주고 누를 때까지 기다린다.
    m = await next(300000);
    if (m.k === "no") throw new Error(String(m.why));
    if (m.k !== "paired" || typeof m.dev !== "string") throw new Error(m.timeout ? "PC 에서 답이 없었다" : "짝짓기가 끊겼다");
    return { dev: m.dev, jwk: key.jwk, pc: b64u(pc) };
  } finally {
    ws.close();
  }
}

async function gunzip(bytes: Uint8Array) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

type Options = {
  url: string;
  paired: Paired;
  onStatus: (s: LinkStatus) => void;
  onEvent: (name: string, payload: unknown) => void;
  /** PC 가 이 폰을 모른다(잊었다). */
  onUnpaired: () => void;
  /** 붙을 때마다 PC 가 알려 주는 폰 묶음의 판(시작 파일 이름). */
  onVersion?: (v: string) => void;
};

/** 짝지은 폰의 평소 연결. 끊기면 다시 잇고, 다시 이어지면 `remote:resync` 를 낸다 — 끊긴 사이의 이벤트는 돌아오지 않는다. */
export class Link {
  private ws: WebSocket | null = null;
  private keys: { up: CryptoKey; down: CryptoKey } | null = null;
  private tx = 0;
  private rx = 0;
  private parts: string[] = [];
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  /** 연결이 열리기 전에 부른 명령. 열리면 보낸다 — 대화창은 켜자마자 원문을 묻는다. */
  private waiting: (() => void)[] = [];
  private seq = 1;
  private wait = 1000;
  private last = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private everOpen = false;
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();
  private hellos = new WeakMap<WebSocket, Uint8Array>();
  private o: Options;

  constructor(o: Options) {
    this.o = o;
  }

  start() {
    this.stopped = false;
    void this.connect();
    clearInterval(this.beat);
    this.beat = setInterval(() => {
      if (this.stopped || !this.ws) return;
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send("ping");
      // 중계는 숨 쉬는 줄에 바로 답한다. 한참 아무것도 없으면 겉으로만 열린 연결이다(뒤로 갔다 온 iOS 가 그렇다).
      if (Date.now() - this.last > 60000) void this.connect();
    }, 25000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.beat);
    this.ws?.close();
    this.ws = null;
  }

  /** 앱이 다시 앞에 왔다. 끊겨 있으면 기다리지 않고 바로 잇는다. */
  wake() {
    if (this.stopped) return;
    if (!this.keys || Date.now() - this.last > 30000) {
      this.wait = 1000;
      void this.connect();
    }
  }

  invoke(cmd: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const go = () => {
        const i = this.seq++;
        this.calls.set(i, { resolve, reject });
        void this.send({ t: "invoke", i, cmd, args }).catch((e) => {
          this.calls.delete(i);
          reject(e);
        });
      };
      if (this.keys) return go();
      const t = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== go);
        reject("PC 와 잇는 중이다");
      }, 20000);
      this.waiting.push(() => {
        clearTimeout(t);
        go();
      });
    });
  }

  private async send(m: Msg) {
    const ws = this.ws;
    const keys = this.keys;
    if (!ws || !keys || ws.readyState !== WebSocket.OPEN) throw "PC 와 끊겼다";
    const n = this.tx++;
    const c = await seal(keys.up, n, JSON.stringify(m));
    if (c.length <= CHUNK) return ws.send(JSON.stringify({ k: "x", n, c }));
    const of = Math.ceil(c.length / CHUNK);
    for (let i = 0; i < of; i++) ws.send(JSON.stringify({ k: "x", n, c: c.slice(i * CHUNK, (i + 1) * CHUNK), i, of }));
  }

  private drop(why: unknown) {
    this.keys = null;
    for (const c of this.calls.values()) c.reject(why);
    this.calls.clear();
  }

  private async connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.drop("PC 와 끊겼다");
    this.o.onStatus(this.everOpen ? "retrying" : "connecting");
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    this.last = Date.now();
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      this.last = Date.now();
      if (e.data === "pong") return;
      let m: Msg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      // 순서대로 푼다. 풀기는 비동기라 줄마다 따로 돌리면 순번이 엉킨다.
      this.chain = this.chain.then(() => this.receive(ws, m)).catch(() => this.connect());
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      this.drop("PC 와 끊겼다");
      this.o.onStatus("retrying");
      this.timer = setTimeout(() => void this.connect(), this.wait);
      this.wait = Math.min(this.wait * 2, 15000);
    });
  }

  /** 연결마다 하는 인사. 이번 연결의 키는 두 쪽 난수로 새로 만든다 — 지난 연결의 암호문을 되풀이해 보내도 안 풀린다. */
  private async hello(ws: WebSocket) {
    const nA = random(16);
    this.hellos.set(ws, nA);
    ws.send(JSON.stringify({ k: "hello", dev: this.o.paired.dev, na: b64u(nA) }));
  }

  private async receive(ws: WebSocket, m: Msg) {
    if (this.ws !== ws) return;
    if (m.relay === "pc-offline") {
      this.drop("PC 가 안 보인다");
      return this.o.onStatus("pc-offline");
    }
    if (m.relay === "pc-online") return this.hello(ws);
    if (m.k === "no") {
      if (m.why === "unknown") {
        this.stop();
        return this.o.onUnpaired();
      }
      return;
    }
    if (m.k === "hi") {
      const nA = this.hellos.get(ws);
      if (!nA) return;
      const key = await loadKey(this.o.paired.jwk);
      const k = await sessionKeys(key.priv, unb64u(this.o.paired.pc), nA, unb64u(String(m.nb)), this.o.paired.dev);
      this.keys = { up: k.up, down: k.down };
      this.tx = 0;
      this.rx = 0;
      this.parts = [];
      this.wait = 1000;
      this.o.onStatus("open");
      if (typeof m.v === "string" && m.v) this.o.onVersion?.(m.v);
      if (this.everOpen) this.o.onEvent("remote:resync", null);
      this.everOpen = true;
      this.waiting.splice(0).forEach((go) => go());
      return;
    }
    if (m.k !== "x" || !this.keys) return;
    if (m.n !== this.rx) throw new Error("순번이 어긋났다");
    let c = String(m.c);
    if (typeof m.of === "number") {
      if (m.i !== this.parts.length) throw new Error("조각이 어긋났다");
      this.parts.push(c);
      if (this.parts.length < m.of) return;
      c = this.parts.join("");
      this.parts = [];
    }
    const n = this.rx++;
    const text = m.z ? await gunzip(await openRaw(this.keys.down, n, c)) : await open(this.keys.down, n, c);
    const inner = JSON.parse(text) as Msg;
    if (inner.t === "ret") {
      const call = this.calls.get(Number(inner.i));
      this.calls.delete(Number(inner.i));
      if (inner.ok) call?.resolve(inner.v);
      else call?.reject(inner.e);
    } else if (inner.t === "ev") this.o.onEvent(String(inner.e), inner.p);
  }
}
