//! Developer diagnostics, enabled only by launch flags. Not part of the user workflow.
//!
//! `--stress=<cycles>`: repeated capture → all overlays visible → cancel cycles, for latency and
//! memory checks (ADR-013, ADR-019). Logs `[stress] … visible` while overlays are up and
//! `[stress] … settled` after a pause, so an external sampler knows when to measure.
//!
//! `--stress-export=<cycles>`: the same, but each cycle ends with an export
//! (`export::stress_export`: composition, PNG + TIFF, onto a private pasteboard) instead of Escape.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::export;
use crate::overlay::{self, CaptureState};

/// Pause before sampling, so WebKit helper processes of closed overlays can exit.
const SETTLE: Duration = Duration::from_secs(3);
/// How long the overlays stay up in each cycle.
const HOLD: Duration = Duration::from_secs(1);
const CYCLE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy)]
enum End {
    Cancel,
    Export,
}

pub fn start_from_args(app: &AppHandle) {
    let flag = |prefix: &str| {
        std::env::args().find_map(|arg| arg.strip_prefix(prefix)?.parse::<u32>().ok())
    };
    let run = match (flag("--stress="), flag("--stress-export=")) {
        (Some(cycles), _) if cycles > 0 => (cycles, End::Cancel),
        (_, Some(cycles)) if cycles > 0 => (cycles, End::Export),
        _ => return,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = stress(&app, run.0, run.1) {
            eprintln!("[stress] failed: {err}");
        }
    });
}

fn stress(app: &AppHandle, cycles: u32, end: End) -> Result<(), String> {
    std::thread::sleep(SETTLE);
    eprintln!("[stress] baseline settled");
    let state = app.state::<CaptureState>();
    for cycle in 1..=cycles {
        let started = Instant::now();
        let handle = app.clone();
        app.run_on_main_thread(move || overlay::start(&handle))
            .map_err(|e| e.to_string())?;
        wait(started, || state.all_visible())
            .map_err(|()| format!("cycle {cycle}: overlays did not appear"))?;
        eprintln!("[stress] cycle {cycle} visible");
        std::thread::sleep(HOLD);
        let session = state
            .active()
            .ok_or(format!("cycle {cycle}: capture ended early"))?;
        match end {
            // Same path as Escape (`overlay_cancel`).
            End::Cancel => overlay::close_on_main_thread(app, session, None),
            End::Export => {
                let line = export::stress_export(app, session)
                    .map_err(|e| format!("cycle {cycle}: export failed: {e}"))?;
                eprintln!("[stress] cycle {cycle} exported {line}");
            }
        }
        wait(started, || !state.is_busy())
            .map_err(|()| format!("cycle {cycle}: overlays did not close"))?;
        std::thread::sleep(SETTLE);
        eprintln!("[stress] cycle {cycle} settled");
    }
    eprintln!("[stress] done");
    Ok(())
}

fn wait(started: Instant, done: impl Fn() -> bool) -> Result<(), ()> {
    while !done() {
        if started.elapsed() > CYCLE_TIMEOUT {
            return Err(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
