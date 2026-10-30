use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command, Stdio};

const LIMIT: usize = 256 * 1024;

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.fsmonitor=false"]).arg("-C").arg(root).args(args).env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    // 큰 diff도 화면에 보낼 양까지만 읽는다. 외부 diff·textconv는 호출 지점에서 끈다.
    child.stdout.take().ok_or("Git 출력이 없다")?.take((LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() && bytes.len() <= LIMIT { return Err("Git 변경을 읽지 못했다".into()); }
    Ok(bytes)
}

fn snapshot(root: &Path) -> Result<String, String> {
    let repo = git(root, &["rev-parse", "--show-toplevel"])?;
    let repo = std::fs::canonicalize(String::from_utf8_lossy(&repo).trim()).map_err(|e| e.to_string())?;
    let has_head = git(&repo, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let tracked = if has_head { git(&repo, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--"])? }
        else { git(&repo, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--cached", "--"])? };
    let mut out = String::from_utf8_lossy(&tracked).into_owned();
    if !has_head { out.push_str(&String::from_utf8_lossy(&git(&repo, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"])?)); }
    for raw in git(&repo, &["ls-files", "--others", "--exclude-standard", "-z"])?.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        if out.len() > LIMIT { break; }
        let name = String::from_utf8_lossy(raw);
        let relative = Path::new(name.as_ref());
        if relative.components().any(|c| !matches!(c, Component::Normal(_))) { continue; }
        let file = repo.join(relative);
        let Ok(meta) = std::fs::symlink_metadata(&file) else { continue };
        if !meta.file_type().is_file() || !std::fs::canonicalize(&file).is_ok_and(|p| p.starts_with(&repo)) { continue; }
        out.push_str(&format!("\n--- /dev/null\n+++ untracked/{name}\n"));
        if meta.len() > 64 * 1024 { out.push_str("[큰 새 파일 — 내용 생략]\n"); continue; }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        if bytes.contains(&0) { out.push_str("[바이너리 새 파일]\n"); continue; }
        for line in String::from_utf8_lossy(&bytes).lines() { out.push('+'); out.push_str(line); out.push('\n'); }
    }
    if out.is_empty() { return Ok("작업 폴더에 Git 변경이 없다".into()); }
    if out.len() > LIMIT {
        let mut end = LIMIT;
        while !out.is_char_boundary(end) { end -= 1; }
        out.truncate(end); out.push_str("\n[긴 diff — 나머지 생략]");
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_diff(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(Path::new(&root))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn includes_staged_unstaged_and_untracked_without_external_diff() {
        let root = std::env::temp_dir().join(format!("chiispace-git-diff-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init"]).unwrap();
        std::fs::write(root.join("tracked.txt"), "old\n").unwrap();
        git(&root, &["add", "tracked.txt"]).unwrap();
        git(&root, &["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]).unwrap();
        git(&root, &["config", "diff.external", "missing-chiispace-diff-command"]).unwrap();
        std::fs::write(root.join("tracked.txt"), "staged\n").unwrap();
        git(&root, &["add", "tracked.txt"]).unwrap();
        std::fs::write(root.join("new.txt"), "UNTRACKED_MARK\n").unwrap();
        std::fs::write(root.join("tracked.txt"), "staged\nUNSTAGED_MARK\n").unwrap();
        let out = snapshot(&root).unwrap();
        for mark in ["+staged", "+UNSTAGED_MARK", "+UNTRACKED_MARK", "untracked/new.txt"] { assert!(out.contains(mark), "{out}"); }
    }
}
