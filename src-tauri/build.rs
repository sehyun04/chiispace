fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "x86_64" => "x64",
            "x86" => "x86",
            "aarch64" => "arm64",
            other => panic!("unsupported ConPTY architecture: {other}"),
        };
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("conpty");
        let mut cmd = std::process::Command::new("powershell.exe");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let status = cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-File",
                "../scripts/prepare-conpty.ps1",
                "-Architecture",
                arch,
                "-Destination",
            ])
            .arg(out)
            .status()
            .expect("prepare ConPTY runtime");
        assert!(status.success(), "ConPTY runtime preparation failed");
        println!("cargo:rerun-if-changed=../scripts/prepare-conpty.ps1");
        println!("cargo:rerun-if-changed=CONPTY-LICENSE.txt");
    }
    tauri_build::build()
}
