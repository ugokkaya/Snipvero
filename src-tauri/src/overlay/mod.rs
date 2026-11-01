//! Frozen-screen overlay: one borderless window per display showing that display's capture.
//! Scope: show the frame, select a region, annotate it, export it (`crate::export`) or cancel
//! with Escape, then give focus back. Selection and annotation run entirely in the overlay page;
//! Rust only records the selected region, so there is no IPC while the mouse moves. Annotations
//! reach Rust only as the rasterized layer of an export request.
//!
//! Overlay windows are pre-created hidden (one per display) and replaced by a fresh hidden set
//! after every capture: used windows are destroyed, because a hidden WebKit page keeps the
//! memory of a shown frame indefinitely (ADR-013).
//!
//! Every way a capture ends (Escape, a finished export, a failure, a display change) names the
//! session it ends, so a late or stale request can never close a newer capture (ADR-019).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::capture::{self, Frame};
use crate::events;
use crate::geometry::{LogicalRect, PixelRect};
use crate::system::{self, AppId};
use crate::transfer;

#[cfg(target_os = "macos")]
mod macos;

const LABEL_PREFIX: &str = "overlay-";

/// Pre-create overlays only where a capture backend exists to use them.
pub const PRECREATE: bool = cfg!(target_os = "macos");

/// Overlays normally show within half a second. One that never reports ready (a crashed or hung
/// page) would otherwise leave the capture busy and invisible, so shortcut and tray did nothing.
const READY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Default)]
pub struct CaptureState {
    /// Set while a capture is being taken or shown, so a second trigger is ignored.
    busy: AtomicBool,
    session: Mutex<Option<Session>>,
    next_session: AtomicU64,
}

pub struct Session {
    pub id: u64,
    pub frames: Vec<Arc<Frame>>,
    pub started: Instant,
    /// Frame on the display under the cursor; its overlay receives keyboard focus.
    pub focus: usize,
    /// Which overlays are shown, per frame. A window reporting ready twice counts once.
    pub shown: Vec<bool>,
    /// App to give focus back to when the overlays close.
    pub previous_app: Option<AppId>,
    /// The single selection of this capture, on one display (FR-3).
    pub selection: Option<Selection>,
    /// A copy or save is in progress; further export requests are rejected until it ends.
    pub exporting: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    /// Frame (and overlay) index of the display the selection is on.
    pub index: usize,
    /// `None` while the first selection on that display is still being dragged.
    pub region: Option<PixelRect>,
}

impl Session {
    /// A new capture of `frames`. Fails without frames: nothing could be shown or cancelled.
    pub fn new(
        id: u64,
        frames: Vec<Frame>,
        started: Instant,
        focus: usize,
        previous_app: Option<AppId>,
    ) -> Result<Self, String> {
        if frames.is_empty() {
            return Err("no display could be captured".into());
        }
        Ok(Session {
            id,
            shown: vec![false; frames.len()],
            frames: frames.into_iter().map(Arc::new).collect(),
            started,
            focus,
            previous_app,
            selection: None,
            exporting: false,
        })
    }

    /// Records overlay `index` as shown. Returns whether every overlay is now shown.
    fn mark_shown(&mut self, index: usize) -> Result<bool, String> {
        *self.shown.get_mut(index).ok_or("no such frame")? = true;
        Ok(self.all_shown())
    }

    pub fn all_shown(&self) -> bool {
        self.shown.iter().all(|&shown| shown)
    }

    /// Records the selection made on overlay `index`. Returns the overlay that held the previous
    /// selection if it was another one, so that overlay can clear it.
    fn select(&mut self, index: usize, region: Option<PixelRect>) -> Result<Option<usize>, String> {
        let frame = self.frames.get(index).ok_or("no such frame")?;
        if let Some(r) = region
            && !r.fits(frame.width, frame.height)
        {
            return Err(format!(
                "selection {r:?} is empty or outside the {}×{} frame",
                frame.width, frame.height
            ));
        }
        let previous = self.selection.map(|s| s.index).filter(|&i| i != index);
        self.selection = Some(Selection { index, region });
        Ok(previous)
    }

    /// Starts exporting `region` of overlay `index`, which becomes the selection (the page may
    /// export before its last `overlay_select` arrived). Returns the frame and, as `select`, an
    /// overlay to clear.
    fn begin_export(
        &mut self,
        index: usize,
        region: PixelRect,
    ) -> Result<(Arc<Frame>, Option<usize>), String> {
        if self.exporting {
            return Err("an export is already in progress".into());
        }
        let previous = self.select(index, Some(region))?;
        let frame = self.frames.get(index).ok_or("no such frame")?.clone();
        self.exporting = true;
        Ok((frame, previous))
    }
}

impl CaptureState {
    fn try_begin(&self) -> bool {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// Takes the capture lock for an update install, so no capture can start until the app
    /// restarts (or `release_update` after a failed install). False while a capture is open.
    pub fn reserve_for_update(&self) -> bool {
        self.try_begin()
    }

    /// Gives the capture lock back after a failed install; no capture exists while it is held.
    pub fn release_update(&self) {
        self.abort();
    }

    pub fn session(&self) -> MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True once every overlay of the current session is visible.
    pub fn all_visible(&self) -> bool {
        self.session().as_ref().is_some_and(Session::all_shown)
    }

    /// The active capture's ID, if any.
    pub fn active(&self) -> Option<u64> {
        self.session().as_ref().map(|s| s.id)
    }

    fn is_active(&self, session: u64) -> bool {
        self.active() == Some(session)
    }

    /// Whether Escape may end `session` now. Not during an export: the save panel is a sheet on
    /// one overlay, and destroying it under the open panel is not safe. The panel takes Escape
    /// itself; another display's overlay could still receive it after a click.
    fn may_cancel(&self, session: u64) -> bool {
        self.session()
            .as_ref()
            .is_some_and(|s| s.id == session && !s.exporting)
    }

    /// Allows the next capture when none was stored (a failure before or while capturing).
    fn abort(&self) {
        self.session().take();
        self.busy.store(false, Ordering::Release);
    }

    /// Drops the frames of `session` and allows the next capture. `None` if that capture already
    /// ended; otherwise the app to give focus back to.
    fn end(&self, session: u64) -> Option<Option<AppId>> {
        let mut guard = self.session();
        if guard.as_ref()?.id != session {
            return None;
        }
        let previous = guard.take().and_then(|s| s.previous_app);
        self.busy.store(false, Ordering::Release);
        Some(previous)
    }

    /// See `Session::begin_export`; fails unless `session` is the active capture.
    pub fn begin_export(
        &self,
        session: u64,
        index: usize,
        region: PixelRect,
    ) -> Result<(Arc<Frame>, Option<usize>), String> {
        self.session()
            .as_mut()
            .filter(|s| s.id == session)
            .ok_or("capture no longer active")?
            .begin_export(index, region)
    }

    /// Allows the next export. False if the session already ended (for example by Escape).
    pub fn end_export(&self, session: u64) -> bool {
        self.session()
            .as_mut()
            .filter(|s| s.id == session)
            .map(|s| s.exporting = false)
            .is_some()
    }

    pub fn frame(&self, index: usize) -> Result<(u64, Arc<Frame>), String> {
        self.session()
            .as_ref()
            .and_then(|s| Some((s.id, s.frames.get(index)?.clone())))
            .ok_or_else(|| format!("no captured frame {index}"))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    pub session: u64,
    pub index: usize,
    pub display_id: u32,
    pub bounds: LogicalRect,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
    pub focused: bool,
}

/// Captures all displays and shows the overlays. Returns immediately; capture runs on a thread.
pub fn start(app: &AppHandle) {
    let started = Instant::now();
    let state = app.state::<CaptureState>();
    if !state.try_begin() {
        return;
    }
    if !capture::has_permission() {
        capture::request_permission();
        state.abort();
        return fail(app, &capture::CaptureError::PermissionDenied.to_string());
    }
    // Before any of our windows take focus.
    let previous_app = system::frontmost_app();
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<CaptureState>();
        let id = state.next_session.fetch_add(1, Ordering::Relaxed) + 1;
        let session = capture::capture_displays()
            .map_err(|err| err.to_string())
            .and_then(|(frames, timings)| {
                eprintln!("[capture] {} display(s), {timings:?}", frames.len());
                let focus = cursor_display(&frames);
                Session::new(id, frames, started, focus, previous_app)
                    .map_err(|err| format!("Screen capture failed: {err}"))
            });
        let count = match session {
            Ok(session) => {
                let count = session.frames.len();
                *state.session() = Some(session);
                count
            }
            Err(err) => {
                state.abort();
                return fail(&app, &err);
            }
        };
        watch_readiness(&app, id);
        for index in 0..count {
            let label = label(index);
            let result = match app.get_webview_window(&label) {
                // Pre-created window: tell its page to load the new frame.
                Some(_) => app.emit_to(&label, events::OVERLAY_LOAD, id),
                // New window: its page loads the current frame when it starts. If a background
                // pre-creation won the race, the existing window is told instead.
                None => create_window(&app, index).or_else(|error| {
                    if app.get_webview_window(&label).is_some() {
                        app.emit_to(&label, events::OVERLAY_LOAD, id)
                    } else {
                        Err(error)
                    }
                }),
            };
            if let Err(err) = result {
                return close_on_main_thread(
                    &app,
                    id,
                    Some(format!("could not open overlay: {err}")),
                );
            }
        }
    });
}

/// Closes all overlays of capture `session`, releases its frames and gives focus back to the
/// previous app. The end of every capture: Escape, a finished export, a failure while opening,
/// or a display change. Returns false, and touches nothing, if that capture already ended.
/// Call on the main thread (window teardown and focus restoration belong there).
pub fn close(app: &AppHandle, session: u64) -> bool {
    let state = app.state::<CaptureState>();
    // Still busy while the windows go, so no new capture can start in between.
    if !state.is_active(session) {
        return false;
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = window.destroy();
        }
    }
    eprintln!("[overlay] closed");
    if let Some(Some(previous)) = state.end(session) {
        system::activate_app(previous);
    }
    precreate_in_background(app);
    true
}

/// `close` from any thread; reports `failure` if this call ended the capture.
pub fn close_on_main_thread(app: &AppHandle, session: u64, failure: Option<String>) {
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        if close(&handle, session)
            && let Some(message) = failure
        {
            fail(&handle, &message);
        }
    });
    if let Err(err) = result {
        eprintln!("[overlay] could not close capture {session}: {err}");
    }
}

/// Ends `session` with an error if its overlays are not all shown after `READY_TIMEOUT`, so a
/// page that never paints cannot leave an invisible capture that blocks every later one.
fn watch_readiness(app: &AppHandle, session: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_TIMEOUT);
        let stuck = app
            .state::<CaptureState>()
            .session()
            .as_ref()
            .is_some_and(|s| s.id == session && !s.all_shown());
        if stuck {
            close_on_main_thread(
                &app,
                session,
                Some("The capture overlays did not appear. Please try again.".into()),
            );
        }
    });
}

/// Whether `current` displays are the captured ones (same bounds, in any order).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn same_displays(captured: &[LogicalRect], current: &[LogicalRect]) -> bool {
    const TOLERANCE: f64 = 0.5;
    let close = |a: &LogicalRect, b: &LogicalRect| {
        (a.x - b.x).abs() < TOLERANCE
            && (a.y - b.y).abs() < TOLERANCE
            && (a.width - b.width).abs() < TOLERANCE
            && (a.height - b.height).abs() < TOLERANCE
    };
    captured.len() == current.len() && captured.iter().all(|a| current.iter().any(|b| close(a, b)))
}

/// The display arrangement changed (a display was connected, removed or rearranged): the
/// overlays no longer match the displays, so the capture ends. AppKit also posts the change
/// notification when nothing a capture depends on changed (seen once in 50 stress cycles),
/// so the capture only ends if the display bounds really differ from the captured ones. Not
/// during an export, whose save panel is a sheet on an overlay (see `may_cancel`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn displays_changed(app: &AppHandle, current: Option<Vec<LogicalRect>>) {
    let state = app.state::<CaptureState>();
    let Some(session) = state.active() else {
        return;
    };
    let captured: Vec<LogicalRect> = state
        .session()
        .as_ref()
        .map(|s| s.frames.iter().map(|f| f.bounds).collect())
        .unwrap_or_default();
    if current
        .as_ref()
        .is_some_and(|current| same_displays(&captured, current))
    {
        eprintln!("[overlay] screen parameters changed; displays unchanged, keeping the capture");
        return;
    }
    eprintln!("[overlay] displays changed from {captured:?} to {current:?}");
    if !state.may_cancel(session) {
        eprintln!("[overlay] displays changed during an export; keeping the capture");
        return;
    }
    eprintln!("[overlay] displays changed; ending capture {session}");
    if close(app, session) {
        fail(
            app,
            "The displays changed during the capture. Please take the screenshot again.",
        );
    }
}

/// Ends a capture when the displays change (see `displays_changed`). Call once at startup.
pub fn watch_displays(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        macos::observe_display_changes(move || displays_changed(&app, macos::display_bounds()));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Puts the shown overlays below modal dialogs (the save panel) while `open`, and back above
/// everything afterwards. Waits for the main thread, so a dialog shown next is ordered after the
/// change. Call from a background thread. Windows needs nothing: the dialog is owned by an overlay.
pub fn set_dialog_open(app: &AppHandle, open: bool) {
    #[cfg(target_os = "macos")]
    {
        let (done, wait) = std::sync::mpsc::channel();
        let handle = app.clone();
        let posted = app.run_on_main_thread(move || {
            for (label, window) in handle.webview_windows() {
                if label.starts_with(LABEL_PREFIX)
                    && window.is_visible().unwrap_or(false)
                    && let Err(err) = macos::set_raised(&window, !open)
                {
                    eprintln!("[overlay] could not change the level of {label}: {err}");
                }
            }
            let _ = done.send(());
        });
        if posted.is_ok() {
            let _ = wait.recv();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, open);
}

/// Creates a hidden overlay window per display that does not have one yet. Runs on its own
/// thread: creating windows inside a synchronous command deadlocks on Windows.
pub fn precreate_in_background(app: &AppHandle) {
    if !PRECREATE {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = app.available_monitors().and_then(|displays| {
            for index in 0..displays.len().max(1) {
                if app.get_webview_window(&label(index)).is_none() {
                    create_window(&app, index)?;
                }
            }
            Ok(())
        });
        if let Err(err) = result {
            eprintln!("[overlay] could not pre-create overlays: {err}");
        }
    });
}

fn fail(app: &AppHandle, message: &str) {
    eprintln!("[capture] {message}");
    let _ = app.emit(events::CAPTURE_FAILED, message);
    crate::show_main_window(app);
}

pub fn label(index: usize) -> String {
    format!("{LABEL_PREFIX}{index}")
}

pub fn index_from_label(label: &str) -> Option<usize> {
    label.strip_prefix(LABEL_PREFIX)?.parse().ok()
}

fn create_window(app: &AppHandle, index: usize) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, label(index), WebviewUrl::App("index.html".into()))
        .title("Snipvero capture")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // The first press on another display's overlay must start a selection, not just focus it.
        .accept_first_mouse(true)
        // Placed on its display by `overlay_ready`, once the frame (and so the display) is known.
        .inner_size(1.0, 1.0)
        .background_color(Color(0, 0, 0, 255))
        // Shown by `overlay_ready` once the frame is painted, to avoid flashing an empty window.
        .visible(false)
        .focused(false)
        .build()?;
    Ok(())
}

fn cursor_display(frames: &[Frame]) -> usize {
    #[cfg(target_os = "macos")]
    if let Some((x, y)) = macos::cursor_location() {
        return frames
            .iter()
            .position(|f| f.bounds.contains(x, y))
            .unwrap_or(0);
    }
    let _ = frames;
    0
}

#[tauri::command]
pub fn overlay_frame_info(index: usize, state: State<CaptureState>) -> Result<FrameInfo, String> {
    let (session, frame) = state.frame(index)?;
    let focused = state.session().as_ref().is_some_and(|s| s.focus == index);
    Ok(FrameInfo {
        session,
        index,
        display_id: frame.display_id,
        bounds: frame.bounds,
        scale: frame.scale,
        width: frame.width,
        height: frame.height,
        focused,
    })
}

/// Raw RGBA bytes of a frame (ADR-007). Async so the conversion runs off the main thread.
#[tauri::command]
pub async fn overlay_frame(
    index: usize,
    state: State<'_, CaptureState>,
) -> Result<Response, String> {
    let (_, frame) = state.frame(index)?;
    Ok(Response::new(transfer::to_rgba(&frame)))
}

/// Called by an overlay once its frame is painted: place it above everything and show it.
#[tauri::command]
pub fn overlay_ready(
    window: WebviewWindow,
    session: u64,
    state: State<CaptureState>,
) -> Result<(), String> {
    let index = index_from_label(window.label()).ok_or("not an overlay window")?;
    let (bounds, focus, started, all_visible) = {
        let mut guard = state.session();
        let s = guard
            .as_mut()
            .filter(|s| s.id == session)
            .ok_or("capture no longer active")?;
        let bounds = s.frames.get(index).ok_or("no such frame")?.bounds;
        (bounds, s.focus, s.started, s.mark_shown(index)?)
    };
    #[cfg(target_os = "macos")]
    macos::raise(&window, bounds)?;
    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
            .and_then(|()| window.set_size(tauri::LogicalSize::new(bounds.width, bounds.height)))
            .map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    if index == focus {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    if all_visible {
        eprintln!(
            "[overlay] all visible {:.1} ms after trigger",
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    Ok(())
}

/// Called by an overlay when it takes the selection (press, `region` = None) and whenever a
/// region is finalized there. Clears the selection on the overlay that held it before.
#[tauri::command]
pub fn overlay_select(
    window: WebviewWindow,
    session: u64,
    region: Option<PixelRect>,
    state: State<CaptureState>,
) -> Result<(), String> {
    let index = index_from_label(window.label()).ok_or("not an overlay window")?;
    let (previous, frame) = {
        let mut guard = state.session();
        let s = guard
            .as_mut()
            .filter(|s| s.id == session)
            .ok_or("capture no longer active")?;
        let previous = s.select(index, region)?;
        (previous, s.frames.get(index).cloned())
    };
    if let Some(previous) = previous {
        window
            .emit_to(label(previous), events::OVERLAY_SELECTION_CLEARED, session)
            .map_err(|e| e.to_string())?;
    }
    if let (Some(region), Some(frame)) = (region, frame) {
        eprintln!(
            "[overlay] selection on display {index}: {region:?} px = {:?} pt",
            region.to_logical(frame.bounds, (frame.width, frame.height))
        );
    }
    Ok(())
}

/// Escape in an overlay of `session`. Returns whether the capture ended; false for a capture that
/// already ended (a stale page) or while an export runs (see `CaptureState::may_cancel`).
#[tauri::command]
pub fn overlay_cancel(app: AppHandle, session: u64, state: State<CaptureState>) -> bool {
    if !state.may_cancel(session) {
        eprintln!("[overlay] cancel of capture {session} ignored");
        return false;
    }
    close(&app, session)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;

    use super::{CaptureState, Selection, Session, index_from_label, label};
    use crate::capture::Frame;
    use crate::geometry::{LogicalRect, PixelRect};

    fn frame(x: f64, width: f64, height: f64, scale: f64) -> Arc<Frame> {
        Arc::new(Frame {
            display_id: 0,
            bounds: LogicalRect {
                x,
                y: 0.0,
                width,
                height,
            },
            scale,
            width: (width * scale) as u32,
            height: (height * scale) as u32,
            bgra: Vec::new(),
        })
    }

    /// The original three-display test setup: left 1×, built-in Retina 2×, right 1×.
    fn session() -> Session {
        Session {
            id: 1,
            frames: vec![
                frame(-1920.0, 1920.0, 1080.0, 1.0),
                frame(0.0, 1512.0, 982.0, 2.0),
                frame(1512.0, 1920.0, 1080.0, 1.0),
            ],
            started: Instant::now(),
            focus: 1,
            shown: vec![true; 3],
            previous_app: None,
            selection: None,
            exporting: false,
        }
    }

    const REGION: PixelRect = PixelRect {
        x: 10,
        y: 20,
        width: 300,
        height: 200,
    };

    #[test]
    fn one_selection_per_session_across_displays() {
        let mut s = session();
        assert_eq!(s.select(1, None), Ok(None));
        assert_eq!(s.select(1, Some(REGION)), Ok(None));
        // A press on the left display takes the selection from the built-in one.
        assert_eq!(s.select(0, None), Ok(Some(1)));
        assert_eq!(
            s.selection,
            Some(Selection {
                index: 0,
                region: None
            })
        );
        assert_eq!(s.select(0, Some(REGION)), Ok(None));
        assert_eq!(s.select(2, Some(REGION)), Ok(Some(0)));
    }

    #[test]
    fn rejects_regions_outside_the_frame_or_empty() {
        let mut s = session();
        let full_retina = PixelRect {
            x: 0,
            y: 0,
            width: 3024,
            height: 1964,
        };
        assert_eq!(s.select(1, Some(full_retina)), Ok(None));
        // The same pixel size does not fit the 1× display.
        assert!(s.select(0, Some(full_retina)).is_err());
        assert!(s.select(2, Some(PixelRect { width: 0, ..REGION })).is_err());
        assert!(s.select(3, None).is_err());
        // A rejected region leaves the previous selection unchanged.
        assert_eq!(s.selection.map(|sel| sel.index), Some(1));
    }

    #[test]
    fn one_export_at_a_time_and_it_takes_the_selection() {
        let state = CaptureState::default();
        assert!(state.begin_export(1, 1, REGION).is_err(), "no capture yet");
        let mut s = session();
        s.select(0, Some(REGION)).unwrap();
        *state.session() = Some(s);
        assert!(state.begin_export(2, 1, REGION).is_err(), "stale session");
        // Exporting from the built-in display moves the selection there and clears the left one.
        let (frame, previous) = state.begin_export(1, 1, REGION).unwrap();
        assert_eq!((frame.width, previous), (3024, Some(0)));
        // A repeated request (Enter, then the Copy button) is rejected while the first runs.
        assert!(state.begin_export(1, 1, REGION).is_err());
        assert!(state.end_export(1));
        // After a cancelled save dialog or a failure the user can try again.
        assert_eq!(state.begin_export(1, 1, REGION).unwrap().1, None);
        assert!(state.end_export(1));
    }

    #[test]
    fn rejected_export_leaves_no_lock_behind() {
        let state = CaptureState::default();
        *state.session() = Some(session());
        let outside = PixelRect { x: 1900, ..REGION };
        assert!(state.begin_export(1, 0, outside).is_err());
        assert!(state.begin_export(1, 9, REGION).is_err());
        assert!(state.begin_export(1, 0, REGION).is_ok());
    }

    #[test]
    fn ending_the_session_releases_frames_and_export_state() {
        let state = CaptureState::default();
        assert!(state.try_begin());
        *state.session() = Some(session());
        state.begin_export(1, 1, REGION).unwrap();
        // A successful export closes the overlays through `close`, which ends the session.
        assert_eq!(state.end(1), Some(None));
        assert!(state.session().is_none());
        assert!(!state.is_busy());
        // The export finishing afterwards finds no session and closes nothing again.
        assert!(!state.end_export(1));
        assert_eq!(state.end(1), None);
    }

    #[test]
    fn an_update_install_and_a_capture_exclude_each_other() {
        let state = CaptureState::default();
        // An open capture (including its export) refuses the install.
        assert!(state.try_begin());
        *state.session() = Some(session());
        assert!(!state.reserve_for_update());
        assert_eq!(state.end(1), Some(None));
        // An install in progress refuses a capture until it fails and gives the lock back.
        assert!(state.reserve_for_update());
        assert!(!state.try_begin());
        state.release_update();
        assert!(!state.is_busy());
        assert!(state.try_begin());
    }

    #[test]
    fn ending_a_stale_session_leaves_the_current_one_alone() {
        // Regression: a late Escape, a failing page of an ended capture or a timed-out
        // watchdog closed whatever capture was active, including a newer one.
        let state = CaptureState::default();
        assert!(state.try_begin());
        *state.session() = Some(Session {
            id: 2,
            previous_app: Some(42),
            ..session()
        });
        assert_eq!(state.end(1), None);
        assert!(state.is_busy());
        assert_eq!(state.active(), Some(2));
        assert_eq!(state.end(2), Some(Some(42)));
        assert!(!state.is_busy());
        assert_eq!(state.active(), None);
    }

    #[test]
    fn escape_is_refused_during_an_export_and_for_other_sessions() {
        let state = CaptureState::default();
        *state.session() = Some(session());
        assert!(state.may_cancel(1));
        assert!(!state.may_cancel(2));
        // The save panel is a sheet on an overlay: closing the overlays under it is not safe.
        state.begin_export(1, 1, REGION).unwrap();
        assert!(!state.may_cancel(1));
        assert!(state.end_export(1));
        assert!(state.may_cancel(1));
    }

    #[test]
    fn readiness_counts_each_overlay_once() {
        // Regression: two ready reports from one window counted as two shown overlays.
        let mut s = Session {
            shown: vec![false; 3],
            ..session()
        };
        assert_eq!(s.mark_shown(1), Ok(false));
        assert_eq!(s.mark_shown(1), Ok(false));
        assert_eq!(s.mark_shown(0), Ok(false));
        assert!(s.mark_shown(5).is_err());
        assert_eq!(s.mark_shown(2), Ok(true));
        assert!(s.all_shown());
    }

    #[test]
    fn a_capture_without_displays_is_refused() {
        // Regression: no frames meant no overlay to show or cancel, and a capture that
        // stayed busy until Snipvero was restarted.
        let started = Instant::now();
        assert!(Session::new(1, Vec::new(), started, 0, None).is_err());
        let frames = vec![Frame {
            display_id: 1,
            bounds: LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            scale: 1.0,
            width: 10,
            height: 10,
            bgra: vec![0; 400],
        }];
        let s = Session::new(1, frames, started, 0, Some(7)).unwrap();
        assert_eq!((s.frames.len(), s.shown.clone()), (1, vec![false]));
        assert!(!s.all_shown());
    }

    #[test]
    fn only_one_capture_runs_until_cancelled() {
        let state = CaptureState::default();
        assert!(!state.is_busy());
        assert!(state.try_begin());
        assert!(!state.try_begin());
        assert!(!state.all_visible());
        state.abort();
        assert!(!state.is_busy());
        assert!(state.try_begin());
    }

    #[test]
    fn display_changes_are_detected_by_bounds() {
        let rect = |x: f64, width: f64, height: f64| LogicalRect {
            x,
            y: 0.0,
            width,
            height,
        };
        let captured: Vec<_> = session().frames.iter().map(|f| f.bounds).collect();
        // A notification without a real change (AppKit once posted one mid-capture): same
        // displays, in another order and with rounding noise.
        let reordered = vec![
            rect(0.0, 1512.0, 982.0),
            rect(1512.2, 1920.0, 1080.0),
            rect(-1920.0, 1920.0, 1080.0),
        ];
        assert!(super::same_displays(&captured, &reordered));
        // Removed, moved or resized displays end the capture.
        assert!(!super::same_displays(&captured, &reordered[..2]));
        let moved = vec![reordered[0], reordered[1], rect(-1800.0, 1920.0, 1080.0)];
        assert!(!super::same_displays(&captured, &moved));
        let resized = vec![rect(0.0, 1728.0, 1117.0), reordered[1], reordered[2]];
        assert!(!super::same_displays(&captured, &resized));
        let added = [reordered.clone(), vec![rect(3432.0, 1920.0, 1080.0)]].concat();
        assert!(!super::same_displays(&captured, &added));
    }

    #[test]
    fn labels_round_trip() {
        assert_eq!(index_from_label(&label(0)), Some(0));
        assert_eq!(index_from_label(&label(12)), Some(12));
        assert_eq!(index_from_label("main"), None);
        assert_eq!(index_from_label("overlay-x"), None);
    }
}
