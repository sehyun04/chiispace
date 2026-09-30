/** 터미널 없는 claude 칸의 통로(claude_chat.rs)에서 오가는 말.
 *
 *  `claude -p --input-format stream-json --output-format stream-json` 은 한 줄에 JSON 하나를
 *  주고받는다. 대화 내용 자체는 여기서 다루지 않는다 — 말풍선은 대화 파일이, 쓰이는 중인 답은
 *  프록시가 그린다(Chat.tsx). 여기서는 대화창이 화면 대신 받아야 하는 것만 모은다:
 *  권한 묻기, 선택지 질문, 일하는 중인지, 모델과 권한 모드. React 없이 단위 검증한다. */

export type Suggestion = Record<string, unknown>;

export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

export type Prompt =
  | {
      kind: "permission";
      requestId: string;
      toolUseId?: string;
      tool: string;
      input: Record<string, unknown>;
      description?: string;
      blockedPath?: string;
      /** "다시 묻지 않기" 갈래. claude 가 준 그대로 되돌려 주면 그 규칙이 적용된다. */
      suggestions: Suggestion[];
    }
  | {
      kind: "ask";
      requestId: string;
      toolUseId?: string;
      input: Record<string, unknown>;
      questions: Question[];
    };

export type ModelChoice = {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
};

/** 설정(`effortLevel`)으로 걸 수 있는 추론 수준. 모델이 `max` 를 받아도 설정 값으로는 받지 않는다. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
export const effortChoices = (m?: ModelChoice) => (m?.supportedEffortLevels ?? []).filter((v) => EFFORT_LEVELS.includes(v));

/** 지금 쓰는 모델의 항목. 첫 턴 전에는 쓰는 모델을 모르므로(system init 은 첫 말과 함께 온다) 기본값이다. */
export const currentModel = (s: StreamState) =>
  s.model ? s.models.find((m) => m.value === s.model || m.resolvedModel === s.model) : s.models.find((m) => m.value === "default");

export type StreamState = {
  /** 초기화에 답이 왔다. 모델 목록은 그때 온다. */
  ready: boolean;
  /** 턴이 도는 중. 보낸 뒤부터 결과가 올 때까지다. */
  busy: boolean;
  prompts: Prompt[];
  models: ModelChoice[];
  /** 지금 쓰는 모델. 고른 값(`sonnet`)이 아니라 실제 이름(`claude-sonnet-5`)일 수 있다. */
  model?: string;
  mode?: string;
  /** claude 가 지금 쓰는 대화 id. `/clear` 하면 새 대화로 넘어가며 바뀐다. */
  session?: string;
  /** 지금 걸린 추론 수준(설정 조회의 `applied.effort`). */
  effort?: string;
  /** 모델 오류처럼 턴이 실패한 까닭. 중단은 실패가 아니다. */
  error?: string;
  exited?: { code: number | null; error: string };
};

export const initialStream: StreamState = { ready: false, busy: false, prompts: [], models: [] };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const INIT_ID = "chiispace-init";

function questions(input: Obj): Question[] {
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.flatMap((raw) => {
    const q = obj(raw);
    const question = str(q.question);
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((o) => {
      const label = str(obj(o).label);
      return label ? [{ label, description: str(obj(o).description) }] : [];
    });
    return question && options.length ? [{ question, header: str(q.header), multiSelect: q.multiSelect === true, options }] : [];
  });
}

/** 통로에서 온 한 줄을 반영한다. 모르는 말은 그대로 둔다 — claude 가 새 말을 보내도 깨지지 않는다. */
export function reduceStream(s: StreamState, msg: unknown): StreamState {
  const m = obj(msg);
  switch (m.type) {
    case "control_response": {
      const r = obj(m.response);
      if (r.request_id !== INIT_ID) return s;
      const body = obj(r.response);
      const models = (Array.isArray(body.models) ? body.models : []).flatMap((raw) => {
        const v = obj(raw);
        const value = str(v.value);
        const efforts = Array.isArray(v.supportedEffortLevels) ? v.supportedEffortLevels.filter((e): e is string => typeof e === "string") : undefined;
        return value
          ? [{ value, displayName: str(v.displayName), description: str(v.description), resolvedModel: str(v.resolvedModel), supportedEffortLevels: efforts }]
          : [];
      });
      return { ...s, ready: true, models, mode: str(body.current_permission_mode) ?? s.mode };
    }
    case "system":
      if (m.subtype !== "init") return s;
      return { ...s, model: str(m.model) ?? s.model, mode: str(m.permissionMode) ?? s.mode, session: str(m.session_id) ?? s.session };
    case "stream_event":
    case "assistant":
      return s.busy ? s : { ...s, busy: true, error: undefined };
    case "result": {
      const failed = m.is_error === true && m.subtype !== "error_during_execution";
      return {
        ...s,
        busy: false,
        prompts: [],
        error: failed ? (str(m.result) ?? "claude 가 답하지 못했다") : undefined,
        session: str(m.session_id) ?? s.session,
      };
    }
    case "control_request": {
      const req = obj(m.request);
      const requestId = str(m.request_id);
      if (req.subtype !== "can_use_tool" || !requestId) return s;
      const tool = str(req.tool_name) ?? "";
      const input = obj(req.input);
      const toolUseId = str(req.tool_use_id);
      const prompt: Prompt = tool === "AskUserQuestion"
        ? { kind: "ask", requestId, toolUseId, input, questions: questions(input) }
        : {
            kind: "permission",
            requestId,
            toolUseId,
            tool,
            input,
            description: str(req.description),
            blockedPath: str(req.blocked_path),
            suggestions: (Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []).map(obj),
          };
      return { ...s, busy: true, prompts: [...s.prompts.filter((p) => p.requestId !== requestId), prompt] };
    }
    case "control_cancel_request":
      return { ...s, prompts: s.prompts.filter((p) => p.requestId !== m.request_id) };
    default:
      return s;
  }
}

/** 보낸 말은 통로에 아직 아무것도 안 떠도 그때부터 일하는 중이다. */
export const sentStream = (s: StreamState): StreamState => ({ ...s, busy: true, error: undefined });
export const answeredStream = (s: StreamState, requestId: string): StreamState => ({
  ...s,
  prompts: s.prompts.filter((p) => p.requestId !== requestId),
});

let seq = 0;
const nextId = () => `chiispace-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const initLine = () => ({ type: "control_request", request_id: INIT_ID, request: { subtype: "initialize" } });
export const userLine = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  session_id: "",
});
export const interruptLine = () => ({ type: "control_request", request_id: nextId(), request: { subtype: "interrupt" } });
export const modelLine = (model: string) => ({ type: "control_request", request_id: nextId(), request: { subtype: "set_model", model } });
export const modeLine = (mode: string) => ({ type: "control_request", request_id: nextId(), request: { subtype: "set_permission_mode", mode } });
/** 답을 받아야 하는 요청. 부른 쪽이 `request_id` 로 답(control_response)을 짝짓는다. */
export const controlLine = (request: Record<string, unknown>) => ({ type: "control_request", request_id: nextId(), request });
/** 추론 수준은 이 세션에만 거는 설정 층(flag settings)으로 건다. 사용자 설정 파일은 건드리지 않는다. */
export const effortRequest = (effortLevel: string) => ({ subtype: "apply_flag_settings", settings: { effortLevel } });

/** 설정 조회 답에서 지금 걸린 추론 수준. */
export function appliedEffort(body: unknown): string | undefined {
  const b = obj(body);
  return str(obj(b.applied).effort) ?? str(obj(b.effective).effortLevel);
}

/** 문맥 조회 답을 사람이 읽을 한 줄로. */
export function contextLine(body: unknown): string | undefined {
  const b = obj(body);
  if (typeof b.totalTokens !== "number") return undefined;
  const n = (v: number) => v.toLocaleString("en-US");
  const max = typeof b.maxTokens === "number" ? ` / ${n(b.maxTokens)}` : "";
  const pct = typeof b.percentage === "number" ? ` (${b.percentage}%)` : "";
  return `${n(b.totalTokens)}${max}${pct}`;
}

/** 허락. claude 는 어느 호출에 대한 답인지 `toolUseID` 로 맞춘다 — 빠지면 답을 못 알아듣고 계속 기다린다. */
export function allowLine(p: Prompt, extra: { input?: Obj; always?: Suggestion } = {}) {
  const response: Obj = { behavior: "allow", updatedInput: extra.input ?? p.input, toolUseID: p.toolUseId };
  if (extra.always) response.updatedPermissions = [extra.always];
  return { type: "control_response", response: { subtype: "success", request_id: p.requestId, response } };
}

export function denyLine(p: Prompt, message = "사용자가 허락하지 않았다") {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: p.requestId, response: { behavior: "deny", message, toolUseID: p.toolUseId } },
  };
}

/** 선택지 질문의 답. claude 는 질문 문장을 열쇠로 고른 답을 받는다. 여럿 고르면 쉼표로 잇는다. */
export function answerLine(p: Extract<Prompt, { kind: "ask" }>, answers: Record<string, string>) {
  return allowLine(p, { input: { ...p.input, answers } });
}

/** "다시 묻지 않기" 갈래를 사람이 읽을 말로. 모르는 갈래는 띄우지 않는다. */
export function suggestionLabel(s: Suggestion): string | null {
  if (s.type === "addRules") {
    const rules = Array.isArray(s.rules) ? s.rules.map(obj) : [];
    const what = rules.map((r) => str(r.ruleContent) ?? str(r.toolName)).filter(Boolean).join(", ");
    return what ? `다시 묻지 않기 · ${what}` : "다시 묻지 않기";
  }
  if (s.type === "setMode" && s.mode === "acceptEdits") return "이 대화에선 편집 묻지 않기";
  if (s.type === "addDirectories") {
    const dirs = Array.isArray(s.directories) ? s.directories.filter((d) => typeof d === "string") : [];
    return dirs.length ? `이 폴더 허락 · ${dirs.join(", ")}` : null;
  }
  return null;
}

/** 칸 이름으로 쓸 첫 말. 여러 줄이면 첫 줄만, 길면 자른다. */
export function titleFrom(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line || line.startsWith("/")) return null;
  const chars = Array.from(line);
  return chars.length > 40 ? chars.slice(0, 40).join("") + "…" : line;
}
