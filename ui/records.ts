/** 칸 id 로 묶은 기록에서 한 칸을 뺀다. 없으면 같은 객체를 돌려줘 다시 그리지 않게 한다. */
export function without<T>(m: Record<string, T>, id: string): Record<string, T> {
  if (!(id in m)) return m;
  const next = { ...m };
  delete next[id];
  return next;
}
