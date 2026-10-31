//! Global capture shortcut. The accelerator is a string so a future settings store can pass a
//! user-chosen one to `register` without changing this module.

use std::sync::Mutex;

use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Cmd+Shift+2 on macOS, Ctrl+Shift+2 on Windows (FR-1).
pub const DEFAULT_ACCELERATOR: &str = "CommandOrControl+Shift+2";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub accelerator: String,
    pub registered: bool,
    /// Why registration failed, for example another app already owns the combination.
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ShortcutRegistry(Mutex<Option<ShortcutStatus>>);

impl ShortcutRegistry {
    pub fn status(&self) -> Option<ShortcutStatus> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
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

/// Registers `accelerator` as the capture shortcut and records the outcome for the UI.
pub fn register(app: &AppHandle, accelerator: &str) -> ShortcutStatus {
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
    *app.state::<ShortcutRegistry>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(status.clone());
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_accelerator_parses() {
        assert!(DEFAULT_ACCELERATOR.parse::<Shortcut>().is_ok());
    }
}
