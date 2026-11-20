/** 다른 PC 로 대화 이사 — 보내는 칸의 카드(`/move`). 받는 PC 의 방에 폰과 같은 길(짝짓기·암호 통로, phone-link.ts)로 붙어
 *  꾸러미를 넘기고, 받는 PC 에서 [받기]를 눌렀다는 답이 오면 이 칸을 닫는다. 받는 쪽은 src-tauri/src/session_move.rs. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Link, socketUrl, type LinkStatus, type Paired } from "./phone-link";
import { moveFailure, moveOffer, senderNotes, sizeLabel, type Pack } from "./session-move";

export type Peer = { id: string; name: string; page: string; added: number };

/** 그 PC 에 붙어 이사 꾸러미를 넘긴다. 받는 PC 의 답(받음·거절·시간 넘김)이 올 때까지 기다린다. */
async function sendMove(peer: string, offer: unknown, onStatus: (s: LinkStatus) => void): Promise<{ session: string; cwd: string }> {
  const key = await invoke<{ name: string; page: string; paired: Paired }>("remote_peer_key", { peer });
  return new Promise((resolve, reject) => {
    const link = new Link({
      url: socketUrl(key.page),
      paired: key.paired,
      onStatus: (s) => {
        onStatus(s);
        if (s !== "pc-offline") return;
        link.stop();
        reject(new Error(`${key.name} PC 가 중계에 안 붙어 있다 — 그 PC 의 chiispace 와 [폰 연결]이 켜져 있어야 한다`));
      },
      onEvent: () => {},
      onUnpaired: () => reject(new Error(`${key.name} PC 가 이 PC 를 잊었다 — [폰 연결]에서 다시 이어 줘`)),
    });
    link.start();
    link
      .invoke("session_move_offer", offer)
      .then((v) => resolve(v as { session: string; cwd: string }), reject)
      .finally(() => link.stop());
  });
}

type Step = "packing" | "ready" | "sending" | "failed" | "unsure";

export function MoveCard({ peer, cwd, session, title, slug, name, onMoved, onClose }: {
  peer: Peer;
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
  }, [cwd, session]);

  const go = async () => {
    if (!pack) return;
    setStep("sending");
    setText(`${peer.name} 에 붙는 중`);
    let opened = false;
    try {
      await sendMove(peer.id, moveOffer(pack, { title, slug, name }), (s) => {
        if (s !== "open") return;
        opened = true;
        setText(`${peer.name} 에서 [받기]를 눌러 줘 — 5분 기다린다`);
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
      <div className="ask-title">이 대화를 {peer.name} PC 로 이사할까</div>
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
