//! Small OS integrations outside capture itself: the frontmost app (for focus restoration) and
//! the Screen Recording settings page. No-ops where an OS has no equivalent yet.

#[cfg(target_os = "macos")]
mod macos;

/// Identifies the app that was active before a capture (a process ID on macOS).
pub type AppId = i32;

/// The active app, unless it is Snipvero itself.
pub fn frontmost_app() -> Option<AppId> {
    #[cfg(target_os = "macos")]
    return macos::frontmost_app();
    #[cfg(not(target_os = "macos"))]
    None
}

/// Gives focus back to `app`. Snipvero's own windows keep their stacking order behind it.
pub fn activate_app(app: AppId) {
    #[cfg(target_os = "macos")]
    macos::activate_app(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Opens the OS page where Screen Recording permission is granted.
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::open_screen_recording_settings();
    #[cfg(not(target_os = "macos"))]
    Err("there is no screen recording permission page on this platform".into())
}

/// Opens a web page in the default browser. Callers pass fixed addresses only (ADR-024).
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::open_url(url);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("opening links is not implemented on this platform yet".into())
    }
}

/// Opens a local file in its default app.
pub fn open_file(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::open_file(path);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("opening files is not implemented on this platform yet".into())
    }
}
