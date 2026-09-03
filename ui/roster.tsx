/** 치이카와 로스터와 얼굴.
 *
 *  누가 어느 칸을 맡을 수 있는지, 그 얼굴을 어디서 가져오는지가 여기 모여 있다.
 *  그림을 넣고 빼는 일은 `ui/assets/faces/` 에서만 일어나므로 이 파일은 그 폴더가
 *  무엇을 담고 있든 같은 방식으로 답한다 — 그림이 늘어도 고칠 것이 없다. */
import roster from "./roster.json";

export type Member = { name: string; slug: string; school: string; header_color: string };

/** 로스터 이름표. 옆칸 아래에 "치이카와 · 대장" 으로 걸린다. */
export const rosterLabel = roster.label as string;
export const userTitle = roster.user_title as string;

export const leader = roster.leader as Member;
export const members = roster.members as Member[];

/** 로스터 전체. 이름을 되찾을 때 쓴다. */
export const roll: Member[] = [leader, ...members];
export const bySlug = new Map(roll.map((m) => [m.slug, m]));

/** `ui/assets/faces/<slug>.png` 를 넣으면 그때부터 그 얼굴이 붙는다.
 *  vite 가 빌드 때 모아 주므로 파일을 넣는 것 말고 할 일이 없다. */
export const faces = import.meta.glob("./assets/faces/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
/** `<slug>.png` 가 기본, `<slug>-work.png` 가 있으면 일하는 중에는 그걸 쓴다.
 *  APNG·GIF 를 그 이름으로 넣어도 된다 — `<img>` 가 알아서 돌린다. */
/** 그림이 들어온 사람만 칸을 맡는다.
 *
 *  스무 명을 다 세워 두면 아직 얼굴이 없는 사람이 색 동그라미로 섞여 나와,
 *  들어온 그림이 오히려 묻힌다. 그림을 더 넣으면 여기가 저절로 늘어난다.
 *  하나도 없으면 로스터 전체로 돌아간다 — 그때는 색으로라도 칸을 갈라야 한다. */
export const faceUrl = (slug?: string, state?: "work") => {
  if (!slug) return undefined;
  if (state) {
    const alt = faces[`./assets/faces/${slug}-${state}.png`];
    if (alt) return alt;
  }
  return faces[`./assets/faces/${slug}.png`];
};
/** 그 사람의 일하는 중 그림이 따로 있는지. 있으면 그림이 알아서 움직이므로
 *  우리가 통통 뛰게 만들지 않는다 — 두 움직임이 겹치면 산만하다. */
export const hasWorkFace = (slug?: string) =>
  !!slug && !!faces[`./assets/faces/${slug}-work.png`];

export const drawn = roll.filter((m) => faceUrl(m.slug));
export const cast: Member[] = drawn.length ? drawn : roll;
/** 그림이 하나라도 들어왔는가. 그때부터는 얼굴 없는 배정을 갈아 끼운다. */
export const anyFace = drawn.length > 0;

/** 그 칸을 맡은 캐릭터의 얼굴.
 *
 *  그림이 아직 없으면 그 사람의 색으로 칠한 원에 역할 기호(에이전트=별,
 *  셸=프롬프트)를 얹는다 — 그림이 들어오기 전에도 칸끼리는 구별되어야 한다. */
export function Face({ slug, agent }: { slug?: string; agent?: boolean }) {
  const url = faceUrl(slug);
  const who = slug ? bySlug.get(slug) : undefined;
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
