#!/usr/bin/env node
/** 배포한 앱·CLI 를 GitHub 릴리스로 올린다. 소스도 빌드 도구도 없는 다른 PC(데스크톱 등)는
 *  `chiispace-update.ps1` 로 이 릴리스를 받아 같은 판을 쓴다.
 *
 *  deploy.mjs 가 바꾸기를 마친 뒤 부른다. 손으로 부를 수도 있다(이미 배포한 판을 올릴 때):
 *    node scripts/release.mjs --app <exe> --cli <exe> --commit <커밋> [--when <yyyymmdd-hhmmss>] [--dry]
 *
 *  릴리스는 프리릴리스가 아니다: `releases/latest` 가 가리켜야 업데이터와 설치 한 줄이 늘 같은 주소를 쓴다. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_REPO = "sehyun04/chiispace";
export const INSTALL_LINE =
  `$f = "$env:TEMP\\chiispace-update.ps1"; Invoke-WebRequest -UseBasicParsing https://github.com/${RELEASE_REPO}/releases/latest/download/chiispace-update.ps1 -OutFile $f; powershell -ExecutionPolicy Bypass -File $f -Install`;

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();

/** @returns {{ ok: boolean, tag: string, message: string }} */
export function publishRelease({ app, cli, updater = path.join(here, "chiispace-update.ps1"), commit, subject = "", when, dry = false }) {
  const short = commit.slice(0, 7);
  const tag = `build-${when}-${short}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "chiispace-release-"));
  try {
    const files = [];
    for (const [from, name] of [[app, "chiispace.exe"], [cli, "chiispace-cli.exe"], [updater, "chiispace-update.ps1"]]) {
      if (!existsSync(from)) return { ok: false, tag, message: `없다: ${from}` };
      const to = path.join(dir, name);
      copyFileSync(from, to);
      files.push(to);
    }
    // 업데이터는 이 목록에 있는 파일만 받고, 받은 뒤 해시를 대조한다
    const sums = files.map((f) => `${sha256(f)} *${path.basename(f)}`).join("\n") + "\n";
    writeFileSync(path.join(dir, "SHA256SUMS.txt"), sums);
    files.push(path.join(dir, "SHA256SUMS.txt"));
    const date = `${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)} ${when.slice(9, 11)}:${when.slice(11, 13)}`;
    const notes = [
      `docs/DEPLOYS.md 의 ${date} 줄과 같은 판. 커밋 \`${short}\`${subject ? ` ${subject}` : ""}`,
      "",
      "깔린 PC 는 chiispace 바로가기를 누르면 이 판을 받는다(떠 있으면 다음 실행부터).",
      "",
      "새 PC 에 깔기(PowerShell, 관리자 아님):",
      "```powershell",
      INSTALL_LINE,
      "```",
      "",
      "```",
      sums.trim(),
      "```",
    ].join("\n");
    const args = ["release", "create", tag, "-R", RELEASE_REPO, "--target", commit, "--title", `chiispace ${short}`, "--notes", notes, ...files];
    if (dry) return { ok: true, tag, message: `--dry: gh ${args.slice(0, 7).join(" ")} ... (${files.map((f) => path.basename(f)).join(", ")})\n${sums}` };
    const r = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return { ok: false, tag, message: (r.stderr || r.stdout || "").trim() };
    return { ok: true, tag, message: (r.stdout || "").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  const commit = opt("--commit");
  if (!opt("--app") || !opt("--cli") || !commit) {
    console.error("쓰는 법: node scripts/release.mjs --app <exe> --cli <exe> --commit <커밋> [--when <yyyymmdd-hhmmss>] [--dry]");
    process.exit(2);
  }
  const full = spawnSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], { encoding: "utf8" }).stdout.trim();
  const subject = spawnSync("git", ["log", "-1", "--format=%s", full], { encoding: "utf8" }).stdout.trim();
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const when = opt("--when") ?? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const r = publishRelease({ app: opt("--app"), cli: opt("--cli"), commit: full, subject, when, dry: argv.includes("--dry") });
  console.log(`[release] ${r.ok ? "" : "실패: "}${r.tag}\n${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
