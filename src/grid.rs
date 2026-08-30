//! 화면 모델. `PtySession` 이 뱉는 `ScreenUpdate` 는 **바뀐 줄만** 담은 diff 라,
//! 그대로 그리면 화면이 조각난다. 여기서 전체 그리드를 들고 있으면서 diff 를
//! 덮어써 "지금 화면"을 유지한다.

use kasa_bridge::{Cell, Color, ScreenUpdate};

pub struct Grid {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Vec<Cell>>,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    /// DECCKM. 켜져 있으면 방향키를 CSI 대신 SS3 로 보내야 한다 — 안 그러면
    /// readline/vim/claude 안에서 커서 이동이 조용히 먹통이 된다.
    pub app_cursor: bool,
    pub bracketed_paste: bool,
    pub title: Option<String>,
    pub eof: bool,
}

impl Grid {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            cells: vec![vec![Cell::blank(); cols as usize]; rows as usize],
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            app_cursor: false,
            bracketed_paste: false,
            title: None,
            eof: false,
        }
    }

    pub fn apply(&mut self, up: &ScreenUpdate) {
        if up.eof {
            self.eof = true;
            return;
        }
        if up.rows != self.rows || up.cols != self.cols {
            self.rows = up.rows;
            self.cols = up.cols;
            self.cells = vec![vec![Cell::blank(); up.cols as usize]; up.rows as usize];
        }
        for (r, row) in &up.dirty {
            let Some(dst) = self.cells.get_mut(*r as usize) else {
                continue;
            };
            for (c, cell) in row.iter().enumerate() {
                if c >= dst.len() {
                    break;
                }
                dst[c] = cell.clone();
            }
            // diff 가 짧은 줄을 주면 나머지는 이전 프레임 잔상이다. 지운다.
            for c in row.len()..dst.len() {
                dst[c] = Cell::blank();
            }
        }
        self.cursor_row = up.cursor_row;
        self.cursor_col = up.cursor_col;
        self.cursor_visible = up.cursor_visible;
        self.app_cursor = up.app_cursor;
        self.bracketed_paste = up.bracketed_paste;
        if up.title.is_some() {
            self.title = up.title.clone();
        }
    }
}

pub const BG: [f32; 4] = [0.055, 0.063, 0.078, 1.0];
pub const FG: [f32; 4] = [0.855, 0.878, 0.914, 1.0];

/// ANSI 0-15. 밝기·채도를 한 계열로 맞춘 값 — 터미널 색이 제각각으로 튀면
/// 출력이 정보가 아니라 소음이 된다.
const ANSI16: [[u8; 3]; 16] = [
    [0x1c, 0x20, 0x28], [0xe0, 0x60, 0x60], [0x7d, 0xc4, 0x8f], [0xd8, 0xb4, 0x6a],
    [0x6c, 0xa8, 0xe8], [0xb4, 0x8e, 0xe0], [0x5c, 0xc0, 0xc0], [0xc0, 0xc6, 0xd0],
    [0x4a, 0x52, 0x60], [0xf0, 0x80, 0x80], [0x98, 0xd8, 0xa8], [0xe8, 0xcc, 0x88],
    [0x8c, 0xc0, 0xf4], [0xcc, 0xac, 0xf0], [0x7c, 0xd8, 0xd8], [0xf0, 0xf4, 0xfa],
];

fn u8_rgb(r: u8, g: u8, b: u8) -> [f32; 4] {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0]
}

/// 256색 인덱스를 실제 색으로. 16-231 은 6x6x6 큐브, 232-255 는 회색 24단.
pub fn resolve(color: &Color, fallback: [f32; 4]) -> [f32; 4] {
    match color {
        Color::Default => fallback,
        Color::Rgb(r, g, b) => u8_rgb(*r, *g, *b),
        Color::Idx(i) if *i < 16 => {
            let c = ANSI16[*i as usize];
            u8_rgb(c[0], c[1], c[2])
        }
        Color::Idx(i) if *i < 232 => {
            let n = *i as u32 - 16;
            let lv = |v: u32| if v == 0 { 0u8 } else { (55 + v * 40) as u8 };
            u8_rgb(lv(n / 36), lv((n / 6) % 6), lv(n % 6))
        }
        Color::Idx(i) => {
            let v = 8 + (*i as u32 - 232) * 10;
            u8_rgb(v as u8, v as u8, v as u8)
        }
    }
}
