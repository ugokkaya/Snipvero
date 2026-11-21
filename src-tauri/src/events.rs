//! Event names shared with the frontend. Keep in sync with `src/ipc.ts`.

/// Emitted with a user-facing message when a capture cannot be taken (for example, no permission).
pub const CAPTURE_FAILED: &str = "capture-failed";

/// Sent to a pre-created overlay window with the new session ID: load and show its frame.
pub const OVERLAY_LOAD: &str = "overlay-load";

/// Sent to an overlay with the session ID when another display took the selection: clear it.
pub const OVERLAY_SELECTION_CLEARED: &str = "overlay-selection-cleared";

/// Sent to the main window by the menu bar's **Check for Updates…**: start an update check.
pub const UPDATE_CHECK_REQUESTED: &str = "update-check-requested";

/// Sent to every window with the new interface language (`"en"` or `"tr"`) when the user changes it.
pub const LANGUAGE_CHANGED: &str = "language-changed";

/// Sent to every window with the `RecordingStatus` on each state change of a recording (not per frame).
pub const RECORDING_STATE: &str = "recording-state";

/// Emitted with a user-facing message when a recording cannot start or ends without a file
/// (permission lost, disk full, encoder error).
pub const RECORDING_FAILED: &str = "recording-failed";

/// Sent to the recording review window while a GIF export runs: `{ id, phase, fraction, message }`,
/// at most about ten times a second, then once with `done`, `cancelled` or `failed`.
pub const RECORDING_EXPORT_PROGRESS: &str = "recording-export-progress";
