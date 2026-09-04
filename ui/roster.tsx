/** 치이카와 로스터와 얼굴.
 *
 *  누가 어느 칸을 맡을 수 있는지, 그 얼굴을 어디서 가져오는지가 여기 모여 있다.
 *  그림을 넣고 빼는 일은 `ui/assets/faces/` 에서만 일어나므로 이 파일은 그 폴더가
 *  무엇을 담고 있든 같은 방식으로 답한다 — 그림이 늘어도 고칠 것이 없다. */
import roster from "./roster.json";
import { useSyncExternalStore } from "react";

export type Member = { name: string; slug: string; school: string; header_color: string };

/** 로스터 이름표. 옆칸 아래에 "치이카와 · 대장" 으로 걸린다. */
export const rosterLabel = roster.label as string;
export const userTitle = roster.user_title as string;

export const leader = roster.leader as Member;
export const members = roster.members as Member[];

/** 로스터 전체. 이름을 되찾을 때 쓴다. */
export const roll: Member[] = [leader, ...members];
export const bySlug = new Map(roll.map((m) => [m.slug, m]));

/** 작업용 파생 이미지를 제외해야 상체 원본 한 장만 모든 표시 위치에서 공유된다. */
export const faces = import.meta.glob(
  ["./assets/faces/*.png", "!./assets/faces/*-work.png"],
  {
    eager: true,
    query: "?url",
    import: "default",
  },
) as Record<string, string>;
/** 그림이 들어온 사람만 칸을 맡는다.
 *
 *  스무 명을 다 세워 두면 아직 얼굴이 없는 사람이 색 동그라미로 섞여 나와,
 *  들어온 그림이 오히려 묻힌다. 그림을 더 넣으면 여기가 저절로 늘어난다.
 *  하나도 없으면 로스터 전체로 돌아간다 — 그때는 색으로라도 칸을 갈라야 한다. */
export const faceUrl = (slug?: string) => {
  if (!slug) return undefined;
  return faces[`./assets/faces/${slug}.png`];
};
const DANCE_FRAMES = 4;
const DANCE_FRAME_MS = 250;
const DANCE_TILT = [0, 7, 0, -7] as const;
const danceListeners = new Set<() => void>();
let danceTimer: number | undefined;

const danceFrame = () => Math.floor(Date.now() / DANCE_FRAME_MS) % DANCE_FRAMES;

const scheduleDanceFrame = () => {
  if (!danceListeners.size) return;
  const wait = DANCE_FRAME_MS - (Date.now() % DANCE_FRAME_MS) + 1;
  danceTimer = window.setTimeout(() => {
    danceListeners.forEach((listener) => listener());
    scheduleDanceFrame();
  }, wait);
};

const subscribeDance = (listener: () => void) => {
  danceListeners.add(listener);
  if (danceListeners.size === 1) scheduleDanceFrame();
  return () => {
    danceListeners.delete(listener);
    if (!danceListeners.size && danceTimer !== undefined) {
      window.clearTimeout(danceTimer);
      danceTimer = undefined;
    }
  };
};

/** 새로 나타난 캐릭터도 현재 합동 박자에 바로 합류해야 시작 시각 대신 절대 시간을 쓴다. */
export function DanceFace({
  slug,
  className = "",
  label: alt = "",
}: {
  slug?: string;
  className?: string;
  label?: string;
}) {
  const url = faceUrl(slug);
  const frame = useSyncExternalStore(subscribeDance, danceFrame, () => 0);
  if (!url) return null;
  return (
    <img
      className={`${className} dance-face`.trim()}
      src={url}
      alt={alt}
      draggable={false}
      style={{ transform: `rotate(${DANCE_TILT[frame]}deg)` }}
    />
  );
}

export const drawn = roll.filter((m) => faceUrl(m.slug));
export const cast: Member[] = drawn.length ? drawn : roll;
/** 그림이 하나라도 들어왔는가. 그때부터는 얼굴 없는 배정을 갈아 끼운다. */
export const anyFace = drawn.length > 0;

/** 그 칸을 맡은 캐릭터의 얼굴.
 *
 *  그림이 아직 없으면 그 사람의 색으로 칠한 원에 역할 기호(에이전트=별,
 *  셸=프롬프트)를 얹는다 — 그림이 들어오기 전에도 칸끼리는 구별되어야 한다. */
export function Face({ slug, agent, dancing }: { slug?: string; agent?: boolean; dancing?: boolean }) {
  const url = faceUrl(slug);
  const who = slug ? bySlug.get(slug) : undefined;
  if (dancing && url) {
    return <DanceFace slug={slug} className="face" label={who?.name ?? ""} />;
  }
  if (url) return <img className="face" src={url} alt={who?.name ?? ""} draggable={false} />;
  return (
    <span className="face ph" style={who ? { background: who.header_color } : undefined}>
      {agent ? <AgentMark /> : <ShellMark />}
    </span>
  );
}

/** 에이전트가 도는 칸. 무엇이 특별한지 한눈에 보이도록 채운 별로 둔다. */
export function AgentMark() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M8 1.6 L9.5 6.3 L14.2 8 L9.5 9.7 L8 14.4 L6.5 9.7 L1.8 8 L6.5 6.3 Z" fill="currentColor" />
    </svg>
  );
}

/** 그냥 셸인 칸. 프롬프트 기호가 곧 그 뜻이다. */
export function ShellMark() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M3.2 4.4 L6.6 8 L3.2 11.6 M8.4 11.8 H12.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Row({ m, lead }: { m: Member; lead?: boolean }) {
  return (
    <div className={lead ? "member lead" : "member"}>
      <span className="pip" style={{ background: m.header_color }} />
      <span className="who">{m.name}</span>
      <span className="school">{m.school}</span>
    </div>
  );
}
