/** 옆칸의 다른 PC 를 따라간다 — 이은 PC 마다 그 PC 의 방에 붙어 있어 켜짐/꺼짐과 그 PC 의 칸 목록을 안다. 붙는 길은 이사
 *  보낼 때와 같다(phone-link.ts `Link`, 그 PC 는 PC 짝에게 칸 목록만 보인다 — remote.rs). 예전 판 PC 는 칸 목록을 안 주므로
 *  켜짐/꺼짐만 보인다. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Link, socketUrl, type LinkStatus, type Paired } from "./phone-link";
import type { Peer } from "./session-move";

/** 그 PC 의 칸 하나(remote.rs `PhonePane` 가운데 옆칸이 쓰는 것). */
export type PeerPane = { id: string; title: string; slug: string | null; name: string | null; agent?: "claude" | "codex"; alive: boolean; busy: boolean; tasks: number; waiting: number };
/** `forgot` 은 그 PC 가 이 PC 를 잊었다는 뜻이다(다시 이어야 한다). */
export type PeerLive = { status: LinkStatus | "forgot"; panes: PeerPane[] | null };

export function usePeers(peers: Peer[] | null): Record<string, PeerLive> {
  const [live, setLive] = useState<Record<string, PeerLive>>({});
  // 이름만 바뀌어도 다시 붙지 않게 id 로만 다시 맞춘다.
  const ids = (peers ?? []).map((p) => p.id).join(",");
  useEffect(() => {
    setLive({});
    if (!ids) return;
    let alive = true;
    const links: Link[] = [];
    const set = (id: string, patch: Partial<PeerLive>) =>
      alive && setLive((x) => ({ ...x, [id]: { ...(x[id] ?? { status: "connecting", panes: null }), ...patch } }));
    for (const id of ids.split(",")) {
      void invoke<{ name: string; page: string; paired: Paired }>("remote_peer_key", { peer: id }).then(
        (key) => {
          if (!alive) return;
          const load = () =>
            link.invoke("remote_panes", {}).then(
              (v) => set(id, { panes: Array.isArray(v) ? (v as PeerPane[]) : null }),
              () => set(id, { panes: null }),
            );
          const link: Link = new Link({
            url: socketUrl(key.page),
            paired: key.paired,
            onStatus: (status) => {
              set(id, status === "open" ? { status } : { status, panes: null });
              if (status === "open") void load();
            },
            onEvent: (e) => {
              if (e === "remote:panes" || e === "remote:resync") void load();
            },
            onUnpaired: () => set(id, { status: "forgot", panes: null }),
          });
          links.push(link);
          link.start();
        },
        () => {},
      );
    }
    return () => {
      alive = false;
      links.forEach((l) => l.stop());
    };
  }, [ids]);
  return live;
}
