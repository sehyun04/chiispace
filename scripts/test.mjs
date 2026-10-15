#!/usr/bin/env node
/** 검증을 한 줄로 돌린다.
 *
 *  실제 앱 검증은 앱 exe·설치된 claude·Codex 경로를 환경 변수로 받는데(README "헤드리스 검증"), 그 넷을
 *  매번 손으로 적다 보면 하나가 빠져 조용히 건너뛰어진 것을 "통과"로 읽게 된다. 여기서 찾아 채우고,
 *  무엇을 썼는지와 건너뛴 것을 결과와 함께 보인다.
 *
 *    node scripts/test.mjs                 단위 검증만(앱 exe 없음 → 실제 앱 검증은 건너뜀)
 *    node scripts/test.mjs --build         지금 작업본을 target/test-build 에 구워 실제 앱까지
 *    node scripts/test.mjs --exe <경로>    그 exe 로 실제 앱까지
 *    node scripts/test.mjs chat stream     파일 이름에 그 낱말이 든 검증만
 *
 *  그 밖: --no-claude · --no-codex(실제 CLI 를 안 씀) · --shot(검증 창 캡처) · --log <경로>.
 *  사용자 세션·인증은 건드리지 않는다 — 각 검증이 격리 상태 폴더를 스스로 만든다. */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flags = new Set();
const values = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--exe" || a === "--log") values[a] = argv[++i];
  else if (a.startsWith("--")) flags.add(a);
  else words.push(a);
}

const firstLine = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : undefined;
};

/** 설치된 claude. PATH 의 것이 사용자가 실제로 쓰는 판이다. */
function findClaude() {
  const hit = firstLine("where", ["claude.exe"]);
  if (hit && existsSync(hit)) return hit;
  const local = path.join(os.homedir(), ".local", "bin", "claude.exe");
  return existsSync(local) ? local : undefined;
}

/** 설치된 Codex. npm 판이면 실행기(codex.js)와 그 안의 네이티브 exe 를 둘 다 준다. */
function findCodex() {
  // npm 은 .cmd 라 셸로 부른다. 인자를 따로 주면 Node 가 이스케이프 경고를 내므로 한 줄로 준다.
  const root = firstLine("npm root -g", [], { shell: true });
  if (!root) return {};
  const pkg = path.join(root, "@openai", "codex");
  const js = path.join(pkg, "bin", "codex.js");
  let exe;
  const scoped = path.join(pkg, "node_modules", "@openai");
  if (existsSync(scoped)) {
    for (const dir of readdirSync(scoped).filter((d) => d.startsWith("codex-win32-"))) {
      const vendor = path.join(scoped, dir, "vendor");
      if (!existsSync(vendor)) continue;
      for (const arch of readdirSync(vendor)) {
        const candidate = path.join(vendor, arch, "bin", "codex.exe");
        if (existsSync(candidate)) exe = candidate;
      }
    }
  }
  return { js: existsSync(js) ? js : undefined, exe };
}

function run(cmd, args, cwd) {
  // npx 는 .cmd 라 셸로 부른다. 인자는 우리가 정한 것뿐이라 한 줄로 이어도 안전하다.
  const viaShell = cmd === "npx";
  const r = viaShell
    ? spawnSync([cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), { cwd, stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[test] 실패: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

/** 지금 작업본을 앱 exe 로 굽는다. 고정 경로(target/release)와 다른 폴더라 사용자 앱을 건드리지 않는다. */
function build() {
  const target = path.join(repo, "src-tauri", "target", "test-build");
  run("npx", ["tsc", "--noEmit"], repo);
  run("npx", ["vite", "build"], repo);
  run("cargo", ["build", "--release", "--features", "custom-protocol", "--target-dir", target], path.join(repo, "src-tauri"));
  return path.join(target, "release", "chiispace.exe");
}

const exe = flags.has("--build") ? build() : values["--exe"] ? path.resolve(values["--exe"]) : undefined;
if (exe && !existsSync(exe)) {
  console.error(`[test] 앱 exe 가 없다: ${exe}`);
  process.exit(1);
}
const claude = flags.has("--no-claude") ? undefined : findClaude();
const codex = flags.has("--no-codex") ? {} : findCodex();

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("CHIISPACE_TEST_")) delete env[k];
if (exe) env.CHIISPACE_TEST_EXE = exe;
if (exe && claude) env.CHIISPACE_TEST_REAL_CLAUDE = claude;
if (exe && codex.exe) env.CHIISPACE_TEST_REAL_CODEX = codex.exe;
if (codex.js) env.CHIISPACE_TEST_CODEX_JS = codex.js;
if (flags.has("--shot")) env.CHIISPACE_TEST_SCREENSHOT = "1";

const files = readdirSync(path.join(repo, "scripts"))
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !words.length || words.some((w) => f.includes(w)))
  .sort()
  .map((f) => path.join("scripts", f));
if (!files.length) {
  console.error(`[test] 고른 검증이 없다: ${words.join(" ")}`);
  process.exit(1);
}

const log = values["--log"] ?? path.join(os.tmpdir(), `chiispace-test-${Date.now()}.log`);
console.log(`[test] 앱 exe: ${exe ?? "(없음 — 실제 앱 검증은 건너뜀)"}`);
console.log(`[test] claude: ${claude ?? "(없음)"} · codex: ${codex.exe ?? "(없음)"}`);
console.log(`[test] 검증 ${files.length}개 · 기록 ${log}`);

const out = createWriteStream(log);
let text = "";
// 실제 앱 검증은 앱을 띄우므로 한 번에 하나씩 돌린다(동시 기동 타임아웃은 미진단).
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], { cwd: repo, env, windowsHide: true });
for (const s of [child.stdout, child.stderr]) {
  s.on("data", (d) => {
    out.write(d);
    text += d;
  });
}
child.on("close", (code) => {
  out.end();
  const line = (k) => text.match(new RegExp(`^ℹ ${k} (\\d+)`, "m"))?.[1] ?? "?";
  console.log(`[test] 전체 ${line("tests")} · 통과 ${line("pass")} · 실패 ${line("fail")} · 건너뜀 ${line("skipped")}`);
  const failing = text.split("✖ failing tests:")[1] ?? "";
  const lines = failing.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("✖ ")) continue;
    const why = lines.slice(i + 1, i + 4).map((l) => l.trim()).find((l) => /Error|assert/i.test(l)) ?? "";
    console.log(`  ${lines[i]}\n    ${why.slice(0, 200)}`);
  }
  if (line("skipped") !== "0" && line("skipped") !== "?") {
    const skipped = [...text.matchAll(/^﹣ (.+?) \(\d/gm)].map((m) => m[1]);
    for (const s of skipped) console.log(`  건너뜀: ${s}`);
  }
  process.exit(code ?? 1);
});
