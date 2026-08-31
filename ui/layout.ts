/** pane 배치 트리. 모든 좌표는 0..1 비율이다 — 픽셀을 안 들고 있어야
 *  창 크기가 바뀌어도 트리를 손댈 일이 없다.
 *
 *  트리를 Rust(kasa_pty::layout)가 아니라 여기 두는 이유: 그쪽은 셀 좌표로
 *  말하고, 디바이더를 끄는 동안 초당 수십 번 왕복해야 한다. 렌더가 트리의
 *  주인인 편이 웹에서는 맞다. Rust 는 PTY 서버로만 남는다.
 *
 *  용어는 tmux 를 따른다 — "h"(Horizontal)는 좌우로 나란히 놓는 것이고
 *  그 사이 경계선은 세로다. 헷갈리기 쉬워 여기 적어 둔다.
 */

export type Dir = "h" | "v";

export type Node =
  | { kind: "leaf"; id: string }
  | { kind: "split"; dir: Dir; ratio: number; a: Node; b: Node };

export type Rect = { x: number; y: number; w: number; h: number };
export type Slot = { id: string; rect: Rect };
/** 드래그할 경계. `parent` 는 이 split 이 차지한 영역 — 마우스 위치를 ratio 로
 *  환산하려면 그 영역을 알아야 한다. */
export type Seam = { path: number[]; dir: Dir; rect: Rect; parent: Rect };

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** 한 쪽이 0 이 되면 그 pane 은 되돌릴 방법이 없어진다. */
const MIN_RATIO = 0.08;

export function leaf(id: string): Node {
  return { kind: "leaf", id };
}

export function leaves(n: Node): string[] {
  if (n.kind === "leaf") return [n.id];
  return [...leaves(n.a), ...leaves(n.b)];
}

export function rects(n: Node, r: Rect = FULL): Slot[] {
  if (n.kind === "leaf") return [{ id: n.id, rect: r }];
  const [ra, rb] = halves(n, r);
  return [...rects(n.a, ra), ...rects(n.b, rb)];
}

export function seams(n: Node, r: Rect = FULL, path: number[] = []): Seam[] {
  if (n.kind === "leaf") return [];
  const [ra, rb] = halves(n, r);
  const here: Seam =
    n.dir === "h"
      ? { path, dir: n.dir, parent: r, rect: { x: r.x + r.w * n.ratio, y: r.y, w: 0, h: r.h } }
      : { path, dir: n.dir, parent: r, rect: { x: r.x, y: r.y + r.h * n.ratio, w: r.w, h: 0 } };
  return [here, ...seams(n.a, ra, [...path, 0]), ...seams(n.b, rb, [...path, 1])];
}

function halves(n: Extract<Node, { kind: "split" }>, r: Rect): [Rect, Rect] {
  if (n.dir === "h") {
    const aw = r.w * n.ratio;
    return [
      { x: r.x, y: r.y, w: aw, h: r.h },
      { x: r.x + aw, y: r.y, w: r.w - aw, h: r.h },
    ];
  }
  const ah = r.h * n.ratio;
  return [
    { x: r.x, y: r.y, w: r.w, h: ah },
    { x: r.x, y: r.y + ah, w: r.w, h: r.h - ah },
  ];
}

export function splitLeaf(n: Node, target: string, dir: Dir, newId: string): Node {
  if (n.kind === "leaf") {
    if (n.id !== target) return n;
    return { kind: "split", dir, ratio: 0.5, a: n, b: leaf(newId) };
  }
  return { ...n, a: splitLeaf(n.a, target, dir, newId), b: splitLeaf(n.b, target, dir, newId) };
}

/** 지운 자리는 형제가 통째로 물려받는다. 마지막 하나를 지우면 null. */
export function removeLeaf(n: Node, target: string): Node | null {
  if (n.kind === "leaf") return n.id === target ? null : n;
  const a = removeLeaf(n.a, target);
  const b = removeLeaf(n.b, target);
  if (a === null) return b;
  if (b === null) return a;
  return { ...n, a, b };
}

export function setRatio(n: Node, path: number[], ratio: number): Node {
  if (n.kind === "leaf") return n;
  if (path.length === 0) {
    return { ...n, ratio: Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio)) };
  }
  const [head, ...rest] = path;
  return head === 0
    ? { ...n, a: setRatio(n.a, rest, ratio) }
    : { ...n, b: setRatio(n.b, rest, ratio) };
}

/** 두 pane 의 자리를 맞바꾼다. 배치는 그대로 두고 id 만 바꿔 끼우는 이유:
 *  React 는 slot 을 id 로 짝지으므로 그 Term 이 언마운트 없이 새 자리로
 *  옮겨간다 — 트리를 다시 엮으면 그때마다 PTY 가 죽는다. */
export function swapLeaves(n: Node, a: string, b: string): Node {
  if (n.kind === "leaf") {
    if (n.id === a) return { kind: "leaf", id: b };
    if (n.id === b) return { kind: "leaf", id: a };
    return n;
  }
  return { ...n, a: swapLeaves(n.a, a, b), b: swapLeaves(n.b, a, b) };
}

export type Side = "left" | "right" | "up" | "down" | "center";

/** `from` 을 뽑아 `target` 의 `side` 쪽에 붙인다.
 *
 *  트리를 다시 엮어도 pane 은 안 죽는다 — slot 은 배치 모양이 아니라 id 로
 *  짝지어지므로, 같은 id 가 남아 있는 한 React 는 그 Term 을 옮기기만 한다. */
export function moveLeaf(n: Node, from: string, target: string, side: Side): Node | null {
  if (from === target) return n;
  if (side === "center") return swapLeaves(n, from, target);
  const without = removeLeaf(n, from);
  if (!without) return null;
  const dir: Dir = side === "left" || side === "right" ? "h" : "v";
  return graft(without, target, dir, from, side === "left" || side === "up");
}

function graft(n: Node, target: string, dir: Dir, id: string, before: boolean): Node {
  if (n.kind === "leaf") {
    if (n.id !== target) return n;
    const added = leaf(id);
    return before
      ? { kind: "split", dir, ratio: 0.5, a: added, b: n }
      : { kind: "split", dir, ratio: 0.5, a: n, b: added };
  }
  return { ...n, a: graft(n.a, target, dir, id, before), b: graft(n.b, target, dir, id, before) };
}

/** 화면 좌표(0..1)가 어느 pane 의 어느 쪽인지. 가운데면 자리 맞바꾸기다. */
export function dropTarget(n: Node, fx: number, fy: number): { id: string; side: Side } | null {
  const hit = rects(n).find(
    (s) =>
      fx >= s.rect.x && fx < s.rect.x + s.rect.w && fy >= s.rect.y && fy < s.rect.y + s.rect.h,
  );
  if (!hit) return null;
  const dx = (fx - hit.rect.x) / hit.rect.w - 0.5;
  const dy = (fy - hit.rect.y) / hit.rect.h - 0.5;
  // 가장자리로 충분히 나가야 방향이 정해진다. 그 전에는 맞바꾸기 —
  // 조금만 움직여도 배치가 갈라지면 손이 무서워서 못 끈다.
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.25) return { id: hit.id, side: "center" };
  const side: Side =
    Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
  return { id: hit.id, side };
}

/** 드롭 힌트가 덮을 자리. */
export function dropRect(n: Node, at: { id: string; side: Side }): Rect | null {
  const s = rects(n).find((x) => x.id === at.id);
  if (!s) return null;
  const r = s.rect;
  switch (at.side) {
    case "left":
      return { ...r, w: r.w / 2 };
    case "right":
      return { ...r, x: r.x + r.w / 2, w: r.w / 2 };
    case "up":
      return { ...r, h: r.h / 2 };
    case "down":
      return { ...r, y: r.y + r.h / 2, h: r.h / 2 };
    default:
      return r;
  }
}

/** 포커스를 옮길 이웃 찾기. 중심점에서 그 방향으로 가장 가까운 pane —
 *  트리 순서로 고르면 화면상 옆에 있지 않은 pane 으로 튄다. */
export function neighbor(n: Node, from: string, dir: "left" | "right" | "up" | "down"): string | null {
  const all = rects(n);
  const me = all.find((s) => s.id === from);
  if (!me) return null;
  const cx = me.rect.x + me.rect.w / 2;
  const cy = me.rect.y + me.rect.h / 2;

  let best: { id: string; d: number } | null = null;
  for (const s of all) {
    if (s.id === from) continue;
    const sx = s.rect.x + s.rect.w / 2;
    const sy = s.rect.y + s.rect.h / 2;
    const ok =
      dir === "left" ? sx < cx : dir === "right" ? sx > cx : dir === "up" ? sy < cy : sy > cy;
    if (!ok) continue;
    // 진행 방향 거리를 주로 보되, 옆으로 벗어난 정도에 벌점을 준다.
    const along = dir === "left" || dir === "right" ? Math.abs(sx - cx) : Math.abs(sy - cy);
    const across = dir === "left" || dir === "right" ? Math.abs(sy - cy) : Math.abs(sx - cx);
    const d = along + across * 2;
    if (!best || d < best.d) best = { id: s.id, d };
  }
  return best?.id ?? null;
}
