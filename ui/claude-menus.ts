/** Claude 대화창의 `/memory`·`/export`·`/copy` — `claude -p` 가 받지 않는 TUI 명령의 값 다루기. React 없이 단위 검증한다.
 *
 *  2.1.323 에서 `/memory`·`/export` 는 "isn't available in this environment" 로 끝나고 `/copy` 는 목록에도 없다.
 *  `/mcp`·`/context`·`/usage` 는 claude 가 받아 글로 답하므로 앱이 만들지 않는다. */
import { shortToolName, toolSummary } from "./tools.ts";
import type { Item } from "./transcript.ts";
import type { PaletteChoice } from "./palette.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

const KINDS: Record<string, string> = {
  User: "사용자",
  Project: "프로젝트",
  Local: "이 컴퓨터만",
  AutoMem: "자동 메모리",
  Managed: "관리",
  Enterprise: "관리",
};
const base = (p: string) => p.split(/[\\/]/).pop() || p;

/** `get_context_usage` 답의 `memoryFiles` — claude 가 이 대화에 실제로 불러온 메모리 파일. 앱이 경로를 짐작하지 않는다. */
export function memoryChoices(body: unknown): PaletteChoice[] {
  const files = obj(body).memoryFiles;
  const seen = new Set<string>();
  return (Array.isArray(files) ? files : []).map(obj).flatMap((f) => {
    const path = typeof f.path === "string" ? f.path : "";
    if (!path || seen.has(path)) return [];
    seen.add(path);
    const kind = typeof f.type === "string" ? (KINDS[f.type] ?? f.type) : "메모리";
    return [{ value: path, label: `${kind} · ${base(path)}`, hint: path }];
  });
}

/** 마지막 답. 도구를 부르기 전의 짧은 말이 아니라 맨 끝 말풍선이다 — TUI 의 `/copy` 도 그렇다. */
export function lastAnswer(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "bubble" && it.role === "assistant" && it.text.trim()) return it.text;
  }
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 내보낼 파일 이름 — 날짜·시각과 칸 이름. Windows 가 받지 않는 글자를 지운다(claude_menus.rs 가 한 번 더 본다). */
export function exportName(title: string | undefined, now = new Date()): string {
  const words = (title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "");
  const name = Array.from(words).slice(0, 40).join("").trim() || "claude 대화";
  return `${stamp(now)}-${pad(now.getHours())}${pad(now.getMinutes())}-${name}.md`;
}

/** 대화를 마크다운으로. 말풍선은 누가 했는지 제목으로 가르고, 도구·명령은 한 줄씩 남긴다. 생각·시스템 알림은 뺀다. */
export function exportMarkdown(items: Item[], meta: { title?: string; session?: string; folder?: string; now?: Date }): string {
  const now = meta.now ?? new Date();
  const out: string[] = [`# ${meta.title?.trim() || "claude 대화"}`, ""];
  out.push([meta.folder, meta.session && `대화 ${meta.session}`, `${stamp(now)} ${pad(now.getHours())}:${pad(now.getMinutes())} 내보냄`].filter(Boolean).join(" · "), "");
  let who: "me" | "claude" | null = null;
  // 도구·질문 줄은 빈 줄 없이 이어 한 목록으로 읽히게 하고, 다른 덩어리가 오면 그 앞에서 끊는다.
  let list = false;
  const block = (...lines: string[]) => {
    if (list) out.push("");
    list = false;
    out.push(...lines, "");
  };
  const line = (l: string) => {
    out.push(l);
    list = true;
  };
  const speak = (w: "me" | "claude") => {
    if (who === w) return;
    who = w;
    block(w === "me" ? "## 나" : "## Claude");
  };
  for (const it of items) {
    switch (it.kind) {
      case "bubble": {
        speak(it.role === "user" ? "me" : "claude");
        if (it.text.trim()) block(it.text.trim());
        if (it.images?.length) block(`(그림 ${it.images.length}장)`);
        break;
      }
      case "command":
        speak("me");
        // 대화 파일의 명령 이름에는 빗금이 이미 붙어 있다(`/model`).
        block(`\`${it.name.startsWith("/") ? "" : "/"}${it.name}${it.args ? ` ${it.args}` : ""}\``);
        break;
      case "local-command":
        block("```", it.stdout.trim(), "```");
        break;
      case "tool":
        speak("claude");
        line(`- ${shortToolName(it.toolUse.name)}: ${toolSummary(it.toolUse.name, it.toolUse.input)}`);
        break;
      case "launch":
        speak("claude");
        line(`- 서브에이전트: ${it.description ?? it.agentType ?? ""}`.trimEnd());
        break;
      case "qa":
        // 묻는 쪽은 Claude 다. 답은 화살표 뒤에 둔다.
        speak("claude");
        for (const { q, a } of it.qa) line(`- 질문: ${q} → ${a}`);
        break;
      case "interrupted":
        block("_(여기서 중단했다)_");
        break;
    }
  }
  return out.join("\n").trimEnd() + "\n";
}
