/** 다른 PC 로 대화 이사 — 보내는 칸의 카드(`/move`, 칸을 끌어 PC 에 놓기). 받는 PC 의 방에 폰과 같은 길(짝짓기·암호 통로,
 *  phone-link.ts)로 붙어 꾸러미를 넘기고, 받는 PC 가 받았다는 답이 오면 이 칸을 닫는다. 받는 쪽은 src-tauri/src/session_move.rs. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { callOnce, socketUrl, type LinkStatus, type Paired } from "./phone-link";
import { askBeforeSend, moveFailure, moveOffer, senderNotes, sizeLabel, type Pack } from "./session-move";

export type { Peer } from "./session-move";

/** 그 PC 에 붙어 이사 꾸러미를 넘긴다. 받는 PC 의 답(받음·거절·시간 넘김)이 올 때까지 기다린다. */
async function sendMove(peer: string, offer: unknown, onStatus: (s: LinkStatus) => void): Promise<{ session: string; cwd: string }> {
  const key = await invoke<{ name: string; page: string; paired: Paired }>("remote_peer_key", { peer });
  return (await callOnce(socketUrl(key.page), key.paired, key.name, "session_move_offer", offer, onStatus)) as { session: string; cwd: string };
}

type Step = "packing" | "ready" | "sending" | "failed" | "unsure";

export function MoveCard({ peer, auto, cwd, session, title, slug, name, onMoved, onClose }: {
  peer: { id: string; name: string };
  /** 칸을 끌어 놓았다. 묻지 않고 보낸다 — 커밋 안 한 변경이 있을 때만 카드에서 한 번 묻는다. */
  auto?: boolean;
  cwd: string;
  session: string;
  title?: string;
  slug?: string;
  name?: string;
  /** 받는 PC 가 받았다. 부른 쪽이 이 칸을 닫는다. */
  onMoved: () => void;
  /** 그만두고 이 칸에서 계속한다. */
  onClose: () => void;
}) {
  const [pack, setPack] = useState<Pack | null>(null);
  const [step, setStep] = useState<Step>("packing");
  const [text, setText] = useState("");

  useEffect(() => {
    let live = true;
    invoke<Pack>("session_move_pack", { root: cwd, id: session }).then(
      (p) => {
        if (!live) return;
        setPack(p);
        setStep("ready");
        if (auto && !askBeforeSend(p.git)) void go(p);
      },
      (e) => {
        if (!live) return;
        setText(String(e));
        setStep("failed");
      },
    );
    return () => {
      live = false;
    };
    // 꾸러미는 칸이 뜬 때 한 번 만든다. go 는 그때의 칸 이름·얼굴로 보낸다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, session]);

  const go = async (p = pack) => {
    if (!p) return;
    setStep("sending");
    setText(`${peer.name} 에 붙는 중`);
    let opened = false;
    try {
      await sendMove(peer.id, moveOffer(p, { title, slug, name }), (s) => {
        if (s !== "open") return;
        opened = true;
        // 받는 PC 가 같은 레포 폴더를 찾으면 묻지 않고 받는다. 못 찾으면 그 PC 에 폴더 고르는 창이 뜬다.
        setText(`${peer.name} 에 보냈다 — 받기를 기다린다. 그 PC 가 폴더를 물으면 거기서 [받기]`);
      });
      onMoved();
    } catch (e) {
      const f = moveFailure(e, opened);
      setText(f.text);
      setStep(f.unsure ? "unsure" : "failed");
    }
  };

  const notes = pack ? senderNotes(pack.git) : [];
  return (
    <div className="ask move" role="alertdialog" aria-label="다른 PC 로 이사">
      <div className="ask-title">{step === "sending" || (auto && step === "packing") ? `${peer.name} PC 로 이사하는 중` : `이 대화를 ${peer.name} PC 로 이사할까`}</div>
      <p className="move-lead">대화를 그 PC 의 대화창으로 옮기고 여기서는 칸을 닫는다. 같은 대화를 두 PC 에서 이어 쓰면 둘로 갈라진다.</p>
      {pack ? (
        <p className="move-facts">
          {sizeLabel(pack.bytes)}
          {pack.git.branch ? ` · ${pack.git.branch}` : ""}
          {pack.git.head ? ` ${pack.git.head.slice(0, 7)}` : ""}
          {pack.files.length > 1 ? ` · 서브에이전트 등 ${pack.files.length - 1}개 파일 함께` : ""}
        </p>
      ) : null}
      {notes.map((n) => (
        <p key={n} className="move-note">
          {n}
        </p>
      ))}
      {text ? (
        <p className={step === "failed" || step === "unsure" ? "move-note bad" : "move-step"} role="status">
          {text}
        </p>
      ) : null}
      <div className="ask-row">
        {step === "unsure" ? (
          <>
            <button className="ask-go" onClick={onMoved}>
              그 PC 에 열렸다 · 이 칸 닫기
            </button>
            <button className="ask-no" onClick={onClose}>
              안 열렸다 · 여기서 계속
            </button>
          </>
        ) : (
          <>
            <button className="ask-go" disabled={step !== "ready"} onClick={() => void go()}>
              {step === "sending" ? "보내는 중" : "보내기"}
            </button>
            <button className="ask-no" disabled={step === "sending"} onClick={onClose}>
              그만
            </button>
          </>
        )}
      </div>
    </div>
  );
}
