use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub home: String,
    pub cwd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "saved_by_default")]
    pub resumable: bool,
}

fn saved_by_default() -> bool {
    true
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

impl Session {
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.id)
            || self.home.len() > 32768
            || self.cwd.len() > 32768
            || !std::path::Path::new(&self.home).is_absolute()
            || !std::path::Path::new(&self.cwd).is_absolute()
            || self.home.contains(['\0', '\r', '\n'])
            || self.cwd.contains(['\0', '\r', '\n'])
        {
            bail!("Codex 복원 정보가 올바르지 않습니다");
        }
        if self.args.len() > 128 || restore_options(&self.args) != self.args {
            bail!("Codex 복원 옵션이 올바르지 않습니다");
        }
        Ok(())
    }
}

pub fn restore_options(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            break;
        }
        let (flag, attached) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(a, b)| (a, Some(b)));
        if matches!(
            flag,
            "--model"
                | "-m"
                | "--profile"
                | "-p"
                | "--sandbox"
                | "-s"
                | "--ask-for-approval"
                | "-a"
                | "--add-dir"
                | "--local-provider"
        ) {
            let value = attached.or_else(|| args.get(i + 1).map(String::as_str));
            if let Some(value) =
                value.filter(|v| !v.contains(['\0', '\r', '\n']) && v.len() <= 32768)
            {
                out.push(flag.into());
                out.push(value.into());
            }
            if attached.is_none() {
                i += 1;
            }
        } else if matches!(
            arg.as_str(),
            "--oss"
                | "--search"
                | "--approve-for-me"
                | "--dangerously-bypass-approvals-and-sandbox"
                | "--dangerously-bypass-hook-trust"
                | "--no-alt-screen"
        ) {
            out.push(arg.clone());
        } else if matches!(flag, "--config" | "-c") {
            let value = attached.or_else(|| args.get(i + 1).map(String::as_str));
            if let Some(value) = value.filter(|v| safe_config(v)) {
                out.push("-c".into());
                out.push(value.into());
            }
            if attached.is_none() {
                i += 1;
            }
        } else if matches!(flag, "--cd" | "-C" | "--image" | "-i") && attached.is_none() {
            // 원문 프롬프트·첨부·인증이 들어갈 수 있는 config 값을 세션 파일에 복제하지 않는다.
            i += 1;
        }
        i += 1;
    }
    out
}

fn safe_config(value: &str) -> bool {
    if value.len() > 32768 || value.contains(['\0', '\r', '\n']) {
        return false;
    }
    let key = value
        .split_once('=')
        .map(|(key, _)| key.trim())
        .unwrap_or("");
    matches!(
        key,
        "model"
            | "model_provider"
            | "model_reasoning_effort"
            | "service_tier"
            | "approval_policy"
            | "sandbox_mode"
    ) || key.starts_with("sandbox_workspace_write.")
        || key.starts_with("permissions.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_shell_sensitive_paths_are_validated_and_encoded() {
        let root = std::env::temp_dir()
            .join("한글 & ' ; $ 경로")
            .to_string_lossy()
            .into_owned();
        let s = Session {
            id: "12345678-1234-4234-8234-123456789abc".into(),
            home: root.clone(),
            cwd: root,
            args: vec![],
            resumable: true,
        };
        assert!(s.validate().is_ok());
        assert_eq!(
            serde_json::from_str::<Session>(&serde_json::to_string(&s).unwrap()).unwrap(),
            s
        );
        for bad in [
            "../../other",
            "12345678-1234-4234-8234-123456789abz",
            "1234567811234-4234-8234-123456789abc",
        ] {
            assert!(!valid_id(bad));
        }
        assert!(Session {
            home: "relative".into(),
            ..s
        }
        .validate()
        .is_err());
    }

    #[test]
    fn restoration_retains_explicit_permissions_without_copying_prompts_or_credentials() {
        let args: Vec<String> = [
            "--sandbox=read-only",
            "-m",
            "test-model",
            "-c",
            "approval_policy=\"never\"",
            "-c",
            "mcp_servers.private.env.API_KEY=\"secret\"",
            "resume",
            "some-id",
            "--",
            "--model",
            "prompt",
        ]
        .map(Into::into)
        .into();
        assert_eq!(
            restore_options(&args),
            [
                "--sandbox",
                "read-only",
                "-m",
                "test-model",
                "-c",
                "approval_policy=\"never\""
            ]
        );
    }
}
