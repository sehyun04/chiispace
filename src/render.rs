//! wgpu 표면 + kasa-cells 파이프라인. 이 파일이 하는 일은 딱 하나 —
//! `Grid` 한 장을 인스턴스 배열로 펴서 드로우콜 하나에 넘긴다.

use std::sync::Arc;

use anyhow::{Context, Result};
use kasa_cells::{pipeline::CellInstance, Atlas, GlyphKey, Pipeline, Shaper};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use winit::window::Window;

use crate::grid::{self, Grid};

/// 셀 격자 바깥 여백(물리 px). 글자가 창 모서리에 붙으면 읽기 불편하다.
const PAD: f32 = 10.0;

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: Pipeline,
    atlas: Atlas,
    shaper: Shaper,
    bind_group: wgpu::BindGroup,
    font_px: f32,
    pub cell_w: f32,
    pub cell_h: f32,
}

/// 주 폰트와 폴백 사슬. 주 폰트는 반드시 등폭이어야 한다 — 셀 폭을 'M' 하나로
/// 재기 때문에 가변폭을 물리면 격자 전체가 어긋난다. 폴백은 없는 파일을 조용히
/// 건너뛰므로 플랫폼별 목록을 그냥 늘어놓아도 된다.
fn font_chain() -> (String, Vec<String>) {
    if let Ok(p) = std::env::var("KASASPACE_FONT") {
        return (p, Vec::new());
    }
    if cfg!(windows) {
        (
            "C:/Windows/Fonts/consola.ttf".into(),
            vec![
                "C:/Windows/Fonts/malgun.ttf".into(),   // 한글
                "C:/Windows/Fonts/seguiemj.ttf".into(), // 이모지
                "C:/Windows/Fonts/seguisym.ttf".into(), // 박스 드로잉·기호
            ],
        )
    } else {
        (
            "/System/Library/Fonts/Menlo.ttc".into(),
            vec![
                "/System/Library/Fonts/AppleSDGothicNeo.ttc".into(),
                "/System/Library/Fonts/Apple Color Emoji.ttc".into(),
            ],
        )
    }
}

impl Renderer {
    pub async fn new(window: Arc<Window>, font_px: f32) -> Result<Self> {
        let instance = wgpu::Instance::default();
        let size = window.inner_size();
        let target = wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: window.display_handle()?.as_raw(),
            raw_window_handle: window.window_handle()?.as_raw(),
        };
        // SAFETY: surface 는 window(Arc) 보다 오래 살지 않는다 — 둘 다 App 이
        // 같이 들고 있다가 같이 떨군다.
        let surface = unsafe { instance.create_surface_unsafe(target)? };
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .context("쓸 수 있는 wgpu 어댑터가 없다")?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("kasaspace device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::default(),
                experimental_features: wgpu::ExperimentalFeatures::default(),
                trace: wgpu::Trace::Off,
            })
            .await?;

        let caps = surface.get_capabilities(&adapter);
        // 일부러 **비-sRGB** 포맷을 고른다. 셰이더도 우리 색값도 이미 감마
        // 인코딩된 sRGB 바이트라, sRGB 표면을 잡으면 GPU 가 한 번 더 인코딩해
        // 화면 전체가 뿌옇게 뜬다(배경 #0E1014 가 #3F4247 로 나왔다).
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or_else(|| caps.formats[0].remove_srgb_suffix());
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let (primary, fallbacks) = font_chain();
        let mut shaper = Shaper::from_path(&primary, 0)
            .with_context(|| format!("주 폰트를 못 읽었다: {primary}"))?;
        for f in &fallbacks {
            shaper.add_fallback_path(f, 0);
        }
        let cell_w = shaper.cell_advance(font_px).ceil();
        let cell_h = (font_px * 1.4).ceil();

        let mut atlas = Atlas::new(&device, &queue, 2048);
        // 출력 가능한 ASCII 는 미리 구워 둔다. 첫 프레임에 백몇 개를 한꺼번에
        // 래스터라이즈하면 그 프레임만 눈에 띄게 늦는다.
        for code in 0x20u32..0x7Fu32 {
            if let Some(ch) = char::from_u32(code) {
                for bold in [false, true] {
                    let key = GlyphKey {
                        ch,
                        bold,
                        italic: false,
                        size_px: font_px as u32,
                        font: 0,
                    };
                    let _ = atlas.get_or_bake(&device, &queue, &mut shaper, key);
                }
            }
        }

        // `Pipeline::new` 이 아니라 이쪽이어야 한다 — new 는 non-filtering 샘플러를
        // 바인딩 레이아웃에 선언하는데 `Atlas` 가 주는 샘플러는 Linear(filtering)라
        // 바인드그룹 생성에서 검증 오류로 패닉한다. 엔진에 딸려 온 grid_bw 예제는
        // 이 점에서 낡았다.
        let pipeline = Pipeline::with_filtering(&device, format, 65_536, true);
        pipeline.write_uniforms(&queue, [config.width as f32, config.height as f32]);
        let bind_group = pipeline.make_bind_group(&device, atlas.view(), atlas.sampler());

        Ok(Self {
            surface,
            device,
            queue,
            config,
            pipeline,
            atlas,
            shaper,
            bind_group,
            font_px,
            cell_w,
            cell_h,
        })
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        self.config.width = w.max(1);
        self.config.height = h.max(1);
        self.surface.configure(&self.device, &self.config);
        self.pipeline.write_uniforms(
            &self.queue,
            [self.config.width as f32, self.config.height as f32],
        );
    }

    /// 지금 창 크기에 몇 칸이 들어가는지. PTY 를 이 크기로 맞춰야 셸이
    /// 줄바꿈을 제자리에 넣는다.
    pub fn grid_size(&self) -> (u16, u16) {
        let cols = ((self.config.width as f32 - PAD * 2.0) / self.cell_w).floor();
        let rows = ((self.config.height as f32 - PAD * 2.0) / self.cell_h).floor();
        (cols.max(1.0) as u16, rows.max(1.0) as u16)
    }

    fn build(&mut self, g: &Grid) -> Vec<CellInstance> {
        let mut out: Vec<CellInstance> = Vec::with_capacity(g.rows as usize * g.cols as usize);

        // 1) 배경 먼저. 인스턴스는 넣은 순서대로 알파 합성되므로 배경 -> 커서 ->
        //    글자 순이 아니면 글자가 자기 배경에 덮인다.
        for (r, row) in g.cells.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let bg = if cell.inverse {
                    grid::resolve(&cell.fg, grid::FG)
                } else {
                    grid::resolve(&cell.bg, grid::BG)
                };
                if bg == grid::BG {
                    continue;
                }
                out.push(CellInstance {
                    cell_px: [
                        PAD + c as f32 * self.cell_w,
                        PAD + r as f32 * self.cell_h,
                        self.cell_w,
                        self.cell_h,
                    ],
                    uv_min: Atlas::SOLID_UV,
                    uv_max: Atlas::SOLID_UV,
                    fg_rgba: bg,
                    ..Default::default()
                });
            }
        }

        // 2) 커서 블록.
        if g.cursor_visible && (g.cursor_row as usize) < g.cells.len() {
            out.push(CellInstance {
                cell_px: [
                    PAD + g.cursor_col as f32 * self.cell_w,
                    PAD + g.cursor_row as f32 * self.cell_h,
                    self.cell_w,
                    self.cell_h,
                ],
                uv_min: Atlas::SOLID_UV,
                uv_max: Atlas::SOLID_UV,
                fg_rgba: grid::FG,
                ..Default::default()
            });
        }

        // 3) 글자.
        for (r, row) in g.cells.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                // NUL 은 와이드 글자(한글·CJK)의 뒷칸 자리표시자다. 그리면 안 된다.
                if cell.hidden || cell.ch == ' ' || cell.ch == '\u{0}' {
                    continue;
                }
                let mut fg = if cell.inverse {
                    grid::resolve(&cell.bg, grid::BG)
                } else {
                    grid::resolve(&cell.fg, grid::FG)
                };
                let on_cursor =
                    g.cursor_visible && r as u16 == g.cursor_row && c as u16 == g.cursor_col;
                if on_cursor {
                    fg = grid::BG;
                }
                if cell.dim {
                    fg[3] *= 0.6;
                }
                let key = GlyphKey {
                    ch: cell.ch,
                    bold: cell.bold,
                    italic: cell.italic,
                    size_px: self.font_px as u32,
                    font: 0,
                };
                let Some(e) =
                    self.atlas
                        .get_or_bake(&self.device, &self.queue, &mut self.shaper, key)
                else {
                    continue;
                };
                let baseline = PAD + r as f32 * self.cell_h + self.cell_h * 0.78;
                out.push(CellInstance {
                    cell_px: [
                        PAD + c as f32 * self.cell_w + e.bearing_x as f32,
                        baseline - e.bearing_y as f32,
                        e.px_w as f32,
                        e.px_h as f32,
                    ],
                    uv_min: e.uv_min,
                    uv_max: e.uv_max,
                    fg_rgba: fg,
                    flags: if e.is_color {
                        CellInstance::FLAG_COLOR
                    } else {
                        0
                    },
                    ..Default::default()
                });
            }
        }
        out
    }

    pub fn draw(&mut self, g: &Grid) -> Result<()> {
        let instances = self.build(g);
        self.pipeline
            .write_instances(&self.device, &self.queue, &instances);
        let frame = self.surface.get_current_texture()?;
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("kasaspace"),
            });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cells"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: grid::BG[0] as f64,
                            g: grid::BG[1] as f64,
                            b: grid::BG[2] as f64,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            self.pipeline
                .draw(&mut pass, &self.bind_group, instances.len() as u32);
        }
        self.queue.submit(Some(enc.finish()));
        frame.present();
        Ok(())
    }
}
