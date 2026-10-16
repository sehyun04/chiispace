import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/* 검증이 사용자 세션·전역 설정을 건드리지 않았는지 본다.
 *
 * 전역 설정(`~/.claude.json`·`~/.codex/config.toml` 등)은 바이트로 비교하지 않는다. 사용자의 다른 claude·codex 가
 * 검증 도중에도 고쳐 쓰기 때문이다 — 10월 16일 배포가 그것으로 멈췄고, claude 가 떠 있으면 아예 비교를 빼던 검증은
 * 사용자가 늘 claude 를 띄워 두니 사실상 꺼져 있었다. 대신 이 검증만 남길 수 있는 흔적(임시 폴더·검증 exe 폴더 경로,
 * chiispace MCP 토큰 이름)이 새로 늘었는지 본다. 앱이 설정에 새면 칸의 폴더나 MCP 설정을 적게 되므로 흔적이 남는다.
 *
 * 앱 세션 파일은 chiispace 만 쓰므로 사용자 앱이 꺼져 있으면 지금처럼 바이트 그대로를 요구한다. 떠 있을 때만
 * 흔적 비교로 내려간다 — 그때는 사용자 앱이 제 세션을 쓰는 것이 정상이다. */
export function watchUserFiles(files, { root, exe }) {
  const read = (file) => { try { return readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  const userApp = spawnSync("tasklist", ["/FI", "IMAGENAME eq chiispace.exe", "/NH"], { encoding: "utf8", windowsHide: true })
    .stdout.toLowerCase().includes("chiispace.exe");
  const strict = (file) => !userApp && /[\\/]com\.sehyun\.[^\\/]+[\\/]session\.json$/i.test(file);
  const traces = [root, exe && path.dirname(path.resolve(exe))].filter(Boolean)
    .flatMap((p) => [p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\")])
    .concat("CHIISPACE_AGENT_TOKEN").map((t) => t.toLowerCase());
  const count = (text, t) => text.toLowerCase().split(t).length - 1;
  const before = files.map(read);
  return (label) => files.forEach((file, i) => {
    const now = read(file);
    if (now === before[i]) return;
    assert.ok(!strict(file), `${label}: ${file} 이 바뀜`);
    assert.notEqual(now, null, `${label}: ${file} 이 지워짐`);
    for (const t of traces) {
      assert.ok(count(now, t) <= count(before[i] ?? "", t), `${label}: ${file} 에 검증 흔적(${t})이 새로 생김`);
    }
  });
}
