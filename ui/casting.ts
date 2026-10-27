/** 새 칸에 붙일 사람 고르기. React·그림 없이 이름(slug)만 다뤄 단위 검증한다(`casting.test.mjs`). */

/** 배정이 없는 칸(`need`)에 `pool` 의 사람을 하나씩 붙인다.
 *
 *  떠 있는 칸이 맡은 사람은 피한다. 닫힌 칸의 배정은 지우지 않지만(같은 칸이 되살아날 때 얼굴이 바뀌면 낯설다)
 *  "쓰는 중"으로 세지도 않는다 — 셌더니 열두 명이 한 번씩 다 나온 뒤로는 순번으로 돌아 떠 있는 칸과 겹쳤다.
 *  아직 한 번도 안 나온 사람을 먼저 쓰고, 떠 있는 칸이 `pool` 보다 많을 때만 겹친다. */
export function assign(
  casting: Record<string, string>,
  live: string[],
  need: string[],
  pool: string[],
): Record<string, string> {
  if (!pool.length || !need.length) return casting;
  const next = { ...casting };
  const taken = new Set(live.filter((id) => !need.includes(id) && next[id]).map((id) => next[id]));
  const seen = new Set(Object.values(casting));
  for (const id of need) {
    const slug =
      pool.find((s) => !taken.has(s) && !seen.has(s)) ??
      pool.find((s) => !taken.has(s)) ??
      pool[taken.size % pool.length];
    next[id] = slug;
    taken.add(slug);
    seen.add(slug);
  }
  return next;
}
