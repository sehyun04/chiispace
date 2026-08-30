//! 키 입력 -> PTY 바이트. 터미널이 "반응하는 물건"이 되는 건 여기서다.

use winit::event::KeyEvent;
use winit::keyboard::{Key, ModifiersState, NamedKey};

pub fn encode(ev: &KeyEvent, mods: ModifiersState, app_cursor: bool) -> Option<Vec<u8>> {
    // DECCKM 이 켜져 있으면 방향키·Home/End 는 CSI(`ESC [`) 가 아니라 SS3(`ESC O`).
    // 이걸 무시하면 vim/readline/claude 안에서 방향키가 조용히 아무것도 안 한다.
    let ss3: &[u8] = if app_cursor { b"\x1bO" } else { b"\x1b[" };

    if let Key::Named(named) = ev.logical_key {
        let out: Vec<u8> = match named {
            NamedKey::Enter => b"\r".to_vec(),
            NamedKey::Backspace => vec![0x7f],
            NamedKey::Tab => b"\t".to_vec(),
            NamedKey::Escape => vec![0x1b],
            NamedKey::Space => b" ".to_vec(),
            NamedKey::ArrowUp => [ss3, b"A"].concat(),
            NamedKey::ArrowDown => [ss3, b"B"].concat(),
            NamedKey::ArrowRight => [ss3, b"C"].concat(),
            NamedKey::ArrowLeft => [ss3, b"D"].concat(),
            NamedKey::Home => [ss3, b"H"].concat(),
            NamedKey::End => [ss3, b"F"].concat(),
            NamedKey::PageUp => b"\x1b[5~".to_vec(),
            NamedKey::PageDown => b"\x1b[6~".to_vec(),
            NamedKey::Insert => b"\x1b[2~".to_vec(),
            NamedKey::Delete => b"\x1b[3~".to_vec(),
            _ => return None,
        };
        return Some(out);
    }

    if let Key::Character(s) = &ev.logical_key {
        // Ctrl+A..Z 는 0x01..0x1a. text 필드는 Ctrl 조합에서 비어 오는 일이
        // 많아 logical_key 로 직접 만든다.
        if mods.control_key() {
            if let Some(c) = s.chars().next() {
                let up = c.to_ascii_uppercase();
                if up.is_ascii_uppercase() {
                    return Some(vec![up as u8 - b'A' + 1]);
                }
                return match c {
                    '[' => Some(vec![0x1b]),
                    '\u{5c}' => Some(vec![0x1c]),
                    ']' => Some(vec![0x1d]),
                    _ => None,
                };
            }
        }
    }

    // 나머지는 winit 이 이미 레이아웃·조합을 반영해 만든 문자열을 그대로 쓴다.
    // Alt 는 ESC 접두(meta) 관례를 따른다.
    let text = ev.text.as_ref()?;
    if text.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    if mods.alt_key() {
        out.push(0x1b);
    }
    out.extend_from_slice(text.as_bytes());
    Some(out)
}
