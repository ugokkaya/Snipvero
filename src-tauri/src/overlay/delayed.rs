//! Recapture after giving the previous app time to open transient UI. Only a nonactivating,
//! click-through indicator is shown during the wait; hide it before reading the screen pixels.

use super::*;

const DELAY: Duration = Duration::from_secs(5);

fn countdown_tick(elapsed: Duration) -> Option<(u64, bool)> {
    let remaining = DELAY.checked_sub(elapsed)?;
    if remaining.is_zero() {
        return None;
    }
    Some((
        remaining.as_nanos().div_ceil(1_000_000_000) as u64,
        (elapsed.as_millis() / 500).is_multiple_of(2),
    ))
}

/// Wait for main-thread indicator updates, especially the final hide, before reading pixels.
/// Session validation here also prevents ticks from an old timer touching a later capture.
fn tick_on_main(app: &AppHandle, session: u64, tick: Option<(u64, bool)>) -> bool {
    let (done, wait) = std::sync::mpsc::channel();
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let active = handle
                .state::<CaptureState>()
                .session()
                .as_ref()
                .is_some_and(|s| s.id == session && s.delayed);
            if active {
                #[cfg(target_os = "macos")]
                match tick {
                    Some((seconds, bright)) => macos::update_countdown(session, seconds, bright),
                    None => macos::hide_countdown(session),
                }
                #[cfg(not(target_os = "macos"))]
                let _ = tick;
            }
            let _ = done.send(active);
        })
        .is_err()
    {
        return false;
    }
    wait.recv().unwrap_or(false)
}

impl Session {
    fn begin_delay(&mut self, index: usize, region: PixelRect) -> Result<(), String> {
        if self.exporting || self.delayed || !self.all_shown() {
            return Err("capture is not ready for a delayed screenshot".into());
        }
        self.select(index, Some(region))?;
        self.delayed = true;
        Ok(())
    }

    /// Match by display identity, not enumeration order. Never silently move a saved region to
    /// another screen or reuse pixel coordinates after a resolution/scale change.
    fn recaptured(&self, id: u64, frames: Vec<Frame>) -> Result<Session, String> {
        let selection = self.selection.ok_or("no selected region")?;
        let old = self
            .frames
            .get(selection.index)
            .ok_or("no selected display")?;
        let index = frames
            .iter()
            .position(|f| f.display_id == old.display_id)
            .ok_or(tr!(
                "The selected display was disconnected. Please capture again.",
                "Seçilen ekranın bağlantısı kesildi. Lütfen yeniden yakalayın."
            ))?;
        let frame = &frames[index];
        let captured: Vec<_> = self.frames.iter().map(|f| f.bounds).collect();
        let current: Vec<_> = frames.iter().map(|f| f.bounds).collect();
        if !same_displays(&captured, &current)
            || frame.bounds != old.bounds
            || frame.width != old.width
            || frame.height != old.height
            || frame.scale != old.scale
        {
            return Err(tr!(
                "The displays changed. Please take the screenshot again.",
                "Ekranlar değişti. Lütfen ekran görüntüsünü yeniden alın."
            )
            .into());
        }
        let mut next = Session::new(id, frames, Instant::now(), index, self.previous_app)?;
        next.select(index, selection.region)?;
        next.mode = self.mode;
        Ok(next)
    }
}

#[tauri::command]
pub fn overlay_capture_delayed(
    app: AppHandle,
    window: WebviewWindow,
    session: u64,
    region: PixelRect,
    state: State<CaptureState>,
) -> Result<(), String> {
    let index = index_from_label(window.label()).ok_or("not an overlay window")?;
    let (previous, frame) = {
        let mut guard = state.session();
        let s = guard
            .as_mut()
            .filter(|s| s.id == session)
            .ok_or("capture no longer active")?;
        s.begin_delay(index, region)?;
        (s.previous_app, s.frames[index].clone())
    };
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX)
            && let Err(err) = window.hide()
        {
            close(&app, session);
            fail(
                &app,
                tr!(
                    "Could not hide the capture overlays. Please try again.",
                    "Yakalama katmanları gizlenemedi. Lütfen yeniden deneyin."
                ),
            );
            return Err(err.to_string());
        }
    }
    if let Some(previous) = previous {
        system::activate_app(previous);
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::show_countdown(
        session,
        frame.bounds,
        region,
        (frame.width, frame.height),
        DELAY.as_secs(),
    ) {
        close(&app, session);
        fail(&app, &error);
        return Err(error);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = frame;
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            std::thread::sleep(
                Duration::from_millis(500).min(DELAY.saturating_sub(started.elapsed())),
            );
            let tick = countdown_tick(started.elapsed());
            if !tick_on_main(&app, session, tick) {
                return;
            }
            if tick.is_none() {
                break;
            }
        }
        // ScreenCaptureKit reads the dropdown before anything reactivates Snipvero.
        let result = capture::capture_displays()
            .map(|(frames, _)| frames)
            .map_err(|e| e.to_string());
        let handle = app.clone();
        if let Err(err) = app.run_on_main_thread(move || finish(&handle, session, result)) {
            eprintln!("[capture] could not finish delayed capture: {err}");
        }
    });
    Ok(())
}

fn finish(app: &AppHandle, session: u64, frames: Result<Vec<Frame>, String>) {
    let state = app.state::<CaptureState>();
    let next = {
        let mut guard = state.session();
        let Some(current) = guard.as_ref().filter(|s| s.id == session && s.delayed) else {
            return; // Cancelled, including while the native capture was running.
        };
        let id = state.next_session.fetch_add(1, Ordering::Relaxed) + 1;
        match frames.and_then(|frames| current.recaptured(id, frames)) {
            Ok(next) => {
                let count = next.frames.len();
                *guard = Some(next);
                Ok((id, count))
            }
            Err(error) => Err(error),
        }
    };
    match next {
        Ok((id, count)) => {
            watch_readiness(app, id);
            for index in 0..count {
                if let Err(error) = app.emit_to(label(index), events::OVERLAY_LOAD, id) {
                    close_on_main_thread(app, id, Some(error.to_string()));
                    break;
                }
            }
        }
        Err(error) => {
            if close(app, session) {
                fail(app, &error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn countdown_uses_deadline_not_tick_count_and_pulses_only_the_border() {
        assert_eq!(countdown_tick(Duration::ZERO), Some((5, true)));
        assert_eq!(countdown_tick(Duration::from_millis(500)), Some((5, false)));
        assert_eq!(countdown_tick(Duration::from_secs(1)), Some((4, true)));
        assert_eq!(countdown_tick(Duration::from_millis(2400)), Some((3, true)));
        assert_eq!(countdown_tick(Duration::from_secs(4)), Some((1, true)));
        assert_eq!(
            countdown_tick(DELAY - Duration::from_nanos(1)),
            Some((1, false))
        );
        assert_eq!(countdown_tick(DELAY), None);
        assert_eq!(countdown_tick(DELAY + Duration::from_secs(1)), None);
    }

    fn frame(id: u32, x: f64, scale: f64) -> Frame {
        Frame {
            display_id: id,
            bounds: LogicalRect {
                x,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            scale,
            width: (100.0 * scale) as u32,
            height: (100.0 * scale) as u32,
            bgra: vec![id as u8; 4],
        }
    }

    const REGION: PixelRect = PixelRect {
        x: 10,
        y: 20,
        width: 50,
        height: 60,
    };

    fn session() -> Session {
        let mut s = Session::new(
            1,
            vec![frame(10, -100.0, 1.0), frame(20, 0.0, 2.0)],
            Instant::now(),
            0,
            Some(42),
        )
        .unwrap();
        s.shown.fill(true);
        s
    }

    #[test]
    fn delay_validates_before_locking_and_rejects_duplicate_or_export() {
        let mut s = session();
        assert!(s.begin_delay(9, REGION).is_err());
        assert!(s.begin_delay(0, PixelRect { width: 0, ..REGION }).is_err());
        assert!(!s.delayed);
        s.exporting = true;
        assert!(s.begin_delay(1, REGION).is_err());
        s.exporting = false;
        s.shown[0] = false;
        assert!(s.begin_delay(1, REGION).is_err());
        s.shown[0] = true;
        s.begin_delay(1, REGION).unwrap();
        assert!(s.begin_delay(1, REGION).is_err());
        assert!(s.begin_export(1, REGION).is_err());
        assert!(s.select(0, None).is_err());
    }

    #[test]
    fn recapture_keeps_region_and_focus_on_same_display_with_fresh_pixels() {
        let mut s = session();
        s.begin_delay(1, REGION).unwrap();
        let mut fresh = frame(20, 0.0, 2.0);
        fresh.bgra = vec![99; 4];
        let next = s
            .recaptured(2, vec![fresh, frame(10, -100.0, 1.0)])
            .unwrap();
        assert_eq!(next.id, 2);
        assert_eq!(next.focus, 0);
        assert_eq!(next.previous_app, Some(42));
        assert_eq!(
            next.selection,
            Some(Selection {
                index: 0,
                region: Some(REGION)
            })
        );
        assert_eq!(next.frames[0].bgra, vec![99; 4]);
        assert!(!next.delayed);
        assert!(!next.all_shown());
    }

    #[test]
    fn display_removal_replacement_rearrangement_or_scale_change_is_refused() {
        let mut s = session();
        s.begin_delay(1, REGION).unwrap();
        for frames in [
            vec![],
            vec![frame(10, -100.0, 1.0)],
            vec![frame(10, -100.0, 1.0), frame(30, 0.0, 2.0)],
            vec![frame(10, -100.0, 1.0), frame(20, 100.0, 2.0)],
            vec![frame(10, -100.0, 1.0), frame(20, 0.0, 1.0)],
        ] {
            assert!(s.recaptured(2, frames).is_err());
        }
    }

    #[test]
    fn delay_keeps_capture_update_lock_and_can_be_cancelled_by_shortcut() {
        let state = CaptureState::default();
        assert!(state.try_begin());
        let mut s = session();
        s.begin_delay(1, REGION).unwrap();
        *state.session() = Some(s);
        assert!(!state.reserve_for_update());
        assert!(!state.all_visible());
        assert!(state.may_cancel(1));
        assert_eq!(state.on_shortcut(), ShortcutPress::Cancel(1));
        assert_eq!(state.end(1), Some(Some(42)));
        assert!(!state.is_active(1));
        assert!(state.try_begin());
        *state.session() = Some(Session { id: 2, ..session() });
        assert_eq!(state.end(1), None);
        assert_eq!(state.active(), Some(2));
    }
}
