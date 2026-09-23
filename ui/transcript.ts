/** 대화 원문(jsonl)을 말풍선이 그릴 것으로 평탄화한다.
 *
 *  claude 는 `~/.claude/projects/<폴더>/<대화 id>.jsonl` 에 한 줄에 한 레코드씩
 *  쌓는다. 그 줄들은 **메시지 경계를 이미 갖고 있다** — 터미널 화면을 뜯어
 *  경계를 만들어 내던 일(`tailBlock`)이 여기서는 필요가 없다.
 *
 *  화면을 그리는 코드가 아니므로 React 를 부르지 않는다. 그래야 이 판정들을
 *  브라우저 없이 그대로 돌려 볼 수 있다.
 *
 *  판정 대부분은 kasaterm 의 아로나 모드에서 왔다. 거기서 값을 치르고 알아낸
 *  것들이라 옮기면서 줄이지 않았다 — 어느 줄이 사람이 한 말이고 어느 줄이
 *  시스템이 끼워 넣은 것인지는 눈으로 봐서는 갈라지지 않는다. */

// ── 원문의 모양 ──────────────────────────────────────────────────

export type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
  [k: string]: unknown;
};

export type SessionEvent = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: Record<string, unknown>;
  };
  toolUseResult?: unknown;
  sourceToolUseID?: string;
  operation?: string;
  content?: unknown;
  attachment?: {
    type?: string;
    toolUseID?: string;
    prompt?: unknown[];
    stdout?: string;
  };
  [k: string]: unknown;
};

/** 한 줄이 깨져 있어도 나머지는 읽는다. 대화 끝을 자른 파일이 늘 그렇다. */
export function parseJsonl(text: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionEvent);
    } catch {
      // 반 토막 줄은 버린다
    }
  }
  return out;
}

// ── 도구 호출과 그 결과 짝짓기 ───────────────────────────────────

export type ToolPair = {
  toolUse: { id?: string; name?: string; input?: unknown } | null;
  toolResult: { content?: unknown; is_error?: boolean } | null;
  /** 구조화된 결과. Edit 의 structuredPatch 처럼 줄 번호가 든 것이 여기 온다. */
  toolUseResult: unknown;
};
export type ToolMap = Map<string, ToolPair>;

/** 호출과 결과는 다른 레코드에 있다. `tool_use_id` 로 묶어야 한 장의 카드가 된다. */
export function buildToolMap(events: SessionEvent[]): ToolMap {
  const map: ToolMap = new Map();
  const ensure = (id: string) => {
    let e = map.get(id);
    if (!e) {
      e = { toolUse: null, toolResult: null, toolUseResult: null };
      map.set(id, e);
    }
    return e;
  };
  for (const ev of events) {
    if (ev.type !== "assistant" && ev.type !== "user") continue;
    const content = ev.message?.content;
    let lastResultId: string | undefined;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_use" && b.id) {
          ensure(b.id).toolUse = { id: b.id, name: b.name, input: b.input };
        } else if (b.type === "tool_result" && b.tool_use_id) {
          ensure(b.tool_use_id).toolResult = { content: b.content, is_error: b.is_error };
          lastResultId = b.tool_use_id;
        }
      }
    }
    // 구조화된 결과는 블록이 아니라 user 레코드의 맨 위에 붙어 온다.
    if (ev.type === "user") {
      const id = ev.sourceToolUseID || lastResultId;
      if (ev.toolUseResult != null && id) ensure(id).toolUseResult = ev.toolUseResult;
    }
  }
  return map;
}

// ── 사람이 한 말만 남기기 ────────────────────────────────────────

/** 시스템이 user 턴에 끼워 넣는 블록들.
 *
 *  이것들을 지우지 않으면 서브에이전트 알림·훅 출력·`/compact` 요약이 전부
 *  사용자가 직접 친 말인 것처럼 내 말풍선으로 나온다. 위임 알림
 *  (`<task-notification>`) 이 그래서 여기 있다 — 칸 이름을 덮어쓰던 그 쪽지다. */
const META_BLOCKS: [string, string][] = [
  ["<system-reminder>", "</system-reminder>"],
  ["<command-message>", "</command-message>"],
  ["<command-name>", "</command-name>"],
  ["<command-args>", "</command-args>"],
  ["<local-command-stdout>", "</local-command-stdout>"],
  ["<task-notification>", "</task-notification>"],
  ["<local-command-caveat>", "</local-command-caveat>"],
];

export function stripMeta(text: string): string {
  let s = text;
  for (const [open, close] of META_BLOCKS) {
    for (;;) {
      const start = s.indexOf(open);
      if (start < 0) break;
      const end = s.indexOf(close, start + open.length);
      // 닫는 태그가 없으면 래퍼가 잘린 것이다. 그 뒤는 믿을 수 없으니 버린다.
      if (end < 0) {
        s = s.slice(0, start);
        break;
      }
      s = s.slice(0, start) + s.slice(end + close.length);
    }
  }
  // 이미지 자리 표시는 지운다. 진짜 그림은 image 블록으로 따로 온다.
  s = s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("[Image: source:") ||
        t.startsWith("[Image: original ") ||
        (t.startsWith("[Image #") && t.endsWith("]"))
      );
    })
    .join("\n");
  return s.trim();
}

/** 메타 블록을 벗기고도 남는 시스템 문구.
 *
 *  `/compact` 뒤에 오는 이어가기 요약은 user 턴인데 메타 표시가 없다. 걸러내지
 *  않으면 그 긴 요약이 통째로 사용자가 보낸 말로 뜬다. */
export function isSystemInjection(text: string): boolean {
  return /\[Request interrupted|^\s*##\s*Context Usage|^\s*Caveat:\s|^\s*This session is being continued from a previous conversation/i.test(
    text,
  );
}

export type SlashCommand =
  | { kind: "command"; name: string; args?: string; message?: string }
  | { kind: "local-command"; stdout: string };

/** `/rename` 같은 슬래시 명령은 태그로 와서 본문과 섞인다. 카드로 승격한다. */
export function parseSlashCommand(content: string): SlashCommand | null {
  const tag = (name: string) => {
    const m = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1] : undefined;
  };
  const name = tag("command-name");
  if (name !== undefined) {
    return { kind: "command", name: name.trim(), args: tag("command-args"), message: tag("command-message") };
  }
  const stdout = tag("local-command-stdout");
  if (stdout !== undefined) return { kind: "local-command", stdout };
  return null;
}

/** 시스템 레코드 중 사람에게 보일 값이 있는 것만 한 덩이 글로. */
function flattenSystem(ev: SessionEvent): string | null {
  const e = ev as {
    subtype?: string;
    error?: { status?: number; requestID?: string | null; error?: { message?: string; error?: { message?: string } } };
    retryAttempt?: number;
    maxRetries?: number;
    retryInMs?: number;
    compactMetadata?: { trigger?: string; preTokens?: number };
  };
  const lines: string[] = [];
  if (e.subtype === "api_error") {
    if (e.error?.status !== undefined) lines.push(`상태: ${e.error.status}`);
    if (e.error?.requestID) lines.push(`요청 ID: ${e.error.requestID}`);
    const msg =
      e.error?.error?.error?.message ??
      e.error?.error?.message ??
      (e.error?.error ? JSON.stringify(e.error.error, null, 2) : null);
    if (msg) lines.push(`오류: ${msg}`);
    if (e.retryAttempt !== undefined) lines.push(`재시도: ${e.retryAttempt}/${e.maxRetries}`);
    if (e.retryInMs !== undefined) lines.push(`재시도까지: ${(e.retryInMs / 1000).toFixed(2)}초`);
  } else if (e.subtype === "compact_boundary") {
    if (e.compactMetadata?.trigger) lines.push(`줄인 이유: ${e.compactMetadata.trigger}`);
    if (e.compactMetadata?.preTokens !== undefined) lines.push(`줄이기 전 토큰: ${e.compactMetadata.preTokens}`);
  } else {
    return null;
  }
  return lines.length ? lines.join("\n") : null;
}

/** AskUserQuestion 의 결과에서 질문과 고른 답을 짝지어 꺼낸다.
 *
 *  질문에 따옴표가 들어 있으면 단순한 쌍 정규식이 깨져 직접 쓴 답이 통째로
 *  사라진다. 질문 문구는 호출 입력에 정확히 있으므로 그것을 닻으로 삼는다. */
function answeredPairs(content: unknown, questions: string[]): Map<string, string> {
  const m = new Map<string, string>();
  const s =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((x) => (x as { text?: string })?.text ?? "").join("")
        : "";
  for (const q of questions) {
    const key = `"${q}"="`;
    const i = s.indexOf(key);
    if (i < 0) continue;
    const start = i + key.length;
    const end = s.indexOf('"', start);
    m.set(q, (end >= 0 ? s.slice(start, end) : s.slice(start)).trim());
  }
  if (m.size) return m;
  const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s))) m.set(mm[1], mm[2]);
  return m;
}

// ── 말풍선이 그릴 것 ─────────────────────────────────────────────

export type Bubble = {
  kind: "bubble";
  role: string;
  text: string;
  uuid?: string;
  ts?: string;
  images?: string[];
  /** 작업 중 보낸 예약 메시지가 아직 처리되지 않았다. */
  queued?: boolean;
};

export type Item =
  | Bubble
  | { kind: "tool"; toolUse: { id?: string; name?: string; input?: unknown }; pair?: ToolPair }
  | { kind: "thinking"; text: string }
  | { kind: "command"; name: string; args?: string; message?: string }
  | { kind: "local-command"; stdout: string }
  | { kind: "qa"; qa: { q: string; a: string }[] }
  /** 아직 답하지 않은 질문. 고르는 화면은 터미널에만 있다. */
  | { kind: "ask"; questions: string[] }
  | { kind: "launch"; agentType?: string; description?: string }
  | { kind: "system"; text: string }
  | { kind: "interrupted" };

function pushUserText(items: Item[], text: string, ts?: string, uuid?: string): void {
  const parsed = parseSlashCommand(text);
  if (parsed?.kind === "command") {
    items.push({ kind: "command", name: parsed.name, args: parsed.args, message: parsed.message });
    return;
  }
  if (parsed?.kind === "local-command") {
    if (parsed.stdout.trim()) items.push({ kind: "local-command", stdout: parsed.stdout });
    return;
  }
  const clean = stripMeta(text);
  if (clean && !isSystemInjection(clean)) items.push({ kind: "bubble", role: "user", text: clean, ts, uuid });
}

/** 원문 레코드들을 말풍선 · 도구 카드 · 시스템 카드의 한 줄기로 편다.
 *
 *  `keepSidechain` 은 서브에이전트만 따로 볼 때 쓴다. 그 대화는 레코드가 전부
 *  사이드체인이라 기본 규칙대로 걸러내면 화면이 통째로 빈다. */
export function toItems(events: SessionEvent[], toolMap: ToolMap, keepSidechain = false): Item[] {
  const items: Item[] = [];
  // 예약 메시지는 깨끗한 user 턴으로 안 남고 큐 조작으로만 기록된다. 넣은 것을
  // 본문에 띄우고, 꺼내 간 것은 정식 턴으로 다시 오므로 마지막에 뺀다.
  const pendingQ: (Bubble | null)[] = [];
  const dropped = new Set<Item>();
  let pendingImages: string[] = [];

  // 어떤 레코드도 부모로 가리키지 않는 발화는 프롬프트에 들어가지 못한 것일 수
  // 있다. 그 판정에 쓸 참조 집합.
  const referenced = new Set<string>();
  for (const ev of events) {
    if (ev.parentUuid) referenced.add(ev.parentUuid);
    if (ev.logicalParentUuid) referenced.add(ev.logicalParentUuid);
  }

  for (const ev of events) {
    if (!keepSidechain && ev.isSidechain) continue;

    if (ev.type === "system") {
      const text = flattenSystem(ev);
      if (text) items.push({ kind: "system", text });
      continue;
    }

    if (ev.type === "queue-operation") {
      const op = ev.operation;
      if (op === "enqueue") {
        const raw = typeof ev.content === "string" ? ev.content : "";
        const clean = stripMeta(raw);
        if (clean && !isSystemInjection(clean)) {
          const b: Bubble = { kind: "bubble", role: "user", text: clean, ts: ev.timestamp, queued: true };
          if (pendingImages.length) {
            b.images = pendingImages;
            pendingImages = [];
          }
          items.push(b);
          pendingQ.push(b);
        } else if (pendingImages.length) {
          const b: Bubble = {
            kind: "bubble",
            role: "user",
            text: "",
            ts: ev.timestamp,
            images: pendingImages,
            queued: true,
          };
          pendingImages = [];
          items.push(b);
          pendingQ.push(b);
        } else {
          // 띄울 것이 없어도 자리는 채운다. 그래야 뒤의 조작이 맞는 것을 가리킨다.
          pendingQ.push(null);
        }
      } else if (op === "dequeue" || op === "popAll") {
        const n = op === "popAll" ? pendingQ.length : 1;
        for (let i = 0; i < n; i++) {
          const d = pendingQ.shift();
          if (d) dropped.add(d);
        }
      } else if (op === "remove") {
        // 큐에서는 빠지지만 정식 턴으로 다시 오지는 않는다. 본문에 남기고 표시만 푼다.
        const d = pendingQ.shift();
        if (d) d.queued = false;
      }
      continue;
    }

    if (ev.type === "attachment") {
      const att = ev.attachment;
      if (att?.type === "queued_command" && Array.isArray(att.prompt)) {
        const urls: string[] = [];
        for (const b of att.prompt) {
          const blk = b as ContentBlock;
          const src = blk?.source;
          if (blk?.type === "image" && src?.type === "base64" && src.data) {
            urls.push(`data:${src.media_type || "image/png"};base64,${src.data}`);
          }
        }
        if (urls.length) {
          // 같은 예약의 글보다 그림이 먼저 오는 쪽이 흔하다. 따로 띄우면 시각이
          // 갈라져 보낼 때 자리가 튄다. 뒤에 올 글에 합친다.
          const prev = [...items]
            .reverse()
            .find((it) => it.kind === "bubble" && it.queued && !it.images) as Bubble | undefined;
          if (prev) prev.images = urls;
          else pendingImages = urls;
        }
      } else if (att?.type === "hook_success" && att.stdout) {
        try {
          const j = JSON.parse(att.stdout.trim()) as { systemMessage?: unknown };
          if (typeof j.systemMessage === "string" && j.systemMessage.trim()) {
            items.push({ kind: "system", text: j.systemMessage.trim() });
          }
        } catch {
          // 훅이 그냥 글을 뱉은 것은 카드로 띄우지 않는다. 그런 것이 너무 많다.
        }
      }
      continue;
    }

    if (ev.type !== "user" && ev.type !== "assistant") continue;
    const role = ev.type;
    const uuid = ev.uuid;
    const ts = ev.timestamp;
    const content = ev.message?.content;

    // 중단 표시는 그 자리에 마커로 남긴다. 바로 앞 프롬프트는 이미 보내진
    // 것이라 취소가 아니다 — 지우면 사용자가 친 말이 없어진다.
    if (role === "user") {
      const flat =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b) => (b && typeof b === "object" ? String(b.text ?? "") : "")).join(" ")
            : "";
      if (/^\s*\[Request interrupted by user/.test(flat)) {
        if (items[items.length - 1]?.kind !== "interrupted") items.push({ kind: "interrupted" });
        continue;
      }
    }

    if (typeof content === "string") {
      if (role === "user") pushUserText(items, content, ts, uuid);
      else if (content.trim()) items.push({ kind: "bubble", role, text: content, uuid, ts });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (!b || typeof b !== "object") continue;

      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (role === "user") pushUserText(items, b.text, ts, uuid);
        else items.push({ kind: "bubble", role, text: b.text, uuid, ts });
      } else if (b.type === "image" && role === "user") {
        const src = b.source;
        if (src?.type === "base64" && src.data) {
          const url = `data:${src.media_type || "image/png"};base64,${src.data}`;
          const last = items[items.length - 1];
          if (last && last.kind === "bubble" && last.role === "user" && last.ts === ts) {
            (last.images ??= []).push(url);
          } else {
            items.push({ kind: "bubble", role: "user", text: "", ts, images: [url] });
          }
        }
      } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        items.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        // 답한 것은 문답 카드로. 아직 고르는 중인 것은 터미널로 보내는 카드가 된다 —
        // 선택지 화면은 claude 의 TUI 에만 있어서 여기서는 고를 수 없다.
        const pair = b.id ? toolMap.get(b.id) : undefined;
        const answered = pair?.toolResult?.content;
        const raw = (b.input as { questions?: unknown })?.questions;
        const qs = Array.isArray(raw) ? (raw as { question?: string; header?: string }[]) : [];
        if (answered == null) {
          items.push({ kind: "ask", questions: qs.map((q) => q.question ?? q.header ?? "질문") });
        } else {
          const ans = answeredPairs(
            answered,
            qs.map((q) => q.question ?? q.header ?? "").filter(Boolean),
          );
          const qa = qs.map((q) => ({
            q: q.question ?? q.header ?? "질문",
            a: ans.get(q.question ?? "") ?? ans.get(q.header ?? "") ?? "—",
          }));
          if (qa.length) items.push({ kind: "qa", qa });
        }
      } else if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        // 서브에이전트를 부른 것은 한 줄 표시로 둔다. 그 안의 대화는 따로 본다.
        const inp = b.input as { subagent_type?: string; description?: string };
        items.push({ kind: "launch", agentType: inp?.subagent_type, description: inp?.description });
      } else if (b.type === "tool_use") {
        items.push({ kind: "tool", toolUse: { id: b.id, name: b.name, input: b.input }, pair: b.id ? toolMap.get(b.id) : undefined });
      }
    }
  }

  // 보내자마자 물린 발화 지우기.
  //
  // 아무도 부모로 가리키지 않는다는 것만으로 지우면 빠르게 두 번 친 말이나
  // 알림이 체인을 가로챈 정상 발화까지 사라진다. 바로 다음 발화가 이 글로
  // 시작할 때 — 즉 지우고 다시 친 모양일 때만 지운다.
  if (!keepSidechain) {
    const userIdx: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "bubble" && it.role === "user") userIdx.push(i);
    }
    for (let k = 0; k < userIdx.length - 1; k++) {
      const it = items[userIdx[k]] as Bubble;
      if (!it.uuid || referenced.has(it.uuid)) continue;
      const next = items[userIdx[k + 1]] as Bubble;
      if (it.text.trim() && next.text.startsWith(it.text.trim())) dropped.add(it);
    }
  }

  // 답 없는 질문은 맨 끝에 있을 때만 "지금 고르는 중"이다. 그 뒤로 대화가 이어졌다면
  // 중단되어 버려진 질문이라, 남겨 두면 끝난 일을 고르라고 계속 조른다.
  let lastReal = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind !== "system" && !dropped.has(items[i])) {
      lastReal = i;
      break;
    }
  }
  items.forEach((it, i) => {
    if (it.kind === "ask" && i !== lastReal) dropped.add(it);
  });

  return dropped.size ? items.filter((it) => !dropped.has(it)) : items;
}

// ── 말풍선에 붙는 잔글씨 ─────────────────────────────────────────

/** 한 번 묻고 답이 끝나기까지 걸린 시간. 그 답 말풍선 아래에 붙는다. */
export function turnDurations(events: SessionEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  const isRealUser = (ev: SessionEvent): boolean => {
    if (ev.type !== "user" || ev.isSidechain) return false;
    const content = ev.message?.content;
    if (Array.isArray(content)) {
      const first = content[0];
      // 도구 결과만 담은 user 레코드는 사람이 친 것이 아니다.
      if (first && typeof first === "object" && first.type === "tool_result") return false;
    }
    return true;
  };
  const starts: number[] = [];
  for (let i = 0; i < events.length; i++) if (isRealUser(events[i])) starts.push(i);
  for (let t = 0; t < starts.length; t++) {
    const from = starts[t];
    const to = starts[t + 1] ?? events.length;
    const startTs = events[from].timestamp;
    let last: SessionEvent | undefined;
    for (let i = from + 1; i < to; i++) {
      if (events[i].type === "assistant" && !events[i].isSidechain) last = events[i];
    }
    const endTs = last?.timestamp;
    const uuid = last?.uuid;
    if (startTs && endTs && uuid) {
      const dur = Date.parse(endTs) - Date.parse(startTs);
      if (!Number.isNaN(dur) && dur >= 0) map.set(uuid, dur);
    }
  }
  return map;
}

/** 그 답에 쓴 출력 토큰. 원문에 적혀 오는 값이라 어림이 아니다. */
export function turnTokens(events: SessionEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== "assistant" || ev.isSidechain) continue;
    const usage = ev.message?.usage;
    if (!ev.uuid || !usage) continue;
    const out = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    if (out > 0) map.set(ev.uuid, out);
  }
  return map;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 0) return "0초";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h === 0 && m === 0) return `${(ms / 1000).toFixed(1)}초`;
  if (h === 0) return s > 0 ? `${m}분 ${s}초` : `${m}분`;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
}

export function fmtClock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  let h = d.getHours();
  const half = h < 12 ? "오전" : "오후";
  h = h % 12;
  if (h === 0) h = 12;
  return `${half} ${h}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 도구 결과의 글만 꺼낸다. 블록으로 오기도 하고 그냥 글로 오기도 한다. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as ContentBlock;
    if (typeof blk.text === "string") parts.push(blk.text);
  }
  return parts.join("\n");
}
