//! kasaspace — 터미널 한 장에서 시작하는 작업환경.
//!
//! 터미널 자체는 만들지 않는다. PTY 생성·VT 파싱은 `kasa_pty`, 셀을 GPU 로
//! 칠하는 건 `kasa_cells` — 둘 다 upstream(2rami/kasaterm) 것을 그대로 쓴다.
//! 여기 있는 코드는 그 둘을 창 하나에 묶는 배선이고, 앞으로 붙을 것(pane 분할,
//! 파일트리, git, 에이전트)이 자랄 자리다.

mod grid;
mod keys;
mod render;

use std::sync::Arc;

use anyhow::Result;
use kasa_bridge::ScreenUpdate;
use kasa_pty::{PtyOptions, PtySession};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, Ime, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::ModifiersState;
use winit::window::{Window, WindowId};

use grid::Grid;
use render::Renderer;

/// 논리 px 기준 글자 크기. 물리 px 은 여기에 창의 scale factor 를 곱한다 —
/// 안 그러면 고DPI 화면에서 글자가 절반 크기로 나온다.
const FONT_LOGICAL_PX: f32 = 15.0;

/// PTY 리더 스레드가 GUI 스레드를 깨우는 통로. 이 방식이라야 이벤트 루프를
/// `Wait` 로 둘 수 있다 — `Poll` + 폴링이면 아무 출력이 없어도 CPU 를 계속 먹는다.
enum Wake {
    Screen(Box<ScreenUpdate>),
    /// 테스트 하네스가 주입하는 입력. 창에 포커스를 주지 않고도 키 경로 뒤쪽
    /// (PTY 왕복 · 화면 갱신)을 검증하려고 둔다. OS 로 키를 쏘는 방식은 포커스가
    /// 다른 창에 있으면 **엉뚱한 앱에 타이핑된다** — 한 번 겪었다.
    Input(Vec<u8>),
    Quit,
}

struct Space {
    window: Arc<Window>,
    renderer: Renderer,
    session: PtySession,
    grid: Grid,
    mods: ModifiersState,
    /// IME 조합 중인지. 조합 중에는 같은 키가 KeyboardInput 으로도 오기 때문에
    /// 막지 않으면 자모가 한 번 더 셸에 들어간다.
    composing: bool,
}

struct App {
    proxy: EventLoopProxy<Wake>,
    space: Option<Space>,
}

impl App {
    fn boot(&mut self, el: &ActiveEventLoop) -> Result<Space> {
        let attrs = Window::default_attributes()
            .with_title("kasaspace")
            .with_inner_size(winit::dpi::LogicalSize::new(1100, 700));
        let window = Arc::new(el.create_window(attrs)?);
        window.set_ime_allowed(true);

        let font_px = (FONT_LOGICAL_PX * window.scale_factor() as f32).round();
        let renderer = pollster::block_on(Renderer::new(window.clone(), font_px))?;
        let (cols, rows) = renderer.grid_size();

        let session = PtySession::start(PtyOptions {
            cols,
            rows,
            pane_id: "%0".to_string(),
            ..Default::default()
        })?;

        // 리시버를 복제해 전용 스레드에 넘긴다. 원본은 세션이 계속 들고 있어도
        // crossbeam 채널은 소비자가 여럿이어도 되고, 우리는 이 스레드 하나만 쓴다.
        let rx = session.screens.clone();
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            while let Ok(update) = rx.recv() {
                if proxy.send_event(Wake::Screen(Box::new(update))).is_err() {
                    break; // 이벤트 루프가 끝났다.
                }
            }
        });

        self.arm_harness();

        Ok(Space {
            window,
            renderer,
            session,
            grid: Grid::new(cols, rows),
            mods: ModifiersState::empty(),
            composing: false,
        })
    }

    /// 헤드리스 검증 손잡이. 제품 동작에는 관여하지 않고, env 가 있을 때만 깨어난다.
    ///   KASASPACE_AUTOSEND="dir" KASASPACE_AUTOSEND_MS=2000 KASASPACE_AUTOQUIT_MS=6000
    fn arm_harness(&self) {
        let ms = |k: &str, d: u64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(d)
        };
        if let Ok(text) = std::env::var("KASASPACE_AUTOSEND") {
            let delay = ms("KASASPACE_AUTOSEND_MS", 2000);
            let proxy = self.proxy.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                let mut bytes = text.into_bytes();
                bytes.push(b'\r');
                let _ = proxy.send_event(Wake::Input(bytes));
            });
        }
        if std::env::var("KASASPACE_AUTOQUIT_MS").is_ok() {
            let delay = ms("KASASPACE_AUTOQUIT_MS", 8000);
            let proxy = self.proxy.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                let _ = proxy.send_event(Wake::Quit);
            });
        }
    }
}

impl ApplicationHandler<Wake> for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.space.is_some() {
            return;
        }
        match self.boot(el) {
            Ok(space) => self.space = Some(space),
            Err(e) => {
                eprintln!("기동 실패: {e:?}");
                el.exit();
            }
        }
    }

    fn user_event(&mut self, el: &ActiveEventLoop, wake: Wake) {
        let Some(sp) = self.space.as_mut() else { return };
        let update = match wake {
            Wake::Screen(u) => u,
            Wake::Input(bytes) => {
                let _ = sp.session.send_bytes(&bytes);
                return;
            }
            Wake::Quit => {
                el.exit();
                return;
            }
        };
        sp.grid.apply(&update);
        if sp.grid.eof {
            el.exit();
            return;
        }
        if let Some(t) = &sp.grid.title {
            sp.window.set_title(&format!("kasaspace — {t}"));
        }
        sp.window.request_redraw();
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(sp) = self.space.as_mut() else { return };
        match event {
            WindowEvent::CloseRequested => el.exit(),

            WindowEvent::Resized(size) => {
                sp.renderer.resize(size.width, size.height);
                let (cols, rows) = sp.renderer.grid_size();
                // PTY 를 먼저 맞춘다. 셸이 새 폭으로 다시 그린 결과가
                // ScreenUpdate 로 돌아오면서 그리드도 같이 갱신된다.
                let _ = sp.session.resize(cols, rows);
                sp.window.request_redraw();
            }

            WindowEvent::ModifiersChanged(m) => sp.mods = m.state(),

            WindowEvent::Ime(ime) => match ime {
                Ime::Preedit(text, _) => sp.composing = !text.is_empty(),
                Ime::Commit(text) => {
                    sp.composing = false;
                    let _ = sp.session.send_bytes(text.as_bytes());
                }
                _ => {}
            },

            WindowEvent::KeyboardInput { event, .. } => {
                if event.state != ElementState::Pressed || sp.composing {
                    return;
                }
                if let Some(bytes) = keys::encode(&event, sp.mods, sp.grid.app_cursor) {
                    let _ = sp.session.send_bytes(&bytes);
                }
            }

            WindowEvent::RedrawRequested => {
                if let Err(e) = sp.renderer.draw(&sp.grid) {
                    eprintln!("그리기 실패: {e:?}");
                }
            }

            _ => {}
        }
    }
}

fn main() -> Result<()> {
    let event_loop = EventLoop::<Wake>::with_user_event().build()?;
    // 그릴 게 생겼을 때만 깬다. PTY 출력은 Wake 로 들어오고, 나머지는 창 이벤트다.
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let mut app = App { proxy, space: None };
    event_loop.run_app(&mut app)?;
    Ok(())
}
