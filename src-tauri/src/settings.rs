//! User settings, stored as `settings.json` in the app's config directory (ADR-030). Only the
//! capture shortcut so far. A missing or unreadable file means defaults; it never stops startup.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::i18n::tr;

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Capture accelerator; `None` means the default (`shortcut::DEFAULT_ACCELERATOR`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    /// Longest recording in seconds; `None` means the default. Clamped where it is used
    /// (`recording::cap_from_setting`); there is no screen for it yet (ADR-037).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_max_seconds: Option<u32>,
    /// Record the sound the computer plays. Off by default (ADR-037); never turned on by itself.
    #[serde(default, skip_serializing_if = "is_false")]
    pub record_system_audio: bool,
    /// Record the microphone. Off by default; only turned on once the system allowed it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub record_microphone: bool,
    /// Interface language: `en` or `tr`; `None` follows the system (ADR-039).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !value
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| {
            tr!(
                format!("no settings directory: {e}"),
                format!("ayarlar klasörü yok: {e}")
            )
        })
}

/// The stored settings, or defaults when there are none or they cannot be read.
pub fn load(app: &AppHandle) -> Settings {
    match path(app).and_then(|path| read(&path)) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("[settings] {error}; using defaults");
            Settings::default()
        }
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    write(&path(app)?, settings)
}

fn read(path: &Path) -> Result<Settings, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("{} is not valid: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// Writes a temporary file next to `path` and renames it over, so a crash or a full disk never
/// leaves a half-written file behind.
fn write(path: &Path, settings: &Settings) -> Result<(), String> {
    let dir = path.parent().ok_or(tr!(
        "settings path has no directory",
        "ayarlar yolunda klasör yok"
    ))?;
    fs::create_dir_all(dir).map_err(|e| {
        tr!(
            format!("{} could not be created: {e}", dir.display()),
            format!("{} oluşturulamadı: {e}", dir.display())
        )
    })?;
    let mut json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    json.push(b'\n');
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json)
        .and_then(|()| fs::rename(&temporary, path))
        .map_err(|e| {
            let _ = fs::remove_file(&temporary);
            tr!(
                format!("{} could not be written: {e}", path.display()),
                format!("{} yazılamadı: {e}", path.display())
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty directory per test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "snipvero-settings-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_means_defaults() {
        let dir = scratch("missing");
        assert_eq!(read(&dir.join(FILE_NAME)), Ok(Settings::default()));
    }

    #[test]
    fn round_trips_and_creates_the_directory() {
        let dir = scratch("round-trip");
        let file = dir.join("nested").join(FILE_NAME);
        let settings = Settings {
            shortcut: Some("CommandOrControl+Alt+S".into()),
            recording_max_seconds: Some(60),
            record_system_audio: true,
            record_microphone: true,
            language: Some("tr".into()),
        };
        write(&file, &settings).expect("write");
        assert_eq!(read(&file), Ok(settings));
        assert!(!file.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_shortcut_is_not_written() {
        let dir = scratch("default");
        let file = dir.join(FILE_NAME);
        write(&file, &Settings::default()).expect("write");
        assert_eq!(fs::read_to_string(&file).expect("read"), "{}\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_is_off_by_default_and_a_choice_is_remembered() {
        let dir = scratch("audio");
        let file = dir.join(FILE_NAME);
        fs::create_dir_all(&dir).expect("dir");
        fs::write(&file, r#"{"shortcut":"Alt+Shift+X"}"#).expect("write");
        let stored = read(&file).expect("read");
        assert!(!stored.record_system_audio && !stored.record_microphone);
        let chosen = Settings {
            record_microphone: true,
            ..stored
        };
        write(&file, &chosen).expect("write");
        let text = fs::read_to_string(&file).expect("read");
        assert!(text.contains("\"recordMicrophone\": true"), "{text}");
        assert!(!text.contains("recordSystemAudio"), "{text}");
        assert_eq!(read(&file), Ok(chosen));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_panic() {
        let dir = scratch("corrupt");
        let file = dir.join(FILE_NAME);
        fs::create_dir_all(&dir).expect("dir");
        fs::write(&file, "{ not json").expect("write");
        assert!(read(&file).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let dir = scratch("unknown");
        let file = dir.join(FILE_NAME);
        fs::create_dir_all(&dir).expect("dir");
        fs::write(&file, r#"{"shortcut":"Alt+Shift+X","later":true}"#).expect("write");
        assert_eq!(
            read(&file).expect("read").shortcut.as_deref(),
            Some("Alt+Shift+X")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
