/** 다른 PC 가 대화를 이사 보내 왔을 때 이 PC 에 뜨는 창. 어느 폴더에서 이어 쓸지 사람이 고르고 [받기]를 눌러야 파일을 쓴다
 *  (src-tauri/src/session_move.rs). 받으면 부른 쪽(App)이 그 대화를 새 탭의 대화창으로 연다. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { receiverNotes, sizeLabel, type FolderGuess, type MoveOffer as Offer } from "./session-move";
import "./remote.css";

export type MovedIn = { session: string; cwd: string; title: string; slug: string };

export function MoveOffer({ known, onOpen }: {
  /** 이 PC 의 앱이 아는 폴더(탭·칸). 같은 레포를 이 안에서 찾는다. */
  known: string[];
  onOpen: (m: MovedIn) => void;
}) {
  const [queue, setQueue] = useState<Offer[]>([]);
  useEffect(() => {
    const offs = [
      listen<Offer>("remote:move-offer", (e) => setQueue((q) => [...q, e.payload])),
      // 보낸 PC 가 기다리다 그만뒀다(5분).
      listen<{ offer: number }>("remote:move-gone", (e) => setQueue((q) => q.filter((o) => o.offer !== e.payload.offer))),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);
  const o = queue[0];
  if (!o) return null;
  const done = () => setQueue((q) => q.filter((x) => x.offer !== o.offer));
  return <OfferDialog key={o.offer} offer={o} known={known} onOpen={onOpen} onDone={done} />;
}

function OfferDialog({ offer, known, onOpen, onDone }: { offer: Offer; known: string[]; onOpen: (m: MovedIn) => void; onDone: () => void }) {
  const [guesses, setGuesses] = useState<FolderGuess[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = (chosen: string | null) =>
    invoke<FolderGuess[]>("session_move_folders", { origin: offer.git.origin ?? null, folder: offer.folder, known, chosen }).then(
      (g) => {
        setGuesses(g);
        // 첫 줄을 권하기만 한다. [받기]는 사람이 누른다.
        setPick((p) => chosen ?? p ?? g[0]?.path ?? null);
      },
      (e) => setErr(String(e)),
    );
  useEffect(() => {
    void look(null);
    // 창이 뜬 때의 후보만 본다. 앱이 아는 폴더가 바뀔 때마다 다시 찾으면 고르던 줄이 흔들린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const here = guesses?.find((g) => g.path === pick)?.git;
  const notes = receiverNotes(offer, here);
  const take = async () => {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await invoke<{ session: string; cwd: string }>("session_move_answer", { offer: offer.offer, cwd: pick });
      onOpen({ session: r.session, cwd: r.cwd, title: offer.title, slug: offer.slug });
      onDone();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };
  const refuse = () => void invoke("session_move_answer", { offer: offer.offer, cwd: null }).catch(() => {}).finally(onDone);
  const other = async () => {
    const p = await invoke<string | null>("fs_pick").catch(() => null);
    if (p) await look(p);
  };

  return (
    <div className="remote-back">
      <section className="remote move-offer" role="dialog" aria-label="대화 이사 받기">
        <header className="remote-head">
          <span className="remote-title">{offer.from} 에서 대화가 이사 온다</span>
        </header>
        <p className="remote-lead">
          <b>{offer.title || "이름 없는 대화"}</b>
          <br />
          <small>
            보낸 PC 의 {offer.cwd} · {sizeLabel(offer.bytes)}
            {offer.git.branch ? ` · ${offer.git.branch}` : ""}
            {offer.git.head ? ` ${offer.git.head.slice(0, 7)}` : ""}
          </small>
        </p>
        <div className="remote-sub">이 PC 에서 이어 쓸 폴더</div>
        <div className="move-folders">
          {guesses === null ? (
            <div className="remote-none">같은 레포를 찾는 중</div>
          ) : guesses.length ? (
            guesses.map((g) => (
              <label key={g.path} className={g.path === pick ? "move-folder on" : "move-folder"}>
                <input type="radio" name={`move-${offer.offer}`} checked={g.path === pick} onChange={() => setPick(g.path)} />
                <span>
                  <code>{g.path}</code>
                  <small>
                    {g.remembered ? " · 전에 고른 폴더" : ""}
                    {g.git.branch ? ` · ${g.git.branch}` : ""}
                    {g.git.head ? ` ${g.git.head.slice(0, 7)}` : ""}
                  </small>
                </span>
              </label>
            ))
          ) : (
            <div className="remote-none">{offer.git.origin ? `${offer.git.origin} 를 이 PC 의 탭에서 못 찾았다` : "같은 이름의 폴더를 못 찾았다"} — 폴더를 골라 줘</div>
          )}
          <button className="remote-btn" onClick={() => void other()}>
            다른 폴더
          </button>
        </div>
        {notes.map((n) => (
          <p key={n} className="move-offer-note">
            {n}
          </p>
        ))}
        {err ? <p className="remote-bad">{err}</p> : null}
        <div className="move-offer-row">
          <button className="remote-btn on wide" disabled={!pick || busy} onClick={() => void take()}>
            {busy ? "받는 중" : "받기"}
          </button>
          <button className="remote-btn wide" disabled={busy} onClick={refuse}>
            거절
          </button>
        </div>
      </section>
    </div>
  );
}
