/** 폰 화면 검증용 헤드리스 Edge(remote-app·session-move 가 같이 쓴다). 별도 프로필의 한 탭을 아이폰 크기로 띄우고 CDP 로만
 *  다룬다 — 사용자 브라우저·OS 키보드·마우스를 쓰지 않는다. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const edge = [
  path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
].find((p) => existsSync(p));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, n = 300) => {
  for (let i = 0; i < n && !(await ok()); i++) await delay(100);
  return ok();
};
const killTree = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });

/** 별도 프로필의 헤드리스 Edge 한 탭(아이폰 크기). 사용자 브라우저·OS 입력을 쓰지 않고 페이지 안에서만 누른다(CDP). */
export async function phoneBrowser(dir) {
  const proc = spawn(edge, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const portFile = path.join(dir, "DevToolsActivePort");
  assert.ok(await until(() => existsSync(portFile), 100), "Edge 디버깅 포트가 안 열림");
  const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
  let page;
  await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    page = list.find((t) => t.type === "page");
    return !!page;
  }, 100);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      waiting.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  return {
    send,
    evaluate,
    shot: async (file) => writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")),
    close: () => {
      try {
        ws.close();
      } catch {}
      killTree(proc.pid);
    },
  };
}
