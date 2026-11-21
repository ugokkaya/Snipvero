//! Windows has no recording backend yet: this stub only has to compile (CI), and every entry point
//! says so (ADR-037). Other non-macOS systems use it as well.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use super::gif::{Picture, ReadError};
use super::{Finalized, MicrophoneAccess, RecordingError, StartRequest};

pub const SUPPORTED: bool = false;

/// Never constructed: `start` always fails.
pub struct Recorder;

pub fn start(_request: StartRequest) -> Result<Recorder, RecordingError> {
    Err(RecordingError::Unsupported)
}

impl Recorder {
    pub fn stop(self) -> Result<Finalized, RecordingError> {
        Err(RecordingError::Unsupported)
    }

    pub fn cancel(self) {}
}

pub fn available_space(_path: &Path) -> Option<u64> {
    None
}

pub fn copy_file(_path: &Path) -> Result<(), String> {
    Err(RecordingError::Unsupported.to_string())
}

pub fn copy_text(_text: &str) -> Result<(), String> {
    Err(RecordingError::Unsupported.to_string())
}

pub fn microphone_access() -> MicrophoneAccess {
    MicrophoneAccess::Unsupported
}

pub fn request_microphone_access(done: Box<dyn FnOnce(bool) + Send>) {
    done(false);
}

/// No frame source on this platform: a GIF cannot be made.
pub fn read_pictures(
    _path: &Path,
    _cancel: &AtomicBool,
    _on_picture: &mut dyn FnMut(Picture<'_>) -> Result<(), String>,
) -> Result<(), ReadError> {
    Err(ReadError::Failed(RecordingError::Unsupported.to_string()))
}
