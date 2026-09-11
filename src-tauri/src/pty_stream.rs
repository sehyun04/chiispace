use kasa_pty::PtySession;
use std::sync::Weak;
use std::time::Duration;

// 끊긴 VT 명령·동기 출력 상태를 끝낸 뒤 스냅샷으로 교체해야 중복 이력이 남지 않는다.
const RESYNC: &[u8] = b"\x18\x1b[?2026l\x1bc";

pub enum Event {
    Data(Vec<u8>),
    Exit,
}

struct ShellExit {
    #[cfg(windows)]
    handle: Option<std::os::windows::io::OwnedHandle>,
}

impl ShellExit {
    fn new(pty: &PtySession) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            // PID는 재사용되므로 시작 때 얻은 핸들로 같은 셸의 종료만 관찰한다.
            let handle = pty.shell_pid().and_then(|pid| unsafe {
                let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
                (!handle.is_null())
                    .then(|| std::os::windows::io::OwnedHandle::from_raw_handle(handle))
            });
            Self { handle }
        }
        #[cfg(not(windows))]
        {
            let _ = pty;
            Self {}
        }
    }

    fn exited(&self) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            self.handle.as_ref().is_some_and(|handle| unsafe {
                WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_OBJECT_0
            })
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}

pub fn forward(session: Weak<PtySession>, mut emit: impl FnMut(Event) -> bool) {
    let Some(pty) = session.upgrade() else { return };
    let (mut rx, seed) = pty.tap_bytes_with_snapshot();
    let screens = pty.screens.clone();
    let shell = ShellExit::new(&pty);
    drop(pty);
    if !emit(Event::Data(seed)) {
        return;
    }
    let mut eof = false;
    loop {
        if session.strong_count() == 0 {
            return;
        }
        // 바이트 구독은 64청크 지연만으로도 끊어진다. 실제 EOF는 엔진의 별도 센티널이다.
        eof |= screens.try_iter().any(|screen| screen.eof);
        if eof {
            for bytes in rx.try_iter() {
                if !emit(Event::Data(bytes)) {
                    return;
                }
            }
            emit(Event::Exit);
            return;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(mut bytes) => {
                // 작은 청크마다 웹뷰 호출을 쌓으면 소비자가 더 쉽게 구독 한도를 넘는다.
                while bytes.len() < 65536 {
                    let Ok(next) = rx.try_recv() else { break };
                    bytes.extend(next);
                }
                if !emit(Event::Data(bytes)) {
                    return;
                }
            }
            Err(error) if error.is_disconnected() => {
                eof |= screens.try_iter().any(|screen| screen.eof);
                if eof {
                    continue;
                }
                let Some(pty) = session.upgrade() else { return };
                // Weak만 유지해야 사용자가 칸을 닫았을 때 셸의 수명을 붙잡지 않는다.
                // 재구독도 스냅샷과 원자적이어야 그 사이의 출력이 유실되지 않는다.
                let (next, seed) = pty.tap_bytes_with_snapshot();
                drop(pty);
                rx = next;
                let mut bytes = RESYNC.to_vec();
                bytes.extend(seed);
                eprintln!("[chiispace] PTY display subscription recovered; shell preserved");
                if !emit(Event::Data(bytes)) {
                    return;
                }
            }
            // ConPTY는 셸이 끝나도 호스트가 열린 동안 EOF를 주지 않을 수 있다.
            // 먼저 남은 바이트를 비우고 조용해진 뒤에만 종료를 알린다.
            Err(_) => eof = shell.exited(),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use kasa_pty::PtyOptions;
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};

    fn shell(id: &str) -> Arc<PtySession> {
        crate::conpty::load(&std::env::temp_dir().join("chiispace-stream-test-runtime")).unwrap();
        let pty = Arc::new(
            PtySession::start(PtyOptions {
                shell: Some(
                    std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                        .join("System32")
                        .join("cmd.exe")
                        .to_string_lossy()
                        .into_owned(),
                ),
                cols: 100,
                rows: 30,
                pane_id: id.into(),
                cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                ..Default::default()
            })
            .unwrap(),
        );
        // 셸 준비 지연과 화면 구독 지연을 섞으면 테스트 명령 자체가 유실될 수 있다.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pty.visible_text(30).contains('>') {
            assert!(
                Instant::now() < deadline,
                "검증 셸 준비 실패: {:?}",
                pty.visible_text(30)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        pty.send_bytes(b"\r").unwrap();
        std::thread::sleep(Duration::from_millis(250));
        pty
    }

    #[test]
    fn display_failure_is_not_exit_and_pump_does_not_keep_the_shell_alive() {
        let pty = shell("stream-close-test");
        let mut delivered = 0;
        forward(Arc::downgrade(&pty), |event| {
            assert!(
                matches!(event, Event::Data(_)),
                "화면 전송 실패를 종료로 오인"
            );
            delivered += 1;
            false
        });
        assert_eq!(delivered, 1);
        assert_eq!(Arc::strong_count(&pty), 1);
        let weak = Arc::downgrade(&pty);
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            forward(weak, |_| {
                let _ = started_tx.send(());
                true
            });
            done_tx.send(()).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(pty);
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("닫은 칸의 펌프가 세션 수명을 붙잡음");
        worker.join().unwrap();
    }

    #[test]
    fn slow_display_does_not_close_a_live_shell() {
        let pty = shell("stream-test");
        let (started_tx, started_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let weak = Arc::downgrade(&pty);
        let worker = std::thread::spawn(move || {
            let mut first = true;
            forward(weak, |event| {
                if first {
                    first = false;
                    started_tx.send(()).unwrap();
                    // 웹뷰 전송이 밀리는 동안에도 PTY 리더는 계속 출력한다.
                    if resume_rx.recv_timeout(Duration::from_secs(20)).is_err() {
                        return false;
                    }
                }
                event_tx.send(event).is_ok()
            });
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let observer = pty.tap_bytes();
        pty.send_bytes(b"powershell.exe -NoProfile -Command \"1..400 | ForEach-Object { [Console]::WriteLine('STREAM-BURST-' + $_); Start-Sleep -Milliseconds 10 }; [Console]::WriteLine('STREAM-END')\"\r").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut chunks = 0;
        let mut bytes = Vec::new();
        while Instant::now() < deadline {
            if let Ok(part) = observer.recv_timeout(Duration::from_millis(100)) {
                chunks += 1;
                bytes.extend(part);
                if chunks > 100 && String::from_utf8_lossy(&bytes).contains("STREAM-BURST-400") {
                    break;
                }
            }
        }
        assert!(chunks > 64, "구독 한도를 넘기는 출력 재현 실패: {chunks}");
        resume_tx.send(()).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut received = Vec::new();
            let mut resynced = false;
            while Instant::now() < deadline {
                match event_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(Event::Exit) => panic!("화면 지연을 셸 종료로 오인"),
                    Ok(Event::Data(part)) => {
                        resynced |= part.starts_with(RESYNC);
                        received.extend(part);
                        if String::from_utf8_lossy(&received).contains("STREAM-BURST-400") {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => panic!("출력 연결 조기 종료"),
                    Err(_) => {}
                }
            }
            assert!(
                String::from_utf8_lossy(&received).contains("STREAM-BURST-400"),
                "최신 화면 재연결 실패"
            );
            assert!(resynced, "끊긴 스트림의 파서 상태 초기화 누락");
            pty.send_bytes(b"echo STREAM-AFTER-RECOVERY & exit\r")
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                assert!(Instant::now() < deadline, "재연결 뒤 셸 입력 실패");
                match event_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(Event::Data(part))
                        if String::from_utf8_lossy(&part).contains("STREAM-AFTER-RECOVERY") =>
                    {
                        break
                    }
                    Ok(Event::Exit) => panic!("살아 있는 셸의 잘못된 종료"),
                    _ => {}
                }
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                assert!(Instant::now() < deadline, "실제 셸 종료 누락");
                if matches!(
                    event_rx.recv_timeout(Duration::from_millis(100)),
                    Ok(Event::Exit)
                ) {
                    break;
                }
            }
        }));
        drop(pty);
        drop(event_rx);
        worker.join().unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
}
