import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watchUserFiles } from "./user-files.mjs";
import { Link, pair, socketUrl } from "../ui/phone-link.ts";
import { b64u, commitOf, newKey, open, random, sasOf, seal, sessionKeys, unb64u } from "../ui/phone-crypto.ts";
import { askBeforeSend, autoFolder, dropMove, moveFailure, moveLock, moveOffer, pcNote, receiverNotes, roomOf, senderNotes, setMovable, sizeLabel } from "../ui/session-move.ts";

test("이사 꾸러미와 두 PC 화면의 안내", () => {
  const git = { origin: "github.com/a/b", branch: "main", head: "abcdef1234", dirty: 2 };
  const pack = { session: "s", cwd: "C:/x", git, files: [{ rel: "s.jsonl", gz: "x" }], bytes: 2048 };
  assert.deepEqual(moveOffer(pack, { title: "t", slug: "usagi" }), { v: 1, agent: "claude", session: "s", cwd: "C:/x", git, files: pack.files, title: "t", slug: "usagi", name: "" });
  assert.equal(sizeLabel(2048), "2KB");
  assert.equal(sizeLabel(10), "1KB");
  assert.equal(sizeLabel(3 * 1024 * 1024), "3.0MB");
  // 대화만 가고 코드는 안 간다.
  assert.deepEqual(senderNotes(git), ["커밋 안 한 변경 2개는 이 PC 에만 남는다 — 대화만 간다"]);
  assert.match(senderNotes({ dirty: 0 })[0], /폴더를 직접 고른다/);
  const notes = receiverNotes({ git, relation: "split" }, { head: "1111111aaa", branch: "dev", dirty: 0 });
  assert.ok(notes.some((n) => n.includes("갈라졌다")), notes.join("|"));
  assert.ok(notes.some((n) => n.includes("커밋 안 한 변경 2개")));
  assert.ok(notes.some((n) => n.includes("여기 1111111 · 보낸 PC abcdef1")));
  assert.ok(notes.some((n) => n.includes("가지가 다르다")));
  assert.match(receiverNotes({ git: { dirty: 0 }, relation: "ahead" })[0], /덮지 않고/);
  assert.deepEqual(receiverNotes({ git: { head: "a", branch: "m", dirty: 0 }, relation: "new" }, { head: "a", branch: "m", dirty: 5 }), []);
  // 붙은 뒤에 끊기면 받는 PC 에 열렸을 수 있다. 받는 PC 의 답(거절)은 확실하다.
  assert.equal(moveFailure(new Error("PC 와 끊겼다"), true).unsure, true);
  assert.equal(moveFailure(new Error("PC 와 끊겼다"), false).unsure, false);
  assert.deepEqual(moveFailure("받는 PC 에서 거절했다", true), { text: "받는 PC 에서 거절했다", unsure: false });
  const room = "1b0016dbe43537733003e79293f26bd9";
  assert.equal(roomOf(`https://r.dev/r/${room}/`), room);
  assert.equal(roomOf(`https://r.dev/r/${room.toUpperCase()}`), room);
  assert.equal(roomOf("https://r.dev/x"), null);
});

test("끌어 놓는 이사 — 막는 까닭, 묻지 않고 보내기·받기", () => {
  const ok = { alive: true, busy: false, tasks: 0, talked: true, moving: false };
  assert.equal(moveLock(ok), null);
  assert.match(moveLock({ ...ok, busy: true }), /일하는 중/);
  assert.match(moveLock({ ...ok, tasks: 2 }), /서브에이전트/);
  assert.match(moveLock({ ...ok, talked: false }), /주고받은 말이 없다/);
  assert.match(moveLock({ ...ok, alive: false }), /안 떠 있다/);
  assert.match(moveLock({ ...ok, busy: true, moving: true }), /이사하는 중/);
  // 커밋 안 한 코드는 안 따라가니 그때만 카드로 묻는다.
  assert.equal(askBeforeSend({ dirty: 0 }), false);
  assert.equal(askBeforeSend({ dirty: 3 }), true);

  const origin = "github.com/a/b";
  const g = (path, o, remembered = false) => ({ path, git: { origin: o, dirty: 0 }, remembered });
  const offer = (relation, o = origin) => ({ git: { origin: o, dirty: 0 }, relation });
  // 같은 레포가 하나뿐이면 그 폴더로, 여럿이면 전에 고른 것으로, 그것도 없으면 사람이 고른다.
  assert.equal(autoFolder(offer("new"), [g("C:/b", origin)]), "C:/b");
  assert.equal(autoFolder(offer("behind"), [g("C:/x", "github.com/x/y"), g("C:/b", origin)]), "C:/b");
  assert.equal(autoFolder(offer("new"), [g("C:/b", origin), g("D:/b", origin)]), null);
  assert.equal(autoFolder(offer("new"), [g("C:/b", origin), g("D:/b", origin, true)]), "D:/b");
  // 전에 고른 폴더가 지금은 다른 레포면 쓰지 않는다.
  assert.equal(autoFolder(offer("new"), [g("D:/old", "github.com/x/y", true)]), null);
  assert.equal(autoFolder(offer("same"), [g("C:/b", origin)]), "C:/b");
  // 이 PC 의 같은 대화가 더 길거나 갈라졌으면, 원격이 없는 폴더면, 후보가 없으면 묻는다.
  assert.equal(autoFolder(offer("ahead"), [g("C:/b", origin)]), null);
  assert.equal(autoFolder(offer("split"), [g("C:/b", origin)]), null);
  assert.equal(autoFolder(offer("new", null), [g("C:/b", null)]), null);
  assert.equal(autoFolder(offer("new"), []), null);

  // 놓인 칸이 잠겨 있으면 보내지 않는다. 적어 두지 않은 칸(터미널·Codex)은 아무 일도 없다.
  const got = [];
  setMovable("%1", { lock: null, drop: (p) => got.push(["%1", p]) });
  setMovable("%2", { lock: "일하는 중", drop: (p) => got.push(["%2", p]) });
  dropMove("%1", "pc1");
  dropMove("%2", "pc1");
  dropMove("%3", "pc1");
  setMovable("%1", null);
  dropMove("%1", "pc2");
  assert.deepEqual(got, [["%1", "pc1"]]);

  // 옆칸의 PC 줄은 늘 보인다. 끌지 않을 때는 쓰는 법, 끄는 동안은 놓을 수 있는지와 까닭.
  const note = (o) => pcNote({ dragging: true, movable: true, lock: null, over: false, ...o });
  assert.deepEqual(pcNote({ dragging: false, movable: false, lock: null, over: false }), { text: "칸을 끌어 여기에 놓으면 이사", lock: false });
  assert.deepEqual(note({ movable: false }), { text: "Claude 대화창 칸만 옮긴다", lock: true });
  assert.deepEqual(note({ lock: "일하는 중 — 답이 끝난 뒤에 옮긴다" }), { text: "일하는 중 — 답이 끝난 뒤에 옮긴다", lock: true });
  assert.deepEqual(note({}), { text: "여기에 놓는다", lock: false });
  assert.deepEqual(note({ over: true }), { text: "놓으면 옮기고 이 칸은 닫는다", lock: false });
});

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const wrangler = path.join(relayDir, "node_modules", ".bin", "wrangler.cmd");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, n = 300) => {
  for (let i = 0; i < n && !(await ok()); i++) await delay(100);
  return ok();
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const killTree = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
const same = (a, b) => String(a).replaceAll("\\", "/").toLowerCase() === String(b).replaceAll("\\", "/").toLowerCase();
const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const unpack = (f) => gunzipSync(Buffer.from(f.gz, "base64")).toString("utf8");

/** claude 대화 파일 한 개(사용자 말 하나, 답 하나). */
function conversation(sid, cwd, mark) {
  const user = randomUUID();
  const common = { sessionId: sid, cwd, version: "2.1.328", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  return [
    { ...common, type: "user", uuid: user, parentUuid: null, message: { role: "user", content: `${mark} 물음` } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: user, message: { id: "msg_0", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: `${mark} 답` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n";
}

/** 이사 받는 PC 노릇. 중계의 그 방에 PC 로 붙어 짝짓기·인사·암호 통로를 PC 쪽(remote.rs)과 같은 규칙으로 받는다.
 *  `session_move_offer` 가 오면 꾸러미를 적어 두고, 검증이 `release` 할 때까지 답을 미룬다. */
async function fakePc(base, room, secret) {
  const key = await newKey();
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/pc/${room}`, { headers: { Authorization: `Bearer ${secret}` } });
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let release;
  const held = new Promise((r) => (release = r));
  const st = { pend: null, sas: null, devices: new Map(), sessions: new Map(), offers: [], error: null };
  const send = (p, v) => ws.send(JSON.stringify({ t: "msg", p, d: JSON.stringify(v) }));
  const reply = async (p, s, v) => send(p, { k: "x", n: s.tx, c: await seal(s.k.down, s.tx++, JSON.stringify(v)) });
  async function handle(text) {
    if (text === "pong") return;
    const m = JSON.parse(text);
    if (m.t !== "msg") return;
    const p = m.p;
    const d = JSON.parse(m.d);
    if (d.k === "pair1") {
      st.pend = { p, c: d.c, name: d.name, kind: d.kind, nb: random(16) };
      send(p, { k: "pair2", pc: b64u(key.pub), nb: b64u(st.pend.nb) });
    } else if (d.k === "pair3") {
      const pub = unb64u(d.pub);
      const na = unb64u(d.na);
      if (b64u(await commitOf(pub, na)) !== st.pend?.c) return send(p, { k: "no", why: "짝짓기 말이 맞지 않는다" });
      st.pend.pub = pub;
      st.sas = await sasOf(pub, key.pub, na, st.pend.nb);
      send(p, { k: "sas" });
    } else if (d.k === "hello") {
      const pub = st.devices.get(d.dev);
      if (!pub) return send(p, { k: "no", why: "unknown" });
      const nb = random(16);
      st.sessions.set(p, { k: await sessionKeys(key.priv, pub, unb64u(d.na), nb, d.dev), rx: 0, tx: 0, parts: [] });
      send(p, { k: "hi", nb: b64u(nb) });
    } else if (d.k === "x") {
      const s = st.sessions.get(p);
      if (!s || d.n !== s.rx) throw new Error("순번이 어긋났다");
      let c = d.c;
      if (typeof d.of === "number") {
        s.parts.push(c);
        if (s.parts.length < d.of) return;
        c = s.parts.join("");
        s.parts = [];
      }
      const msg = JSON.parse(await open(s.k.up, s.rx++, c));
      if (msg.t !== "invoke") return;
      if (msg.cmd !== "session_move_offer") return reply(p, s, { t: "ret", i: msg.i, ok: false, e: "모르는 명령" });
      st.offers.push(msg.args);
      await held;
      await reply(p, s, { t: "ret", i: msg.i, ok: true, v: { session: msg.args.session, cwd: "D:/desk/project", relation: "new" } });
    }
  }
  let chain = Promise.resolve();
  ws.onmessage = (e) => {
    chain = chain.then(() => handle(String(e.data))).catch((err) => (st.error = String(err)));
  };
  return {
    st,
    release,
    confirm: () => {
      st.devices.set("0123456789abcdef", st.pend.pub);
      send(st.pend.p, { k: "paired", dev: "0123456789abcdef", name: "데스크톱" });
    },
    close: () => ws.close(),
  };
}

test("세션이사 — PC 로 짝짓기, 받는 PC 에서 묻고 받기·묻지 않고 받기·거절, 보내는 PC 의 /move·칸 끌어 놓기와 칸 닫기, 막기", { skip: !exe || !claude || !existsSync(wrangler), timeout: 480000 }, async () => {
  // 격리: 별도 앱 세션·CLAUDE_CONFIG_DIR·폰 연결 설정, 가짜 키와 가짜 Anthropic 서버, 이 PC 안의 중계(wrangler).
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-move-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const git = (...a) => spawnSync("git", ["-C", project, "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...a], { windowsHide: true, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/move-fixture.git");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  const home = path.join(root, "claude-state");
  mkdirSync(home);
  const guard = watchUserFiles(["com.sehyun.chiispace", "com.sehyun.kasaspace"].flatMap((id) => ["session.json", "remote.json"].map((f) => path.join(process.env.APPDATA, id, f))), { root, exe });
  const settings = {
    hasCompletedOnboarding: true,
    theme: "light",
    hasSeenAutoDefaultNudge: true,
    hasSeenAutoModeEntryWarning: true,
    projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] },
  };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
  // 보낼 대화. 칸 %0 이 이 대화로 이어 열린다.
  const sid = randomUUID();
  const cwd = project.replaceAll("\\", "/");
  mkdirSync(path.join(home, "projects", slug(project)), { recursive: true });
  writeFileSync(path.join(home, "projects", slug(project), sid + ".jsonl"), conversation(sid, project, "MOVE_OUT_MARK"));
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(
    state,
    JSON.stringify({
      tabs: [{ key: "t0", focus: "%0", root: cwd, shell, layout: { kind: "leaf", id: "%0" } }],
      active: 0,
      nextPane: 1,
      nextTab: 1,
      restoreMode: "native-continue",
      procs: {},
      streams: { "%0": { agent: "claude", session: sid, cwd } },
      paneTitles: { "%0": "보낼 대화" },
      casting: { "%0": "hachiware" },
    }),
  );

  const relayPort = await freePort();
  const relayBase = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(`"${wrangler}" dev --ip 127.0.0.1 --port ${relayPort} --persist-to "${path.join(root, "relay-state")}"`, { cwd: relayDir, shell: true, windowsHide: true, stdio: "ignore" });
  const room = randomBytes(16).toString("hex");
  const remoteFile = path.join(root, "remote.json");
  writeFileSync(remoteFile, JSON.stringify({ on: true, relay: relayBase, room, secret: randomBytes(32).toString("hex"), devices: [] }));
  const page = `${relayBase}/r/${room}/`;
  const wsUrl = socketUrl(page);

  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === probe) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        latest = JSON.parse(body);
        return res.end(JSON.stringify(commands.splice(0)));
      }
      if (req.method !== "POST") return res.writeHead(200).end();
      if (req.url.includes("count_tokens")) return res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const message = { id: "msg_" + randomUUID().slice(0, 8), type: "message", role: "assistant", model: j.model ?? "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!j.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "제목" }], stop_reason: "end_turn" }));
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { message });
      sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "안녕" } });
      sse(res, "content_block_stop", { index: 0 });
      sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      sse(res, "message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || key === "CHIISPACE_PROXY" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|ENABLE_TOOL_SEARCH|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false;
  setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const side = document.querySelector('.side');
      const over = document.querySelector('[data-pane="%0"] .chat-over');
      const input = over?.querySelector('.composer textarea');
      const panel = document.querySelector('section[aria-label="폰 연결"]');
      const offer = document.querySelector('.move-offer');
      const texts = (root, sel) => [...(root?.querySelectorAll(sel) ?? [])].map(e => e.textContent);
      const dom = {
        input: !!input, inputDisabled: !!input?.disabled, value: input?.value ?? null,
        palette: texts(over, '.palette-row'),
        moveCard: over?.querySelector('.ask.move')?.textContent ?? null,
        moveStep: over?.querySelector('.ask.move .move-step')?.textContent ?? null,
        moveCards: texts(document, '.ask.move'),
        pcs: side?.querySelector('.side-pcs') ? {
          text: side.querySelector('.side-pcs').textContent,
          on: !!side.querySelector('.pc-row.on'),
          link: !!side.querySelector('.pc-link'),
          dragging: !!side.querySelector('.side-pcs.dragging'),
          here: texts(side, '.side-dev'),
        } : null,
        toast: document.querySelector('.move-toast')?.textContent ?? null,
        remote: panel ? {
          state: panel.querySelector('.remote-switch span')?.textContent ?? null,
          sas: panel.querySelector('.remote-digits[data-sas]')?.dataset.sas ?? null,
          sasText: panel.querySelector('.remote-pair small')?.textContent ?? null,
          pair: panel.querySelector('.remote-pair')?.textContent ?? null,
          devices: texts(panel, '.remote-devs:not(.remote-peers) .remote-dev > span'),
          peers: texts(panel, '.remote-peers .remote-dev > span'),
          peerSas: panel.querySelector('[data-peer-sas]')?.dataset.peerSas ?? null,
          peerErr: panel.querySelector('.remote-peer-form .remote-bad')?.textContent ?? null,
        } : null,
        offer: offer ? {
          title: offer.querySelector('.remote-title')?.textContent ?? null,
          lead: offer.querySelector('.remote-lead')?.textContent ?? null,
          folders: [...offer.querySelectorAll('.move-folder')].map(e => ({ text: e.textContent, on: e.classList.contains('on') })),
          notes: texts(offer, '.move-offer-note'),
          bad: offer.querySelector('.remote-bad')?.textContent ?? null,
        } : null,
        panes: [...document.querySelectorAll('[data-pane]')].map(s => ({
          id: s.dataset.pane,
          title: s.querySelector('.pane-head .title')?.textContent ?? null,
          bubbles: texts(s, '.chat-over .msg:not(.mine):not(.live) .bubble'),
        })),
      };
      const r = await fetch(${JSON.stringify(apiBase + probe)}, { method: 'POST', body: JSON.stringify({ dom }) });
      for (const c of await r.json()) {
        const scope = ({ side, remote: panel, offer, over })[c.in ?? 'over'];
        if (c.click) scope?.querySelector(c.click)?.click();
        if (c.down) scope?.querySelector(c.down)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        if (c.button) [...(scope?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === c.button)?.click();
        if (c.fill) {
          const el = scope?.querySelector(c.fill);
          if (el) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, c.value); el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
        // 칸(머리줄 또는 옆칸의 칸 줄)을 잡아 옆칸의 다른 PC 위까지 끌고 멈춘다. 놓기(drop)·되돌리기(cancel)는 다음 명령이다 —
        // 그 사이에 놓을 곳을 본다.
        if (c.drag) {
          const grab = document.querySelector(c.drag);
          const ev = (el, type, x, y, buttons) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons }));
          const t = document.querySelector('[data-drop-out]');
          if (grab && t) {
            const h = grab.getBoundingClientRect();
            const x0 = h.x + Math.min(40, h.width / 2), y0 = h.y + h.height / 2;
            ev(grab, 'mousedown', x0, y0, 1);
            ev(grab, 'mousemove', x0, y0, 1);
            ev(grab, 'mousemove', x0 + 50, y0 + 50, 1);
            await new Promise(r => setTimeout(r, 200));
            const b = t.getBoundingClientRect();
            ev(t, 'mousemove', b.x + b.width / 2, b.y + b.height / 2, 1);
            window.__drop = () => ev(t, 'mouseup', b.x + b.width / 2, b.y + b.height / 2, 0);
            window.__cancel = () => { ev(grab, 'mousemove', x0, y0, 1); ev(grab, 'mouseup', x0, y0, 0); };
          }
        }
        if (c.cancel) { window.__cancel?.(); window.__cancel = null; }
        if (c.drop) { window.__drop?.(); window.__drop = null; }
        if (c.key && input) { input.dispatchEvent(new KeyboardEvent('keydown', { key: c.key, bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 80)); }
        if (c.send && input) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }
      }
    } finally { pending = false; }
  }, 100); return 'isolated move test'; })()`;

  const dom = () => latest.dom ?? {};
  const seen = () => JSON.stringify(dom());
  // CHIISPACE_TEST_SCREENSHOT=1 로 직접 돌릴 때 검증 창만 찍는다. 사용자 창은 건드리지 않는다.
  const shot = (name) => {
    if (process.env.CHIISPACE_TEST_SCREENSHOT !== "1" || !app) return;
    spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid), "-WaitSec", "1", "-Out", path.join(root, name + ".png")], { windowsHide: true });
  };
  let app = null;
  let host = null;
  const links = [];
  const open = (paired) => {
    let status = null;
    const link = new Link({ url: wsUrl, paired, onStatus: (s) => (status = s), onEvent: () => {}, onUnpaired: () => {} });
    links.push(link);
    link.start();
    return { link, open: () => until(() => status === "open", 100) };
  };
  const pairAs = async (name, kind) => {
    commands.push({ in: "remote", button: "폰 짝짓기" });
    assert.ok(await until(() => /폰에서 \[연결\]/.test(dom().remote?.pair ?? ""), 50), "짝짓기 받기가 안 열림: " + seen());
    let shown = null;
    const pairing = pair(wsUrl, name, (s) => (shown = s), kind);
    assert.ok(await until(() => shown && dom().remote?.sas === shown, 100), `${name} 의 숫자가 PC 에 안 맞음: ` + seen());
    const text = dom().remote.sasText;
    commands.push({ in: "remote", button: "맞다" });
    return { paired: await pairing, text };
  };
  try {
    assert.ok(await until(async () => (await fetch(relayBase + "/").then((r) => r.status, () => 0)) === 404, 300), "중계가 안 뜸");
    app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
    assert.ok(await until(() => dom().input && !dom().inputDisabled, 600), "칸의 claude 가 안 켜짐: " + seen());
    // 옆칸은 기기별로 나뉜다. 위 목록은 이 PC, 맨 아래는 다른 PC — 아직 이은 PC 가 없으면 잇는 길이 늘 보인다.
    assert.ok(await until(() => dom().pcs?.link && dom().pcs.here.join() === "이 PC,다른 PC", 100), "옆칸에 기기 구역이 안 보임: " + seen());
    commands.push({ in: "side", click: ".pc-link" });
    assert.ok(await until(() => /중계에 붙음/.test(dom().remote?.state ?? ""), 200), "[다른 PC 잇기]가 [폰 연결]을 안 엶: " + seen());

    // 1. PC 로 짝짓기. 받는 PC 의 숫자 확인에 PC 라고 보이고, 짝지은 쪽은 받는 PC 의 이름을 받는다.
    const laptop = await pairAs("노트북", "pc");
    assert.match(laptop.text, /다른 PC\(노트북\)가 짝지으려 한다/, "PC 짝짓기인 것이 안 보임");
    assert.equal(laptop.paired.name, process.env.COMPUTERNAME || "PC", "받는 PC 가 제 이름을 안 알려 줌");
    assert.ok(await until(() => dom().remote?.devices?.some((t) => t.includes("노트북") && t.includes("PC · 이사 받기")), 50), "짝지은 PC 가 PC 로 안 보임: " + seen());
    const phone = await pairAs("iPhone");
    assert.ok(await until(() => dom().remote?.devices?.length === 2, 50));

    const pc = open(laptop.paired);
    const ph = open(phone.paired);
    assert.ok(await pc.open() && (await ph.open()), "평소 연결이 안 열림");
    // 2. 막기: 폰은 이사 명령을 못 부르고, PC 짝은 폰 명령을 못 부른다. 꾸러미 밖의 파일 자리는 받지 않는다.
    const S2 = randomUUID();
    const incoming = conversation(S2, "C:\\sender\\project", "MOVED_IN_MARK");
    const gz = (s) => gzipSync(Buffer.from(s)).toString("base64");
    const offerOf = (session, files) => ({
      v: 1, agent: "claude", session, cwd: "C:\\sender\\project", title: "이사 시험", slug: "usagi", name: "우사기",
      git: { origin: "github.com/example/move-fixture", branch: "main", head: "1234567890abcdef1234567890abcdef12345678", dirty: 2 },
      files,
    });
    const good = offerOf(S2, [{ rel: `${S2}.jsonl`, gz: gz(incoming) }, { rel: `${S2}/subagents/agent-a7c9ae52f4cfba48c.jsonl`, gz: gz("{}\n") }]);
    await assert.rejects(ph.link.invoke("session_move_offer", good), /폰에서는 부를 수 없는/);
    await assert.rejects(pc.link.invoke("remote_panes", {}), /이사 보내기만/);
    await assert.rejects(pc.link.invoke("session_move_offer", offerOf(S2, [{ rel: `${S2}/../evil.jsonl`, gz: gz("x") }])), /받을 수 없는 파일 자리/);
    await assert.rejects(pc.link.invoke("session_move_offer", { ...good, v: 2 }), /모르는 이사 꾸러미/);
    assert.equal(dom().offer, null, "막힌 이사에 창이 뜸");

    // 3. 이 PC 의 같은 대화와 갈라졌으면 묻는다. 같은 원격 주소의 폴더(이 PC 의 탭)를 권하고, 커밋 안 한 변경·다른 커밋을 알린다.
    // 받으면 이 PC 의 것을 옆에 남겨 두고 받은 것으로 바꾼다.
    const written = path.join(home, "projects", slug(cwd), S2 + ".jsonl");
    const diverged = conversation(S2, project, "HERE_MARK");
    writeFileSync(written, diverged);
    const got = pc.link.invoke("session_move_offer", good);
    assert.ok(await until(() => /노트북 에서 대화가 이사 온다/.test(dom().offer?.title ?? ""), 100), "받는 창이 안 뜸: " + seen());
    assert.ok(await until(() => dom().offer.folders.some((f) => f.on && same(f.text.split(" ·")[0], cwd)), 100), "같은 레포 폴더를 권하지 않음: " + seen());
    assert.ok(dom().offer.notes.some((n) => n.includes("갈라졌다")), "갈라진 것을 안 알림: " + seen());
    assert.ok(dom().offer.notes.some((n) => n.includes("커밋 안 한 변경 2개")), "보낸 PC 의 커밋 안 한 변경을 안 알림: " + seen());
    assert.ok(dom().offer.notes.some((n) => n.includes("다른 커밋이다")), "커밋이 다른 것을 안 알림: " + seen());
    shot("move-offer");
    commands.push({ in: "offer", button: "받기" });
    const r = await got;
    assert.equal(r.session, S2);
    assert.ok(same(r.cwd, cwd), "고른 폴더가 아님: " + JSON.stringify(r));
    assert.equal(readFileSync(written, "utf8"), incoming, "받은 대화가 claude 자리에 안 써짐");
    const kept = readdirSync(path.dirname(written)).filter((f) => f.startsWith(S2 + ".jsonl.before-move-"));
    assert.equal(kept.length, 1, "갈라진 이 PC 의 대화를 안 남김");
    assert.equal(readFileSync(path.join(path.dirname(written), kept[0]), "utf8"), diverged);
    assert.ok(existsSync(path.join(home, "projects", slug(cwd), S2, "subagents", "agent-a7c9ae52f4cfba48c.jsonl")), "서브에이전트 대화가 안 옴");
    assert.ok(await until(() => dom().panes?.some((p) => p.id !== "%0" && p.bubbles.some((b) => b.includes("MOVED_IN_MARK")) && p.title === "이사 시험"), 200), "받은 대화가 새 칸에 안 열림: " + seen());
    assert.equal(JSON.parse(readFileSync(remoteFile, "utf8")).move_folders?.["github.com/example/move-fixture"], cwd, "고른 폴더를 기억하지 않음");

    // 4. 같은 레포 폴더가 정해지면 묻지 않고 받아 새 탭에 열고, 한 줄로 알린다.
    const S4 = randomUUID();
    const autoIn = conversation(S4, "C:\\sender\\project", "AUTO_MARK");
    const autoOffer = { ...offerOf(S4, [{ rel: `${S4}.jsonl`, gz: gz(autoIn) }]), title: "자동 시험" };
    let asked = false;
    const watch = setInterval(() => (asked ||= !!dom().offer), 50);
    const r4 = await pc.link.invoke("session_move_offer", autoOffer);
    assert.ok(same(r4.cwd, cwd), "같은 레포 폴더로 안 받음: " + JSON.stringify(r4));
    assert.equal(readFileSync(path.join(home, "projects", slug(cwd), S4 + ".jsonl"), "utf8"), autoIn);
    assert.ok(await until(() => /노트북 에서 "자동 시험" 대화가 이사 왔다/.test(dom().toast ?? ""), 50), "묻지 않고 받은 것을 안 알림: " + seen());
    shot("move-toast");
    assert.ok(await until(() => dom().panes?.some((p) => p.bubbles.some((b) => b.includes("AUTO_MARK")) && p.title === "자동 시험"), 200), "묻지 않고 받은 대화가 안 열림: " + seen());
    assert.equal(asked, false, "같은 레포 폴더가 정해졌는데 물음: " + seen());
    // 같은 대화를 다시 받아도 칸을 또 열지 않는다(이미 연 칸을 다시 연다). 받은 칸의 claude 가 이어 열며 줄을 더 적었으면
    // 이 PC 쪽이 더 길다 — 그때는 덮지 않고 묻는다.
    let settled = false;
    const again = pc.link.invoke("session_move_offer", autoOffer).finally(() => (settled = true));
    assert.ok(await until(() => settled || dom().offer, 100), "다시 보낸 같은 대화에 답이 없음: " + seen());
    clearInterval(watch);
    if (!settled) {
      assert.ok(dom().offer.notes.some((n) => /더 길다/.test(n)), "이 PC 쪽이 더 긴 것을 안 알림: " + seen());
      commands.push({ in: "offer", button: "받기" });
    }
    await again;
    await delay(1000);
    assert.equal(dom().panes.filter((p) => p.bubbles.some((b) => b.includes("AUTO_MARK"))).length, 1, "같은 대화로 칸을 또 엶: " + seen());

    // 5. 거절. 원격이 없는 폴더의 대화는 묻는다.
    const S3 = randomUUID();
    const refused = pc.link.invoke("session_move_offer", { ...offerOf(S3, [{ rel: `${S3}.jsonl`, gz: gz(conversation(S3, "C:\\x", "REFUSED_MARK")) }]), git: { dirty: 0 } });
    assert.ok(await until(() => dom().offer !== null, 100), "두 번째 받는 창이 안 뜸");
    commands.push({ in: "offer", button: "거절" });
    await assert.rejects(refused, /거절했다/);
    assert.ok(!readdirSync(path.join(home, "projects")).some((d) => existsSync(path.join(home, "projects", d, S3 + ".jsonl"))), "거절했는데 대화를 씀");

    // 6. 보내는 PC: 받는 PC(흉내)의 방에 [PC 잇기]. 이 PC 자신의 주소는 막는다.
    const room2 = randomBytes(16).toString("hex");
    host = await fakePc(relayBase, room2, randomBytes(32).toString("hex"));
    commands.push({ in: "remote", fill: ".remote-peer-form input", value: page });
    await delay(300);
    commands.push({ in: "remote", button: "PC 잇기" });
    assert.ok(await until(() => /이 PC 의 주소다/.test(dom().remote?.peerErr ?? ""), 50), "제 주소로 잇기를 안 막음: " + seen());
    commands.push({ in: "remote", fill: ".remote-peer-form input", value: `${relayBase}/r/${room2}` });
    await delay(300);
    commands.push({ in: "remote", button: "PC 잇기" });
    assert.ok(await until(() => host.st.sas && dom().remote?.peerSas === host.st.sas, 150), "두 PC 의 숫자가 안 맞음: " + JSON.stringify({ host: host.st, dom: dom().remote }));
    assert.equal(host.st.pend.kind, "pc", "PC 라고 밝히지 않음");
    assert.equal(host.st.pend.name, process.env.COMPUTERNAME || "PC");
    host.confirm();
    assert.ok(await until(() => dom().remote?.peers?.some((t) => t.includes("데스크톱")), 100), "이은 PC 가 목록에 없음: " + seen());
    shot("move-peers");
    // 짝지을 때 받은 컴퓨터 이름은 알아보기 어려워 바꿀 수 있다.
    commands.push({ in: "remote", button: "이름" });
    await delay(300);
    commands.push({ in: "remote", fill: ".remote-peer-name input", value: "집 데스크톱" });
    await delay(300);
    commands.push({ in: "remote", click: ".remote-peer-name button" });
    assert.ok(await until(() => dom().remote?.peers?.some((t) => t.startsWith("집 데스크톱")), 50), "PC 이름이 안 바뀜: " + seen());
    assert.equal(JSON.parse(readFileSync(remoteFile, "utf8")).peers?.[0]?.name, "집 데스크톱", "바꾼 이름을 저장하지 않음");
    commands.push({ in: "remote", click: ".remote-x" });
    // 끌기 전에도 옆칸 맨 아래에 이은 PC 가 늘 보인다.
    assert.ok(await until(() => !dom().remote && /집 데스크톱칸을 끌어 여기에 놓으면 이사/.test(dom().pcs?.text ?? "") && !dom().pcs.link, 100), "옆칸에 이은 PC 가 안 보임: " + seen());
    shot("move-side");

    // 7. /move — 카드가 뜨는 동안 입력바가 잠기고, 받는 PC 의 답을 기다린 뒤 이 칸을 닫는다. 받은 대화가 새 탭으로 열려
    // 있으니 보낼 칸의 탭(첫 탭)으로 돌아간다.
    commands.push({ in: "side", down: ".tg-head" });
    assert.ok(await until(() => dom().panes?.some((p) => p.id === "%0") && dom().input && !dom().inputDisabled, 100));
    commands.push({ send: "/move" });
    assert.ok(await until(() => dom().value === "/move " && dom().palette.some((t) => t.includes("데스크톱")), 100), "/move 목록에 이은 PC 가 없음: " + seen());
    commands.push({ key: "Enter" });
    assert.ok(await until(() => /이 대화를 집 데스크톱 PC 로 이사할까/.test(dom().moveCard ?? "") && dom().inputDisabled, 100), "이사 카드가 안 뜨거나 입력바가 안 잠김: " + seen());
    assert.ok(await until(() => /KB/.test(dom().moveCard ?? ""), 100), "꾸러미를 못 만듦: " + seen());
    commands.push({ click: ".ask.move .ask-go" });
    assert.ok(await until(() => host.st.offers.length === 1, 150), "받는 PC 에 꾸러미가 안 옴: " + JSON.stringify({ error: host.st.error, dom: dom().moveCard }));
    assert.ok(await until(() => /받기를 기다린다/.test(dom().moveStep ?? ""), 50), "받는 PC 를 기다린다고 안 보임: " + seen());
    shot("move-card");
    const sent = host.st.offers[0];
    assert.equal(sent.session, sid);
    assert.equal(sent.title, "보낼 대화");
    assert.equal(sent.slug, "hachiware");
    assert.equal(sent.git.origin, "github.com/example/move-fixture");
    assert.ok(unpack(sent.files.find((f) => f.rel === `${sid}.jsonl`)).includes("MOVE_OUT_MARK"), "보낸 꾸러미에 대화가 없음");
    assert.ok(dom().panes.some((p) => p.id === "%0"), "받기 전에 칸을 닫음");
    host.release();
    assert.ok(await until(() => !dom().panes?.some((p) => p.id === "%0"), 100), "받은 뒤에 보낸 칸이 안 닫힘: " + seen());
    assert.ok(existsSync(path.join(home, "projects", slug(project), sid + ".jsonl")), "보낸 대화 파일을 지움");

    // 8. 칸을 끌어 옆칸 맨 아래의 PC 에 놓는다. 머리줄로 끌어 PC 위에 가면 놓을 곳이 켜지고, 되돌려 놓으면 아무 일이 없다.
    // 옆칸의 칸 줄을 끌어 놓으면 커밋 안 한 변경이 없으니 카드로 묻지 않고 보내고, 받으면 닫는다.
    const autoPane = dom().panes.find((p) => p.title === "자동 시험")?.id;
    assert.ok(autoPane, "끌 칸이 없음: " + seen());
    commands.push({ in: "side", down: '.prow[title="자동 시험"]' });
    await delay(500);
    commands.push({ drag: `[data-pane="${autoPane}"] .pane-head` });
    assert.ok(await until(() => dom().pcs?.dragging && dom().pcs.on, 100), "머리줄로 끌 때 PC 가 놓을 곳으로 안 켜짐: " + seen());
    assert.match(dom().pcs.text, /놓으면 옮기고 이 칸은 닫는다/);
    shot("move-dock");
    commands.push({ cancel: true });
    assert.ok(await until(() => !dom().pcs?.dragging, 50), "되돌려 놓았는데 끌기가 안 끝남: " + seen());
    await delay(1000);
    assert.equal(host.st.offers.length, 1, "PC 에 안 놓았는데 보냄");
    assert.ok(dom().panes.some((p) => p.id === autoPane), "PC 에 안 놓았는데 칸이 닫힘");
    commands.push({ drag: '.prow[title="자동 시험"]' });
    assert.ok(await until(() => dom().pcs?.dragging && dom().pcs.on, 100), "옆칸 칸 줄로 끌 때 PC 가 놓을 곳으로 안 켜짐: " + seen());
    commands.push({ drop: true });
    assert.ok(await until(() => host.st.offers.length === 2, 150), "끌어 놓았는데 안 보냄: " + JSON.stringify({ error: host.st.error, cards: dom().moveCards }));
    assert.equal(host.st.offers[1].session, S4);
    assert.equal(host.st.offers[1].title, "자동 시험");
    assert.ok(await until(() => !dom().pcs?.dragging && !dom().panes?.some((p) => p.id === autoPane), 100), "받은 뒤에 끌어 보낸 칸이 안 닫힘: " + seen());
    console.log("세션이사 확인", root);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ latest, host: host?.st ?? null }));
    console.error("세션이사 검증 기록", root);
    throw e;
  } finally {
    host?.release();
    host?.close();
    for (const l of links) l.stop();
    if (app && app.exitCode === null) {
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
      for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
      if (app.exitCode === null) app.kill();
    }
    killTree(relay.pid);
    server.closeAllConnections();
    server.close();
  }
  guard("사용자 세션·폰 연결 파일 보호");
});
