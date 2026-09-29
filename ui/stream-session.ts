export type StreamChat =
  | { agent: "claude"; session: string; cwd: string }
  | { agent: "codex"; session: string; cwd: string; unstarted?: boolean; model?: string; effort?: string; approvalPolicy?: unknown; sandbox?: unknown };

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
      ...(typeof c.model === "string" ? { model: c.model } : {}), ...(typeof c.effort === "string" ? { effort: c.effort } : {}),
      ...(c.approvalPolicy !== undefined ? { approvalPolicy: c.approvalPolicy } : {}), ...(c.sandbox !== undefined ? { sandbox: c.sandbox } : {}) }]];
  }));
}
