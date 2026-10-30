import type { PaletteCommand } from "./palette";
import type { Data } from "./codex-stream";

export const CODEX_COMMANDS: PaletteCommand[] = [
  { name: "compact", hint: "지난 대화를 줄여 문맥 비우기" },
  { name: "rename", hint: "대화 이름 바꾸기", args: "<이름>" },
  { name: "mcp", hint: "이 대화의 MCP 서버와 도구 조회" },
  { name: "skills", hint: "스킬 목록과 사용 여부 조회" },
  { name: "diff", hint: "작업 폴더의 Git 변경 · 새 파일 포함" },
  { name: "pwd", aliases: ["cwd"], hint: "지금 작업 폴더 보기" },
  { name: "usage", hint: "계정 사용 한도 조회" },
  { name: "warnings", hint: "이 실행에서 받은 경고 보기" },
  { name: "agents", aliases: ["subagents"], hint: "서브에이전트 대화 고르기" },
  { name: "copy", hint: "마지막 답 복사" },
  { name: "init", hint: "이 프로젝트의 AGENTS.md 작성 요청 · 일반 턴" },
  { name: "recap", hint: "현재 대화 요약 요청 · 일반 턴" },
];

export function codexCommand(name: string): string {
  const key = name.replace(/^\//, "");
  return "/" + (CODEX_COMMANDS.find(c => c.name === key || c.aliases?.includes(key))?.name ?? key);
}

export function codexPrompt(command: string, args: string[]): string | null {
  const extra = args.length ? `\n추가 요청: ${args.join(" ")}` : "";
  if (command === "/init") return "현재 프로젝트의 구조와 개발·검증 방법을 살펴보고, 이 프로젝트에서 일할 에이전트를 위한 AGENTS.md를 작성해 줘. 기존 파일이 있으면 유효한 사용자 규칙을 보존하며 필요한 부분만 보완해 줘." + extra;
  if (command === "/recap") return "이 대화에서 지금까지 한 일, 결정한 이유, 검증 결과, 아직 남은 일과 다음 시작 지점을 요약해 줘. 이 요청에서는 파일을 변경하지 말고 대화 내용만 정리해 줘." + extra;
  return null;
}

export function mcpReport(servers: Data[]): string {
  return servers.map(s => `${s.name} · ${s.runtimeStatus?.type ?? s.authStatus ?? "연결됨"}\n` +
    (Object.keys(s.tools ?? {}).sort().map(t => `  ${t}`).join("\n") || "  도구 없음") +
    (s.toolsError ? `\n  ${s.toolsError}` : "")).join("\n\n") || "이 대화에 연결된 MCP 서버가 없다";
}

export function skillsReport(entries: Data[]): string {
  return entries.map(e => [e.cwd, ...(e.skills ?? []).map((s: Data) =>
    `${s.enabled ? "사용" : "꺼짐"} · ${s.name}\n  ${String(s.interface?.shortDescription || s.shortDescription || s.description || "").split("\n")[0]}`),
  ...(e.errors ?? []).map((x: Data) => `읽기 실패 · ${x.path}\n  ${x.message}`)].join("\n")).join("\n\n") || "스킬이 없다";
}

export function usageReport(data: Data): string {
  const limits = data.rateLimitsByLimitId ?? (data.rateLimits ? { 기본: data.rateLimits } : {});
  return Object.entries<Data>(limits).map(([id, limit]) => [limit.limitName || id,
    ...["primary", "secondary"].flatMap(k => limit[k] ? [`  ${limit[k].limitWindowMinutes ?? ""}분 한도 · ${limit[k].usedPercent ?? 0}% 사용` +
      (limit[k].resetsAt ? ` · ${new Date(limit[k].resetsAt * 1000).toLocaleString("ko-KR")}에 초기화` : "")] : [])].join("\n")).join("\n\n") || "이 계정의 사용 한도 정보가 없다";
}
