//! Screen recording of one region of one display into a temporary MP4 (ADR-037).
//!
//! This module is platform independent: the state machine, caps, temporary-file lifecycle and
//! commands. The capture and encoder live in `macos.rs` (ScreenCaptureKit + AVAssetWriter);
//! other systems only get the unsupported stub in `windows.rs`.
//!
//! The page never sees a path: it gets an opaque recording id. Save, copy and discard run here,
//! and the review window plays the file through the `snipvero-recording` protocol, which serves
//! only the current finished recording.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response};
use tauri::{
    AppHandle, Emitter, Manager, State, UriSchemeResponder, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::events;
use crate::export::{self, ExportOutcome};
use crate::geometry::{
    LogicalRect, PixelRect, RECORDING_FPS, RecordingGeometry, RegionError, recording_bitrate,
    recording_geometry,
};
use crate::overlay::{self, CaptureState, Mode};
use crate::settings;
use crate::tray;

#[cfg(target_os = "macos")]
mod macos;
mod mixer;
mod tempfiles;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(not(target_os = "macos"))]
mod windows;
#[cfg(not(target_os = "macos"))]
use windows as platform;

/// Label of the review window shown after a recording.
pub const LABEL: &str = "recording";
/// URI scheme of the review window's preview. Mirrored in `src/ipc.ts` and the CSP.
pub const PROTOCOL: &str = "snipvero-recording";

/// Default and limits of the duration cap, in seconds (ADR-037). The setting is clamped.
pub const DEFAULT_CAP_SECONDS: u32 = 300;
pub const MIN_CAP_SECONDS: u32 = 10;
pub const MAX_CAP_SECONDS: u32 = 600;
/// A recording that reaches this size is stopped, whatever the cap says (ADR-037).
const MAX_FILE_BYTES: u64 = 1 << 30;
/// How often the cap, the file size and the indicators are looked at.
const TICK: Duration = Duration::from_millis(250);
/// Lets the destroyed overlays leave the screen and the previous app come back before the first
/// frame is requested. The overlays are excluded from the stream anyway; this is for the app
/// being recorded, whose focus ring and menus change when it is activated again.
const SETTLE: Duration = Duration::from_millis(250);
/// The largest piece of the file one preview request gets, so an open-ended range stays small.
const MAX_CHUNK: u64 = 4 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Starting,
    Recording,
    Stopping,
    /// A finished recording waits in the temporary file for Save or Discard.
    Finished,
}

/// What the page and the tray show. Sent with every state change, never per frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub supported: bool,
    pub phase: Phase,
    /// Opaque id of the current recording; `None` while idle.
    pub id: Option<u64>,
    pub elapsed_ms: u64,
    pub cap_ms: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// Length of the finished video.
    pub duration_ms: Option<u64>,
    /// Why a recording ended other than by the user, and anything that went wrong with the
    /// sound, for the review window.
    pub notice: Option<String>,
    /// Which sound sources this recording has (ADR-037); both false is a silent video.
    pub system_audio: bool,
    pub microphone: bool,
}

/// Which audio sources a recording takes. Both are off by default and independent (ADR-037).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChoice {
    pub system: bool,
    pub microphone: bool,
}

impl AudioChoice {
    pub fn any(self) -> bool {
        self.system || self.microphone
    }
}

/// Where the microphone permission stands. `Unsupported`: this platform cannot record sound yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MicrophoneAccess {
    NotDetermined,
    Authorized,
    Denied,
    Restricted,
    Unsupported,
}

/// What the main window shows about sound: the stored choices and the microphone permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub supported: bool,
    pub system: bool,
    /// The stored choice. The microphone is only recorded while `microphone_access` is
    /// `authorized`; the page shows the toggle on only then.
    pub microphone: bool,
    pub microphone_access: MicrophoneAccess,
}

fn stored_audio(stored: &settings::Settings) -> AudioChoice {
    AudioChoice {
        system: stored.record_system_audio,
        microphone: stored.record_microphone,
    }
}

fn audio_status(stored: &settings::Settings, access: MicrophoneAccess) -> AudioStatus {
    let wanted = stored_audio(stored);
    AudioStatus {
        supported: platform::SUPPORTED,
        system: wanted.system,
        microphone: wanted.microphone,
        microphone_access: access,
    }
}

/// The code `recording_start` rejects with when the microphone is switched on but not allowed
/// (not yet asked, denied or revoked, restricted). The overlay offers to record without it.
/// Mirrored in `src/ipc.ts`.
pub const MICROPHONE_UNAVAILABLE: &str = "microphoneUnavailable";

/// Decides what a recording takes: the stored choices, minus a microphone that is not allowed
/// when the user chose to go on without it. Without that choice a microphone that is switched on
/// but not allowed is refused, never dropped silently.
fn plan_audio(wanted: AudioChoice, without_microphone: bool) -> Result<AudioChoice, &'static str> {
    // The permission is not even looked at while the microphone is off (ADR-037).
    if !wanted.microphone {
        return Ok(wanted);
    }
    plan_microphone(wanted, platform::microphone_access(), without_microphone)
}

fn plan_microphone(
    wanted: AudioChoice,
    access: MicrophoneAccess,
    without_microphone: bool,
) -> Result<AudioChoice, &'static str> {
    if !wanted.microphone || access == MicrophoneAccess::Authorized {
        return Ok(wanted);
    }
    if without_microphone {
        return Ok(AudioChoice {
            microphone: false,
            ..wanted
        });
    }
    Err(MICROPHONE_UNAVAILABLE)
}

/// The review window's notice: why the recording ended early, then what went wrong with the sound.
fn join_notices(reason: Option<String>, audio: Vec<String>) -> Option<String> {
    let all: Vec<String> = reason.into_iter().chain(audio).collect();
    (!all.is_empty()).then(|| all.join(" "))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Finished {
    bytes: u64,
    duration: Duration,
    notice: Option<String>,
}

/// Why a recording is being stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StopReason {
    User,
    Cap(Duration),
    Size,
    /// The stream or the encoder failed; what was written is kept if it can be finalized.
    Failure(String),
}

impl StopReason {
    fn notice(&self) -> Option<String> {
        match self {
            StopReason::User => None,
            StopReason::Cap(cap) => Some(format!(
                "The recording stopped at the maximum length ({}).",
                clock(*cap)
            )),
            StopReason::Size => Some("The recording stopped at the maximum file size.".into()),
            StopReason::Failure(message) => Some(format!("The recording stopped early: {message}")),
        }
    }
}

#[derive(Debug)]
pub enum RecordingError {
    Unsupported,
    PermissionDenied,
    /// A user-facing refusal that is not a failure of the system.
    Refused(String),
    Failed(String),
    /// Stopped before the first frame arrived: there is nothing to save.
    NoFrames,
}

impl fmt::Display for RecordingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecordingError::Unsupported => {
                f.write_str("Screen recording is not available on this platform yet.")
            }
            RecordingError::PermissionDenied => {
                f.write_str(&crate::capture::CaptureError::PermissionDenied.to_string())
            }
            RecordingError::Refused(message) => f.write_str(message),
            RecordingError::Failed(reason) => write!(f, "Screen recording failed: {reason}"),
            RecordingError::NoFrames => {
                f.write_str("Nothing was recorded: the screen delivered no picture.")
            }
        }
    }
}

impl From<crate::capture::CaptureError> for RecordingError {
    fn from(error: crate::capture::CaptureError) -> Self {
        use crate::capture::CaptureError;
        match error {
            CaptureError::PermissionDenied => RecordingError::PermissionDenied,
            CaptureError::Unsupported => RecordingError::Unsupported,
            CaptureError::Failed(reason) => RecordingError::Failed(reason),
        }
    }
}

/// Everything a backend needs to start recording.
pub struct StartRequest {
    pub display_id: u32,
    pub geometry: RecordingGeometry,
    /// Video bit rate in bit/s.
    pub bitrate: u32,
    pub fps: u32,
    pub output: PathBuf,
    /// The sound sources to record; none is a silent video and touches no audio API.
    pub audio: AudioChoice,
    /// Called once, from a backend thread, when the stream or the encoder fails mid-recording.
    pub on_failure: std::sync::Arc<dyn Fn(String) + Send + Sync>,
}

/// A finalized recording as the backend reports it.
pub struct Finalized {
    pub duration: Duration,
    /// Problems with the sound, in words for the user; empty when it went well.
    pub notices: Vec<String>,
}

/// Why `Machine::begin_start` said no.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// A recording is starting, running or being finalized.
    Busy,
    /// The previous recording was neither saved nor discarded.
    Pending,
}

/// The recording lifecycle (`idle → starting → recording → stopping → finished`), free of any
/// platform call so the rules are tested alone. Every transition names the recording it acts on,
/// so a late timer, a stale page or a repeated stop can never touch a newer recording.
struct Machine {
    phase: Phase,
    id: u64,
    next_id: u64,
    cap: Duration,
    size: (u32, u32),
    started: Option<Instant>,
    file: Option<PathBuf>,
    finished: Option<Finished>,
    /// A save dialog or copy is running: the file must stay.
    saving: bool,
    audio: AudioChoice,
}

impl Default for Machine {
    fn default() -> Self {
        Machine {
            phase: Phase::Idle,
            id: 0,
            next_id: 0,
            cap: Duration::from_secs(u64::from(DEFAULT_CAP_SECONDS)),
            size: (0, 0),
            started: None,
            file: None,
            finished: None,
            saving: false,
            audio: AudioChoice::default(),
        }
    }
}

impl Machine {
    fn begin_start(&mut self, cap: Duration, size: (u32, u32)) -> Result<u64, Refusal> {
        match self.phase {
            Phase::Idle => {}
            Phase::Finished => return Err(Refusal::Pending),
            _ => return Err(Refusal::Busy),
        }
        self.next_id += 1;
        *self = Machine {
            phase: Phase::Starting,
            id: self.next_id,
            next_id: self.next_id,
            cap,
            size,
            ..Machine::default()
        };
        Ok(self.id)
    }

    /// The sound sources of the recording that is starting.
    fn set_audio(&mut self, id: u64, audio: AudioChoice) {
        if self.id == id {
            self.audio = audio;
        }
    }

    fn is(&self, id: u64, phase: Phase) -> bool {
        self.id == id && self.phase == phase
    }

    /// The stream is running and `file` is being written.
    fn mark_recording(&mut self, id: u64, file: PathBuf, now: Instant) -> bool {
        if !self.is(id, Phase::Starting) {
            return false;
        }
        self.phase = Phase::Recording;
        self.started = Some(now);
        self.file = Some(file);
        true
    }

    /// The start failed or was refused by the system; back to idle.
    fn fail_start(&mut self, id: u64) -> bool {
        if !self.is(id, Phase::Starting) {
            return false;
        }
        self.phase = Phase::Idle;
        true
    }

    /// Only the first stop of a running recording counts; a repeated press does nothing.
    fn begin_stop(&mut self, id: u64) -> bool {
        if !self.is(id, Phase::Recording) {
            return false;
        }
        self.phase = Phase::Stopping;
        true
    }

    fn finish(&mut self, id: u64, finished: Finished) -> bool {
        if !self.is(id, Phase::Stopping) {
            return false;
        }
        self.phase = Phase::Finished;
        self.finished = Some(finished);
        true
    }

    /// Finalizing failed: back to idle. Returns the file to delete.
    fn fail_stop(&mut self, id: u64) -> Option<PathBuf> {
        if !self.is(id, Phase::Stopping) {
            return None;
        }
        self.phase = Phase::Idle;
        self.file.take()
    }

    /// The finished recording's file, for saving. One save at a time, and no discard meanwhile.
    fn begin_save(&mut self, id: u64) -> Result<PathBuf, String> {
        if !self.is(id, Phase::Finished) {
            return Err("that recording no longer exists".into());
        }
        if self.saving {
            return Err("the recording is already being saved".into());
        }
        let file = self.file.clone().ok_or("the recording has no file")?;
        self.saving = true;
        Ok(file)
    }

    fn end_save(&mut self) {
        self.saving = false;
    }

    /// Ends a finished recording (discarded or saved). Returns the file to delete.
    fn discard(&mut self, id: u64) -> Result<PathBuf, String> {
        if !self.is(id, Phase::Finished) {
            return Err("that recording no longer exists".into());
        }
        if self.saving {
            return Err("the recording is being saved".into());
        }
        self.phase = Phase::Idle;
        self.finished = None;
        self.file
            .take()
            .ok_or_else(|| "the recording has no file".into())
    }

    /// The file of the finished recording `id`, for the preview and for copying.
    fn finished_file(&self, id: u64) -> Option<&Path> {
        self.is(id, Phase::Finished)
            .then_some(self.file.as_deref())
            .flatten()
    }

    fn elapsed(&self, now: Instant) -> Duration {
        match (self.phase, self.started) {
            (Phase::Recording | Phase::Stopping, Some(started)) => {
                now.saturating_duration_since(started)
            }
            _ => Duration::ZERO,
        }
    }

    /// The monotonic deadline: wall-clock changes and the frame count have no say (ADR-037).
    fn cap_reached(&self, now: Instant) -> bool {
        self.phase == Phase::Recording && self.elapsed(now) >= self.cap
    }

    fn status(&self, now: Instant, bytes: u64) -> RecordingStatus {
        let idle = self.phase == Phase::Idle;
        let finished = self.finished.as_ref();
        RecordingStatus {
            supported: platform::SUPPORTED,
            phase: self.phase,
            id: (!idle).then_some(self.id),
            elapsed_ms: self.elapsed(now).as_millis() as u64,
            cap_ms: self.cap.as_millis() as u64,
            width: self.size.0,
            height: self.size.1,
            bytes: finished.map_or(bytes, |f| f.bytes),
            duration_ms: finished.map(|f| f.duration.as_millis() as u64),
            notice: finished.and_then(|f| f.notice.clone()),
            system_audio: self.audio.system,
            microphone: self.audio.microphone,
        }
    }
}

/// `m:ss`, the clock of the tray title and the indicator.
pub fn clock(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// The cap in effect: the setting clamped to its limits, or the default.
pub fn cap_from_setting(seconds: Option<u32>) -> Duration {
    let seconds = seconds
        .unwrap_or(DEFAULT_CAP_SECONDS)
        .clamp(MIN_CAP_SECONDS, MAX_CAP_SECONDS);
    Duration::from_secs(u64::from(seconds))
}

/// The tray's recording row for a phase: its label and whether it can be clicked.
pub fn menu_entry(phase: Phase) -> (&'static str, bool) {
    match phase {
        Phase::Idle => ("Record Region", true),
        Phase::Starting => ("Starting Recording…", false),
        Phase::Recording => ("Stop Recording", true),
        Phase::Stopping => ("Saving Recording…", false),
        Phase::Finished => ("Review Last Recording…", true),
    }
}

/// The recording this app instance runs and its temporary storage.
pub struct RecordingState {
    machine: Mutex<Machine>,
    /// The running capture. Stored before the machine says `recording`, taken by the stop.
    recorder: Mutex<Option<platform::Recorder>>,
    /// This launch's private directory, created at the first recording.
    launch_dir: Mutex<Option<PathBuf>>,
    /// Anything in the temp root last modified before this belongs to an earlier launch.
    launched: SystemTime,
    /// Where the recording is on screen, for the indicator.
    target: Mutex<Option<Target>>,
}

impl Default for RecordingState {
    fn default() -> Self {
        RecordingState {
            machine: Mutex::default(),
            recorder: Mutex::default(),
            launch_dir: Mutex::default(),
            launched: SystemTime::now(),
            target: Mutex::default(),
        }
    }
}

/// The recorded display and region, for the on-screen indicator.
#[derive(Debug, Clone, Copy)]
struct Target {
    bounds: LogicalRect,
    frame: (u32, u32),
    region: PixelRect,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl RecordingState {
    fn machine(&self) -> MutexGuard<'_, Machine> {
        lock(&self.machine)
    }

    fn status(&self) -> RecordingStatus {
        let machine = self.machine();
        let bytes = machine
            .file
            .as_deref()
            .and_then(|file| std::fs::metadata(file).ok())
            .map_or(0, |metadata| metadata.len());
        machine.status(Instant::now(), bytes)
    }

    /// This launch's directory, created on first use.
    fn launch_dir(&self) -> Result<PathBuf, String> {
        let mut dir = lock(&self.launch_dir);
        if let Some(dir) = dir.as_ref() {
            return Ok(dir.clone());
        }
        let created = tempfiles::create_launch_dir(&tempfiles::root(), std::process::id())
            .map_err(|e| format!("Could not create the folder for recordings: {e}"))?;
        *dir = Some(created.clone());
        Ok(created)
    }
}

fn region_message(error: RegionError) -> String {
    match error {
        RegionError::Outside => "The selection is outside the display.".into(),
        RegionError::TooSmall => "The region is too small to record. Select at least 16 × 16 pixels.".into(),
        RegionError::TooLarge => "The region is too large to record as video. Select at most 8192 pixels per side and about 9.4 megapixels (for example 3840 × 2160).".into(),
    }
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit(
        events::RECORDING_STATE,
        app.state::<RecordingState>().status(),
    );
}

/// Tells the user, on the main window as for a failed capture.
fn fail(app: &AppHandle, message: &str) {
    eprintln!("[recording] {message}");
    let _ = app.emit(events::RECORDING_FAILED, message);
    crate::show_main_window(app);
}

/// Releases the capture lock a recording held since its overlay closed.
fn release_lock(app: &AppHandle) {
    app.state::<CaptureState>().release_recording();
}

/// The tray's row and title, and the on-screen indicator, for the current phase.
fn refresh_ui(app: &AppHandle, id: u64) {
    let state = app.state::<RecordingState>();
    let (phase, elapsed) = {
        let machine = state.machine();
        (machine.phase, machine.elapsed(Instant::now()))
    };
    tray::show_recording(app, phase, elapsed);
    let text = format!("● {}", clock(elapsed));
    let target = *lock(&state.target);
    let _ = app.run_on_main_thread(move || match (phase, target) {
        (Phase::Recording, Some(t)) => {
            overlay::update_recording_indicator(id, t.bounds, t.region, t.frame, &text)
        }
        _ => overlay::hide_recording_indicator(id),
    });
}

/// The tray row, the main window's button and the capture shortcut all end here: start a
/// recording, stop the running one, or bring back the review of the last.
pub fn trigger(app: &AppHandle) {
    let state = app.state::<RecordingState>();
    let (phase, id) = {
        let machine = state.machine();
        (machine.phase, machine.id)
    };
    match phase {
        Phase::Idle => overlay::start_with_mode(app, Mode::Record),
        Phase::Recording => stop(app, id, StopReason::User),
        Phase::Finished => show_review(app),
        Phase::Starting | Phase::Stopping => {}
    }
}

/// The capture shortcut stops a running recording (as it ends an open capture, ADR-034). Returns
/// whether it handled the press, so no capture starts while a recording exists in any phase.
pub fn on_shortcut(app: &AppHandle) -> bool {
    let state = app.state::<RecordingState>();
    let (phase, id) = {
        let machine = state.machine();
        (machine.phase, machine.id)
    };
    match phase {
        Phase::Recording => {
            stop(app, id, StopReason::User);
            true
        }
        Phase::Starting | Phase::Stopping => true,
        Phase::Idle | Phase::Finished => false,
    }
}

/// Starts recording `region` of the display the overlay of `session` shows. The overlay closes
/// first, so the selection UI is never in the video (ADR-037), and the capture lock passes to the
/// recording, which keeps screenshots, a second recording and an update install out meanwhile.
#[tauri::command]
pub fn recording_start(
    app: AppHandle,
    window: WebviewWindow,
    session: u64,
    region: PixelRect,
    without_microphone: Option<bool>,
    capture: State<CaptureState>,
    _recording: State<RecordingState>,
) -> Result<RecordingStatus, String> {
    if !platform::SUPPORTED {
        return Err(RecordingError::Unsupported.to_string());
    }
    let index = overlay::index_from_label(window.label()).ok_or("not an overlay window")?;
    if !crate::capture::has_permission() {
        return Err(RecordingError::PermissionDenied.to_string());
    }
    // Before the overlay closes: a refused microphone leaves the selection on screen, where the
    // user can record without it (ADR-037).
    let audio = plan_audio(
        stored_audio(&settings::load(&app)),
        without_microphone.unwrap_or(false),
    )?;
    let target = capture.begin_recording(session, index, region)?;
    begin(&app, target, region, audio, || {
        overlay::hand_off_to_recording(&app, session)
    })
}

/// Checks `region` of the display `target`, takes over the capture lock through `take_over` (the
/// overlay of the selection closing, which keeps the lock) and starts the capture. Everything
/// that can be refused is refused before `take_over` runs.
fn begin(
    app: &AppHandle,
    target: overlay::RecordingTarget,
    region: PixelRect,
    audio: AudioChoice,
    take_over: impl FnOnce() -> bool,
) -> Result<RecordingStatus, String> {
    let recording = app.state::<RecordingState>();
    let geometry =
        recording_geometry(region, target.bounds, target.frame).map_err(region_message)?;
    let bitrate = recording_bitrate(geometry.width, geometry.height, RECORDING_FPS);
    let cap = cap_from_setting(settings::load(app).recording_max_seconds);

    let dir = recording.launch_dir()?;
    let required = tempfiles::required_free_bytes(bitrate, cap.as_secs());
    if let Some(available) = platform::available_space(&dir)
        && available < required
    {
        return Err(format!(
            "Not enough free disk space to record. About {} MB must be free.",
            required.div_ceil(1_000_000)
        ));
    }

    let id = match recording
        .machine()
        .begin_start(cap, (geometry.width, geometry.height))
    {
        Ok(id) => id,
        Err(Refusal::Busy) => return Err("A recording is already in progress.".into()),
        Err(Refusal::Pending) => {
            show_review(app);
            return Err("Save or discard the previous recording first.".into());
        }
    };
    recording.machine().set_audio(id, audio);
    if !take_over() {
        recording.machine().fail_start(id);
        return Err("The capture is no longer active.".into());
    }
    *lock(&recording.target) = Some(Target {
        bounds: target.bounds,
        frame: target.frame,
        region,
    });
    let output = tempfiles::new_recording_path(&dir);
    emit_state(app);
    refresh_ui(app, id);
    spawn_start(
        app,
        id,
        StartRequest {
            display_id: target.display_id,
            geometry,
            bitrate,
            fps: RECORDING_FPS,
            output,
            audio,
            on_failure: {
                let app = app.clone();
                std::sync::Arc::new(move |message| {
                    stop(&app, id, StopReason::Failure(message));
                })
            },
        },
    );
    Ok(recording.status())
}

/// Developer harness (`--stress-record`): one recording of the central quarter of the first
/// display for `seconds`, stopped and discarded, through the same lock, writer and cleanup as a
/// real one but without the overlay. Returns a log line.
pub fn stress_record(
    app: &AppHandle,
    seconds: u64,
    quit_mid_recording: bool,
    audio: AudioChoice,
) -> Result<String, String> {
    use std::time::Duration;

    let capture = app.state::<CaptureState>();
    if !capture.reserve_for_update() {
        return Err("a capture or recording is open".into());
    }
    // The lock is released by the recording's own end, or here when it never starts.
    let result = stress_inner(app, seconds, quit_mid_recording, audio);
    if result.is_err() && app.state::<RecordingState>().machine().phase == Phase::Idle {
        capture.release_recording();
    }
    return result;

    fn stress_inner(
        app: &AppHandle,
        seconds: u64,
        quit_mid_recording: bool,
        audio: AudioChoice,
    ) -> Result<String, String> {
        let audio = plan_audio(audio, false)
            .map_err(|code| format!("the microphone is not allowed ({code})"))?;
        let (frames, _) = crate::capture::capture_displays().map_err(|e| e.to_string())?;
        let frame = frames.first().ok_or("no display")?;
        let region = PixelRect {
            x: frame.width / 4,
            y: frame.height / 4,
            width: frame.width / 2,
            height: frame.height / 2,
        };
        let target = overlay::RecordingTarget {
            display_id: frame.display_id,
            bounds: frame.bounds,
            frame: (frame.width, frame.height),
        };
        drop(frames);
        let state = app.state::<RecordingState>();
        let started = begin(app, target, region, audio, || true)?;
        let id = started.id.ok_or("no recording id")?;
        let wait_for = |phase: Phase, timeout: Duration| -> Result<(), String> {
            let from = Instant::now();
            while state.machine().phase != phase {
                if from.elapsed() > timeout {
                    return Err(format!("recording did not reach {phase:?}"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(())
        };
        wait_for(Phase::Recording, Duration::from_secs(20))?;
        std::thread::sleep(Duration::from_secs(seconds));
        if quit_mid_recording {
            // Quits while the capture runs: the exit path must cancel it and delete the folder.
            app.exit(0);
            return Ok("quitting".into());
        }
        stop(app, id, StopReason::User);
        wait_for(Phase::Finished, Duration::from_secs(60))?;
        let status = state.status();
        let file = state.machine().discard(id)?;
        let leftover = file
            .parent()
            .and_then(|dir| std::fs::read_dir(dir).ok())
            .map_or(0, |entries| entries.count());
        let existed = file.exists();
        remove_file(&file);
        emit_state(app);
        refresh_ui(app, id);
        close_review(app);
        let after = file
            .parent()
            .and_then(|dir| std::fs::read_dir(dir).ok())
            .map_or(0, |entries| entries.count());
        Ok(format!(
            "{}×{} px, {} B, {} ms; file present {existed}, entries before/after delete {leftover}/{after}",
            status.width,
            status.height,
            status.bytes,
            status.duration_ms.unwrap_or(0)
        ))
    }
}

/// Starts the capture on its own thread: the backend waits for system callbacks.
fn spawn_start(app: &AppHandle, id: u64, request: StartRequest) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        let output = request.output.clone();
        let state = app.state::<RecordingState>();
        match platform::start(request) {
            Ok(recorder) => {
                *lock(&state.recorder) = Some(recorder);
                if state
                    .machine()
                    .mark_recording(id, output.clone(), Instant::now())
                {
                    eprintln!("[recording] {id} started");
                    emit_state(&app);
                    refresh_ui(&app, id);
                    monitor(&app, id);
                } else if let Some(recorder) = lock(&state.recorder).take() {
                    // The app is exiting; nothing waits for this recording any more.
                    recorder.cancel();
                    remove_file(&output);
                }
            }
            Err(error) => {
                state.machine().fail_start(id);
                remove_file(&output);
                *lock(&state.target) = None;
                release_lock(&app);
                emit_state(&app);
                refresh_ui(&app, id);
                fail(&app, &error.to_string());
            }
        }
    });
}

/// Watches the cap and the file size, and keeps the clock current, until the recording ends.
fn monitor(app: &AppHandle, id: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut shown = u64::MAX;
        loop {
            std::thread::sleep(TICK);
            let state = app.state::<RecordingState>();
            let (alive, cap, capped, file) = {
                let machine = state.machine();
                let now = Instant::now();
                (
                    machine.is(id, Phase::Recording),
                    machine.cap,
                    machine.cap_reached(now),
                    machine.file.clone(),
                )
            };
            if !alive {
                return;
            }
            if capped {
                return stop(&app, id, StopReason::Cap(cap));
            }
            let too_big = file
                .and_then(|file| std::fs::metadata(file).ok())
                .is_some_and(|metadata| metadata.len() >= MAX_FILE_BYTES);
            if too_big {
                return stop(&app, id, StopReason::Size);
            }
            let seconds = state.machine().elapsed(Instant::now()).as_secs();
            if seconds != shown {
                shown = seconds;
                refresh_ui(&app, id);
            }
        }
    });
}

/// Stops recording `id` and finalizes the file on a worker thread. A second stop, and a stop of
/// another recording, do nothing.
fn stop(app: &AppHandle, id: u64, reason: StopReason) {
    let state = app.state::<RecordingState>();
    if !state.machine().begin_stop(id) {
        return;
    }
    let Some(recorder) = lock(&state.recorder).take() else {
        eprintln!("[recording] {id} has no capture to stop");
        return;
    };
    eprintln!("[recording] {id} stopping: {reason:?}");
    emit_state(app);
    refresh_ui(app, id);
    let app = app.clone();
    std::thread::spawn(move || {
        let result = recorder.stop();
        finalized(&app, id, reason, result);
    });
}

fn finalized(
    app: &AppHandle,
    id: u64,
    reason: StopReason,
    result: Result<Finalized, RecordingError>,
) {
    let state = app.state::<RecordingState>();
    let file = state.machine().file.clone();
    let outcome = result.and_then(|finalized| {
        let bytes = file
            .as_deref()
            .and_then(|file| std::fs::metadata(file).ok())
            .map(|metadata| metadata.len())
            .ok_or_else(|| RecordingError::Failed("the recording file is missing".into()))?;
        Ok(Finished {
            bytes,
            duration: finalized.duration,
            notice: join_notices(reason.notice(), finalized.notices),
        })
    });
    match outcome {
        Ok(finished) => {
            eprintln!(
                "[recording] {id} finished: {} B, {:?}",
                finished.bytes, finished.duration
            );
            state.machine().finish(id, finished);
            *lock(&state.target) = None;
            release_lock(app);
            emit_state(app);
            refresh_ui(app, id);
            show_review(app);
        }
        Err(error) => {
            if let Some(file) = state.machine().fail_stop(id) {
                remove_file(&file);
            }
            *lock(&state.target) = None;
            release_lock(app);
            emit_state(app);
            refresh_ui(app, id);
            // A recording that never got a picture is the user's quick start-and-stop, not a fault.
            fail(app, &error.to_string());
        }
    }
}

fn remove_file(file: &Path) {
    match std::fs::remove_file(file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("[recording] could not delete {}: {error}", file.display()),
    }
}

/// Opens the review window, or brings it to the front. Created on its own thread: creating
/// windows inside a synchronous command deadlocks on Windows.
fn show_review(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Snipvero recording")
            .inner_size(760.0, 640.0)
            .min_inner_size(560.0, 480.0)
            .center()
            .focused(true)
            .build();
        if let Err(error) = built {
            eprintln!("[recording] could not open the review window: {error}");
            fail(
                &app,
                "The recording is ready, but its window could not open.",
            );
        }
    });
}

fn close_review(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

/// Deletes the finished recording `id`.
#[tauri::command]
pub fn recording_discard(
    app: AppHandle,
    id: u64,
    state: State<RecordingState>,
) -> Result<(), String> {
    let file = state.machine().discard(id)?;
    remove_file(&file);
    emit_state(&app);
    refresh_ui(&app, id);
    close_review(&app);
    Ok(())
}

/// The current state, for a window that opens after the last `recording-state` event.
#[tauri::command]
pub fn recording_status(state: State<RecordingState>) -> RecordingStatus {
    state.status()
}

/// The stored sound choices and the microphone permission, for the main window. Never prompts.
#[tauri::command]
pub fn recording_audio(app: AppHandle) -> AudioStatus {
    audio_status(&settings::load(&app), platform::microphone_access())
}

/// A sound source of a recording.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioKind {
    System,
    Microphone,
}

/// Switches a sound source on or off and remembers it. Turning the microphone on is the moment the
/// system may ask for permission (only while it has not been asked); a denied or restricted
/// microphone stays off, and the answer says why so the page can show how to allow it. Nothing
/// here runs, and no permission is looked at, while both sources stay off.
#[tauri::command]
pub async fn recording_set_audio(
    app: AppHandle,
    window: WebviewWindow,
    kind: AudioKind,
    enabled: bool,
) -> Result<AudioStatus, String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err("sound can only be changed in the main window".into());
    }
    if !platform::SUPPORTED {
        return Err(RecordingError::Unsupported.to_string());
    }
    let mut stored = settings::load(&app);
    match kind {
        AudioKind::System => stored.record_system_audio = enabled,
        AudioKind::Microphone => {
            let mut allowed = platform::microphone_access();
            if enabled && allowed == MicrophoneAccess::NotDetermined {
                allowed = ask_for_microphone().await;
            }
            // Whatever the answer, only an allowed microphone is switched on.
            stored.record_microphone = enabled && allowed == MicrophoneAccess::Authorized;
        }
    }
    settings::save(&app, &stored)?;
    Ok(audio_status(&stored, platform::microphone_access()))
}

/// Shows the system's microphone prompt and waits for the answer.
async fn ask_for_microphone() -> MicrophoneAccess {
    let (answer, wait) = std::sync::mpsc::channel();
    platform::request_microphone_access(Box::new(move |granted| {
        let _ = answer.send(granted);
    }));
    // The prompt waits for the user; ten minutes is longer than anyone leaves it.
    let granted = tauri::async_runtime::spawn_blocking(move || {
        wait.recv_timeout(Duration::from_secs(600)).unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    if granted {
        MicrophoneAccess::Authorized
    } else {
        platform::microphone_access()
    }
}

/// What `recording_copy` puts on the clipboard.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyKind {
    /// The file itself, to paste in Finder. Valid until the recording is deleted.
    File,
    Path,
}

#[tauri::command]
pub fn recording_copy(id: u64, kind: CopyKind, state: State<RecordingState>) -> Result<(), String> {
    let file = state
        .machine()
        .finished_file(id)
        .map(Path::to_path_buf)
        .ok_or("that recording no longer exists")?;
    match kind {
        CopyKind::File => platform::copy_file(&file),
        CopyKind::Path => platform::copy_text(&file.to_string_lossy()),
    }
    .map_err(|error| format!("Could not copy the recording: {error}"))
}

/// Asks where to save the finished recording `id`, then copies the temporary file there, through
/// a hidden sibling renamed over the target (ADR-019). After a successful save the temporary file
/// is deleted: the saved copy is separate (ADR-037).
#[tauri::command]
pub async fn recording_save(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    file_name: String,
    state: State<'_, RecordingState>,
) -> Result<ExportOutcome, String> {
    if !export::valid_file_name_with(&file_name, ".mp4") {
        return Err(format!("invalid file name {file_name:?}"));
    }
    let source = state.machine().begin_save(id)?;
    let result = save(&window, &source, file_name).await;
    state.machine().end_save();
    if matches!(result, Ok(ExportOutcome::Done)) {
        // The save itself succeeded; a file that cannot be deleted is logged by `remove_file`.
        if let Ok(file) = state.machine().discard(id) {
            remove_file(&file);
        }
        emit_state(&app);
        refresh_ui(&app, id);
        close_review(&app);
    }
    result
}

async fn save(
    window: &WebviewWindow,
    source: &Path,
    file_name: String,
) -> Result<ExportOutcome, String> {
    let dialog = rfd::FileDialog::new()
        .set_title("Save recording")
        .set_file_name(file_name)
        .add_filter("MP4 video", &["mp4"])
        .set_parent(window);
    let Some(path) = tauri::async_runtime::spawn_blocking(move || dialog.save_file())
        .await
        .map_err(|e| format!("save dialog failed: {e}"))?
    else {
        return Ok(ExportOutcome::Cancelled);
    };
    let source = source.to_path_buf();
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export::replace_with(&target, |file| {
            std::io::copy(&mut std::fs::File::open(&source)?, file).map(|_| ())
        })
    })
    .await
    .map_err(|e| format!("save failed: {e}"))?
    .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    eprintln!("[recording] saved to {}", path.display());
    Ok(ExportOutcome::Done)
}

/// Removes the leftovers of earlier launches. Call once at startup, off the main thread.
pub fn cleanup_stale(app: &AppHandle) {
    let launched = app.state::<RecordingState>().launched;
    std::thread::spawn(move || {
        let (removed, failed) = tempfiles::remove_stale(&tempfiles::root(), None, launched);
        if removed > 0 {
            eprintln!("[recording] removed {removed} leftover recording folder(s)");
        }
        for (path, error) in failed {
            eprintln!("[recording] could not remove {}: {error}", path.display());
        }
    });
}

/// Ends a running capture and deletes this launch's recordings. Called when the app exits, on the
/// main thread, where blocking for a moment is acceptable.
pub fn on_exit(app: &AppHandle) {
    let state = app.state::<RecordingState>();
    if let Some(recorder) = lock(&state.recorder).take() {
        recorder.cancel();
    }
    let dir = lock(&state.launch_dir).take();
    if let Some(dir) = dir
        && let Err(error) = std::fs::remove_dir_all(&dir)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("[recording] could not delete {}: {error}", dir.display());
    }
}

/// A requested byte range of the preview file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Range {
    Whole,
    /// Inclusive first and last byte.
    Part(u64, u64),
    Unsatisfiable,
}

/// Parses a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range against a file of
/// `len` bytes, and limits one answer to `MAX_CHUNK`. WebKit streams video with such requests.
fn parse_range(header: Option<&str>, len: u64) -> Range {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Range::Whole;
    };
    if len == 0 || spec.contains(',') {
        return if len == 0 {
            Range::Whole
        } else {
            Range::Unsatisfiable
        };
    }
    let Some((start, end)) = spec.split_once('-') else {
        return Range::Unsatisfiable;
    };
    let (first, last) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let Ok(suffix) = suffix.parse::<u64>() else {
                return Range::Unsatisfiable;
            };
            (len.saturating_sub(suffix), len - 1)
        }
        (start, "") => {
            let Ok(start) = start.parse::<u64>() else {
                return Range::Unsatisfiable;
            };
            (start, len - 1)
        }
        (start, end) => match (start.parse::<u64>(), end.parse::<u64>()) {
            (Ok(start), Ok(end)) => (start, end.min(len - 1)),
            _ => return Range::Unsatisfiable,
        },
    };
    if first > last || first >= len {
        return Range::Unsatisfiable;
    }
    Range::Part(first, last.min(first + MAX_CHUNK - 1))
}

/// The `snipvero-recording://localhost/<id>` protocol of the review window's video element. It
/// serves only the finished recording with that id, read from the temporary file here.
pub fn serve(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let file = request
        .uri()
        .path()
        .trim_matches('/')
        .parse::<u64>()
        .ok()
        .and_then(|id| {
            app.state::<RecordingState>()
                .machine()
                .finished_file(id)
                .map(Path::to_path_buf)
        });
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    std::thread::spawn(move || {
        let response = file
            .ok_or(404)
            .and_then(|file| read_range(&file, range.as_deref()))
            .unwrap_or_else(|status| {
                let mut builder = Response::builder().status(status);
                if status == 416 {
                    builder = builder.header("Content-Range", "bytes */0");
                }
                builder.body(Vec::new()).unwrap_or_default()
            });
        responder.respond(response);
    });
}

/// The preview response for `range` of `file`; the error is the HTTP status to answer with.
fn read_range(file: &Path, range: Option<&str>) -> Result<Response<Vec<u8>>, u16> {
    use std::io::{Read, Seek, SeekFrom};

    let mut handle = std::fs::File::open(file).map_err(|_| 404u16)?;
    let len = handle.metadata().map_err(|_| 500u16)?.len();
    let (status, first, last) = match parse_range(range, len) {
        Range::Whole => (200, 0, len.saturating_sub(1).min(MAX_CHUNK - 1)),
        Range::Part(first, last) => (206, first, last),
        Range::Unsatisfiable => return Err(416),
    };
    let count = if len == 0 { 0 } else { last - first + 1 };
    let mut body = vec![0; count as usize];
    handle.seek(SeekFrom::Start(first)).map_err(|_| 500u16)?;
    handle.read_exact(&mut body).map_err(|_| 500u16)?;
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", "video/mp4")
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store")
        .header("Content-Length", count);
    if status == 206 || len > count {
        builder = builder
            .status(206)
            .header("Content-Range", format!("bytes {first}-{last}/{len}"));
    }
    builder.body(body).map_err(|_| 500u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: Duration = Duration::from_secs(300);

    fn running(machine: &mut Machine, now: Instant) -> u64 {
        let id = machine.begin_start(CAP, (640, 480)).unwrap();
        assert!(machine.mark_recording(id, PathBuf::from("/tmp/a.mp4"), now));
        id
    }

    fn finished() -> Finished {
        Finished {
            bytes: 1234,
            duration: Duration::from_secs(5),
            notice: None,
        }
    }

    #[test]
    fn a_recording_walks_through_every_phase_once() {
        let mut machine = Machine::default();
        assert_eq!(machine.phase, Phase::Idle);
        let id = machine.begin_start(CAP, (640, 480)).unwrap();
        assert_eq!(machine.phase, Phase::Starting);
        assert!(machine.mark_recording(id, PathBuf::from("/tmp/a.mp4"), Instant::now()));
        assert_eq!(machine.phase, Phase::Recording);
        assert!(machine.begin_stop(id));
        assert_eq!(machine.phase, Phase::Stopping);
        assert!(machine.finish(id, finished()));
        assert_eq!(machine.phase, Phase::Finished);
        assert_eq!(machine.discard(id), Ok(PathBuf::from("/tmp/a.mp4")));
        assert_eq!(machine.phase, Phase::Idle);
    }

    #[test]
    fn only_one_recording_at_a_time_and_none_over_an_unsaved_one() {
        let mut machine = Machine::default();
        let id = machine.begin_start(CAP, (640, 480)).unwrap();
        for _ in 0..2 {
            assert_eq!(machine.begin_start(CAP, (1, 1)), Err(Refusal::Busy));
            machine.mark_recording(id, PathBuf::from("/tmp/a.mp4"), Instant::now());
        }
        machine.begin_stop(id);
        assert_eq!(machine.begin_start(CAP, (1, 1)), Err(Refusal::Busy));
        machine.finish(id, finished());
        // The user must decide about the finished recording first: it is never overwritten.
        assert_eq!(machine.begin_start(CAP, (1, 1)), Err(Refusal::Pending));
        machine.discard(id).unwrap();
        let next = machine.begin_start(CAP, (1, 1)).unwrap();
        assert_eq!(next, id + 1);
    }

    #[test]
    fn a_stale_id_changes_nothing() {
        let mut machine = Machine::default();
        let old = running(&mut machine, Instant::now());
        machine.begin_stop(old);
        machine.finish(old, finished());
        machine.discard(old).unwrap();
        let current = running(&mut machine, Instant::now());
        // A late timer, page or callback of the first recording.
        assert!(!machine.begin_stop(old));
        assert!(!machine.mark_recording(old, PathBuf::from("/tmp/b.mp4"), Instant::now()));
        assert!(!machine.fail_start(old));
        assert!(!machine.finish(old, finished()));
        assert_eq!(machine.fail_stop(old), None);
        assert!(machine.discard(old).is_err());
        assert!(machine.begin_save(old).is_err());
        assert_eq!(machine.phase, Phase::Recording);
        assert!(machine.is(current, Phase::Recording));
    }

    #[test]
    fn stopping_twice_finalizes_once() {
        let mut machine = Machine::default();
        let id = running(&mut machine, Instant::now());
        assert!(machine.begin_stop(id));
        // The tray, the shortcut and the cap can all fire together.
        assert!(!machine.begin_stop(id));
        assert!(machine.finish(id, finished()));
        assert!(!machine.finish(id, finished()));
    }

    #[test]
    fn a_failed_start_or_finalize_returns_to_idle_and_names_the_file_to_delete() {
        let mut machine = Machine::default();
        let id = machine.begin_start(CAP, (640, 480)).unwrap();
        assert!(machine.fail_start(id));
        assert_eq!(machine.phase, Phase::Idle);

        let id = running(&mut machine, Instant::now());
        machine.begin_stop(id);
        assert_eq!(machine.fail_stop(id), Some(PathBuf::from("/tmp/a.mp4")));
        assert_eq!(machine.phase, Phase::Idle);
        assert!(machine.begin_start(CAP, (1, 1)).is_ok());
    }

    #[test]
    fn the_cap_is_a_monotonic_deadline() {
        let mut machine = Machine::default();
        let start = Instant::now();
        let cap = Duration::from_secs(10);
        let id = machine.begin_start(cap, (640, 480)).unwrap();
        // Not running yet: the deadline cannot fire.
        assert!(!machine.cap_reached(start + Duration::from_secs(60)));
        machine.mark_recording(id, PathBuf::from("/tmp/a.mp4"), start);
        assert!(!machine.cap_reached(start + Duration::from_millis(9_999)));
        assert!(machine.cap_reached(start + Duration::from_secs(10)));
        assert_eq!(
            machine.elapsed(start + Duration::from_secs(4)),
            Duration::from_secs(4)
        );
        // A clock reading before the start never underflows.
        assert_eq!(
            machine.elapsed(start - Duration::from_secs(1)),
            Duration::ZERO
        );
        // Once stopping, the cap no longer applies.
        machine.begin_stop(id);
        assert!(!machine.cap_reached(start + Duration::from_secs(60)));
    }

    #[test]
    fn saving_keeps_the_file_and_one_save_runs_at_a_time() {
        let mut machine = Machine::default();
        let id = running(&mut machine, Instant::now());
        assert!(machine.begin_save(id).is_err(), "not finished yet");
        machine.begin_stop(id);
        machine.finish(id, finished());
        assert_eq!(machine.begin_save(id), Ok(PathBuf::from("/tmp/a.mp4")));
        assert!(machine.begin_save(id).is_err());
        assert!(
            machine.discard(id).is_err(),
            "no discard under a save dialog"
        );
        assert!(machine.finished_file(id).is_some());
        machine.end_save();
        assert!(machine.discard(id).is_ok());
        assert!(machine.finished_file(id).is_none());
    }

    #[test]
    fn the_preview_serves_only_the_finished_recording() {
        let mut machine = Machine::default();
        let id = running(&mut machine, Instant::now());
        assert!(machine.finished_file(id).is_none());
        machine.begin_stop(id);
        machine.finish(id, finished());
        assert_eq!(machine.finished_file(id), Some(Path::new("/tmp/a.mp4")));
        assert!(machine.finished_file(id + 1).is_none());
    }

    #[test]
    fn status_reports_the_phase_and_hides_the_id_when_idle() {
        let mut machine = Machine::default();
        let now = Instant::now();
        assert_eq!(machine.status(now, 0).id, None);
        let id = running(&mut machine, now);
        let status = machine.status(now + Duration::from_secs(3), 99);
        assert_eq!(
            (status.id, status.phase, status.elapsed_ms, status.cap_ms),
            (Some(id), Phase::Recording, 3_000, 300_000)
        );
        assert_eq!((status.width, status.height, status.bytes), (640, 480, 99));
        machine.begin_stop(id);
        machine.finish(
            id,
            Finished {
                notice: Some("capped".into()),
                ..finished()
            },
        );
        let status = machine.status(now, 0);
        assert_eq!(
            (status.phase, status.duration_ms, status.bytes),
            (Phase::Finished, Some(5_000), 1234)
        );
        assert_eq!(status.notice.as_deref(), Some("capped"));
    }

    const BOTH: AudioChoice = AudioChoice {
        system: true,
        microphone: true,
    };
    const MIC: AudioChoice = AudioChoice {
        system: false,
        microphone: true,
    };

    #[test]
    fn with_both_sources_off_nothing_is_asked_whatever_the_permission_is() {
        for access in [
            MicrophoneAccess::NotDetermined,
            MicrophoneAccess::Authorized,
            MicrophoneAccess::Denied,
            MicrophoneAccess::Restricted,
            MicrophoneAccess::Unsupported,
        ] {
            for without in [false, true] {
                assert_eq!(
                    plan_microphone(AudioChoice::default(), access, without),
                    Ok(AudioChoice::default()),
                    "{access:?}"
                );
            }
        }
        assert!(!AudioChoice::default().any());
    }

    #[test]
    fn system_audio_needs_no_microphone_permission() {
        let system = AudioChoice {
            system: true,
            microphone: false,
        };
        assert_eq!(
            plan_microphone(system, MicrophoneAccess::Denied, false),
            Ok(system)
        );
    }

    #[test]
    fn an_allowed_microphone_is_recorded() {
        assert_eq!(
            plan_microphone(BOTH, MicrophoneAccess::Authorized, false),
            Ok(BOTH)
        );
    }

    #[test]
    fn a_microphone_that_is_not_allowed_is_refused_not_dropped_silently() {
        for access in [
            MicrophoneAccess::NotDetermined,
            MicrophoneAccess::Denied,
            MicrophoneAccess::Restricted,
            MicrophoneAccess::Unsupported,
        ] {
            assert_eq!(
                plan_microphone(BOTH, access, false),
                Err(MICROPHONE_UNAVAILABLE),
                "{access:?}"
            );
            assert_eq!(
                plan_microphone(MIC, access, false),
                Err(MICROPHONE_UNAVAILABLE),
                "{access:?}"
            );
        }
    }

    #[test]
    fn going_on_without_the_microphone_keeps_the_other_source() {
        assert_eq!(
            plan_microphone(BOTH, MicrophoneAccess::Denied, true),
            Ok(AudioChoice {
                system: true,
                microphone: false
            })
        );
        assert_eq!(
            plan_microphone(MIC, MicrophoneAccess::Denied, true),
            Ok(AudioChoice::default())
        );
    }

    #[test]
    fn the_stored_choices_become_the_audio_status() {
        let stored = settings::Settings {
            record_microphone: true,
            ..settings::Settings::default()
        };
        let status = audio_status(&stored, MicrophoneAccess::Denied);
        assert_eq!(
            (status.system, status.microphone, status.microphone_access),
            (false, true, MicrophoneAccess::Denied)
        );
        let off = audio_status(
            &settings::Settings::default(),
            MicrophoneAccess::NotDetermined,
        );
        assert_eq!((off.system, off.microphone), (false, false));
        assert_eq!(stored_audio(&stored), MIC);
    }

    #[test]
    fn the_notice_joins_the_stop_reason_and_the_sound_problems() {
        assert_eq!(join_notices(None, vec![]), None);
        assert_eq!(
            join_notices(Some("Stopped.".into()), vec![]),
            Some("Stopped.".into())
        );
        assert_eq!(
            join_notices(None, vec!["No microphone audio.".into()]),
            Some("No microphone audio.".into())
        );
        assert_eq!(
            join_notices(Some("Stopped.".into()), vec!["A.".into(), "B.".into()]),
            Some("Stopped. A. B.".into())
        );
    }

    #[test]
    fn the_status_says_which_sound_the_recording_has() {
        let mut machine = Machine::default();
        let now = Instant::now();
        assert!(!machine.status(now, 0).system_audio && !machine.status(now, 0).microphone);
        let id = machine
            .begin_start(Duration::from_secs(300), (640, 480))
            .unwrap();
        machine.set_audio(id, BOTH);
        let status = machine.status(now, 0);
        assert!(status.system_audio && status.microphone);
        // Another recording's id changes nothing.
        machine.set_audio(id + 1, AudioChoice::default());
        assert!(machine.status(now, 0).microphone);
        // The next recording starts with its own choice.
        machine.fail_start(id);
        let next = machine
            .begin_start(Duration::from_secs(300), (1, 1))
            .unwrap();
        assert!(!machine.status(now, 0).system_audio, "{next}");
    }

    #[test]
    fn the_cap_setting_is_clamped_and_defaults() {
        assert_eq!(cap_from_setting(None), Duration::from_secs(300));
        assert_eq!(cap_from_setting(Some(60)), Duration::from_secs(60));
        assert_eq!(cap_from_setting(Some(1)), Duration::from_secs(10));
        assert_eq!(cap_from_setting(Some(0)), Duration::from_secs(10));
        assert_eq!(cap_from_setting(Some(86_400)), Duration::from_secs(600));
    }

    #[test]
    fn the_clock_shows_minutes_and_seconds() {
        assert_eq!(clock(Duration::ZERO), "0:00");
        assert_eq!(clock(Duration::from_millis(59_999)), "0:59");
        assert_eq!(clock(Duration::from_secs(61)), "1:01");
        assert_eq!(clock(Duration::from_secs(600)), "10:00");
    }

    #[test]
    fn the_tray_row_follows_the_phase() {
        assert_eq!(menu_entry(Phase::Idle), ("Record Region", true));
        assert_eq!(menu_entry(Phase::Recording), ("Stop Recording", true));
        assert_eq!(
            menu_entry(Phase::Finished),
            ("Review Last Recording…", true)
        );
        // Nothing can be clicked while the capture starts or the file is being finalized.
        assert!(!menu_entry(Phase::Starting).1);
        assert!(!menu_entry(Phase::Stopping).1);
    }

    #[test]
    fn stop_reasons_explain_themselves_except_a_plain_stop() {
        assert_eq!(StopReason::User.notice(), None);
        assert_eq!(
            StopReason::Cap(Duration::from_secs(300))
                .notice()
                .as_deref(),
            Some("The recording stopped at the maximum length (5:00).")
        );
        assert!(
            StopReason::Failure("disk full".into())
                .notice()
                .is_some_and(|n| n.contains("disk full"))
        );
    }

    #[test]
    fn ranges_follow_http() {
        assert_eq!(parse_range(None, 1000), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Range::Part(0, 99));
        // Open-ended and oversized ranges are answered with a bounded piece.
        assert_eq!(parse_range(Some("bytes=0-"), 1000), Range::Part(0, 999));
        assert_eq!(
            parse_range(Some("bytes=900-5000"), 1000),
            Range::Part(900, 999)
        );
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Range::Part(900, 999));
        assert_eq!(parse_range(Some("bytes=-5000"), 1000), Range::Part(0, 999));
        let big = 100 << 20;
        assert_eq!(
            parse_range(Some("bytes=10-"), big),
            Range::Part(10, 10 + MAX_CHUNK - 1)
        );
    }

    #[test]
    fn unusable_ranges_are_refused() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=50-10"), 1000), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=a-b"), 1000), Range::Unsatisfiable);
        assert_eq!(
            parse_range(Some("bytes=0-1,5-6"), 1000),
            Range::Unsatisfiable
        );
        // Not a byte range at all: the whole file.
        assert_eq!(parse_range(Some("items=0-1"), 1000), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Range::Whole);
    }

    #[test]
    fn preview_responses_carry_the_range_headers() {
        let dir = std::env::temp_dir().join(format!("snipvero-serve-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.mp4");
        std::fs::write(&file, (0..=255u8).collect::<Vec<_>>()).unwrap();

        let part = read_range(&file, Some("bytes=10-19")).unwrap();
        assert_eq!(part.status().as_u16(), 206);
        assert_eq!(part.body(), &(10..=19u8).collect::<Vec<_>>());
        assert_eq!(part.headers()["Content-Range"], "bytes 10-19/256");
        assert_eq!(part.headers()["Content-Type"], "video/mp4");
        let whole = read_range(&file, None).unwrap();
        assert_eq!((whole.status().as_u16(), whole.body().len()), (200, 256));
        assert_eq!(read_range(&file, Some("bytes=999-")).unwrap_err(), 416);
        assert_eq!(read_range(&dir.join("missing.mp4"), None).unwrap_err(), 404);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
