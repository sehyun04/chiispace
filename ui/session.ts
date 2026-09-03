/** 칸 하나가 무엇을 돌고 있고, 그것을 어떻게 되살리는가.
 *
 *  세션 파일에 남길 값과 그 판정이 여기 모여 있다. 무엇을 저장할지 바꾸려면 이
 *  파일만 보면 된다 — 화면이 그것을 어떻게 그리는지와는 상관이 없다. */

export type PaneStat = {
  id: string;
  proc: string | null;
  agent: string | null;
  busy: boolean;
  cwd: string | null;
};

/** 이 pane 을 되살리려면 무엇을 쳐야 하는가.
 *
 *  `proc` 만 보면 안 된다. 엔진은 전경 프로세스 이름과 에이전트를 따로 판정하는데,
 *  claude 처럼 자기 프로세스 트리를 여러 겹 두는 것은 이름 쪽이 비고 에이전트 쪽만
 *  잡히는 때가 있다. 그때 `proc` 만 보면 claude 를 켜 둔 채로 껐는데도 아무것도
 *  기억하지 못한다.
 *
 *  claude 는 이전 대화를 이어 여는 방법이 따로 있다. 세션을 되돌리려는 참이니
 *  그쪽을 얹는다 — 실행하지는 않으므로 원치 않으면 지우면 된다. */
export type Seed = { cmd: string; auto?: boolean };

export function restoreCmd(p: PaneStat, sid?: string): Seed | null {
  // 에이전트는 이어 열어 준다. 이건 대화를 불러오는 것뿐이라 부작용이 없고,
  // 명령만 쳐 놓아서는 사용자가 말하는 "세션 복원"이 되지 않는다.
  //
  // 세션 ID 를 알면 그것을 짚는다. --continue 는 "그 폴더의 가장 최근" 이라
  // pane 이 여럿이면 전부 같은 대화로 몰리고, 다른 창에서 claude 를 돌리면
  // 엉뚱한 것이 열린다. 못 찾았을 때만 --continue 로 물러선다.
  if (p.agent === "claude")
    return { cmd: sid ? `claude --resume ${sid}` : "claude --continue", auto: true };
  if (p.agent) return { cmd: p.agent, auto: true };
  // 그 밖의 명령은 쳐 놓기만 한다. 빌드나 배포가 저 혼자 다시 도는 건 곤란하다.
  if (p.proc && !SHELLS.has(p.proc.toLowerCase())) return { cmd: p.proc };
  return null;
}

/** 예전 세션은 명령을 문자열로만 적어 두었다. */
export const asSeed = (v: unknown): Seed | null =>
  typeof v === "string" ? { cmd: v } : v && typeof v === "object" ? (v as Seed) : null;

/** 셸 자신은 "돌리던 명령"이 아니다. 이 이름들이 전경에 있으면 그냥 빈 프롬프트다. */
export const SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "fish"]);

/** 헤더에 쓸 이름. 돌고 있는 명령이 있으면 그게 제일 쓸모 있다 —
 *  OSC 타이틀은 cmd.exe 가 자기 전체 경로를 넣어 버려 읽히지 않는다. */
export function label(
  id: string,
  stat: Record<string, PaneStat>,
  titles: Record<string, string>,
): string {
  const t = titles[id];
  const tail = t ? t.split(/[\\/]/).pop() || t : "";
  // 에이전트는 자기 세션 이름을 터미널 타이틀에 실어 보낸다(claude 의 --name
  // 설명에 그렇게 적혀 있다). 그 이름이 "claude" 라는 프로세스 이름보다 훨씬
  // 쓸모 있다 — 여러 개를 띄워 놓으면 헤더가 전부 "claude" 라 구별이 안 된다.
  // claude 는 일하는 중이면 타이틀 앞에 표시를 하나 붙인다(✱ 따위). 그것까지
  // 헤더에 들이면 이름이 밀려 보이므로 앞머리의 기호는 떼고 쓴다.
  const named = tail.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (stat[id]?.agent && named) return named;
  const p = stat[id]?.proc;
  if (p) return p;
  return tail || "shell";
}

/** 홈 아래는 `~` 로 접는다. 목록에서 알고 싶은 것은 어느 프로젝트인지지 전체 경로가 아니다. */
export function shortPath(p: string | null): string {
  if (!p) return "셸";
  return p.replace(/^[A-Za-z]:\/Users\/[^/]+/, "~").replace(/\//g, "\\");
}
