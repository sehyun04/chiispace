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
