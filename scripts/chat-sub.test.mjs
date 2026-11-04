import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const claude = process.env.CHIISPACE_TEST_REAL_CLAUDE;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

test("서브에이전트가 일하는 동안 한 줄로 보이고 옆 칸에도 열리며, 눌러서 그 대화 전체를 열 수 있고, 결과가 돌아가면 걷힌다", { skip: !exe || !claude, timeout: 180000 }, async () => {
  // 가짜 Anthropic 서버가 본 대화에서 Agent 도구를 부르게 하면 실제 claude 가 실제로
  // 서브에이전트를 띄워 같은 서버로 요청을 보낸다. 그 요청은 앱 프록시를 지나며 chat:sub 로
  // 흐른다. 서브에이전트의 답을 붙잡아 둔 동안 대화창을 본다. 유료 모델은 부르지 않는다.
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-sub-"));
  const home = path.join(root, "claude-state");
  const project = path.join(root, "project");
  mkdirSync(project);
  const store = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(store, { recursive: true });
  const sid = randomUUID(), userId = randomUUID();
  const common = { sessionId: sid, cwd: project, version: "2.1.273", isSidechain: false, userType: "external", timestamp: new Date().toISOString() };
  writeFileSync(path.join(store, sid + ".jsonl"), [
    { ...common, type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: "ASK_SUB_START" } },
    { ...common, type: "assistant", uuid: randomUUID(), parentUuid: userId, message: { id: "msg_0", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "SUB_READY_MARK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  // claude 는 승인한 키를 끝 20글자로 기억한다. 전체만 두면 승인으로 치지 않고 "Not logged in" 이 된다.
  // claude 2.1.285 부터 환경의 API 키를 끝 20글자로 승인했는지 보고, 시작할 때 auto 모드를 기본으로 하라는 창을 띄운다.
  // 둘 다 미리 답해 둔다. 안 그러면 확인창·권유 창이 TUI 를 막아 대화창에서 보낸 말이 제출되지 않는다.
  const settings = { hasCompletedOnboarding: true, theme: "light", hasSeenAutoDefaultNudge: true, hasSeenAutoModeEntryWarning: true, projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["chiispace-fixture-key", "chiispace-fixture-key".slice(-20)], rejected: [] } };
  for (const config of [path.join(home, ".claude.json"), home + ".json"]) writeFileSync(config, JSON.stringify(settings));
  // 서브에이전트를 부르는 데 허락을 묻지 않게 한다. 서브에이전트는 글만 쓰고 도구는 안 쓴다.
  // 권한 모드를 적어 둔다. API 키 과금의 격리 claude 는 auto 모드로 뜨는데, 그때 프록시 뒤에서는
  // "분류기 요청 과금" 안내 대화상자를 띄우고 첫 도구를 붙잡는다(Pro·Max·Team 은 안 띄운다고 문서에 있다).
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default", allow: ["Agent", "Task"] } }));
  const state = path.join(root, "session.json");
  const shell = path.join(process.env.SystemRoot, "System32", "cmd.exe");
  writeFileSync(state, JSON.stringify({
    tabs: [{ key: "t0", focus: "%0", root: project, shell, layout: { kind: "leaf", id: "%0" } }],
    active: 0, nextPane: 1, nextTab: 1, restoreMode: "native-continue", procs: {},
    // 대화창 칸으로 그 대화를 이어 연다. 10월 17일까지는 터미널 칸의 claude 위에 덮은 대화창으로 봤다.
    streams: { "%0": { agent: "claude", session: sid, cwd: project } },
  }));

  const probe = "/" + randomUUID();
  let latest = {};
  const commands = [];
  const seen = { main1: 0, main2: 0, sub: 0, subHeader: null, subFirst: null };
  let release;
  const held = new Promise(r => { release = r; });
  const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const text = (j) => JSON.stringify(j.messages ?? []);
  const server = http.createServer((req, res) => {
    if (req.url === probe) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => { latest = JSON.parse(body); res.end(JSON.stringify(commands.splice(0))); });
      return;
    }
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}'); return; }
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const message = { id: "msg_" + randomUUID().slice(0, 8), type: "message", role: "assistant", model: j.model ?? "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "제목" }], stop_reason: "end_turn" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { message });
      const all = text(j);
      // 서브에이전트는 헤더로 가른다. 본문으로 가르면 본 대화의 다음 요청에도 맡긴 일이 실려 있어
      // 본 대화에 서브에이전트의 답을 주게 된다(실제로 그랬다).
      const isSub = !!req.headers["x-claude-code-agent-id"];
      const isMain = !isSub && Array.isArray(j.tools) && j.tools.some(t => t.name === "Agent") && all.includes("CHAT_SUB_ASK");
      if (isSub) {
        // 서브에이전트: 조각을 흘리고, 테스트가 볼 때까지 붙잡아 둔다.
        seen.sub++;
        seen.subHeader = req.headers["x-claude-code-agent-id"] ?? null;
        seen.subFirst ??= JSON.stringify(j.messages?.[0]?.content ?? "").slice(0, 300);
        sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "SUB_WORKING 찾는 중" } });
        await Promise.race([held, delay(60000)]);
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: " SUB_DONE" } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
      } else if (isMain && !all.includes("tool_result")) {
        // 본 대화 첫 요청: 서브에이전트를 부른다.
        seen.main1++;
        sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_sub" + randomUUID().replaceAll("-", "").slice(0, 16), name: "Agent", input: {} } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ description: "로그 찾기", prompt: "SUB_TASK 로그에서 실패 원인 찾기", subagent_type: "general-purpose" }) } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      } else {
        // 서브에이전트 결과를 받은 본 대화의 다음 요청(또는 그 밖의 보조 요청).
        if (isMain) seen.main2++;
        sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: isMain ? "MAIN_AFTER_SUB" : "제목" } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      }
      sse(res, "message_stop", {});
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const apiBase = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env, CHIISPACE_STATE: state, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || key === "CHIISPACE_PROXY" || /API_KEY|AUTH_TOKEN|CLAUDE_CODE_USE_|ENABLE_TOOL_SEARCH/.test(key)) delete env[key];
  }
  Object.assign(env, { ANTHROPIC_API_KEY: "chiispace-fixture-key", ANTHROPIC_BASE_URL: apiBase, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  env[pathKey] = path.dirname(claude) + ";" + env[pathKey];
  env.CHIISPACE_PROBE_MS = "500";
  env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
    if (pending) return; pending = true;
    try {
      const slot = document.querySelector('[data-pane="%0"]');
      const over = slot?.querySelector('.chat-over');
      const input = over?.querySelector('.composer textarea');
      const texts = (sel) => [...(over?.querySelectorAll(sel) ?? [])].map(e => e.textContent);
      const dom = {
        shown: !!input && !input.disabled,
        theirs: texts('.msg:not(.mine):not(.live) .bubble'),
        live: texts('.msg.live .bubble'),
        subs: [...(over?.querySelectorAll('.sub') ?? [])].map(e => ({
          label: e.querySelector('.sub-label')?.textContent,
          what: e.querySelector('.sub-what')?.textContent,
          state: e.querySelector('.tool-stat')?.textContent ?? null,
        })),
        notes: texts('.note'),
        // 오케스트레이션 때 서브에이전트마다 옆에 여는 읽기 전용 칸(useSubPanes).
        panes: [...document.querySelectorAll('[data-pane]')].map(s => {
          const r = s.getBoundingClientRect();
          const ring = s.querySelector('.work-ring');
          return {
            id: s.dataset.pane,
            sub: !!s.querySelector('.sub-body'),
            xterm: !!s.querySelector('.xterm'),
            chip: s.querySelector('.pane-head .chip')?.textContent ?? null,
            title: s.querySelector('.pane-head .title')?.textContent ?? null,
            ring: ring ? ring.getAttribute('data-who') ?? '' : null,
            task: s.querySelector('.sub-body .subview-task')?.textContent ?? null,
            bubbles: [...s.querySelectorAll('.sub-body .bubble')].map(e => e.textContent),
            done: !!s.querySelector('.sub-done'),
            rect: [r.left, r.top, r.width, r.height].map(Math.round),
          };
        }),
        focusIn: document.activeElement?.closest('[data-pane]')?.dataset.pane ?? null,
        view: (() => {
          const v = over?.querySelector('.subview');
          if (!v) return null;
          return {
            title: v.querySelector('.subview-title')?.textContent,
            kind: v.querySelector('.subview-kind')?.textContent,
            task: v.querySelector('.subview-task')?.textContent ?? null,
            bubbles: [...v.querySelectorAll('.bubble')].map(e => e.textContent),
          };
        })(),
      };
      const r = await fetch(${JSON.stringify(apiBase + probe)}, {method:'POST',body:JSON.stringify({dom})});
      for (const c of await r.json()) {
        if (c.click) over?.querySelector(c.click)?.click();
        if (c.closePane) document.querySelector('[data-pane="' + c.closePane + '"] .pane-head .x')?.click();
        // 사람이 Esc 를 누른 것처럼 지금 포커스가 있는 곳에서 올린다.
        if (c.esc) (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        if (c.send && input) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }
      }
    } finally { pending = false; }
  }, 100); return 'isolated sub test'; })()`;

  const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  const dom = () => latest.dom ?? {};
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) await delay(100); return ok(); };
  // 테스트 창만 찍는다(CHIISPACE_TEST_SCREENSHOT=1 로 직접 돌릴 때).
  const shot = (name) => {
    if (process.env.CHIISPACE_TEST_SCREENSHOT !== "1") return;
    spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid), "-WaitSec", "1", "-Out", path.join(root, name + ".png")], { windowsHide: true });
  };
  try {
    assert.ok(await until(() => dom().shown && dom().theirs?.some(t => t.includes("SUB_READY_MARK"))), "저장된 대화가 대화창에 안 뜸: " + JSON.stringify(dom()));

    commands.push({ send: "CHAT_SUB_ASK" });
    // 서브에이전트가 일하는 동안: 그 한 줄이 보이고, 본 대화 말풍선에는 섞이지 않는다.
    const working = () => dom().subs?.some(s => (s.what ?? "").includes("SUB_WORKING"));
    assert.ok(await until(working, 400), "서브에이전트의 일이 대화창에 보이지 않음: " + JSON.stringify({ dom: dom(), seen }));
    const row = dom().subs.find(s => (s.what ?? "").includes("SUB_WORKING"));
    assert.equal(row.state, "쓰는 중");
    assert.match(row.label ?? "", /SUB_TASK|로그/, "서브에이전트에 맡긴 일이 이름으로 안 보임: " + JSON.stringify(row));
    assert.ok(![...dom().theirs, ...dom().live].some(t => t.includes("SUB_WORKING")), "서브에이전트의 글이 본 대화 말풍선에 섞였음");
    assert.ok(seen.subHeader, "서브에이전트 요청에 에이전트 id 헤더가 없음 — 프록시가 가를 근거가 없다");
    // 서브에이전트 대화 파일의 이름이 헤더의 에이전트 id 와 같아야 진행 줄에서 그 대화로 건너갈 수 있다.
    const subFile = path.join(store, sid, "subagents", "agent-" + seen.subHeader + ".jsonl");
    // 파일은 스트림보다 조금 늦게 생긴다(meta 가 먼저, 대화는 0.5초쯤 뒤). 앱도 생길 때까지 다시 찾는다.
    assert.ok(await until(() => existsSync(subFile), 50), "서브에이전트 대화 파일 이름이 헤더 id 와 다름: " + subFile);

    // 오케스트레이션: 서브에이전트가 뜨면 옆에 읽기 전용 칸이 열려 그 대화가 보인다. 본 칸의 입력바를 빼앗지 않는다.
    const subPane = () => dom().panes?.find(p => p.sub);
    assert.ok(await until(() => subPane()?.task?.includes("SUB_TASK"), 100), "서브에이전트 칸이 안 열리거나 맡긴 일이 안 보임: " + JSON.stringify(dom().panes));
    const opened = subPane();
    const main = dom().panes.find(p => p.id === "%0");
    assert.equal(opened.xterm, false, "서브에이전트 칸에 터미널이 떴다");
    assert.equal(opened.chip, "서브에이전트");
    assert.notEqual(opened.ring, null, "일하는 서브에이전트 칸에 테두리가 안 돈다");
    assert.ok(opened.rect[0] > main.rect[0] && Math.abs(opened.rect[1] - main.rect[1]) < 4, "서브에이전트 칸이 본 칸 오른쪽에 안 붙음: " + JSON.stringify(dom().panes));
    assert.notEqual(dom().focusIn, opened.id, "서브에이전트 칸이 포커스를 가져갔다");
    assert.equal(dom().panes.filter(p => p.sub).length, 1, "서브에이전트 하나에 칸이 여럿 열림");
    // 칸 이름은 맡긴 일의 첫 줄이 아니라 claude 가 적은 짧은 설명이다.
    assert.ok(await until(() => subPane()?.title === "로그 찾기", 50), "서브에이전트 칸 이름이 짧은 설명으로 안 바뀜: " + JSON.stringify(subPane()));
    shot("sub-pane-working");

    // 일하는 중에 그 줄을 누르면 서브에이전트의 대화가 열린다. 첫 말은 맡긴 일로 보인다.
    commands.push({ click: ".sub" });
    assert.ok(await until(() => dom().view?.task?.includes("SUB_TASK"), 100), "진행 줄을 눌렀는데 서브에이전트 대화가 안 열림: " + JSON.stringify(dom()));
    assert.equal(dom().view.title, "로그 찾기");
    assert.equal(dom().view.kind, "general-purpose");

    // 서브에이전트가 마지막 답을 끝내면 그 줄은 걷히고, 본 대화의 답은 제자리에 선다.
    // 새 claude 는 서브에이전트를 백그라운드로 돌려 본 대화가 먼저 답할 수도 있다 — 순서는 묻지 않는다.
    release();
    // 열어 둔 채로 끝나면 그 화면에 서브에이전트의 마지막 답까지 들어온다.
    assert.ok(await until(() => dom().view?.bubbles?.some(t => t.includes("SUB_DONE")), 300), "열어 둔 서브에이전트 화면에 마지막 답이 안 들어옴: " + JSON.stringify(dom().view));
    // Esc 는 이 화면만 닫는다. 아래 입력바로 새면 claude 가 하던 일을 끊는다.
    commands.push({ esc: true });
    assert.ok(await until(() => dom().view === null, 50), "Esc 로 서브에이전트 화면이 안 닫힘");
    assert.ok(await until(() => !dom().subs?.length, 300), "서브에이전트가 끝났는데 줄이 안 걷힘: " + JSON.stringify({ dom: dom(), seen }));
    assert.ok(await until(() => dom().theirs?.some(t => t.includes("MAIN_AFTER_SUB")), 300), "본 대화의 답이 안 섬: " + JSON.stringify({ dom: dom(), seen }));
    // 끝난 서브에이전트 칸은 마지막 답까지 보이고 끝남 표시와 함께 남는다. 테두리는 멈춘다.
    const finished = () => dom().panes?.find(p => p.id === opened.id);
    assert.ok(await until(() => finished()?.bubbles?.some(t => t.includes("SUB_DONE")) && finished().done && finished().ring === null, 300), "끝난 서브에이전트 칸이 마지막 답·끝남 표시를 안 보임: " + JSON.stringify(finished()));
    // 다시 켜도 그 칸이 터미널로 뜨지 않게 세션에 적힌다.
    const savedSubs = () => { try { return JSON.parse(readFileSync(state, "utf8")).subPanes ?? {}; } catch { return {}; } };
    assert.ok(await until(() => savedSubs()[opened.id]?.agent === seen.subHeader, 50), "서브에이전트 칸이 세션에 안 적힘: " + JSON.stringify(savedSubs()));
    shot("sub-pane-done");
    assert.ok(![...dom().theirs, ...dom().live].some(t => t.includes("SUB_WORKING") || t.includes("SUB_DONE")), "서브에이전트의 글이 본 대화 말풍선에 섞였음");
    // 새면 입력바의 Esc(중단)가 되어 대화에 "여기서 중단했다"가 선다.
    assert.ok(!dom().notes?.some(t => t.includes("중단")), "서브에이전트 화면을 닫은 Esc 가 claude 로 샜음: " + JSON.stringify(dom().notes));
    // 끝난 뒤에도 "… 부름" 줄을 누르면 그 서브에이전트의 대화를 다시 연다(부른 호출 id 로 찾는다).
    commands.push({ click: ".note.launch" });
    assert.ok(await until(() => dom().view?.bubbles?.some(t => t.includes("SUB_DONE")), 100), "부름 줄로 서브에이전트 대화가 안 열림: " + JSON.stringify(dom()));
    commands.push({ click: ".subview-back" });
    assert.ok(await until(() => dom().view === null, 50), "본 대화로 돌아가지 않음");
    // 사용자가 닫은 서브에이전트 칸은 닫힌 채로 있다.
    commands.push({ closePane: opened.id });
    assert.ok(await until(() => !dom().panes?.some(p => p.id === opened.id), 50), "서브에이전트 칸이 안 닫힘");
    await delay(1500);
    assert.ok(!dom().panes?.some(p => p.sub), "닫은 서브에이전트 칸이 다시 열림: " + JSON.stringify(dom().panes));
    assert.equal(seen.main1, 1);
    assert.ok(seen.main2 >= 1, "서브에이전트 결과를 받은 본 대화 요청이 없음");
    assert.equal(app.exitCode, null);
    console.log("서브에이전트 표시 확인", root, "헤더:", seen.subHeader);
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ ...latest, seen }));
    console.error("서브에이전트 검증 기록", root);
    throw e;
  } finally {
    release();
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + app.pid + " -ErrorAction SilentlyContinue).CloseMainWindow()"], { windowsHide: true });
    for (let i = 0; i < 50 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
