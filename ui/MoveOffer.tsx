/** 다른 PC 가 대화를 이사 보내 왔을 때. 같은 레포 폴더가 하나로 정해지면 묻지 않고 그 폴더로 받고(session-move.ts `autoFolder`),
 *  그 레포가 이 PC 에 없으면 원격에서 받아 와 묻지 않고 받는다(`cloneWanted`). 못 정하거나 못 받아 오면 창을 띄워 사람이 폴더를
 *  고르고 [받기]를 누른다(src-tauri/src/session_move.rs). 받으면 부른 쪽(App)이 그 대화를
 *  새 탭의 대화창으로 연다. 보내는 쪽은 사용자의 다른 PC 로, 숫자를 견주어 한 번 짝지은 기기만 보낼 수 있다(remote.rs). */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { autoFolder, cloneWanted, receiverNotes, sizeLabel, type FolderGuess, type MoveOffer as Offer } from "./session-move";
import "./remote.css";

export type MovedIn = { session: string; cwd: string; title: string; slug: string };

export function MoveOffer({ known, onOpen }: {
  /** 이 PC 의 앱이 아는 폴더(탭·칸). 같은 레포를 이 안에서 찾는다. */
  known: string[];
  onOpen: (m: MovedIn) => void;
}) {
  const [queue, setQueue] = useState<Offer[]>([]);
  // 묻지 않고 받았을 때 한 줄. 새 탭이 왜 생겼는지 알게 한다.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const offs = [
      listen<Offer>("remote:move-offer", (e) => setQueue((q) => [...q, e.payload])),
      // 보낸 PC 가 기다리다 그만뒀다(5분).
      listen<{ offer: number }>("remote:move-gone", (e) => setQueue((q) => q.filter((o) => o.offer !== e.payload.offer))),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);
  const o = queue[0];
  const done = () => setQueue((q) => q.filter((x) => x.offer !== o?.offer));
  return (
    <>
      {o ? <OfferDialog key={o.offer} offer={o} known={known} onOpen={onOpen} onDone={done} onAuto={setToast} /> : null}
      {toast ? (
        <div className="move-toast" role="status">
          {toast}
        </div>
      ) : null}
    </>
  );
}

function OfferDialog({ offer, known, onOpen, onDone, onAuto }: {
  offer: Offer;
  known: string[];
  onOpen: (m: MovedIn) => void;
  onDone: () => void;
  /** 묻지 않고 받았다. */
  onAuto: (text: string) => void;
}) {
  const [guesses, setGuesses] = useState<FolderGuess[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 폴더 후보를 보고 묻지 않고 받을지 정하기 전에는 창을 그리지 않는다 — 바로 받을 이사에 창이 번쩍이지 않게.
  const [ask, setAsk] = useState(false);
  // 그 레포를 원격에서 받아 오는 중. 창 대신 한 줄만 띄운다 — 받는 PC 앞에 사람이 없을 수 있다.
  const [cloning, setCloning] = useState(false);

  const look =(chosen: string | null) =>
    invoke<FolderGuess[]>("session_move_folders", { origin: offer.git.origin ?? null, folder: offer.folder, known, chosen }).then(
      (g) => {
        setGuesses(g);
        setPick((p) => chosen ?? p ?? g[0]?.path ?? null);
        return g;
      },
      (e) => {
        setErr(String(e));
        return [] as FolderGuess[];
      },
    );
  useEffect(() => {
    void look(null).then(async (g) => {
      const auto = autoFolder(offer, g);
      if (auto) return void take(auto, true);
      if (cloneWanted(offer, g)) {
        setCloning(true);
        try {
          const path = await invoke<string>("session_move_clone", { origin: offer.git.origin, cwd: offer.cwd, branch: offer.git.branch ?? null });
          setCloning(false);
          return void take(path, true, true);
        } catch (e) {
          setCloning(false);
          setErr(String(e));
        }
      }
      setAsk(true);
    });
    // 창이 뜬 때의 후보만 본다. 앱이 아는 폴더가 바뀔 때마다 다시 찾으면 고르던 줄이 흔들린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const here = guesses?.find((g) => g.path === pick)?.git;
  const notes = receiverNotes(offer, here);
  const take = async (path = pick, auto = false, cloned = false) => {
    if (!path) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await invoke<{ session: string; cwd: string }>("session_move_answer", { offer: offer.offer, cwd: path });
      onOpen({ session: r.session, cwd: r.cwd, title: offer.title, slug: offer.slug });
      const name = path.split(/[\\/]/).filter(Boolean).pop();
      if (auto) onAuto(`${offer.from} 에서 "${offer.title || "이름 없는 대화"}" 대화가 이사 왔다 — ${cloned ? `레포를 ${path} 에 새로 받아 이어 쓴다` : `${name} 에서 이어 쓴다`}`);
      onDone();
    } catch (e) {
      // 묻지 않고 받다 실패하면(폴더가 사라짐 등) 창을 띄워 사람이 정한다.
      setErr(String(e));
      setBusy(false);
      setAsk(true);
    }
  };
  const refuse = () => void invoke("session_move_answer", { offer: offer.offer, cwd: null }).catch(() => {}).finally(onDone);
  const other = async () => {
    const p = await invoke<string | null>("fs_pick").catch(() => null);
    if (p) await look(p);
  };

  if (cloning)
    return (
      <div className="move-toast" role="status">
        {offer.from} 에서 대화가 이사 온다 — 이 PC 에 없는 레포({offer.git.origin})를 받아 오는 중
      </div>
    );
  if (!ask) return null;
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
          <button className="remote-btn on wide" disabled={!pick || busy} onClick={() => void take(pick)}>
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
