export type ShellKind = { id: string; name: string; path: string };
export type CodexLaunch = { home: string; cwd: string; args?: string[] };
export type CodexSession = CodexLaunch & { id: string; resumable?: boolean };
export type PaneStat = {
  id: string; proc: string | null; agent: string | null; busy: boolean; working?: boolean; cwd: string | null;
  codex?: { run: string; session?: CodexSession | null; launch?: CodexLaunch | null; failed: boolean } | null;
};
export type Seed = { cmd: string; auto?: boolean; cwd?: string; notice?: string; codex?: CodexSession; codexLaunch?: CodexLaunch };

export function isAgentWorking(p?: PaneStat): boolean {
  return (p?.agent === "claude" || p?.agent === "codex") && !!p.working;
}

const absolute = (v: unknown): v is string => typeof v === "string" && v.length <= 32768
  && !/[\0\r\n]/.test(v) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(v);

export function codexContinue(launch: CodexLaunch, auto = true, picker = false): Seed {
  if (!launch || !absolute(launch.home) || !absolute(launch.cwd)
    || (launch.args !== undefined && (!Array.isArray(launch.args) || launch.args.length > 128
      || launch.args.some(s => typeof s !== "string" || s.length > 32768 || /[\0\r\n]/.test(s)))))
    throw new Error("잘못된 Codex 실행 정보");
  // 대화 ID·원문을 넘기지 않는다. 셸 종류와 무관하게 옵션·폴더만 안전하게 전달한다.
  const data: CodexLaunch = { home: launch.home, cwd: launch.cwd, args: launch.args ?? [] };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  const encoded = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { cmd: `chiispace-cli.exe codex-continue ${encoded}${picker ? " --picker" : ""}`, auto, cwd: data.cwd, codexLaunch: data };
}

export function restoreCmd(p: PaneStat): Seed | null {
  if (p.codex && (!p.agent || p.agent === "codex")) {
    const launch = p.codex.launch;
    if (launch) return codexContinue(launch, !p.codex.failed);
    // 외부 remote와 구형 래퍼의 ID를 로컬 최근 대화로 오인하지 않는다.
    return { cmd: "codex resume", auto: false };
  }
  const agent = p.agent ?? p.proc?.replace(/\.exe$/i, "").toLowerCase();
  const cwd = absolute(p.cwd) ? p.cwd : undefined;
  if (agent === "claude") return { cmd: "claude --continue", auto: true, cwd };
  if (agent === "codex") return { cmd: "codex resume --last", auto: true, cwd };
  if (p.agent) return { cmd: p.agent, auto: true, cwd };
  if (p.proc && !SHELLS.has(p.proc.toLowerCase())) return { cmd: p.proc };
  return null;
}

export const asSeed = (v: unknown): Seed | null =>
  typeof v === "string" ? { cmd: v }
    : v && typeof v === "object" && "cmd" in v && typeof v.cmd === "string" ? v as Seed : null;

export function nativeSeed(v: unknown, migrate = false): Seed | null {
  const seed = asSeed(v);
  if (!seed) return null;
  if (seed.codexLaunch || seed.codex) {
    try { return codexContinue(seed.codexLaunch ?? seed.codex!, migrate || seed.auto !== false); }
    catch { return { cmd: "codex resume", auto: false, notice: "저장된 실행 정보가 잘못되어 대화를 직접 선택해야 합니다." }; }
  }
  const cwd = absolute(seed.cwd) ? seed.cwd : undefined;
  if (/^claude(?:\s+(?:--continue|-c|--resume(?:\s+[0-9a-f-]{36})?|--session-id\s+[0-9a-f-]{36}))?$/i.test(seed.cmd))
    return { cmd: "claude --continue", auto: migrate || seed.auto !== false, cwd };
  if (/^codex(?:\s+resume(?:\s+(?:--last|[0-9a-f-]{36}))?)?$/i.test(seed.cmd))
    return { cmd: "codex resume --last", auto: migrate || seed.auto !== false, cwd };
  if (/^chiispace-cli\.exe\s+codex-resume\b/.test(seed.cmd))
    return { cmd: "codex resume", auto: false, cwd };
  return seed;
}

export function continuePlan(seeds: Record<string, unknown>, roots: Record<string, string | null>, migrate = false): Record<string, Seed> {
  const out: Record<string, Seed> = {};
  const used = new Set<string>();
  for (const [id, value] of Object.entries(seeds)) {
    const seed = nativeSeed(value, migrate);
    if (!seed) continue;
    const agent = seed.codexLaunch || seed.cmd === "codex resume --last" ? "codex"
      : seed.cmd === "claude --continue" ? "claude" : null;
    const root = seed.cwd ?? roots[id] ?? "";
    const key = [agent, root].join("|").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    if (agent && seed.auto !== false) {
      // continue는 칸이 아닌 폴더 기준이다. 나머지 칸에 같은 대화를 자동으로 중복 연결하지 않는다.
      if (used.has(key)) {
        const picker = seed.codexLaunch ? codexContinue(seed.codexLaunch, true, true)
          : { ...seed, cmd: agent === "claude" ? "claude --resume" : "codex resume" };
        out[id] = { ...picker, notice: "같은 폴더의 다른 칸이 최근 대화를 이어갑니다. 이 칸에서는 대화를 선택하세요." };
        continue;
      }
      used.add(key);
    }
    out[id] = seed;
  }
  return out;
}

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
