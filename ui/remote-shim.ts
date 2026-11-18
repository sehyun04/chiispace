/** 폰 화면이 PC 대화창 부품을 그대로 쓰게 하는 바꿔 끼우기.
 *
 *  부품은 `@tauri-apps/api` 의 `invoke`·`listen` 을 부르고, 둘 다 `window.__TAURI_INTERNALS__` 를 거친다. 폰에는 Tauri 가
 *  없으므로 그 자리에 PC 로 가는 암호 통로(phone-link.ts)를 놓는다. 무엇을 부를 수 있는지는 PC(remote.rs)가 정한다 —
 *  여기서는 길만 놓는다. */

/** 이벤트 귀 목록. `listen` 이 준 처리기(콜백 번호)를 이벤트 이름별로 든다. */
export function listenerTable() {
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, Map<number, number>>();
  let next = 1;
  return {
    callback(fn: (data: unknown) => void, once = false) {
      const id = next++;
      callbacks.set(id, (d) => {
        if (once) callbacks.delete(id);
        fn(d);
      });
      return id;
    },
    drop(id: number) {
      callbacks.delete(id);
    },
    listen(event: string, handler: number) {
      const id = next++;
      let m = listeners.get(event);
      if (!m) listeners.set(event, (m = new Map()));
      m.set(id, handler);
      return id;
    },
    unlisten(event: string, id: number) {
      listeners.get(event)?.delete(id);
    },
    emit(event: string, payload: unknown) {
      for (const [id, handler] of [...(listeners.get(event) ?? [])]) callbacks.get(handler)?.({ event, id, payload });
    },
  };
}

/** `invoke` 를 PC 로 보내는 길. 이벤트는 돌려준 `emit` 으로 넣는다. */
export function installRemote(call: (cmd: string, args: unknown) => Promise<unknown>) {
  const table = listenerTable();
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    transformCallback: (fn: (d: unknown) => void, once?: boolean) => table.callback(fn, once),
    unregisterCallback: (id: number) => table.drop(id),
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "plugin:event|listen") return table.listen(String(args.event), Number(args.handler));
      if (cmd === "plugin:event|unlisten") return table.unlisten(String(args.event), Number(args.eventId));
      if (cmd === "plugin:event|emit") return table.emit(String(args.event), args.payload);
      // 클립보드는 폰의 것이다. PC 클립보드 쓰기를 폰으로 보내지 않는다.
      if (cmd === "plugin:clipboard-manager|write_text") return navigator.clipboard.writeText(String(args.text ?? ""));
      if (cmd.startsWith("plugin:")) throw "폰에서는 할 수 없는 일이다";
      return call(cmd, args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string, id: number) => table.unlisten(event, id) };
  return { emit: table.emit };
}
