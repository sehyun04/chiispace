use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Notice {
    pub session_id: String,
    pub hook_event_name: String,
    pub cwd: String,
    pub transcript_path: Option<String>,
}

impl Notice {
    pub fn validate(&self) -> Result<()> {
        if !crate::codex_session::valid_id(&self.session_id)
            || !matches!(self.hook_event_name.as_str(), "SessionStart" | "UserPromptSubmit" | "Stop" | "PermissionRequest" | "PostToolUse" | "Interrupt" | "SessionEnd")
            || !std::path::Path::new(&self.cwd).is_absolute()
            || self.cwd.contains(['\0', '\r', '\n'])
        {
            bail!("Codex 대화 연결 정보가 올바르지 않습니다");
        }
        if let Some(path) = &self.transcript_path {
            if path.len() > 32768 || path.contains(['\0', '\r', '\n']) || !std::path::Path::new(path).is_absolute() {
                bail!("Codex 대화 경로가 올바르지 않습니다");
            }
        }
        Ok(())
    }
}

pub fn args() -> Vec<String> {
    let mut args = Vec::new();
    for event in ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse", "Interrupt", "SessionEnd"] {
        // 실행마다 바뀌는 임시 exe 경로를 정의에 넣으면 신뢰 해시도 매번 바뀐다.
        args.extend(["-c".into(), format!("hooks.{event}=[{{hooks=[{{type=\"command\",command=\"chiispace-cli.exe codex-chat-hook\",timeout=3}}]}}]")]);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_copies_metadata_only_and_does_not_change_permissions() {
        let notice: Notice = serde_json::from_value(serde_json::json!({
            "session_id":"12345678-1234-4234-8234-123456789abc", "hook_event_name":"Stop",
            "cwd":std::env::temp_dir(), "transcript_path":null,
            "prompt":"private prompt", "last_assistant_message":"private answer",
        })).unwrap();
        notice.validate().unwrap();
        assert!(!serde_json::to_string(&notice).unwrap().contains("private"));
        let config = args().join(" ");
        assert!(!config.contains("bypass"));
        assert!(!config.contains("sandbox"));
        assert!(!config.contains("approval_policy"));
        assert!(!config.contains("features.hooks"));
    }
}
