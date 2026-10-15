import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** git 상태. 화면에 그리는 것은 브랜치와 바뀐 파일 수뿐이지만, 파일별 표시는
 *  이 값을 쓰는 다른 화면이 생길 때를 위해 그대로 받아 둔다. */
export type GitInfo = {
  branch: string;
  ahead: number;
  behind: number;
  /** 레포 루트 기준 상대 경로 -> 한 글자 상태(M/A/D/R/?). */
  files: Record<string, string>;
};

export const EMPTY_GIT: GitInfo = { branch: "", ahead: 0, behind: 0, files: {} };

/** 지금 보고 있는 탭의 폴더에 대해서만 묻는다. 안 보이는 탭까지 4초마다
 *  git 을 돌리면 탭이 늘수록 그대로 비용이 는다. */
export function useGit(root: string | null): GitInfo {
  const [git, setGit] = useState<GitInfo>(EMPTY_GIT);
  useEffect(() => {
    if (!root) {
      setGit(EMPTY_GIT);
      return;
    }
    let alive = true;
    const tick = () => {
      invoke<GitInfo>("git_status", { root })
        .then((g) => alive && setGit(g))
        .catch(() => {});
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [root]);
  return git;
}
