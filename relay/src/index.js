/**
 * chiispace 중계 — 집 PC 의 chiispace 와 밖의 폰이 만나는 자리. 사용자의 Cloudflare 계정에 한 번 올려 두면 다시 올릴 일이 없다.
 *
 * - PC 앱이 먼저 `/pc/<방>` 으로 웹소켓을 걸어 두고(PC 비밀로 확인), 폰은 `/r/<방>/` 으로 온다. 집 PC 에는 열린 포트가 없다.
 * - 폰 화면 파일도 PC 앱에서 받아 넘긴다. 그래서 PC 앱을 새로 구워도 이 중계는 그대로 둔다.
 * - 폰과 PC 가 주고받는 말은 둘이 짝지을 때 바꾼 키로 암호화되어 온다(ui/phone-crypto.ts). 여기서는 풀지 못하고 풀지도 않는다.
 *   아무것도 저장하지 않고 기록하지 않는다 — 저장하는 것은 PC 비밀의 해시 하나다.
 * - 방 이름은 PC 앱이 만든 128비트 난수다. 아는 사람만 폰 자리에 붙을 수 있고, 붙어도 짝짓기는 PC 에서 사람이 숫자를 보고 허락해야 된다.
 *
 * Durable Object 한 개가 방 하나다. 웹소켓은 잠재우기(hibernation)로 받아, 아무도 말하지 않을 때는 돈이 드는 시간을 쓰지 않는다.
 */

const ROOM = /^\/(pc|r)\/([0-9a-f]{32})(\/.*)?$/;
/** 한 방에 붙는 폰 화면 수. 짝짓지 않은 접속이 방을 채우지 못하게 묶는다. */
const MAX_PHONES = 8;

export default {
  async fetch(req, env) {
    const m = ROOM.exec(new URL(req.url).pathname);
    if (!m) return new Response("chiispace relay\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    return env.ROOM.get(env.ROOM.idFromName(m[2])).fetch(req);
  },
};

async function sha256hex(text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const page = (status, title, body) =>
  new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>chiispace</title>` +
      `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbf5ea;color:#5b4433;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#786453}</style>` +
      `</head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    /** 폰 화면 파일 요청. PC 의 답을 기다리는 동안만 있다(그동안은 잠들지 않는다). */
    this.pending = new Map();
    // 숨 쉬는 줄에는 깨우지 않고 바로 답한다.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  pc() {
    return this.ctx.getWebSockets("pc")[0];
  }

  phones() {
    return this.ctx.getWebSockets("phone");
  }

  idOf(ws) {
    return ws.deserializeAttachment()?.id;
  }

  phone(id) {
    return this.phones().find((ws) => this.idOf(ws) === id);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, kind, , rest = "/"] = ROOM.exec(url.pathname);
    const upgrade = (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";

    if (kind === "pc") {
      if (!upgrade) return new Response("websocket only", { status: 426 });
      const auth = req.headers.get("Authorization") ?? "";
      const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (secret.length < 32) return new Response("forbidden", { status: 403 });
      // 처음 붙은 PC 의 비밀이 이 방의 주인이 된다. 방 이름이 128비트 난수라 남이 먼저 차지할 수 없다.
      const hash = await sha256hex(secret);
      const known = await this.ctx.storage.get("pc");
      if (known && !same(known, hash)) return new Response("forbidden", { status: 403 });
      if (!known) await this.ctx.storage.put("pc", hash);
      for (const old of this.ctx.getWebSockets("pc")) {
        try {
          old.close(4000, "replaced");
        } catch {}
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, ["pc"]);
      server.send(JSON.stringify({ t: "hello", phones: this.phones().map((p) => this.idOf(p)) }));
      for (const p of this.phones()) p.send(JSON.stringify({ relay: "pc-online" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (rest === "/ws") {
      if (!upgrade) return new Response("websocket only", { status: 426 });
      if (this.phones().length >= MAX_PHONES) return new Response("busy", { status: 429 });
      const { 0: client, 1: server } = new WebSocketPair();
      const id = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ["phone"]);
      server.serializeAttachment({ id });
      const pc = this.pc();
      server.send(JSON.stringify({ relay: pc ? "pc-online" : "pc-offline" }));
      pc?.send(JSON.stringify({ t: "open", p: id }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const pc = this.pc();
    if (!pc) return page(503, "PC 가 안 보인다", "집 PC 의 chiispace 가 꺼져 있거나 [폰 연결]이 꺼져 있다.");
    const q = crypto.randomUUID();
    const path = rest === "/" ? "" : decodeURIComponent(rest.slice(1));
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(q);
        resolve(null);
      }, 20000);
      this.pending.set(q, { resolve, timer, parts: [] });
      pc.send(JSON.stringify({ t: "get", q, path }));
    });
    if (!res) return page(504, "PC 가 답하지 않는다", "잠시 뒤 다시 열어 줘.");
    const headers = {
      "content-type": res.type || "application/octet-stream",
      "cache-control": res.cache || "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if ((res.type || "").startsWith("text/html")) {
      const host = url.host;
      headers["content-security-policy"] =
        `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://${host} ws://${host}; frame-ancestors 'none'`;
    }
    return new Response(res.status === 200 ? res.body : null, { status: res.status, headers });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== "string") return;
    const [tag] = this.ctx.getTags(ws);
    if (tag === "phone") {
      // 폰의 말은 열지 않고 PC 로 넘긴다. 짝짓기 말 말고는 암호문이다.
      this.pc()?.send(JSON.stringify({ t: "msg", p: this.idOf(ws), d: msg }));
      return;
    }
    let m;
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    if (m.t === "msg" && typeof m.d === "string") this.phone(m.p)?.send(m.d);
    else if (m.t === "kick") {
      try {
        this.phone(m.p)?.close(4001, "kicked");
      } catch {}
    } else if (m.t === "res") {
      const w = this.pending.get(m.q);
      if (!w) return;
      w.parts.push(m.b ?? "");
      if (m.more) return;
      clearTimeout(w.timer);
      this.pending.delete(m.q);
      const bin = atob(w.parts.join(""));
      const body = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
      w.resolve({ status: m.status, type: m.type, cache: m.cache, body });
    }
  }

  webSocketClose(ws, code, reason) {
    const [tag] = this.ctx.getTags(ws);
    if (tag === "phone") this.pc()?.send(JSON.stringify({ t: "gone", p: this.idOf(ws) }));
    else if (!this.pc() || this.pc() === ws) {
      for (const p of this.phones()) p.send(JSON.stringify({ relay: "pc-offline" }));
    }
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {}
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011, "error");
  }
}
