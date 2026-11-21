//! Interface language (ADR-039): English and Turkish.
//!
//! Rust owns the choice. The stored setting is `None` (follow the system), `en` or `tr`;
//! `current` is what it resolves to and what every Rust string uses. Pages ask for it at startup
//! (`language_get`) and are told when it changes (`LANGUAGE_CHANGED`).
//!
//! Strings are written as an English/Turkish pair at the place they are used (`tr!`), not in a
//! separate catalogue: the pair stays together when the code changes, and no key can go missing.
//! Tests run in English, the default.

use std::sync::atomic::{AtomicU8, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{events, settings};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Lang {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "tr")]
    Tr,
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

pub fn current() -> Lang {
    match CURRENT.load(Ordering::Relaxed) {
        1 => Lang::Tr,
        _ => Lang::En,
    }
}

fn set_current(lang: Lang) {
    CURRENT.store(u8::from(lang == Lang::Tr), Ordering::Relaxed);
}

/// The English or the Turkish expression, whichever is the current language. Only the chosen
/// expression is evaluated, so each side may be a `format!`.
macro_rules! tr {
    ($en:expr, $tr:expr) => {
        match $crate::i18n::current() {
            $crate::i18n::Lang::En => $en,
            $crate::i18n::Lang::Tr => $tr,
        }
    };
}
pub(crate) use tr;

/// `"en"` and `"tr"` are the choices; anything else is not a language setting.
pub fn parse(setting: &str) -> Option<Lang> {
    match setting {
        "en" => Some(Lang::En),
        "tr" => Some(Lang::Tr),
        _ => None,
    }
}

/// Turkish if the first preferred language of the system is Turkish, else English.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn from_preferred(first: Option<&str>) -> Lang {
    match first {
        Some(tag)
            if tag.eq_ignore_ascii_case("tr") || tag.to_ascii_lowercase().starts_with("tr-") =>
        {
            Lang::Tr
        }
        _ => Lang::En,
    }
}

#[cfg(target_os = "macos")]
fn system_language() -> Lang {
    use objc2_foundation::NSLocale;
    let preferred = NSLocale::preferredLanguages();
    let first = preferred.firstObject().map(|tag| tag.to_string());
    from_preferred(first.as_deref())
}

#[cfg(not(target_os = "macos"))]
fn system_language() -> Lang {
    Lang::En
}

/// The language a stored setting means now.
pub fn resolve(setting: Option<&str>) -> Lang {
    setting.and_then(parse).unwrap_or_else(system_language)
}

/// Sets the language from the stored setting. Call once at startup, before any window or the tray.
pub fn init(app: &AppHandle) {
    set_current(resolve(settings::load(app).language.as_deref()));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    /// What the interface uses now.
    language: Lang,
    /// What the user chose: `None` follows the system.
    setting: Option<String>,
}

fn info(setting: Option<String>) -> LanguageInfo {
    LanguageInfo {
        language: current(),
        setting,
    }
}

#[tauri::command]
pub fn language_get(app: AppHandle) -> LanguageInfo {
    info(settings::load(&app).language)
}

/// Stores the choice (`None`: follow the system), applies it and tells every page and the tray.
#[tauri::command]
pub fn language_set(app: AppHandle, setting: Option<String>) -> Result<LanguageInfo, String> {
    if let Some(value) = &setting
        && parse(value).is_none()
    {
        return Err(format!("unknown language: {value}"));
    }
    let mut stored = settings::load(&app);
    stored.language = setting.clone();
    settings::save(&app, &stored)?;
    set_current(resolve(setting.as_deref()));
    crate::tray::relabel(&app);
    let result = info(setting);
    let _ = app.emit(events::LANGUAGE_CHANGED, result.language);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_codes_are_settings() {
        assert_eq!(parse("en"), Some(Lang::En));
        assert_eq!(parse("tr"), Some(Lang::Tr));
        assert_eq!(parse("tr-TR"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("de"), None);
    }

    #[test]
    fn the_first_preferred_language_decides() {
        assert_eq!(from_preferred(Some("tr-TR")), Lang::Tr);
        assert_eq!(from_preferred(Some("tr")), Lang::Tr);
        assert_eq!(from_preferred(Some("en-TR")), Lang::En);
        assert_eq!(from_preferred(Some("de-DE")), Lang::En);
        assert_eq!(from_preferred(None), Lang::En);
    }

    #[test]
    fn a_stored_choice_beats_the_system() {
        assert_eq!(resolve(Some("tr")), Lang::Tr);
        assert_eq!(resolve(Some("en")), Lang::En);
    }

    #[test]
    fn tr_picks_by_language_and_defaults_to_english() {
        assert_eq!(tr!("Capture", "Yakala"), "Capture");
    }
}
