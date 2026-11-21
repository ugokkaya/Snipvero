use std::path::Path;

use objc2::rc::Retained;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSString, NSURL};

use super::AppId;
use crate::i18n::tr;

const SCREEN_RECORDING_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

const MICROPHONE_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

pub fn frontmost_app() -> Option<AppId> {
    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    (pid != std::process::id() as AppId).then_some(pid)
}

pub fn activate_app(pid: AppId) {
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

pub fn open_screen_recording_settings() -> Result<(), String> {
    let url = NSURL::URLWithString(&NSString::from_str(SCREEN_RECORDING_SETTINGS))
        .ok_or("invalid settings URL")?;
    open(
        &url,
        tr!(
            "System Settings could not be opened",
            "Sistem Ayarları açılamadı"
        ),
    )
}

pub fn open_microphone_settings() -> Result<(), String> {
    let url = NSURL::URLWithString(&NSString::from_str(MICROPHONE_SETTINGS))
        .ok_or("invalid settings URL")?;
    open(
        &url,
        tr!(
            "System Settings could not be opened",
            "Sistem Ayarları açılamadı"
        ),
    )
}

pub fn open_url(url: &str) -> Result<(), String> {
    let url = NSURL::URLWithString(&NSString::from_str(url)).ok_or("invalid URL")?;
    open(
        &url,
        tr!("the link could not be opened", "bağlantı açılamadı"),
    )
}

pub fn open_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(tr!(
            format!("{} not found", path.display()),
            format!("{} bulunamadı", path.display())
        ));
    }
    let path = path.to_str().ok_or("file path is not valid UTF-8")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    open(&url, tr!("the file could not be opened", "dosya açılamadı"))
}

fn open(url: &Retained<NSURL>, error: &str) -> Result<(), String> {
    if NSWorkspace::sharedWorkspace().openURL(url) {
        Ok(())
    } else {
        Err(error.into())
    }
}
