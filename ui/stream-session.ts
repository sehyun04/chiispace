export type CodexSettings = { model?: string; effort?: string; approvalPolicy?: unknown };

export type StreamChat =
  | { agent: "claude"; session: string; cwd: string }
  | (CodexSettings & { agent: "codex"; session: string; cwd: string; unstarted?: boolean; sandbox?: unknown; settingsPending?: boolean });

export function codexSettingsPending(selected: CodexSettings, applied: CodexSettings, defaultEffort?: string): boolean {
  return selected.model !== applied.model || (selected.effort ?? defaultEffort) !== (applied.effort ?? defaultEffort)
    || JSON.stringify(selected.approvalPolicy) !== JSON.stringify(applied.approvalPolicy);
}

export function selectStreamThread(chat: StreamChat, session: string): StreamChat {
  if (chat.agent === "claude" || chat.session === session) return { ...chat, session };
  return { agent: "codex", cwd: chat.cwd, session, unstarted: false };
}

type ListedThread = {
  id: string; cwd?: string; parentThreadId?: string; name?: string; preview?: string; updatedAt?: number;
  source?: { subAgent?: { thread_spawn?: { parent_thread_id?: string } } } | string;
};
type ThreadPage = { data?: ListedThread[]; nextCursor?: string | null };

function folderKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "").toLowerCase();
}

export async function codexThreadsInFolder(cwd: string, page: (cursor: string | null) => Promise<ThreadPage>): Promise<ListedThread[]> {
  // 서버의 cwd 필터는 경로 표기가 같아야 맞아서, Windows 경로를 정규화한 뒤 여기에서 거른다.
  const folder = folderKey(cwd);
  const threads = new Map<string, ListedThread>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page(cursor);
    for (const thread of result.data ?? []) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(thread.id) || thread.parentThreadId
        || (typeof thread.source === "object" && thread.source?.subAgent?.thread_spawn?.parent_thread_id)
        || (cwd && folderKey(thread.cwd ?? "") !== folder) || threads.has(thread.id)) continue;
      threads.set(thread.id, thread);
      if (threads.size === 30) return [...threads.values()];
    }
    cursor = result.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("Codex 대화 목록의 다음 페이지가 반복됐다");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...threads.values()];
}

export function missingUnstarted(chat: Extract<StreamChat, { agent: "codex" }>, error: unknown): boolean {
  return chat.unstarted === true && String(error) === `no rollout found for thread id ${chat.session}`;
}

export function savedStreams(value: unknown): Record<string, StreamChat> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap<[string, StreamChat]>(([id, raw]) => {
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c.cwd !== "string" || typeof c.session !== "string") return [];
    // 기존 streams 기록에는 에이전트 구분이 없고 전부 Claude였다.
    if (c.agent === undefined || c.agent === "claude") {
      return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(c.session)
        ? [[id, { agent: "claude", session: c.session, cwd: c.cwd }]] : [];
    }
    if (c.agent !== "codex" || !/^[a-zA-Z0-9_-]{0,128}$/.test(c.session)) return [];
    return [[id, { agent: "codex", session: c.session, cwd: c.cwd,
      ...(c.unstarted === true ? { unstarted: true } : {}),
      ...(c.settingsPending === true ? { settingsPending: true } : {}),
      ...(typeof c.model === "string" ? { model: c.model } : {}), ...(typeof c.effort === "string" ? { effort: c.effort } : {}),
      ...(c.approvalPolicy !== undefined ? { approvalPolicy: c.approvalPolicy } : {}), ...(c.sandbox !== undefined ? { sandbox: c.sandbox } : {}) }]];
  }));
}
