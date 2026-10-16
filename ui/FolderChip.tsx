/** 대화창 입력바 위 줄 오른쪽의 폴더 칩. 누르면 한 단계 위(`..`), 바로 아래 폴더들, 고르기 상자.
 *
 *  Warp 의 작업 폴더 칩처럼 고르기 상자를 열지 않고 옮겨 다니게 하려는 것이다. claude 는 대화를 폴더별로 적어 같은
 *  대화를 다른 폴더로 옮겨 이어 갈 수 없으므로, 폴더를 바꾸면 그 폴더의 새 대화다. 주고받은 말이 있으면 한 번
 *  묻는다 — 지금 대화 파일은 지우지 않지만, 앱에서 다시 고를 목록은 아직 없다. */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Dirs = { parent: string | null; children: string[] };

/** 경로의 마지막 이름. `C:/` 같은 드라이브 뿌리는 `C:` 다. */
export const baseName = (p: string) => p.split(/[\\/]+/).filter(Boolean).pop() ?? p;

export function FolderChip({ path, fresh, disabled, onPick }: {
  path: string;
  /** 아직 주고받은 말이 없는 대화. 그러면 묻지 않고 바꾼다. */
  fresh: boolean;
  disabled?: boolean;
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<Dirs | null>(null);
  const [error, setError] = useState("");
  // 고른 뒤 "새로 시작할까" 를 묻는 중인 폴더.
  const [asking, setAsking] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    setDirs(null);
    setError("");
    setAsking(null);
    invoke<Dirs>("fs_dirs", { path }).then(setDirs, (e) => setError(String(e)));
    // 칩 밖을 누르거나 Esc 면 닫는다. 캡처 단계여야 Esc 가 아래 입력바(중단)로 새지 않는다.
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open, path]);

  const go = (to: string) => {
    if (!fresh && !asking) return setAsking(to);
    setOpen(false);
    onPick(to);
  };
  const pickOther = () =>
    void invoke<string | null>("fs_pick").then((p) => p && go(p), () => {});

  const here = path ? baseName(path) : "홈";
  return (
    <span className="folder" ref={box}>
      <button type="button" className={open ? "on" : undefined} disabled={disabled} title={path || "홈"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.1l1.4 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        <span className="folder-name">{here}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="folder-menu" role="menu" aria-label="폴더 바꾸기">
          {asking ? (
            <div className="folder-ask">
              <div>
                <b>{here}</b> 대화는 두고 <b>{baseName(asking)}</b> 에서 새로 시작할까?
              </div>
              <div className="folder-ask-row">
                <button type="button" className="ask-go" onClick={() => go(asking)}>
                  새로 시작
                </button>
                <button type="button" className="ask-no" onClick={() => setAsking(null)}>
                  취소
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="folder-path" title={path}>{path || "홈"}</div>
              {error ? <div className="folder-note">{error}</div> : null}
              {dirs?.parent ? (
                <button type="button" role="menuitem" className="folder-row up" onClick={() => go(dirs.parent!)}>
                  <span className="folder-row-name">..</span>
                  <span className="folder-row-hint">{baseName(dirs.parent)}</span>
                </button>
              ) : null}
              <div className="folder-list">
                {dirs?.children.map((c) => (
                  <button type="button" role="menuitem" key={c} className="folder-row" onClick={() => go(c)}>
                    <span className="folder-row-name">{baseName(c)}</span>
                  </button>
                ))}
                {dirs && !dirs.children.length ? <div className="folder-note">아래 폴더 없음</div> : null}
              </div>
              <button type="button" role="menuitem" className="folder-row other" onClick={pickOther}>
                <span className="folder-row-name">다른 폴더 고르기…</span>
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
