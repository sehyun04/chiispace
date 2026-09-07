use std::process::Command;

fn main() {
    // 유료 모델이나 사용자 계정 없이 실제 exe 탐지·PTY·MCP 배선을 검증한다.
    let exe = std::env::current_exe().unwrap();
    let status = Command::new(std::env::var("CHIISPACE_FIXTURE_NODE").unwrap())
        .arg(std::env::var("CHIISPACE_FIXTURE_SCRIPT").unwrap())
        .arg(exe.file_stem().unwrap())
        .args(std::env::args().skip(1))
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}
