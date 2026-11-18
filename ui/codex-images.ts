import type { Picture } from "./images";

type CodexInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };

export function codexInput(text: string, images: readonly Picture[] = []): CodexInput[] {
  const input: CodexInput[] = text ? [{ type: "text", text, text_elements: [] }] : [];
  return input.concat(images.map(p => ({ type: "image", url: p.url })));
}

export function codexUserImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  // 다시 읽은 대화가 웹뷰에서 로컬 파일을 열거나 외부 서버를 조회하지 않도록 앱에서 보낸 형식만 그린다.
  const urls = content.flatMap(c => c?.type === "image" && typeof c.url === "string" &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[\w+/]/i.test(c.url) ? [c.url] : []);
  return urls.length ? urls : undefined;
}
