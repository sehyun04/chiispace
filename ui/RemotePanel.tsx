/** PC 쪽 폰 연결 — 켜고 끄기, 짝짓기 번호, 짝지은 폰. 서버와 규칙은 remote.rs 에 있다.
 *
 *  밖에서 닿는 길(Tailscale)은 앱이 깔거나 설정하지 않는다. 로그인을 앱이 대신 받으면 그 인증을 앱이 다뤄야 하고,
 *  `tailscale serve` 는 이 PC 의 네트워크 설정이라 사용자가 직접 한 번 돌린다. 여기서는 그 명령을 보여 주기만 한다. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { bySlug } from "./roster";
import type { StreamChat } from "./stream-session";
import "./remote.css";

type Status = {
  on: boolean;
  port: number;
  running: boolean;
  error: string | null;
  code: string | null;
  codeLeft: number;
  devices: { id: string; name: string; added: number }[];
  clients: number;
};

/** 폰이 볼 수 있는 칸을 알린다. Claude 대화창 칸만 — 터미널 칸과 Codex 칸은 아직 폰으로 옮기지 않았다. */
export function useRemotePanes(
  booted: boolean,
  streams: Record<string, StreamChat>,
  titleOf: (id: string) => string,
  casting: Record<string, string>,
) {
  const panes = booted
    ? Object.entries(streams).flatMap(([id, c]) =>
        c.agent === "claude" && c.session
          ? [{ id, title: titleOf(id), cwd: c.cwd, session: c.session, slug: casting[id] ?? null, name: bySlug.get(casting[id])?.name ?? null }]
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

export function RemotePanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
    // 번호 남은 시간과 붙은 폰 수를 따라간다.
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

  const serve = s ? `tailscale serve --bg ${s.port}` : "";
  const left = s ? `${Math.floor(s.codeLeft / 60)}:${String(s.codeLeft % 60).padStart(2, "0")}` : "";

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
        <p className="remote-lead">밖에서 폰으로 이 PC 의 Claude 대화창을 본다. 말하기와 권한 답하기까지 된다.</p>
        {s ? (
          <>
            <div className="remote-switch">
              <span>
                {s.running ? "켜짐" : "꺼짐"}
                <small>{s.running ? ` · 이 PC 의 127.0.0.1:${s.port} 에서만 받는다` : " · 켜면 이 PC 안에서만 받는다"}</small>
              </span>
              <button className={s.on ? "remote-btn on" : "remote-btn"} onClick={() => void run(invoke<Status>("remote_switch", { on: !s.on }))}>
                {s.on ? "끄기" : "켜기"}
              </button>
            </div>
            {s.error ? <p className="remote-bad">{s.error}</p> : null}
            {s.running ? (
              <>
                <div className="remote-code" aria-live="polite">
                  {s.code ? (
                    <>
                      <span className="remote-digits" data-code={s.code}>
                        {s.code.slice(0, 3)} {s.code.slice(3)}
                      </span>
                      <small>{left} 남음 · 한 번 쓰면 끝</small>
                      <button className="remote-btn" onClick={() => void run(invoke<Status>("remote_new_code"))}>
                        새 번호
                      </button>
                    </>
                  ) : (
                    <button className="remote-btn wide" onClick={() => void run(invoke<Status>("remote_new_code"))}>
                      짝짓기 번호 받기
                    </button>
                  )}
                </div>
                <ol className="remote-steps">
                  <li>PC 와 아이폰에 Tailscale 을 깔고 같은 계정으로 로그인한다.</li>
                  <li>
                    PC 에서 한 번 돌린다
                    <span className="remote-cmd">
                      <code>{serve}</code>
                      <button
                        className="remote-btn"
                        onClick={() =>
                          void writeText(serve).then(() => {
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1500);
                          })
                        }
                      >
                        {copied ? "복사함" : "복사"}
                      </button>
                    </span>
                  </li>
                  <li>아이폰 사파리로 Tailscale 이 알려 준 이 PC 주소(https://…ts.net)를 열고 공유 → 홈 화면에 추가.</li>
                  <li>홈 화면의 chiispace 를 열어 위 번호를 넣는다.</li>
                </ol>
                <div className="remote-devs">
                  <div className="remote-sub">
                    짝지은 폰{s.clients ? ` · 지금 붙은 화면 ${s.clients}` : ""}
                  </div>
                  {s.devices.length ? (
                    s.devices.map((d) => (
                      <div className="remote-dev" key={d.id}>
                        <span>
                          {d.name}
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
          </>
        ) : null}
        {err ? <p className="remote-bad">{err}</p> : null}
      </section>
    </div>
  );
}
