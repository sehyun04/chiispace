/** 폰 화면의 값 다루기 — React 없이 단위 검증한다(remote.test.mjs). */
import { initialStream, reduceStream, type StreamState } from "./claude-stream.ts";

/** 통로가 들고 있던 지금 상태(claude_chat.rs `snapshot`). */
export type Snapshot = { alive: boolean; busy: boolean; init?: string | null; tasks?: string | null; prompts: string[] };

/** PC 가 알려 준 칸 한 줄과 그 통로의 지금 상태(remote.rs `PhonePane`). */
export type PhonePane = {
  id: string;
  title: string;
  cwd: string;
  session: string;
  agent?: "claude" | "codex";
  slug?: string | null;
  name?: string | null;
  alive: boolean;
  busy: boolean;
  /** 지금 도는 서브에이전트 수. 본 대화의 턴은 그보다 먼저 끝난다. */
  tasks?: number;
  waiting: number;
};

/** 뒤늦게 붙은 화면의 상태. 지나간 줄을 PC 와 같은 해석(`reduceStream`)에 다시 태운다.
 *  지금 상태를 받는 사이에 온 줄(`queued`)은 그 뒤에 얹는다 — 그 사이에 뜬 권한 묻기를 잃지 않게. */
export function fromSnapshot(snap: Snapshot, queued: unknown[] = []): StreamState {
  let s = initialStream;
  for (const line of [snap.init, snap.tasks, ...snap.prompts]) {
    if (!line) continue;
    try {
      s = reduceStream(s, JSON.parse(line));
    } catch {
      // 깨진 줄 하나로 화면 전체를 버리지 않는다.
    }
  }
  s = { ...s, busy: snap.busy };
  for (const m of queued) s = reduceStream(s, m);
  return s;
}

/** 폰이 도는 판(`own`, 시작 파일 이름)과 PC 의 판을 견준다. 다르면 새로 불러온다. 입력바에 쓰던 말·붙인 그림이 있으면(`busy`)
 *  날아가지 않게 묻고(띠), 이 판으로 이미 한 번 새로 불러왔는데도 그대로면(`tried`) 다시 돌지 않게 묻는다. 개발 판처럼 이름을 모르면 두지 않는다. */
export function updateAction(own: string | null, pc: string | undefined, busy: boolean, tried: string | null): "none" | "reload" | "ask" {
  const name = (s: string) => s.split("/").pop() ?? s;
  if (!own || !pc || !/^mobile-[\w-]+\.js$/.test(name(own))) return "none";
  if (name(own) === name(pc)) return "none";
  return busy || tried === name(pc) ? "ask" : "reload";
}

/** PC 의 짝지은 폰 목록에 보일 이름. 폰이 스스로 밝히는 것이라 구별용일 뿐이다. */
export function deviceName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "브라우저";
}

/** 칸 목록 한 줄의 상태 글. 답을 기다리는 것이 가장 먼저다 — 그것 때문에 폰을 연다. 본 대화의 턴이 끝났어도 서브에이전트가
 *  돌고 있으면 일하는 중이다(PC 에서는 옆 서브에이전트 칸이 일하는 것이 보인다). */
export function paneState(p: Pick<PhonePane, "alive" | "busy" | "waiting" | "tasks">): { text: string; tone: "wait" | "busy" | "idle" | "off" } {
  if (!p.alive) return { text: "멈춤", tone: "off" };
  if (p.waiting) return { text: p.waiting > 1 ? `허락 기다림 ${p.waiting}` : "허락 기다림", tone: "wait" };
  if (p.busy || p.tasks) return { text: "일하는 중", tone: "busy" };
  return { text: "쉬는 중", tone: "idle" };
}

/** 폰 한 줄에 보일 폴더. 폭이 좁아 전체 경로는 앞부분(C:\Users\...)만 보이고 정작 어느 폴더인지가 잘린다. */
export function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? "홈";
}

/** `#/p/<칸 id>`, 묶인 다른 PC 의 칸이면 `#/pc/<방>/p/<칸 id>` — 칸 id 는 `%3` 처럼 주소에 못 쓰는 글자가 있고, PC 마다 겹친다. */
export const paneHash = (id: string, room?: string | null) => `${room ? `#/pc/${room}` : "#"}/p/${encodeURIComponent(id)}`;
export function paneFromHash(hash: string): string | null {
  const m = /^#(?:\/pc\/[0-9a-f]{32})?\/p\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
/** 주소가 가리키는 묶인 PC 의 방. 없으면 이 페이지를 내준 PC 다. */
export function roomFromHash(hash: string): string | null {
  return /^#\/pc\/([0-9a-f]{32})\//.exec(hash)?.[1] ?? null;
}

/** 폰 칸 목록의 PC 머리글에 붙는 상태. */
export function pcLabel(status: string): string {
  return status === "open" ? "켜짐" : status === "pc-offline" ? "꺼져 있다" : status === "retrying" ? "다시 잇는 중" : "잇는 중";
}
