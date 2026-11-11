/** 대화창 입력바에 붙인 그림 — claude 에 보낼 크기로 줄이고 base64 로 읽는다.
 *
 *  한도는 claude 가 터미널에서 붙인 그림에 거는 값과 같다(2.1.319 바이너리: 가로·세로 2000, 원본 3.75MB).
 *  2000 을 넘는 그림은 한 요청의 그림이 20장을 넘는 순간 API 가 요청을 통째로 거절한다. 대화가 길어지면 지난 그림까지
 *  세므로 처음 몇 장은 되다가 어느 날부터 그 대화가 막힌다. 그래서 보낼 때 미리 줄인다. */

export const MAX_SIDE = 2000;
export const MAX_BYTES = 3_932_160;
/** API 가 받는 형식. 나머지(bmp 등)는 PNG 로 다시 굽는다. */
const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type Picture = { mediaType: string; data: string; url: string };

/** 비율을 지키며 한 변이 `max` 를 넘지 않게. 이미 작으면 그대로다. */
export function fitSize(width: number, height: number, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** 원본을 그대로 보내도 되는가. 다시 구우면 화면 캡처의 작은 글자가 뭉개질 수 있어 될 수 있으면 손대지 않는다. */
export const keepsOriginal = (p: { type: string; size: number; width: number; height: number }) =>
  SENDABLE.includes(p.type) && p.size <= MAX_BYTES && p.width <= MAX_SIDE && p.height <= MAX_SIDE;

export const imageBlock = (p: Picture) => ({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } });

const dataUrl = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(r.error);
    r.readAsDataURL(b);
  });

const encode = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("그림을 다시 굽지 못했다"))), type, quality));

async function shrink(bmp: ImageBitmap): Promise<Blob> {
  let { width, height } = fitSize(bmp.width, bmp.height);
  for (let i = 0; i < 6; i++) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");
    if (!g) throw new Error("그림을 다시 굽지 못했다");
    g.drawImage(bmp, 0, 0, width, height);
    // 화면 캡처는 PNG 라야 글자가 덜 뭉개진다. 크기를 못 맞출 때만 JPEG 로 간다 — JPEG 에는 투명이 없어 흰 바탕을 깐다.
    const png = await encode(c, "image/png");
    if (png.size <= MAX_BYTES) return png;
    g.globalCompositeOperation = "destination-over";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    const jpg = await encode(c, "image/jpeg", 0.85);
    if (jpg.size <= MAX_BYTES) return jpg;
    ({ width, height } = fitSize(width, height, Math.round(Math.max(width, height) * 0.75)));
  }
  throw new Error("그림이 너무 크다");
}

/** 붙여 넣거나 고른 그림 하나를 보낼 모양으로. 그림이 아니거나 못 읽으면 던진다. */
export async function readPicture(blob: Blob): Promise<Picture> {
  const bmp = await createImageBitmap(blob);
  try {
    const out = keepsOriginal({ type: blob.type, size: blob.size, width: bmp.width, height: bmp.height }) ? blob : await shrink(bmp);
    const url = await dataUrl(out);
    return { mediaType: out.type, data: url.slice(url.indexOf(",") + 1), url };
  } finally {
    bmp.close();
  }
}
