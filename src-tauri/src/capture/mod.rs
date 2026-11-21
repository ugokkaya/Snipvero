//! Screen capture: one frame per display, held in memory only (never written to disk).
//!
//! This module is the platform-independent interface. Backends live in `macos.rs` and, later,
//! `windows.rs` (see docs/DECISIONS.md, ADR-008, for the Windows options).

use std::fmt;

use serde::Serialize;

use crate::geometry::LogicalRect;
use crate::i18n::tr;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
/// What the recording backend needs to build the same content filter as a screenshot.
#[cfg(target_os = "macos")]
pub(crate) use macos::{PIXEL_FORMAT_BGRA, own_applications, shareable_content};

/// A captured display.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Frame {
    pub display_id: u32,
    /// Display bounds in logical desktop coordinates (see `geometry`).
    pub bounds: LogicalRect,
    /// Physical pixels per logical unit, as reported by the capture backend.
    pub scale: f64,
    pub width: u32,
    pub height: u32,
    /// Tightly packed BGRA8 rows (stride = `width * 4`), opaque.
    pub bgra: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTimings {
    /// Enumerating displays (ScreenCaptureKit shareable content on macOS).
    pub enumerate_ms: f64,
    /// From issuing all display captures until the last image arrived.
    pub capture_ms: f64,
    /// Copying pixels out of the native images into `Frame::bgra`.
    pub copy_ms: f64,
}

#[derive(Debug)]
pub enum CaptureError {
    PermissionDenied,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Failed(String),
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CaptureError::PermissionDenied => f.write_str(tr!(
                "Screen Recording permission is required. Allow Snipvero in System Settings → \
                 Privacy & Security → Screen & System Audio Recording, then restart Snipvero.",
                "Ekran Kaydı izni gerekiyor. Sistem Ayarları → Gizlilik ve Güvenlik → \
                 Ekran ve Sistem Ses Kaydı bölümünde Snipvero'ya izin verin, ardından \
                 Snipvero'yu yeniden başlatın."
            )),
            CaptureError::Unsupported => f.write_str(tr!(
                "Screen capture is not implemented on this platform yet.",
                "Ekran yakalama bu platformda henüz desteklenmiyor."
            )),
            CaptureError::Failed(reason) => write!(
                f,
                "{}",
                tr!(
                    format!("Screen capture failed: {reason}"),
                    format!("Ekran yakalama başarısız oldu: {reason}")
                )
            ),
        }
    }
}

/// Whether capture is currently allowed, without prompting the user.
pub fn has_permission() -> bool {
    #[cfg(target_os = "macos")]
    return platform::has_permission();
    #[cfg(not(target_os = "macos"))]
    true
}

/// Asks the OS for capture permission. On macOS this shows the system prompt only once per app;
/// the user must then enable the app in System Settings and restart it.
pub fn request_permission() {
    #[cfg(target_os = "macos")]
    platform::request_permission();
}

/// Forgets the cached display enumeration; call when the display arrangement changes.
pub fn invalidate_cache() {
    #[cfg(target_os = "macos")]
    platform::invalidate_cache();
}

/// Captures every display. Blocks the calling thread; do not call from the main thread.
pub fn capture_displays() -> Result<(Vec<Frame>, CaptureTimings), CaptureError> {
    #[cfg(target_os = "macos")]
    return platform::capture_displays();
    #[cfg(not(target_os = "macos"))]
    Err(CaptureError::Unsupported)
}
