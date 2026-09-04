/** 칸 하나가 무엇을 돌고 있고, 그것을 어떻게 되살리는가.
 *
 *  세션 파일에 남길 값과 그 판정이 여기 모여 있다. 무엇을 저장할지 바꾸려면 이
 *  파일만 보면 된다 — 화면이 그것을 어떻게 그리는지와는 상관이 없다. */

/** 이 컴퓨터에서 띄울 수 있는 셸 하나. Rust 의 `shells` 가 찾아 준다.
 *
 *  세션에 남기는 것은 `path` 다. `id` 는 화면에서 고를 때만 쓴다 — 같은 이름이
 *  가리키는 실행 파일이 컴퓨터마다 다르고, 나중에 이름을 고치면 저장된 탭이
 *  전부 짝을 잃는다. */
export type ShellKind = { id: string; name: string; path: string };

export type PaneStat = {
  id: string;
  proc: string | null;
  agent: string | null;
  busy: boolean;
  working?: boolean;
  cwd: string | null;
};

// 프로세스가 열려 있는 상태와 출력이 흐르는 작업 상태를 분리해야 대기 중에는 멈춘다.
export function isAgentWorking(p?: PaneStat, title?: string): boolean {
  if (p?.agent !== "claude" && p?.agent !== "codex") return false;
  const mark = title?.trimStart().codePointAt(0);
  const marked =
    mark !== undefined &&
    ((mark >= 0x2720 && mark <= 0x274f) || (mark >= 0x2800 && mark <= 0x28ff));
  return !!p.working || marked;
}

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

/** 저장된 복원 명령에서 claude 세션 ID 를 꺼낸다. */
export const seedSession = (cmd: string): string | null =>
  /--resume\s+([0-9a-f-]{36})/i.exec(cmd)?.[1] ?? null;

/** 살아 있는 백그라운드 대화는 `--resume` 이 아니라 `attach` 로 붙는다.
 *
 *  claude 는 대화를 데몬에 맡겨 백그라운드로 계속 돌릴 수 있다. 그렇게 살아
 *  있는 대화에 `--resume` 을 걸면 열어 주지 않고 거절 문구만 남긴다 — 한 대화에
 *  두 프로세스가 붙어 같은 기록에 쓰게 되기 때문이다. 그러면 그 칸은 셸 프롬프트
 *  앞에 멈춰 서고, 사용자 눈에는 "복원이 안 됐다"로 보인다. 실제로 그랬다.
 *
 *  `attach` 는 그 살아 있는 대화를 이 칸으로 데려온다. 원래 하려던 일이 그것이다.
 *
 *  판정을 저장할 때가 아니라 **열 때** 한다. 껐다 켜는 사이에 그 대화가 백그라운드로
 *  갔을 수도, 멈췄을 수도 있다 — 저장 시점의 판단은 켤 때쯤이면 이미 낡았다. */
export function liveAttach(seed: Seed, bg: string[]): Seed {
  const sid = seedSession(seed.cmd);
  if (!sid) return seed;
  const short = sid.slice(0, 8).toLowerCase();
  if (!bg.includes(short)) return seed;
  return { ...seed, cmd: `claude attach ${short}` };
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
