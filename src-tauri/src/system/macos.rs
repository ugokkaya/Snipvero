use std::path::Path;

use objc2::rc::Retained;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSString, NSURL};

use super::AppId;

const SCREEN_RECORDING_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

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
    open(&url, "System Settings could not be opened")
}

pub fn open_url(url: &str) -> Result<(), String> {
    let url = NSURL::URLWithString(&NSString::from_str(url)).ok_or("invalid URL")?;
    open(&url, "the link could not be opened")
}

pub fn open_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} not found", path.display()));
    }
    let path = path.to_str().ok_or("file path is not valid UTF-8")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    open(&url, "the file could not be opened")
}

fn open(url: &Retained<NSURL>, error: &str) -> Result<(), String> {
    if NSWorkspace::sharedWorkspace().openURL(url) {
        Ok(())
    } else {
        Err(error.into())
    }
}
