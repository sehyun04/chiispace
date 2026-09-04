//! 이 컴퓨터에서 띄울 수 있는 셸.
//!
//! 목록을 프론트에 박아 두지 않는 이유: 없는 것을 골라 주면 칸이 뜨자마자 죽는데,
//! 그때 사용자에게 남는 건 빈 검은 칸뿐이라 왜 안 되는지 알 수 없다. Git Bash 는
//! 설치 위치가 사람마다 다르고 아예 없는 컴퓨터도 많다.
//!
//! `-il` 이나 PowerShell 의 cwd 심 같은 인자는 **엔진이 알아서 붙인다**
//! (`PtyOptions.shell` 을 받아 실행 파일 이름으로 갈래를 탄다). 여기서는 경로만 준다.

use std::path::PathBuf;

#[derive(serde::Serialize)]
pub struct Shell {
    /// 세션에 저장되는 값이 아니다. 저장은 `path` 로 한다 — 이름은 바뀔 수 있어도
    /// 경로는 그 컴퓨터에서 그대로다.
    id: String,
    name: String,
    path: String,
}

fn have(p: PathBuf) -> Option<PathBuf> {
    p.is_file().then_some(p)
}

/// PATH 에서 실행 파일을 찾는다. `where`/`which` 를 부르지 않는 이유는 그때마다
/// 콘솔 창이 깜빡이고(Windows), 이 목록은 새 탭을 누를 때마다 필요해서다.
fn on_path(exe: &str) -> Option<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    std::env::var("PATH")
        .ok()?
        .split(sep)
        .filter(|d| !d.is_empty())
        .find_map(|d| have(PathBuf::from(d).join(exe)))
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var(var).ok().map(PathBuf::from)
}

#[cfg(windows)]
fn found() -> Vec<Shell> {
    let mut out = Vec::new();
    let win = env_dir("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let sys32 = win.join("System32");

    let mut add = |id: &str, name: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            out.push(Shell {
                id: id.into(),
                name: name.into(),
                path: p.to_string_lossy().into_owned(),
            });
        }
    };

    add("cmd", "명령 프롬프트", have(sys32.join("cmd.exe")));
    add(
        "powershell",
        "Windows PowerShell",
        have(sys32.join(r"WindowsPowerShell\v1.0\powershell.exe")),
    );
    add("pwsh", "PowerShell 7", on_path("pwsh.exe"));

    // Git Bash 는 `bin\bash.exe` 로 띄운다. `usr\bin\bash.exe` 도 돌긴 하지만
    // MSYS 환경을 갖춰 주는 건 앞쪽 래퍼라, 그쪽으로 띄우면 PATH 에 유닉스
    // 도구가 안 잡혀 "bash 인데 ls 가 없는" 칸이 된다.
    let git_bash = [
        env_dir("ProgramFiles").map(|d| d.join(r"Git\bin\bash.exe")),
        env_dir("ProgramFiles(x86)").map(|d| d.join(r"Git\bin\bash.exe")),
        env_dir("LOCALAPPDATA").map(|d| d.join(r"Programs\Git\bin\bash.exe")),
    ]
    .into_iter()
    .flatten()
    .find_map(have)
    // 어디에도 없으면 PATH 의 git.exe 에서 거슬러 올라간다(`<git>\cmd\git.exe`).
    .or_else(|| {
        let git = on_path("git.exe")?;
        let root = git.parent()?.parent()?;
        have(root.join(r"bin\bash.exe"))
    });
    add("gitbash", "Git Bash", git_bash);

    out
}

#[cfg(not(windows))]
fn found() -> Vec<Shell> {
    ["bash", "zsh", "fish", "sh"]
        .into_iter()
        .filter_map(|n| {
            on_path(n).map(|p| Shell {
                id: n.into(),
                name: n.into(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

/// 맨 앞의 것이 기본이다 — 프론트가 아무것도 기억하지 못할 때 그것으로 연다.
#[tauri::command]
pub fn shells() -> Vec<Shell> {
    found()
}
