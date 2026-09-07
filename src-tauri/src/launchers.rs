use crate::launch_config::{Config, Program};
use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Launchers {
    pub env: Vec<(String, String)>,
}

fn find(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}

fn program(name: &str) -> Option<Program> {
    if let Some(exe) = find(&format!("{name}.exe")) {
        // 치이스페 안에서 새 창을 열어도 이전 창의 래퍼를 재귀 호출하지 않는다.
        if let Ok(bytes) = std::fs::read(exe.with_file_name("launch.json")) {
            if let Ok(config) = serde_json::from_slice::<Config>(&bytes) {
                if let Some(real) = config.programs.get(name) {
                    return Some(real.clone());
                }
            }
        }
        return Some(Program { exe, args: vec![] });
    }
    if name == "codex" {
        let cmd = find("codex.cmd")?;
        let js = cmd
            .parent()?
            .join("node_modules/@openai/codex/bin/codex.js");
        if js.is_file() {
            return Some(Program {
                exe: find("node.exe")?,
                args: vec![js.to_string_lossy().into_owned()],
            });
        }
    }
    None
}

pub fn install(base: PathBuf) -> Result<Launchers> {
    let source = std::env::current_exe()?.with_file_name("chiispace-cli.exe");
    if !source.is_file() {
        eprintln!("치이스페 협업 CLI가 없습니다. cargo build --bins로 함께 빌드하세요");
        return Ok(Launchers { env: vec![] });
    }
    let directory = base.join(format!(
        "agents-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
    ));
    std::fs::create_dir_all(&directory)?;
    let cli = directory.join("chiispace-cli.exe");
    std::fs::copy(&source, &cli)?;
    let mut programs = HashMap::new();
    for name in ["claude", "codex"] {
        if let Some(real) = program(name) {
            // exe 래퍼는 cmd/PowerShell/Git Bash에서 같은 argv를 보존한다.
            std::fs::copy(&source, directory.join(format!("{name}.exe")))?;
            programs.insert(name.into(), real);
        }
    }
    std::fs::write(
        directory.join("launch.json"),
        serde_json::to_vec(&Config {
            cli: cli.clone(),
            programs,
        })?,
    )?;
    let mut path = vec![directory];
    path.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    Ok(Launchers {
        env: vec![
            (
                "PATH".into(),
                std::env::join_paths(path)?.to_string_lossy().into_owned(),
            ),
            ("CHIISPACE_CLI".into(), cli.to_string_lossy().into_owned()),
            ("CHIISPACE_AGENT_TOKEN".into(), String::new()),
        ],
    })
}
