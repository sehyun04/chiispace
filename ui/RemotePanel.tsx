/** PC 쪽 폰 연결 — 켜고 끄기, 중계 주소, 폰 주소 QR, 짝짓기, 짝지은 폰. 통로와 규칙은 remote.rs 에 있다.
 *
 *  중계(relay/)는 사용자가 자기 Cloudflare 계정에 올린다. 가입·로그인·배포를 앱이 대신하면 그 인증을 앱이 다뤄야 해서,
 *  여기서는 할 일을 보여 주고 나온 주소를 받기만 한다. */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import qrcode from "qrcode-generator";
import { bySlug } from "./roster";
import { pair, socketUrl } from "./phone-link";
import { roomOf } from "./session-move";
import type { StreamChat } from "./stream-session";
import "./remote.css";

type Status = {
  on: boolean;
  relay: string | null;
  page: string | null;
  connected: boolean;
  error: string | null;
  phones: number;
  pairing: boolean;
  pairingLeft: number;
  sas: string | null;
  sasName: string | null;
  /** 짝지으려는 쪽이 PC 면 "pc" — 허락하면 그 PC 가 이 PC 로 대화를 이사 보낼 수 있다. */
  sasKind: string | null;
  devices: { id: string; name: string; added: number; kind: string | null }[];
  /** 이 PC 가 대화를 이사 보낼 다른 PC. */
  peers: { id: string; name: string; page: string; added: number }[];
};

/** 터미널이나 읽기 전용 자식 칸에는 폰이 열 수 있는 입력 경로가 없다. */
export function useRemotePanes(
  booted: boolean,
  streams: Record<string, StreamChat>,
  titleOf: (id: string) => string,
  casting: Record<string, string>,
  busy: Record<string, boolean>,
) {
  const panes = booted
    ? Object.entries(streams).flatMap(([id, c]) =>
        c.session
          ? [{ id, title: titleOf(id), cwd: c.cwd, session: c.session, agent: c.agent, codexBusy: c.agent === "codex" && !!busy[id],
            slug: casting[id] ?? null, name: bySlug.get(casting[id])?.name ?? null }]
          : [],
      )
    : [];
  const key = JSON.stringify(panes);
  useEffect(() => {
    if (!booted) return;
    void invoke("remote_publish", { panes: JSON.parse(key) }).catch(() => {});
  }, [key, booted]);
}

const day = (secs: number) => {
  const d = new Date(secs * 1000);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** 아이폰 카메라가 읽는 QR. 검정·흰색과 둘레 여백(4칸)은 읽히라고 지키는 규격이라 테마 색을 쓰지 않는다. */
function Qr({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg className="remote-qr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" role="img" aria-label="폰에서 열 주소">
      <rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export function RemotePanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [peerPage, setPeerPage] = useState("");
  const [peerSas, setPeerSas] = useState<string | null>(null);
  const [peerBusy, setPeerBusy] = useState(false);
  // 상태는 1초마다 새로 받으며 `err` 를 걷으므로, 잇기의 까닭은 따로 들고 있는다.
  const [peerErr, setPeerErr] = useState<string | null>(null);
  // 이름을 고치는 중인 PC. 짝지을 때 받은 컴퓨터 이름(`DESKTOP-…`)으로는 어느 PC 인지 알아보기 어렵다.
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  const run = (p: Promise<Status>) =>
    p.then(
      (v) => {
        setS(v);
        setErr(null);
      },
      (e) => setErr(String(e)),
    );
  useEffect(() => {
    void run(invoke<Status>("remote_status"));
    // 짝짓기 남은 시간·폰에서 온 숫자·붙은 폰 수를 따라간다.
    const t = window.setInterval(() => void run(invoke<Status>("remote_status")), 1000);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 포커스는 대개 칸의 입력바나 터미널에 있다. 새면 Esc 가 하던 일을 끊는다.
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", esc, true);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("keydown", esc, true);
    };
  }, [onClose]);

  const relay = draft ?? s?.relay ?? "";
  /** 다른 PC 를 잇는다. 그 PC 의 방에 폰처럼 짝짓되 PC 라고 밝힌다 — 그 PC 의 숫자 확인 화면이 PC 라고 보여 준다. */
  const linkPeer = async () => {
    const raw = peerPage.trim();
    const page = raw.endsWith("/") ? raw : `${raw}/`;
    if (!roomOf(page)) return setPeerErr("그 PC 의 [폰 연결]에 보이는 폰 주소(https://…/r/…/)를 넣어 줘");
    if (roomOf(page) === roomOf(s?.page ?? "")) return setPeerErr("이 PC 의 주소다 — 이사 보낼 다른 PC 의 주소를 넣어 줘");
    setPeerBusy(true);
    setPeerErr(null);
    try {
      const me = await invoke<string>("this_pc_name").catch(() => "PC");
      const paired = await pair(socketUrl(page), me, setPeerSas, "pc");
      setS(await invoke<Status>("remote_peer_add", { name: paired.name ?? "PC", page, paired }));
      setPeerPage("");
    } catch (e) {
      setPeerErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPeerBusy(false);
      setPeerSas(null);
    }
  };
  const copy = (text: string) =>
    void writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });

  return (
    <div className="remote-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="remote" role="dialog" aria-label="폰 연결">
        <header className="remote-head">
          <span className="remote-title">폰 연결</span>
          <button className="remote-x" onClick={onClose} aria-label="닫기">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>
        <p className="remote-lead">밖에서 폰으로 이 PC 의 Claude·Codex 대화창을 쓰고 권한에 답한다. 집 PC 에는 열린 포트가 없고, 폰과 PC 사이의 말은 암호화되어 중계를 지난다.</p>
        {s ? (
          <>
            <div className="remote-switch">
              <span>
                {s.on ? "켜짐" : "꺼짐"}
                <small className={s.on && s.error ? "bad" : undefined}>
                  {!s.on ? "" : !s.relay ? " · 중계 주소를 넣어 줘" : s.connected ? " · 중계에 붙음" : s.error ? ` · ${s.error}` : " · 중계에 붙는 중"}
                </small>
              </span>
              <button className={s.on ? "remote-btn on" : "remote-btn"} onClick={() => void run(invoke<Status>("remote_switch", { on: !s.on }))}>
                {s.on ? "끄기" : "켜기"}
              </button>
            </div>
            <form
              className="remote-relay"
              onSubmit={(e) => {
                e.preventDefault();
                void run(invoke<Status>("remote_set_relay", { url: relay })).then(() => setDraft(null));
              }}
            >
              <label htmlFor="remote-relay">중계 주소</label>
              <input
                id="remote-relay"
                value={relay}
                placeholder="https://chiispace-relay.이름.workers.dev"
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button className="remote-btn" type="submit" disabled={!relay.trim() || relay.trim() === s.relay}>
                저장
              </button>
            </form>
            {!s.relay ? (
              <ol className="remote-steps">
                <li>Cloudflare 에 가입한다(무료).</li>
                <li>
                  chiispace 폴더의 <code>relay</code> 에서 한 번
                  <span className="remote-cmd">
                    <code>npx wrangler login</code>
                  </span>
                  <span className="remote-cmd">
                    <code>npx wrangler deploy</code>
                  </span>
                </li>
                <li>나온 주소(https://chiispace-relay.….workers.dev)를 위에 넣는다.</li>
              </ol>
            ) : null}
            {s.on && s.page ? (
              <>
                <div className="remote-page">
                  <Qr text={s.page} />
                  <div className="remote-page-text">
                    <div className="remote-sub">폰에서 열 주소</div>
                    <code className="remote-url">{s.page}</code>
                    <button className="remote-btn" onClick={() => copy(s.page!)}>
                      {copied ? "복사함" : "주소 복사"}
                    </button>
                    <small>아이폰 카메라로 QR 을 찍어 사파리로 열고, 공유 → 홈 화면에 추가. 그다음 홈 화면의 chiispace 에서 짝짓는다.</small>
                  </div>
                </div>
                <div className="remote-pair" aria-live="polite">
                  {s.sas ? (
                    <>
                      <span className="remote-digits" data-sas={s.sas}>
                        {s.sas.slice(0, 3)} {s.sas.slice(3)}
                      </span>
                      <small>
                        {s.sasKind === "pc"
                          ? `다른 PC(${s.sasName ?? "이름 없음"})가 짝지으려 한다. 허락하면 그 PC 가 이 PC 로 대화를 이사 보낼 수 있다. 그 PC 화면에도 이 숫자가 보이면 [맞다].`
                          : `${s.sasName ?? "폰"} 화면에도 이 숫자가 보이면 [맞다]. 다르면 누가 끼어든 것이다.`}
                      </small>
                      <button className="remote-btn on" onClick={() => void run(invoke<Status>("remote_confirm", { ok: true }))}>
                        맞다
                      </button>
                      <button className="remote-btn" onClick={() => void run(invoke<Status>("remote_confirm", { ok: false }))}>
                        아니다
                      </button>
                    </>
                  ) : s.pairing ? (
                    <>
                      <small>폰에서 [연결]을 눌러 줘 · {clock(s.pairingLeft)} 남음</small>
                      <button className="remote-btn" onClick={() => void run(invoke<Status>("remote_pairing", { on: false }))}>
                        그만
                      </button>
                    </>
                  ) : (
                    <button className="remote-btn wide" disabled={!s.connected} onClick={() => void run(invoke<Status>("remote_pairing", { on: true }))}>
                      폰 짝짓기
                    </button>
                  )}
                </div>
                <div className="remote-devs">
                  <div className="remote-sub">짝지은 폰·PC{s.phones ? ` · 지금 붙은 화면 ${s.phones}` : ""}</div>
                  {s.devices.length ? (
                    s.devices.map((d) => (
                      <div className="remote-dev" key={d.id}>
                        <span>
                          {d.name}
                          {d.kind === "pc" ? <span className="remote-tag">PC · 이사 받기</span> : null}
                          <small> · {day(d.added)}</small>
                        </span>
                        <button className="remote-btn" onClick={() => void run(invoke<Status>("remote_forget", { device: d.id }))}>
                          잊기
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="remote-none">아직 없다</div>
                  )}
                </div>
              </>
            ) : null}
            <div className="remote-devs remote-peers">
              <div className="remote-sub">이사 보낼 PC</div>
              {s.peers.map((p) =>
                naming?.id === p.id ? (
                  <form
                    className="remote-dev remote-peer-name"
                    key={p.id}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(invoke<Status>("remote_peer_rename", { peer: p.id, name: naming.name })).then(() => setNaming(null));
                    }}
                  >
                    <input autoFocus value={naming.name} maxLength={40} spellCheck={false} onChange={(e) => setNaming({ id: p.id, name: e.target.value })} aria-label="PC 이름" />
                    <button className="remote-btn" type="submit" disabled={!naming.name.trim()}>
                      저장
                    </button>
                  </form>
                ) : (
                  <div className="remote-dev" key={p.id}>
                    <span>
                      {p.name}
                      <small> · {day(p.added)}</small>
                    </span>
                    <div className="remote-dev-acts">
                      <button className="remote-btn" onClick={() => setNaming({ id: p.id, name: p.name })}>
                        이름
                      </button>
                      <button className="remote-btn" onClick={() => void run(invoke<Status>("remote_peer_forget", { peer: p.id }))}>
                        잊기
                      </button>
                    </div>
                  </div>
                ),
              )}
              {peerSas ? (
                <div className="remote-pair">
                  <span className="remote-digits" data-peer-sas={peerSas}>
                    {peerSas.slice(0, 3)} {peerSas.slice(3)}
                  </span>
                  <small>그 PC 화면에도 이 숫자가 보이면 그 PC 에서 [맞다]를 눌러 줘.</small>
                </div>
              ) : (
                <form
                  className="remote-peer-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void linkPeer();
                  }}
                >
                  <small>그 PC 의 [폰 연결]에서 [폰 짝짓기]를 누른 뒤, 거기 보이는 폰 주소를 넣고 [잇기]. 이으면 옆칸 맨 아래 "다른 PC" 에 그 PC 가 뜬다. 대화창 칸을 거기로 끌어 놓거나 /move 로 이사 보낸다.</small>
                  <input value={peerPage} placeholder="https://chiispace-relay.이름.workers.dev/r/…/" spellCheck={false} onChange={(e) => setPeerPage(e.target.value)} aria-label="이사 보낼 PC 의 폰 주소" />
                  <button className="remote-btn" type="submit" disabled={peerBusy || !peerPage.trim()}>
                    {peerBusy ? "잇는 중" : "PC 잇기"}
                  </button>
                  {peerErr ? <p className="remote-bad">{peerErr}</p> : null}
                </form>
              )}
            </div>
          </>
        ) : null}
        {err ? <p className="remote-bad">{err}</p> : null}
      </section>
    </div>
  );
}
