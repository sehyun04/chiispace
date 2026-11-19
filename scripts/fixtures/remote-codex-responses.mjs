import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

export async function codexResponse(res, request, project, seen) {
  const input = request.input ?? [];
  const user = [...input].reverse().find(item => item.role === "user");
  const mark = JSON.stringify(user ?? {}).match(/PHONE_CODEX_[A-Z]+/)?.[0] ?? "PHONE_CODEX_REPLY";
  const after = input.at(-1)?.type === "function_call_output";
  seen.push({ mark, after, images: user?.content?.some(item => item.type === "input_image"), answer: after ? input.at(-1).output : undefined });
  const id = "resp_" + randomUUID();
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
  const finish = (item) => {
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    res.end();
  };
  emit("response.created", { response: { id, status: "in_progress", output: [] } });
  if (!after && (mark === "PHONE_CODEX_TOOL" || mark === "PHONE_CODEX_ASK" || mark === "PHONE_CODEX_SUB")) {
    const shell = request.tools?.some(t => t.name === "exec_command") ? "exec_command" : "shell_command";
    const spawn = mark === "PHONE_CODEX_SUB" && (request.tools ?? []).flatMap(t =>
      t.type === "namespace" ? (t.tools ?? []).map(tool => ({ ...tool, namespace: t.name })) : [t]).find(t => t.name === "spawn_agent");
    if (mark === "PHONE_CODEX_SUB") assert.ok(spawn, "격리 Codex에서 자식을 부를 수 없다");
    const name = spawn?.name ?? (mark === "PHONE_CODEX_ASK" ? "request_user_input" : shell);
    const args = spawn ? { message: "PHONE_CODEX_CHILD 합성 답변" } : mark === "PHONE_CODEX_ASK"
      ? { questions: [{ id: "fixture", header: "선택", question: "폰에서 어느 쪽을 고를까?", options: [{ label: "첫째", description: "첫 선택" }, { label: "둘째", description: "두 번째 선택" }] }] }
      : { [shell === "exec_command" ? "cmd" : "command"]: "New-Item -ItemType Directory -Path phone_codex_dir",
        workdir: project, sandbox_permissions: "require_escalated", justification: "격리 폰 테스트 폴더 생성" };
    const item = { id: "fn_" + id, type: "function_call", call_id: "call_" + id, name, arguments: JSON.stringify(args), status: "completed",
      ...(spawn?.namespace ? { namespace: spawn.namespace } : {}) };
    emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
    emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
    finish(item);
    return;
  }
  const text = mark + "_ANSWER";
  const item = { type: "message", id: "msg_" + id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  emit("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: mark });
  if (mark === "PHONE_CODEX_STOP") return;
  await new Promise(resolve => setTimeout(resolve, 350));
  if (res.destroyed) return;
  emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "_ANSWER" });
  emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text });
  finish(item);
}
