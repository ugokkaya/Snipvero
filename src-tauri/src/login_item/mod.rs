//! Opening Snipvero when the user logs in (ADR-033). macOS only for now: elsewhere it is
//! unsupported, the tray has no item for it and the app never counts as launched at login.

#[cfg(target_os = "macos")]
mod macos;

/// Whether this platform can open Snipvero at login.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

/// Whether Snipvero is registered and allowed to open at login. Read from the OS each time, because
/// the user can also change it in System Settings.
pub fn is_enabled() -> bool {
    #[cfg(target_os = "macos")]
    return macos::is_enabled();
    #[cfg(not(target_os = "macos"))]
    false
}

/// Registers or removes Snipvero as a login item.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::set_enabled(enabled);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Err("opening at login is not supported on this platform".into())
    }
}

/// True when the OS started this process as a login item. Only meaningful while the app finishes
/// launching (`RunEvent::Ready`).
pub fn launched_at_login() -> bool {
    #[cfg(target_os = "macos")]
    return macos::launched_at_login();
    #[cfg(not(target_os = "macos"))]
    false
}
