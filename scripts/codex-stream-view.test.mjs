import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = process.env.CHIISPACE_TEST_EXE;
const codex = process.env.CHIISPACE_TEST_REAL_CODEX;
const delay = ms => new Promise(r => setTimeout(r, ms));
const hash = file => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;

test("터미널 없는 Codex: 두 칸·승인·질문·중단·모델·상태·복원·종료", { skip: !exe || !codex, timeout: 240000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chiispace-codex-stream-"));
  const home = path.join(root, "codex-state"), project = path.join(root, "project"), state = path.join(root, "session.json");
  mkdirSync(home); mkdirSync(project);
  const protectedFiles = [path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".codex", "hooks.json"),
    ...["com.sehyun.chiispace", "com.sehyun.kasaspace"].map(s => path.join(process.env.APPDATA, s, "session.json"))];
  const before = protectedFiles.map(hash);
  const probe = "/" + randomUUID(), commands = [], requests = [], observations = [], apps = [];
  let latest = {}, slow;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      if (req.url === probe) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        latest = JSON.parse(body); observations.push(latest);
        res.end(JSON.stringify(commands.splice(0))); return;
      }
      if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      const data = JSON.parse(body), input = data.input ?? [];
      const user = [...input].reverse().find(i => i.role === "user");
      const mark = JSON.stringify(user).match(/CS_[A-Z]+/)?.[0] ?? "CS_NONE";
      const afterTool = input.at(-1)?.type === "function_call_output";
      requests.push({ ...data, mark, afterTool });
      const n = requests.length, id = `resp_${n}`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      emit("response.created", { response: { id, status: "in_progress", output: [] } });
      if (!afterTool && ["CS_ALLOW", "CS_DENY", "CS_ASK"].includes(mark)) {
        const names = (data.tools ?? []).map(t => t.name);
        const name = mark === "CS_ASK" ? "request_user_input" : names.includes("exec_command") ? "exec_command" : "shell_command";
        const dir = mark === "CS_ALLOW" ? "allowed_dir" : "denied_dir";
        const args = mark === "CS_ASK" ? { questions: [{ id: "direction", header: "방향", question: "어느 쪽으로 갈까?", options: [{ label: "왼쪽", description: "첫 선택" }, { label: "오른쪽", description: "둘째 선택" }] }] }
          : { [name === "exec_command" ? "cmd" : "command"]: `New-Item -ItemType Directory -Path ${dir}`, workdir: project, sandbox_permissions: "require_escalated", justification: "격리 테스트 폴더 생성 허락" };
        const item = { id: `fn_${n}`, type: "function_call", call_id: `call_${n}`, name, arguments: JSON.stringify(args), status: "completed" };
        emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
        emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
        emit("response.output_item.done", { output_index: 0, item });
        emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
        res.end(); return;
      }
      const text = mark + (afterTool ? "_AFTER_TOOL" : "_REPLY");
      const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: mark + "_" });
      if (mark === "CS_SLOW") { slow = res; return; }
      await delay(600);
      if (res.destroyed) return;
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: afterTool ? "AFTER_TOOL" : "REPLY" });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 실제 모델·사용자 인증 없이 설치된 CLI의 승인·질문 프로토콜을 구동한다.
  writeFileSync(path.join(home, "config.toml"), `model = "gpt-5.4"\nmodel_provider = "local_test"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[features]\ndefault_mode_request_user_input = true\n[model_providers.local_test]\nname = "Local stream fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  writeFileSync(state, JSON.stringify({ tabs: [{ key: "t0", focus: "%0", root: project.replaceAll("\\", "/"), shell: path.join(process.env.SystemRoot, "System32", "cmd.exe"), layout: { kind: "leaf", id: "%0" } }], active: 0, nextPane: 1, nextTab: 1, procs: {}, restoreMode: "native-continue" }));
  const pane = (id = "%1") => latest.panes?.[id] ?? {};
  const saved = () => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return {}; } };
  const until = async (fn, message, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (fn()) return; await delay(100); }
    throw new Error(message + ": " + JSON.stringify(latest));
  };
  async function launch() {
    latest = {};
    const env = { ...process.env, CHIISPACE_STATE: state, CODEX_HOME: home };
    for (const key of Object.keys(env)) if (key.startsWith("CHIISPACE_AUTO") || key.startsWith("CHIISPACE_PROBE") || key === "CHIISPACE_ROOT" || /API_KEY|AUTH_TOKEN|CODEX_TUI_RECORD|CODEX_TUI_SESSION_LOG/.test(key)) delete env[key];
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
    if (process.env.CHIISPACE_TEST_CODEX_PATH !== "inherited") env[pathKey] = `${path.dirname(codex)};${env[pathKey]}`;
    env.CHIISPACE_PROBE_MS = "500";
    env.CHIISPACE_PROBE = `(() => { let pending = false; setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const side = document.querySelector('.side'), panes = {};
        for (const slot of document.querySelectorAll('[data-pane]')) {
          const over = slot.querySelector('.chat-over'), input = over?.querySelector('.composer textarea');
          const texts = sel => [...(over?.querySelectorAll(sel) ?? [])].map(e => e.textContent);
          panes[slot.dataset.pane] = { over: !!over, xterm: !!slot.querySelector('.xterm'), termButton: !!slot.querySelector('.composer-term'),
            input: !!input, disabled: input?.disabled, value: input?.value, focused: input === document.activeElement,
            mine: texts('.msg.mine:not(.sending) .bubble'), theirs: texts('.msg:not(.mine) .bubble'), sending: texts('.msg.sending .bubble'),
            perm: over?.querySelector('.ask.perm')?.textContent, ask: over?.querySelector('.ask.choose')?.textContent,
            error: texts('[role="alert"]'), stop: !!over?.querySelector('.composer-stop'), status: over?.querySelector('.codex-status')?.textContent,
            models: [...(over?.querySelectorAll('select[aria-label="Codex 모델"] option') ?? [])].map(o => o.value),
            model: over?.querySelector('select[aria-label="Codex 모델"]')?.value, title: slot.querySelector('.pane-head .title')?.textContent };
        }
        const r = await fetch(${JSON.stringify(base + probe)}, {method:'POST', body:JSON.stringify({panes, picker: !!side?.querySelector('.contacts')})});
        for (const c of await r.json()) {
          const slot = document.querySelector('[data-pane="' + (c.id ?? '%1') + '"]'), over = slot?.querySelector('.chat-over');
          if (c.click) (c.side ? side : over)?.querySelector(c.click)?.click();
          if (c.button) [...(over?.querySelectorAll('button') ?? [])].find(b => b.textContent === c.button)?.click();
          if (c.send) {
            const input = over?.querySelector('.composer textarea'); if (!input) continue;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, c.send);
            input.dispatchEvent(new Event('input', {bubbles:true})); await new Promise(r => setTimeout(r, 50));
            input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
          }
          if (c.model) { const sel = over?.querySelector('select[aria-label="Codex 모델"]'); sel.value = c.model; sel.dispatchEvent(new Event('change', {bubbles:true})); }
          if (c.close) slot?.querySelector('.pane-head .x')?.click();
        }
      } finally { pending = false; }
    }, 100); return 'isolated codex stream'; })()`;
    const app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" }); apps.push(app);
    await until(() => latest.panes, "앱 시작"); return app;
  }
  const close = async app => {
    if (app.exitCode !== null) return;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`], { windowsHide: true });
    await until(() => app.exitCode !== null, "테스트 앱 종료", 8000);
  };
  const childPids = app => JSON.parse(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.pid}" | Where-Object { $_.Name -in @('codex.exe','node.exe') } | Select-Object -ExpandProperty ProcessId)`], { windowsHide: true, encoding: "utf8" }).stdout || "[]");
  const alive = pids => Number(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue).Count`], { windowsHide: true, encoding: "utf8" }).stdout.trim());
  const pick = async () => {
    commands.push({ side: true, click: ".newtab" }); await until(() => latest.picker, "새 대화 목록");
    commands.push({ side: true, click: '.ct[data-agent="codex"]' });
  };
  const reply = async (mark, id = "%1", suffix = "_REPLY") => {
    await until(() => pane(id).input && !pane(id).disabled && !pane(id).stop, "입력 준비");
    commands.push({ id, send: mark + " 한글\n다음 줄" });
    await until(() => pane(id).theirs?.includes(mark + suffix) && !pane(id).stop, mark + " 응답");
  };
  const shot = (app, name) => {
    if (process.env.CHIISPACE_TEST_SCREENSHOT !== "1") return;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/shot.ps1", "-ProcessId", String(app.pid), "-WaitSec", "1", "-Out", path.join(root, name + ".png")], { windowsHide: true, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    let app = await launch(); await pick();
    await until(() => pane().input && !pane().disabled, "Codex 연결");
    assert.equal(pane().xterm, false); assert.equal(pane().termButton, false);
    await reply("CS_FIRST");
    assert.deepEqual(pane().mine, ["CS_FIRST 한글\n다음 줄"]);
    assert.deepEqual(pane().theirs, ["CS_FIRST_REPLY"]);
    assert.ok(observations.some(o => o.panes?.["%1"]?.theirs.includes("CS_FIRST_")), "실시간 조각 누락");
    await until(() => saved().streams?.["%1"]?.session, "대화 ID 저장");
    const first = saved().streams["%1"].session;
    await pick(); await reply("CS_SECOND", "%2");
    assert.notEqual(saved().streams["%2"].session, first);
    assert.deepEqual(pane("%1").mine, ["CS_FIRST 한글\n다음 줄"]);
    assert.deepEqual(pane("%2").mine, ["CS_SECOND 한글\n다음 줄"]);

    commands.push({ id: "%2", send: "CS_ALLOW" });
    await until(() => pane("%2").perm?.includes("allowed_dir"), "실행 승인 카드");
    shot(app, "approval");
    commands.push({ id: "%2", click: ".ask.perm .ask-go:first-child" });
    await until(() => pane("%2").theirs?.includes("CS_ALLOW_AFTER_TOOL") && !pane("%2").stop, "승인 뒤 응답");
    assert.ok(existsSync(path.join(project, "allowed_dir")), "승인한 작업 실행 누락");
    commands.push({ id: "%2", send: "CS_DENY" });
    await until(() => pane("%2").perm?.includes("denied_dir"), "거절 카드");
    // CLI가 이 실행에 내준 선택지는 허락·취소뿐이다. 없는 decline을 임의로 보내지 않는다.
    commands.push({ id: "%2", button: "취소" });
    await until(() => !pane("%2").stop && !pane("%2").perm, "거절 뒤 종료");
    assert.equal(existsSync(path.join(project, "denied_dir")), false);

    commands.push({ id: "%2", send: "CS_ASK" });
    await until(() => pane("%2").ask?.includes("어느 쪽"), "질문 카드");
    commands.push({ id: "%2", click: ".ask.choose .ask-opt:nth-child(2)" }); await delay(350);
    commands.push({ id: "%2", click: ".ask.choose .ask-go" });
    await until(() => pane("%2").theirs?.includes("CS_ASK_AFTER_TOOL") && !pane("%2").stop, "질문 답변");
    assert.ok(requests.some(r => r.mark === "CS_ASK" && JSON.stringify(r.input).includes("오른쪽")), "질문 답 유실");
    commands.push({ id: "%2", send: "CS_SLOW" });
    await until(() => pane("%2").stop && pane("%2").theirs?.includes("CS_SLOW_"), "느린 답");
    commands.push({ id: "%2", click: ".composer-stop" });
    await until(() => !pane("%2").stop, "중단"); slow?.destroy();

    const model = pane("%2").models.find(m => m && m !== pane("%2").model);
    assert.ok(model, "변경할 모델 없음"); commands.push({ id: "%2", model });
    await until(() => pane("%2").model === model, "모델 선택");
    commands.push({ id: "%2", send: "/status" }); await until(() => pane("%2").status?.includes(model), "상태 표시");
    await reply("CS_MODEL", "%2");
    shot(app, "status");
    assert.equal(requests.find(r => r.mark === "CS_MODEL").model, model);
    assert.ok(!pane("%2").mine.includes("/status") && !pane("%2").sending.length, "메뉴 명령 말풍선 누출");
    const pids = childPids(app); assert.equal(pids.length, 2);
    await close(app); await until(() => alive(pids) === 0, "앱 종료 후 Codex 회수", 10000);
    app = await launch(); await until(() => pane("%1").mine?.includes("CS_FIRST 한글\n다음 줄") && !pane("%1").disabled, "같은 대화 복원");
    assert.equal(saved().streams["%1"].session, first);
    assert.equal(pane("%1").title, "CS_FIRST 한글");
    assert.ok(!pane("%1").mine.includes("CS_SECOND 한글\n다음 줄"));
    await reply("CS_RESUME", "%2");
    assert.ok(JSON.stringify(requests.find(r => r.mark === "CS_RESUME").input).includes("CS_SECOND"));
    assert.equal(pane("%2").model, model);
    const second = saved().streams["%2"].session;
    commands.push({ id: "%2", send: "/new" });
    await until(() => saved().streams?.["%2"]?.session !== second && !pane("%2").mine?.length, "새 대화 전환");
    await reply("CS_NEW", "%2");
    assert.ok(!JSON.stringify(requests.find(r => r.mark === "CS_NEW").input).includes("CS_SECOND"));
    const remaining = childPids(app); assert.equal(remaining.length, 2);
    commands.push({ id: "%2", close: true });
    await until(() => !latest.panes?.["%2"] && !saved().streams?.["%2"], "칸 닫기");
    await until(() => alive(remaining) === 1, "닫은 칸의 Codex 회수", 12000);
    assert.equal(app.exitCode, null, "칸 닫기가 앱 종료로 전파됨");
    await pick(); await until(() => pane("%3").input && !pane("%3").disabled && saved().streams?.["%3"]?.session, "빈 새 칸 준비");
    const empty = saved().streams["%3"].session;
    await close(app); app = await launch();
    await until(() => pane("%3").input && !pane("%3").disabled, "한 번도 말하지 않은 새 칸 복원");
    await until(() => saved().streams?.["%3"]?.session !== empty, "미전송 칸은 새 빈 대화로 열기");
    assert.equal(pane("%3").mine.length, 0);
    await reply("CS_EMPTY", "%3");
    assert.equal(pane("%3").title, "CS_EMPTY 한글");
    commands.push({ id: "%3", send: "/unsupported-command" });
    await until(() => pane("%3").value === "/unsupported-command" && pane("%3").error.length > 0, "실패한 입력 초안 복구");
    assert.ok(!pane("%3").sending.length);
    await reply("CS_RECOVER", "%3");
    assert.equal(pane("%3").error.length, 0);
    shot(app, "resumed");
    assert.equal(existsSync(path.join(home, "hooks.json")), false, "추가 훅 신뢰 요구");
    console.log("터미널·훅 없이 두 칸 대화, 실승인·거절·질문·중단·모델·상태·복원·종료 확인");
  } catch (e) {
    writeFileSync(path.join(root, "failure.json"), JSON.stringify({ latest, requests, observations })); throw e;
  } finally {
    for (const app of apps) await close(app).catch(() => app.kill());
    slow?.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.deepEqual(protectedFiles.map(hash), before, "사용자 세션·설정 변경");
    console.log("Codex stream 검증:", root);
  }
});
