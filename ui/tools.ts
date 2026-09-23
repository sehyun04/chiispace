/** 도구 호출을 한 줄로 줄이는 규칙.
 *
 *  대화에서 도구 호출은 말보다 몇 배 많다 — 실제 대화 하나를 세어 보니 말풍선
 *  326 개에 도구 1095 개였다. 전부 펼쳐 두면 사람이 한 말이 그 사이에 묻히므로
 *  접어 두고 한 줄만 보인다. 그 한 줄이 무엇을 말하느냐가 여기다.
 *
 *  화면을 안 그리므로 브라우저 없이 그대로 돌려 볼 수 있다. */

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** 경로는 뒤가 중요하다. 앞을 줄여도 어느 파일인지는 남는다. */
export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return parts.join("/");
  return "…/" + parts.slice(-keep).join("/");
}

/** MCP 도구 이름은 `mcp__서버__도구` 로 온다. 그대로 두면 한 줄을 다 먹는다.
 *
 *  서버 이름은 버린다. 플러그인을 거치면 그 자리가
 *  `plugin_playwright_playwright` 처럼 같은 말의 반복이 되고, 도구 이름
 *  (`browser_click`) 만으로 이미 무엇인지 알 수 있다. 전체 이름은 카드를
 *  펼치면 나온다. */
export function shortToolName(name?: string): string {
  if (!name) return "도구";
  return name.match(/^mcp__.+?__(.+)$/)?.[1] ?? name;
}

/** 접힌 카드에 보일 한 줄. 무엇을 한 호출인지 이것만으로 알아야 한다. */
export function toolSummary(name: string | undefined, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const cmd = str(o.command);
      if (!cmd) return "명령";
      // `cd <긴 경로> && 진짜 명령` 이 아주 흔한데, 그 경로가 한 줄을 다 먹어
      // 정작 무엇을 하는 명령인지가 잘려 나간다. 앞의 이동만 줄인다.
      const moved = cmd.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*([\s\S]+)$/);
      const body = moved ? `${shortPath(moved[1].replace(/^["']|["']$/g, ""), 1)} › ${moved[2]}` : cmd;
      return body.replace(/\s*\n\s*/g, " ⏎ ");
    }
    case "Read": {
      const p = str(o.file_path);
      if (!p) return "읽기";
      const from = typeof o.offset === "number" ? o.offset : undefined;
      const n = typeof o.limit === "number" ? o.limit : undefined;
      return from != null || n != null ? `${shortPath(p)} (${from ?? 0}부터 ${n ?? "끝"})` : shortPath(p);
    }
    case "Write":
      return str(o.file_path) ? shortPath(str(o.file_path)!) : "쓰기";
    case "Edit": {
      const p = str(o.file_path);
      const all = o.replace_all === true;
      return p ? `${shortPath(p)}${all ? " (전부)" : ""}` : "고치기";
    }
    case "NotebookEdit":
      return str(o.notebook_path) ? shortPath(str(o.notebook_path)!) : "노트북";
    case "Grep": {
      const pat = str(o.pattern) ?? "";
      const where = str(o.path) ?? str(o.glob);
      return where ? `${pat}  ·  ${shortPath(where, 1)}` : pat || "찾기";
    }
    case "Glob":
      return str(o.pattern) ?? "파일 찾기";
    case "TodoWrite": {
      const todos = Array.isArray(o.todos) ? o.todos : [];
      const done = todos.filter((t) => (t as { status?: string })?.status === "completed").length;
      const doing = todos.find((t) => (t as { status?: string })?.status === "in_progress") as
        | { content?: string; activeForm?: string }
        | undefined;
      const now = doing?.activeForm ?? doing?.content;
      return now ? `${now} (${done}/${todos.length})` : `할 일 ${done}/${todos.length}`;
    }
    case "WebFetch":
      return str(o.url) ?? "가져오기";
    case "WebSearch":
      return str(o.query) ?? "검색";
    case "Skill":
      return str(o.skill) ?? "스킬";
    case "SlashCommand":
      return str(o.command) ?? "명령";
    default: {
      // 모르는 도구는 가장 말이 되는 값을 찾아 쓴다. 빈 줄보다는 무엇이든 낫다.
      for (const k of ["command", "query", "url", "pattern", "file_path", "path", "prompt", "description", "name"]) {
        const v = str(o[k]);
        if (v) return k.endsWith("path") ? shortPath(v) : v;
      }
      const keys = Object.keys(o);
      return keys.length ? keys.join(", ") : "";
    }
  }
}

export type ToolStat = { label: string; bad?: boolean };

/** 카드 머리에 붙는 작은 표시. 구조화된 결과가 있을 때만 나온다. */
export function toolStats(name: string | undefined, toolUseResult: unknown): ToolStat[] {
  if (!toolUseResult || typeof toolUseResult !== "object") return [];
  const r = toolUseResult as Record<string, unknown>;
  const out: ToolStat[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);

  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
    let plus = 0;
    let minus = 0;
    for (const h of patch) {
      const lines = (h as { lines?: unknown })?.lines;
      if (!Array.isArray(lines)) continue;
      for (const l of lines) {
        if (typeof l !== "string") continue;
        if (l.startsWith("+")) plus++;
        else if (l.startsWith("-")) minus++;
      }
    }
    if (plus) out.push({ label: `+${plus}` });
    if (minus) out.push({ label: `−${minus}` });
  }

  const code = num(r.exitCode) ?? num(r.exit_code);
  if (code != null && code !== 0) out.push({ label: `끝 코드 ${code}`, bad: true });

  const lines = num(r.numLines) ?? num(r.numberOfLines);
  if (lines != null) out.push({ label: `${lines}줄` });

  const files = num(r.numFiles);
  if (files != null) out.push({ label: `파일 ${files}개` });

  if (r.interrupted === true) out.push({ label: "중단됨", bad: true });
  return out;
}

/** Edit 의 구조화된 결과에서 바뀐 줄만. 줄 번호가 실제 파일 것이라 어림이 아니다. */
export type DiffLine = { sign: " " | "+" | "-"; text: string; n?: number };

export function diffLines(toolUseResult: unknown, limit = 60): DiffLine[] {
  if (!toolUseResult || typeof toolUseResult !== "object") return [];
  const patch = (toolUseResult as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(patch)) return [];
  const out: DiffLine[] = [];
  for (const h of patch) {
    const hunk = h as { newStart?: number; lines?: unknown };
    if (!Array.isArray(hunk.lines)) continue;
    let n = typeof hunk.newStart === "number" ? hunk.newStart : undefined;
    for (const raw of hunk.lines) {
      if (typeof raw !== "string") continue;
      if (out.length >= limit) return out;
      const sign = raw[0] === "+" ? "+" : raw[0] === "-" ? "-" : " ";
      out.push({ sign, text: raw.slice(1), n: sign === "-" ? undefined : n });
      // 지운 줄은 새 파일에 없으므로 번호가 늘지 않는다.
      if (n != null && sign !== "-") n++;
    }
  }
  return out;
}
