#!/usr/bin/env node
/** 고정 경로(`src-tauri/target/release/`)의 앱·CLI 를 한 커밋으로 굽고 바꾼다.
 *
 *  손으로 하던 절차를 그대로 옮겼다(작업 정리 4절). 하나라도 빠지면 실제로 사고가 났던 단계들이다:
 *  - 작업본이 아니라 그 커밋 그대로의 임시 워크트리에서 굽는다. 작업본에는 다른 세션의 미커밋 변경이 섞여 있다.
 *  - `CONPTY-LICENSE.txt` 가 체크아웃 때 CRLF 로 바뀌면 앱이 켜자마자 죽는다. 커밋의 바이트와 대조한다.
 *  - 그 exe 그대로 전체 검증을 돌린다. 실패가 하나라도 있으면 바꾸지 않는다(--force 로만 넘는다).
 *  - 바꾸기 전에 앱·CLI·사용자 세션 파일을 백업하고, 바꾼 뒤 해시가 검증한 파일과 같은지 본다.
 *  - 사용자 앱을 임의로 끄지 않는다. 떠 있으면 멈추고, --allow-running 이면 실행 중인 exe 를 *.old-<시각>
 *    으로 옮겨 낸 뒤 놓는다(새 코드는 다음 실행부터).
 *
 *    node scripts/deploy.mjs                      origin/master 로 굽고 바꾼다
 *    node scripts/deploy.mjs --ref <커밋>          그 커밋으로
 *    node scripts/deploy.mjs --dry-run            굽고 검증까지만
 *    node scripts/deploy.mjs --label <이름>        백업 폴더 이름(before-<이름>-<시각>)
 *
 *  끝나면 `docs/DEPLOYS.md` 에 한 줄을 붙인다. 커밋은 부른 쪽이 한다. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const dry = flag("--dry-run");

const say = (m) => console.log(`[deploy] ${m}`);
const die = (m) => {
  console.error(`[deploy] 멈춤: ${m}`);
  process.exit(1);
};
const sh = (cmd, args, cwd = repo, inherit = false) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, stdio: inherit ? "inherit" : "pipe" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), status: r.status };
};
const must = (cmd, args, cwd = repo, inherit = false) => {
  const r = sh(cmd, args, cwd, inherit);
  if (!r.ok) die(`${cmd} ${args.join(" ")}\n${r.err || r.out}`);
  return r.out;
};
// npx 는 .cmd 라 셸 없이는 Node 가 띄우지 않는다. 인자는 우리가 정한 것뿐이라 한 줄로 이어 준다.
const npx = (args, cwd) => {
  const r = spawnSync(["npx", ...args].join(" "), { cwd, shell: true, stdio: "inherit", windowsHide: true });
  if (r.status !== 0) die(`npx ${args.join(" ")}`);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
const running = (image) => sh("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"]).out.toLowerCase().includes(image);
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 1. 어느 커밋인가
must("git", ["fetch", "-q", "origin"]);
const ref = opt("--ref") ?? "origin/master";
const commit = must("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
const short = commit.slice(0, 7);
const subject = must("git", ["log", "-1", "--format=%s", commit]);
say(`커밋 ${short} ${subject}`);

// 2. 사용자 앱이 떠 있는가 — 끄지 않는다
const release = path.join(repo, "src-tauri", "target", "release");
const appUp = running("chiispace.exe") || running("chiispace-cli.exe");
if (appUp && !dry && !flag("--allow-running")) die("앱이 떠 있다. 사용자가 끈 뒤 다시 하거나 --allow-running 을 준다");

// 3. 그 커밋 그대로의 워크트리
const wt = path.join(os.tmpdir(), `chiispace-deploy-${short}-${stamp()}`);
must("git", ["worktree", "add", "-q", "--detach", wt, commit]);
const cleanup = () => {
  // junction 은 rmdir 로만 걷는다 — 재귀 삭제는 원본 node_modules 를 지울 수 있다.
  sh("cmd", ["/c", "rmdir", path.join(wt, "node_modules")]);
  sh("git", ["worktree", "remove", "--force", wt]);
};
process.on("exit", cleanup);
must("cmd", ["/c", "mklink", "/J", path.join(wt, "node_modules"), path.join(repo, "node_modules")]);
const license = "src-tauri/CONPTY-LICENSE.txt";
const blob = spawnSync("git", ["cat-file", "blob", `${commit}:${license}`], { cwd: repo }).stdout;
if (!blob || !readFileSync(path.join(wt, license)).equals(blob)) die(`${license} 바이트가 커밋과 다르다(줄바꿈 변환). .gitattributes 를 본다`);

// 4. 굽기 — 다른 세션의 빌드와 겹치지 않는 폴더에
const target = path.join(repo, "src-tauri", "target", "deploy-build");
say("굽는 중");
npx(["tsc", "--noEmit"], wt);
npx(["vite", "build"], wt);
must("cargo", ["build", "--release", "--features", "custom-protocol", "--target-dir", target], path.join(wt, "src-tauri"), true);
const built = { app: path.join(target, "release", "chiispace.exe"), cli: path.join(target, "release", "chiispace-cli.exe") };
const stage = path.join(wt, ".deploy-stage");
mkdirSync(stage, { recursive: true });
const staged = { app: path.join(stage, "chiispace.exe"), cli: path.join(stage, "chiispace-cli.exe") };
copyFileSync(built.app, staged.app);
copyFileSync(built.cli, staged.cli);

// 5. 그 exe 그대로 전체 검증
say("검증 중(실제 앱 포함, 10분 남짓)");
const tester = existsSync(path.join(wt, "scripts", "test.mjs")) ? path.join(wt, "scripts", "test.mjs") : path.join(repo, "scripts", "test.mjs");
const tests = sh(process.execPath, [tester, "--exe", staged.app], wt);
console.log(tests.out.split(/\r?\n/).filter((l) => l.startsWith("[test]") || l.startsWith("  ")).join("\n"));
const summary = tests.out.match(/전체 \S+ · 통과 \S+ · 실패 \S+ · 건너뜀 \S+/)?.[0] ?? "요약 없음";
const cargoTest = sh("cargo", ["test", "--release", "--features", "custom-protocol", "--target-dir", target], path.join(wt, "src-tauri"));
const rustPassed = [...(cargoTest.out + cargoTest.err).matchAll(/test result: ok\. (\d+) passed/g)].reduce((n, m) => n + Number(m[1]), 0);
say(`JS ${summary} · Rust ${cargoTest.ok ? `${rustPassed}개 통과` : "실패"}`);
if ((!tests.ok || !cargoTest.ok) && !flag("--force")) die("검증 실패가 있어 바꾸지 않는다(--force 로만 넘는다)");
if (dry) {
  say("--dry-run: 굽기·검증까지만 했다");
  process.exit(0);
}

// 6. 백업 — 앱·CLI·사용자 세션
const when = stamp();
const backup = path.join(release, "backups", `before-${opt("--label") ?? short}-${when}`);
mkdirSync(backup, { recursive: true });
const saved = [];
for (const [from, name] of [
  [path.join(release, "chiispace.exe"), "chiispace.exe"],
  [path.join(release, "chiispace-cli.exe"), "chiispace-cli.exe"],
  [path.join(process.env.APPDATA ?? "", "com.sehyun.chiispace", "session.json"), "session-before.json"],
  [path.join(process.env.APPDATA ?? "", "com.sehyun.kasaspace", "session.json"), "session-kasaspace-before.json"],
]) {
  if (!existsSync(from)) continue;
  const to = path.join(backup, name);
  copyFileSync(from, to);
  if (sha256(from) !== sha256(to)) die(`백업이 원본과 다르다: ${name}`);
  saved.push(name);
}
say(`백업 ${path.relative(repo, backup)} (${saved.join(", ")})`);

// 7. 바꾸기 — 떠 있는 앱은 끄지 않고 옮겨 낸다
const sessionFile = path.join(process.env.APPDATA ?? "", "com.sehyun.chiispace", "session.json");
const sessionBefore = existsSync(sessionFile) ? sha256(sessionFile) : null;
for (const [name, from] of [["chiispace.exe", staged.app], ["chiispace-cli.exe", staged.cli]]) {
  const to = path.join(release, name);
  if (appUp && existsSync(to)) renameSync(to, `${to}.old-${when}`);
  copyFileSync(from, to);
  if (sha256(to) !== sha256(from)) die(`바꾼 ${name} 가 검증한 파일과 다르다`);
}
const hashes = { app: sha256(path.join(release, "chiispace.exe")), cli: sha256(path.join(release, "chiispace-cli.exe")) };
const sessionAfter = existsSync(sessionFile) ? sha256(sessionFile) : null;
if (sessionBefore !== sessionAfter) say("주의: 교체 중 사용자 세션 파일이 바뀌었다(앱이 떠 있었다면 정상 저장일 수 있다)");
say(`바꿈 ${when} · 앱 ${hashes.app} · CLI ${hashes.cli}`);

// 8. 기록 한 줄 — 커밋은 부른 쪽이 한다
const log = path.join(repo, "docs", "DEPLOYS.md");
const row = `| ${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)} ${when.slice(9, 11)}:${when.slice(11, 13)} | \`${short}\` ${subject} | ${appUp ? "떠 있음(.old 로 옮김)" : "꺼짐"} | JS ${summary} · Rust ${rustPassed} | \`${path.basename(backup)}/\` | \`${hashes.app.slice(0, 16)}…\` / \`${hashes.cli.slice(0, 16)}…\` |\n`;
if (existsSync(log)) {
  appendFileSync(log, row);
  say(`기록 docs/DEPLOYS.md 에 한 줄 붙임 — 커밋은 따로 한다`);
} else console.log(row);
