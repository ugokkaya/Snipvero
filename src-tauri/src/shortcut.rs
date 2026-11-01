//! Global capture shortcut: registered at startup from the settings, changed from the main window
//! (ADR-014, ADR-030).

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcut, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

use crate::settings::{self, Settings};

/// Cmd+Shift+2 on macOS, Ctrl+Shift+2 on Windows (FR-1).
pub const DEFAULT_ACCELERATOR: &str = "CommandOrControl+Shift+2";

/// Combinations the system or nearly every app relies on; a global shortcut would take them away.
#[cfg(target_os = "macos")]
const RESERVED: &[&str] = &[
    "Super+Shift+3",
    "Super+Shift+4",
    "Super+Shift+5",
    "Super+Shift+6",
    "Super+Shift+Q",
    "Super+Shift+Z",
    "Super+Alt+Escape",
    "Control+Super+Q",
    "Control+Super+F",
    "Control+Super+Space",
];
#[cfg(not(target_os = "macos"))]
const RESERVED: &[&str] = &[
    "Control+Alt+Delete",
    "Control+Shift+Escape",
    "Control+Shift+Z",
    "Super+Shift+S",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub accelerator: String,
    pub registered: bool,
    /// Why registration failed, for example another app already owns the combination.
    pub error: Option<String>,
}

/// Why a new shortcut was not taken; the page words it per platform (`src/shortcut.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Rejection {
    /// Not a combination the shortcut plugin understands.
    Invalid,
    /// Too few modifiers: it would take a key other apps need.
    Modifiers,
    /// Used by the system or by nearly every app.
    Reserved,
    /// The system refused to register it, usually because another app holds it.
    Unavailable,
    /// Registered, but the settings file could not be written; the previous shortcut stays.
    NotSaved,
    /// Only the main window may change the shortcut.
    NotAllowed,
}

#[derive(Default)]
struct Inner {
    status: Option<ShortcutStatus>,
    /// Released while the main window records a new shortcut, so pressing the current one there
    /// neither starts a capture nor gets swallowed before the page sees it.
    suspended: bool,
}

#[derive(Default)]
pub struct ShortcutRegistry(Mutex<Inner>);

impl ShortcutRegistry {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> Option<ShortcutStatus> {
        self.lock().status.clone()
    }
}

pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            // Only one shortcut is registered; react on key down, not on release.
            if event.state() == ShortcutState::Pressed {
                crate::overlay::start(app);
            }
        })
        .build()
}

fn is_function_key(key: Code) -> bool {
    use Code::*;
    matches!(
        key,
        F1 | F2
            | F3
            | F4
            | F5
            | F6
            | F7
            | F8
            | F9
            | F10
            | F11
            | F12
            | F13
            | F14
            | F15
            | F16
            | F17
            | F18
            | F19
            | F20
            | F21
            | F22
            | F23
            | F24
    )
}

fn same_keys(a: &Shortcut, b: &Shortcut) -> bool {
    a.mods == b.mods && a.key == b.key
}

/// Whether `accelerator` may become the capture shortcut. It needs Command/Control/Option (Alt)
/// and, except on F1–F24, a second modifier: one-modifier combinations are what apps use for
/// their own commands, and Option+key types characters on macOS.
pub fn validate(accelerator: &str) -> Result<Shortcut, Rejection> {
    let shortcut: Shortcut = accelerator.parse().map_err(|_| Rejection::Invalid)?;
    let modifiers = [
        Modifiers::SUPER,
        Modifiers::CONTROL,
        Modifiers::ALT,
        Modifiers::SHIFT,
    ];
    let held = modifiers
        .iter()
        .filter(|m| shortcut.mods.contains(**m))
        .count();
    let needed = if is_function_key(shortcut.key) { 1 } else { 2 };
    if shortcut.mods == Modifiers::SHIFT || held < needed {
        return Err(Rejection::Modifiers);
    }
    let reserved = RESERVED
        .iter()
        .filter_map(|r| r.parse::<Shortcut>().ok())
        .any(|r| same_keys(&r, &shortcut));
    if reserved {
        return Err(Rejection::Reserved);
    }
    Ok(shortcut)
}

/// Registers the saved shortcut, or the default when none is saved or the saved one is no longer
/// acceptable, and records the outcome for the UI.
pub fn register_saved(app: &AppHandle) -> ShortcutStatus {
    let accelerator = match settings::load(app).shortcut {
        Some(saved) if validate(&saved).is_ok() => saved,
        Some(saved) => {
            eprintln!("[shortcut] ignoring saved shortcut \"{saved}\"; using the default");
            DEFAULT_ACCELERATOR.to_string()
        }
        None => DEFAULT_ACCELERATOR.to_string(),
    };
    register(app, &accelerator)
}

fn register(app: &AppHandle, accelerator: &str) -> ShortcutStatus {
    let result = accelerator
        .parse::<Shortcut>()
        .map_err(|e| format!("invalid shortcut \"{accelerator}\": {e}"))
        .and_then(|shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|e| e.to_string())
        });
    let status = ShortcutStatus {
        accelerator: accelerator.to_string(),
        registered: result.is_ok(),
        error: result.err(),
    };
    if let Some(error) = &status.error {
        eprintln!("[shortcut] {error}");
    }
    app.state::<ShortcutRegistry>().lock().status = Some(status.clone());
    status
}

/// Registers `shortcut` again after a failed change; the status says if even that failed.
fn reactivate(global: &GlobalShortcut<Wry>, inner: &mut Inner, shortcut: Option<Shortcut>) {
    let Some(shortcut) = shortcut else { return };
    if let Err(e) = global.register(shortcut) {
        eprintln!("[shortcut] the previous shortcut could not be restored: {e}");
        if let Some(status) = inner.status.as_mut() {
            status.registered = false;
            status.error = Some(e.to_string());
        }
    }
}

/// Makes `requested` (the default for `None`) the capture shortcut and saves it. On any failure
/// the previous shortcut stays, registered as before.
fn change(app: &AppHandle, requested: Option<&str>) -> Result<ShortcutStatus, Rejection> {
    let accelerator = requested.unwrap_or(DEFAULT_ACCELERATOR);
    let shortcut = validate(accelerator)?;
    let registry = app.state::<ShortcutRegistry>();
    let mut inner = registry.lock();
    let global = app.global_shortcut();

    // Released first, so choosing the same keys again (or Reset to Default) succeeds.
    let active = inner
        .status
        .as_ref()
        .filter(|status| status.registered && !inner.suspended)
        .and_then(|status| status.accelerator.parse::<Shortcut>().ok());
    if let Some(previous) = active {
        let _ = global.unregister(previous);
    }

    if let Err(e) = global.register(shortcut) {
        eprintln!("[shortcut] \"{accelerator}\" could not be registered: {e}");
        reactivate(global, &mut inner, active);
        return Err(Rejection::Unavailable);
    }
    let stored = Settings {
        shortcut: requested.map(str::to_owned),
    };
    if let Err(e) = settings::save(app, &stored) {
        eprintln!("[shortcut] {e}");
        let _ = global.unregister(shortcut);
        reactivate(global, &mut inner, active);
        return Err(Rejection::NotSaved);
    }

    let status = ShortcutStatus {
        accelerator: accelerator.to_string(),
        registered: true,
        error: None,
    };
    inner.status = Some(status.clone());
    inner.suspended = false;
    Ok(status)
}

/// Releases the shortcut while a new one is recorded, or registers it again. Idempotent; also
/// called by Rust when the main window loses focus, so a page that never resumes cannot leave the
/// app without its shortcut.
pub fn suspend(app: &AppHandle, suspended: bool) -> Option<ShortcutStatus> {
    let registry = app.state::<ShortcutRegistry>();
    let mut inner = registry.lock();
    if inner.suspended == suspended {
        return inner.status.clone();
    }
    inner.suspended = suspended;
    let global = app.global_shortcut();
    if let Some(status) = inner.status.as_mut()
        && let Ok(shortcut) = status.accelerator.parse::<Shortcut>()
    {
        if suspended {
            if status.registered {
                let _ = global.unregister(shortcut);
            }
        } else {
            // Also retries a shortcut that failed at startup.
            let result = global.register(shortcut);
            status.registered = result.is_ok();
            status.error = result.err().map(|e| e.to_string());
        }
    }
    inner.status.clone()
}

fn require_main(window: &WebviewWindow) -> Result<(), Rejection> {
    if window.label() == crate::MAIN_WINDOW {
        Ok(())
    } else {
        Err(Rejection::NotAllowed)
    }
}

/// The main window's shortcut recorder: `None` restores the default.
#[tauri::command]
pub fn shortcut_set(
    app: AppHandle,
    window: WebviewWindow,
    accelerator: Option<String>,
) -> Result<ShortcutStatus, Rejection> {
    require_main(&window)?;
    change(&app, accelerator.as_deref())
}

#[tauri::command]
pub fn shortcut_suspend(
    app: AppHandle,
    window: WebviewWindow,
    suspended: bool,
) -> Result<Option<ShortcutStatus>, Rejection> {
    require_main(&window)?;
    Ok(suspend(&app, suspended))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_accelerator_is_valid() {
        assert!(validate(DEFAULT_ACCELERATOR).is_ok());
    }

    #[test]
    fn reserved_entries_parse() {
        for reserved in RESERVED {
            assert!(reserved.parse::<Shortcut>().is_ok(), "{reserved}");
        }
    }

    #[test]
    fn accepts_two_modifiers_or_a_function_key_with_one() {
        for ok in [
            "CommandOrControl+Alt+S",
            "Control+Shift+Digit2",
            "Alt+Shift+A",
            "CommandOrControl+F5",
            "Alt+F12",
            "Control+Alt+Shift+Space",
        ] {
            assert_eq!(validate(ok).map(|_| ()), Ok(()), "{ok}");
        }
    }

    #[test]
    fn rejects_combinations_apps_need() {
        for (accelerator, reason) in [
            ("", Rejection::Invalid),
            ("CommandOrControl+Shift+NoSuchKey", Rejection::Invalid),
            ("A", Rejection::Modifiers),
            ("F5", Rejection::Modifiers),
            ("Shift+F5", Rejection::Modifiers),
            ("CommandOrControl+C", Rejection::Modifiers),
            ("Alt+2", Rejection::Modifiers),
            ("CommandOrControl+Shift+Z", Rejection::Reserved),
        ] {
            assert_eq!(validate(accelerator).err(), Some(reason), "{accelerator:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_system_screenshot_keys() {
        for accelerator in ["CommandOrControl+Shift+3", "Shift+Super+4", "Super+Shift+5"] {
            assert_eq!(validate(accelerator).err(), Some(Rejection::Reserved));
        }
    }

    #[test]
    fn rejections_serialize_as_names() {
        assert_eq!(
            serde_json::to_string(&Rejection::NotSaved).expect("json"),
            "\"notSaved\""
        );
    }
}
