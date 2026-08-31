import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Entry = { name: string; path: string; dir: boolean };
export type GitInfo = {
  branch: string;
  ahead: number;
  behind: number;
  files: Record<string, string>;
};

export const EMPTY_GIT: GitInfo = { branch: "", ahead: 0, behind: 0, files: {} };

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="tw"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      style={{ transform: open ? "rotate(90deg)" : "none" }}
    >
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" width="13" height="13">
      <path
        d="M1.5 3.5h4l1.2 1.6h7.8v7.4H1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" width="13" height="13">
      <path
        d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Tree({
  root,
  git,
  onFile,
}: {
  root: string;
  git: GitInfo;
  /** 파일을 고르면 그 경로가 지금 보고 있는 셸로 간다. 트리는 무엇을 할지 모른다. */
  onFile: (path: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [kids, setKids] = useState<Record<string, Entry[]>>({});

  const load = useCallback(async (p: string) => {
    try {
      const list = await invoke<Entry[]>("fs_list", { path: p });
      setKids((k) => ({ ...k, [p]: list }));
    } catch {
      setKids((k) => ({ ...k, [p]: [] }));
    }
  }, []);

  useEffect(() => {
    setOpen(new Set([root]));
    setKids({});
    load(root);
  }, [root, load]);

  const toggle = (p: string) => {
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
    if (!kids[p]) load(p);
  };

  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

  // 접힌 폴더 안의 변경도 보여야 한다. 안 그러면 접어 둔 순간 정보가 사라져
  // "바뀐 게 없다"고 잘못 읽는다.
  const dirtyDirs = new Set<string>();
  for (const f of Object.keys(git.files)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirtyDirs.add(parts.slice(0, i).join("/"));
  }

  const rows: React.ReactElement[] = [];
  const walk = (p: string, depth: number) => {
    for (const e of kids[p] ?? []) {
      const r = rel(e.path);
      const mark = git.files[r];
      const dirty = e.dir && dirtyDirs.has(r);
      rows.push(
        <div
          key={e.path}
          className={e.dir ? "row dir" : "row"}
          style={{ paddingLeft: 6 + depth * 13 }}
          onClick={() => (e.dir ? toggle(e.path) : onFile(e.path))}
        >
          {e.dir ? <Chevron open={open.has(e.path)} /> : <span className="tw" />}
          {e.dir ? <FolderIcon /> : <FileIcon />}
          <span className="nm">{e.name}</span>
          {mark ? <span className={`gs g-${mark === "?" ? "new" : mark}`}>{mark}</span> : null}
          {!mark && dirty ? <span className="gs g-dot">·</span> : null}
        </div>,
      );
      if (e.dir && open.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk(root, 0);

  return <div className="tree">{rows.length ? rows : <div className="empty">비어 있어</div>}</div>;
}
