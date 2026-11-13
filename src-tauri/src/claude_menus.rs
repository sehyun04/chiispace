//! 대화창의 `/memory`·`/export` — `claude -p` 가 받지 않는 TUI 메뉴 둘의 앱 쪽 손.
//!
//! 무엇을 열고 무엇을 쓸지는 웹뷰가 정하지만 여기서 한 번 더 좁힌다. 여는 것은 있는 `.md` 파일뿐이고,
//! 쓰는 것은 칸 폴더 바로 아래의 새 `.md` 파일뿐이다. 있는 파일은 덮지 않는다.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

fn is_markdown(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// claude 가 불러온 메모리 파일(`get_context_usage` 의 `memoryFiles`)을 기본 편집기로 연다.
/// TUI 의 `/memory` 도 고른 파일을 편집기로 연다 — 앱 안에 편집기를 따로 만들지 않는다.
#[tauri::command]
pub fn open_memory_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !is_markdown(&p) || !p.is_file() {
        return Err("메모리 파일이 아니다".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| format!("못 열었다: {e}"))
}

/// 폴더 밖으로 나가거나 Windows 가 받지 않는 이름은 거절한다. 다듬는 것은 웹뷰가 이미 했다.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 120
        && is_markdown(Path::new(name))
        && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
}

/// 같은 이름이 있으면 `-2`, `-3` … 을 붙인다. 지난 내보내기를 덮지 않는다.
fn candidate(dir: &Path, name: &str, n: u32) -> PathBuf {
    if n == 0 {
        return dir.join(name);
    }
    let stem = &name[..name.len() - 3];
    dir.join(format!("{stem}-{}.md", n + 1))
}

/// 대화를 마크다운 파일로 칸 폴더에 남긴다. TUI 의 `/export` 도 작업 폴더에 쓴다. 쓴 경로를 돌려준다.
#[tauri::command]
pub fn save_export(dir: String, name: String, text: String) -> Result<String, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("폴더가 없다".into());
    }
    if !valid_name(&name) {
        return Err("쓸 수 없는 파일 이름".into());
    }
    for n in 0..100 {
        let p = candidate(&dir, &name, n);
        // 있는지 보고 쓰면 그 사이에 생긴 파일을 덮는다. 새 파일로만 연다.
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                f.write_all(text.as_bytes()).map_err(|e| format!("못 썼다: {e}"))?;
                return Ok(p.display().to_string());
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("못 썼다: {e}")),
        }
    }
    Err("같은 이름의 파일이 너무 많다".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_markdown_names_are_written() {
        assert!(valid_name("2026-11-13-2210-로그 좀 봐 줘.md"));
        assert!(valid_name("a.MD"));
        for bad in ["", "a.txt", "../a.md", "sub/a.md", "sub\\a.md", "C:a.md", ".md", "a?.md", "a\n.md"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn taken_names_get_a_number_instead_of_being_overwritten() {
        let dir = Path::new("C:\\p");
        assert_eq!(candidate(dir, "x.md", 0), dir.join("x.md"));
        assert_eq!(candidate(dir, "x.md", 1), dir.join("x-2.md"));
        assert_eq!(candidate(dir, "한글.md", 2), dir.join("한글-3.md"));
    }

    #[test]
    fn export_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("chiispace-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.display().to_string();
        let a = save_export(d.clone(), "x.md".into(), "first".into()).unwrap();
        let b = save_export(d.clone(), "x.md".into(), "second".into()).unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "second");
        assert!(save_export(d, "../x.md".into(), "no".into()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
