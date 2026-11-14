/** 폰 화면의 값 다루기 — React 없이 단위 검증한다(remote.test.mjs). */
import { initialStream, reduceStream, type StreamState } from "./claude-stream.ts";

/** 통로가 들고 있던 지금 상태(claude_chat.rs `snapshot`). */
export type Snapshot = { alive: boolean; busy: boolean; init?: string | null; prompts: string[] };

/** PC 가 알려 준 칸 한 줄과 그 통로의 지금 상태(remote.rs `PhonePane`). */
export type PhonePane = {
  id: string;
  title: string;
  cwd: string;
  session: string;
  slug?: string | null;
  name?: string | null;
  alive: boolean;
  busy: boolean;
  waiting: number;
};

/** 뒤늦게 붙은 화면의 상태. 지나간 줄을 PC 와 같은 해석(`reduceStream`)에 다시 태운다.
 *  지금 상태를 받는 사이에 온 줄(`queued`)은 그 뒤에 얹는다 — 그 사이에 뜬 권한 묻기를 잃지 않게. */
export function fromSnapshot(snap: Snapshot, queued: unknown[] = []): StreamState {
  let s = initialStream;
  for (const line of [snap.init, ...snap.prompts]) {
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

/** PC 의 짝지은 폰 목록에 보일 이름. 폰이 스스로 밝히는 것이라 구별용일 뿐이다. */
export function deviceName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "브라우저";
}

/** 칸 목록 한 줄의 상태 글. 답을 기다리는 것이 가장 먼저다 — 그것 때문에 폰을 연다. */
export function paneState(p: Pick<PhonePane, "alive" | "busy" | "waiting">): { text: string; tone: "wait" | "busy" | "idle" | "off" } {
  if (!p.alive) return { text: "멈춤", tone: "off" };
  if (p.waiting) return { text: p.waiting > 1 ? `허락 기다림 ${p.waiting}` : "허락 기다림", tone: "wait" };
  if (p.busy) return { text: "일하는 중", tone: "busy" };
  return { text: "쉬는 중", tone: "idle" };
}

/** 폰 한 줄에 보일 폴더. 폭이 좁아 전체 경로는 앞부분(C:\Users\...)만 보이고 정작 어느 폴더인지가 잘린다. */
export function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? "홈";
}

/** `#/p/<칸 id>` — 칸 id 는 `%3` 처럼 주소에 못 쓰는 글자가 있다. */
export const paneHash = (id: string) => `#/p/${encodeURIComponent(id)}`;
export function paneFromHash(hash: string): string | null {
  const m = /^#\/p\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
