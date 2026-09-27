use kasa_pty::{AgentKind, PtySession};

pub fn in_table(table: &[(u32, u32, String)], shell: u32) -> Option<(AgentKind, u32)> {
    if let Some(found) = kasa_pty::agent_pid_for_shell(table, shell) { return Some(found); }
    // 엔진은 우리 continue 실행기를 모른다. 알려진 실행기 사슬만 내려가야 빌드의
    // 임의 자손을 칸의 전경 에이전트로 오인하지 않는다.
    let mut parent = shell;
    for _ in 0..6 {
        let (pid, _, name) = table.iter().filter(|(_, pp, _)| *pp == parent).max_by_key(|(pid, _, _)| pid)?;
        let name = name.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
        let base = name.strip_suffix(".exe").unwrap_or(&name);
        if matches!(base, "claude" | "codex") { return AgentKind::from_id(base).map(|kind| (kind, *pid)); }
        if !matches!(base, "chiispace-cli" | "node" | "npm" | "npx" | "cmd" | "powershell" | "pwsh" | "bash" | "sh") { return None; }
        parent = *pid;
    }
    None
}

pub fn find(pane: &PtySession) -> Option<(AgentKind, u32)> {
    in_table(&kasa_pty::process_table_shared(), pane.shell_pid()?)
}

pub fn fresh(pane: &PtySession) -> Option<(AgentKind, u32)> {
    // 화면 폴링의 캐시는 종료 직후에도 살아 있는 것처럼 보인다. 전송은 새 조회로 판정한다.
    in_table(&kasa_pty::process_table(), pane.shell_pid()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_through_our_cli_and_npm_reaches_codex() {
        let table = [(10, 1, "cmd.exe"), (20, 10, "chiispace-cli.exe"), (30, 20, "node.exe"), (40, 30, "codex.exe")]
            .map(|(p, pp, name)| (p, pp, name.to_string()));
        let (kind, pid) = in_table(&table, 10).unwrap();
        assert_eq!(kind.as_str(), "codex"); assert_eq!(pid, 40);
        assert!(in_table(&table[..3], 10).is_none());
        let mut unrelated = table.clone(); unrelated[1].2 = "build.exe".into();
        assert!(in_table(&unrelated, 10).is_none());
    }
}
