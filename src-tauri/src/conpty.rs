use std::path::Path;

#[cfg(windows)]
pub fn load(cache: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{
        LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };

    // OS 기본 ConPTY는 Windows 10에서 Codex의 영역 스크롤을 화면 덮어쓰기로 바꾼다.
    // 검증된 런타임을 exe에 포함해 OS 업데이트나 사용자 설치 경로에 기대지 않는다.
    let dir = cache.join(format!("conpty-1.24.260710001-{}", std::env::consts::ARCH));
    std::fs::create_dir_all(&dir)?;
    install(
        &dir.join("OpenConsole.exe"),
        include_bytes!(concat!(env!("OUT_DIR"), "/conpty/OpenConsole.exe")),
    )?;
    install(
        &dir.join("conpty.dll"),
        include_bytes!(concat!(env!("OUT_DIR"), "/conpty/conpty.dll")),
    )?;
    install(
        &dir.join("LICENSE.txt"),
        include_bytes!("../CONPTY-LICENSE.txt"),
    )?;
    let dll: Vec<u16> = dir
        .join("conpty.dll")
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // 절대 경로로 먼저 로드해야 portable-pty가 같은 이름의 다른 DLL을 집지 않는다.
    // 핸들은 PTY가 살아 있는 동안 필요하므로 프로세스 종료까지 유지한다.
    let handle = unsafe {
        LoadLibraryExW(
            dll.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn load(_cache: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(any(windows, test))]
fn install(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind, Write};
    let verify = || -> std::io::Result<()> {
        if std::fs::read(path)? == bytes {
            Ok(())
        } else {
            Err(Error::new(
                ErrorKind::InvalidData,
                format!("ConPTY cache mismatch: {}", path.display()),
            ))
        }
    };
    if path.exists() {
        return verify();
    }
    // 두 창의 동시 시작 중에도 불완전한 DLL이 보이지 않도록 완성된 파일만 게시한다.
    let temp = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        if !path.exists() {
            return Err(error);
        }
    }
    verify()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_cache_is_reused_and_corruption_is_not_overwritten() {
        let dir = std::env::temp_dir().join(format!(
            "chiispace-conpty-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("runtime.bin");
        install(&file, b"verified runtime").unwrap();
        install(&file, b"verified runtime").unwrap();
        assert!(install(&file, b"different runtime").is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"verified runtime");
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
