/** 다른 PC 로 대화 이사 — 보내는 쪽 꾸러미와 두 PC 화면에 보일 글. React·Tauri 없이 단위 검증한다(session-move.test.mjs).
 *  받는 쪽 규칙(파일 자리·덮지 않기·폴더 찾기)은 src-tauri/src/session_move.rs, 보내는 길은 MoveCard.tsx, 받는 창은 MoveOffer.tsx,
 *  칸을 끌어 놓을 곳은 MoveDock.tsx. */

export type Git = { origin?: string | null; branch?: string | null; head?: string | null; dirty: number };
/** 받은 대화가 받는 PC 에 있던 같은 대화와 어떤 사이인가(session_move.rs `Relation`). */
export type Relation = "new" | "behind" | "same" | "ahead" | "split";
export type Pack = { session: string; cwd: string; git: Git; files: { rel: string; gz: string }[]; bytes: number };
/** 받는 PC 화면에 오는 이사 하나(session_move.rs `offer` 가 내는 `remote:move-offer`). */
export type MoveOffer = {
  offer: number;
  from: string;
  session: string;
  cwd: string;
  folder: string;
  title: string;
  slug: string;
  name: string;
  git: Git;
  bytes: number;
  relation: Relation;
};
export type FolderGuess = { path: string; git: Git; remembered: boolean };
/** 이사 보낼 PC(remote.rs `PeerView`). */
export type Peer = { id: string; name: string; page: string; added: number };

/** 받는 PC 의 `session_move_offer` 에 보낼 꾸러미. 판(`v`)이 다르면 받는 PC 가 거절한다. */
export function moveOffer(pack: Pack, pane: { title?: string; slug?: string; name?: string }) {
  return {
    v: 1,
    agent: "claude",
    session: pack.session,
    cwd: pack.cwd,
    git: pack.git,
    files: pack.files,
    title: pane.title ?? "",
    slug: pane.slug ?? "",
    name: pane.name ?? "",
  };
}

export const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const short = (h?: string | null) => (h ? h.slice(0, 7) : "?");

/** 보내기 전에 알릴 것. 대화만 가고 코드는 안 간다. */
export function senderNotes(git: Git): string[] {
  const out: string[] = [];
  if (git.dirty) out.push(`커밋 안 한 변경 ${git.dirty}개는 이 PC 에만 남는다 — 대화만 간다`);
  if (!git.origin) out.push("원격이 있는 git 폴더가 아니라 받는 PC 에서 폴더를 직접 고른다");
  return out;
}

/** 받기 전에 알릴 것. `here` 는 고른 폴더의 git 상태다. */
export function receiverNotes(o: Pick<MoveOffer, "git" | "relation">, here?: Git): string[] {
  const out: string[] = [];
  if (o.relation === "behind") out.push("전에 이 PC 에서 보냈던 대화다 — 저쪽에서 이어 쓴 것으로 바꾼다");
  if (o.relation === "same") out.push("이 PC 에 같은 대화가 그대로 있다");
  if (o.relation === "ahead") out.push("이 PC 의 같은 대화가 더 길다 — 덮지 않고 이 PC 의 것을 연다");
  if (o.relation === "split") out.push("이 PC 의 같은 대화와 갈라졌다 — 이 PC 의 것은 옆에 남겨 두고 받은 것으로 바꾼다");
  if (o.git.dirty) out.push(`보낸 PC 에 커밋 안 한 변경 ${o.git.dirty}개가 있다 — 그 변경은 안 온다`);
  if (here?.head && o.git.head && here.head !== o.git.head)
    out.push(`이 폴더는 다른 커밋이다(여기 ${short(here.head)} · 보낸 PC ${short(o.git.head)}) — 필요하면 git pull`);
  if (here?.branch && o.git.branch && here.branch !== o.git.branch) out.push(`가지가 다르다(여기 ${here.branch} · 보낸 PC ${o.git.branch})`);
  return out;
}

/** 보낼 때 카드로 한 번 물을까. 커밋 안 한 코드는 안 따라가니 그때만 묻고, 아니면 끌어 놓자마자 보낸다. */
export const askBeforeSend = (git: Git) => git.dirty > 0;

/** 이 칸을 지금 이사 보낼 수 없는 까닭. 없으면 null. 일하는 중·서브에이전트가 도는 중에 옮기면 그 일이 끊기고,
 *  주고받은 말이 없으면 옮길 대화 파일이 없다. */
export function moveLock(p: { alive: boolean; busy: boolean; tasks: number; talked: boolean; moving: boolean }): string | null {
  if (p.moving) return "이사하는 중이다";
  if (!p.alive) return "claude 가 안 떠 있다";
  if (p.busy) return "일하는 중 — 답이 끝난 뒤에 옮긴다";
  if (p.tasks) return "서브에이전트가 도는 중 — 끝난 뒤에 옮긴다";
  if (!p.talked) return "아직 주고받은 말이 없다";
  return null;
}

/** 받는 PC 가 묻지 않고 받을 폴더. 같은 레포(원격 주소)의 폴더가 하나로 정해질 때만 준다 — 전에 고른 폴더가 그 레포면 그것,
 *  아니면 이 PC 의 앱이 아는 폴더 가운데 그 레포가 하나뿐일 때. 이 PC 의 같은 대화가 더 길거나 갈라졌으면 사람이 보고 정한다. */
export function autoFolder(o: Pick<MoveOffer, "git" | "relation">, guesses: FolderGuess[]): string | null {
  if (!o.git.origin || o.relation === "ahead" || o.relation === "split") return null;
  const same = guesses.filter((g) => g.git.origin === o.git.origin);
  return same.find((g) => g.remembered)?.path ?? (same.length === 1 ? same[0].path : null);
}

/** 끌어 다른 PC 에 놓을 수 있는 칸. 대화창 칸이 제 상태로 적어 두고, 놓였을 때 보내는 일도 그 칸이 한다 —
 *  끄는 쪽(useDrag)은 어느 칸이 어느 PC 에 놓였는지만 안다. */
type Movable = { lock: string | null; drop: (peer: string) => void };
const movable = new Map<string, Movable>();
export function setMovable(pane: string, m: Movable | null) {
  if (m) movable.set(pane, m);
  else movable.delete(pane);
}
export const movableOf = (pane: string) => movable.get(pane);
/** 칸이 PC 에 놓였다. 잠긴 칸이면 아무것도 안 한다(놓을 곳에 까닭이 보인다). */
export function dropMove(pane: string, peer: string) {
  const m = movable.get(pane);
  if (m && !m.lock) m.drop(peer);
}

/** 보내다 실패했을 때. 받는 PC 의 답(거절·시간 넘김)은 옮겨지지 않은 것이 확실하다. 붙은 뒤에 끊기면 받는 PC 에서 이미
 *  열렸을 수 있다 — 그때 이 칸을 그냥 살리면 같은 대화를 두 PC 에서 이어 쓰게 되므로 사람이 보고 정하게 한다. */
export function moveFailure(e: unknown, opened: boolean): { text: string; unsure: boolean } {
  const text = e instanceof Error ? e.message : String(e);
  if (opened && /PC 와 끊겼다/.test(text))
    return { text: "보내는 사이 연결이 끊겼다 — 받는 PC 에 이 대화가 열렸는지 보고 정해 줘", unsure: true };
  return { text, unsure: false };
}

/** 폰 주소의 방 이름. 같은 PC 로 이사하지 않게 견준다. */
export function roomOf(page: string): string | null {
  return /\/r\/([0-9a-f]{32})\/?$/i.exec(page.trim())?.[1]?.toLowerCase() ?? null;
}
