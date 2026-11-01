mod about;
mod capture;
mod devtools;
mod events;
mod export;
mod geometry;
mod overlay;
mod shortcut;
mod system;
mod transfer;
mod tray;
mod update;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tray::TrayAction;

pub(crate) const MAIN_WINDOW: &str = "main";

pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first so a second launch exits before doing any work.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(shortcut::plugin())
        .plugin(update::plugin())
        .manage(overlay::CaptureState::default())
        .manage(shortcut::ShortcutRegistry::default())
        .manage(update::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            overlay::overlay_frame_info,
            overlay::overlay_frame,
            overlay::overlay_ready,
            overlay::overlay_select,
            overlay::overlay_cancel,
            export::overlay_copy,
            export::overlay_save,
            app_status,
            app_info,
            start_capture,
            show_about,
            open_link,
            open_screen_recording_settings,
            restart_app,
            update::update_check,
            update::update_install,
            update::update_cancel,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::create(app.handle())?;
            shortcut::register(app.handle(), shortcut::DEFAULT_ACCELERATOR);
            overlay::precreate_in_background(app.handle());
            overlay::watch_displays(app.handle());
            devtools::start_from_args(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. }
                if close_policy(window.label()) == ClosePolicy::Hide =>
            {
                api.prevent_close();
                let _ = window.hide();
            }
            // A download started there shows its progress only there; nothing is installed yet.
            WindowEvent::Destroyed if window.label() == about::LABEL => {
                update::cancel_download(window.app_handle(), Some(about::LABEL));
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build Snipvero");

    app.run(|_app, event| {
        // Only an explicit exit (tray "Exit", which passes an exit code) may stop the app.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

pub(crate) fn handle_tray_action(app: &AppHandle, action: TrayAction) {
    match action {
        TrayAction::Capture => overlay::start(app),
        TrayAction::Open => show_main_window(app),
        TrayAction::About => about::show(app),
        TrayAction::CheckForUpdates => update::request_check(app),
        TrayAction::Exit => app.exit(0),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ClosePolicy {
    /// The main window only hides; the app keeps running in the tray and the page keeps its state.
    Hide,
    /// Other windows (About, overlays) are destroyed and created again when needed.
    Destroy,
}

fn close_policy(label: &str) -> ClosePolicy {
    if label == MAIN_WINDOW {
        ClosePolicy::Hide
    } else {
        ClosePolicy::Destroy
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    /// Whether this platform has a capture backend yet (macOS only for now).
    capture_supported: bool,
    screen_recording_allowed: bool,
    shortcut: Option<shortcut::ShortcutStatus>,
}

#[tauri::command]
fn app_status(shortcuts: State<shortcut::ShortcutRegistry>) -> AppStatus {
    AppStatus {
        capture_supported: cfg!(target_os = "macos"),
        screen_recording_allowed: capture::has_permission(),
        shortcut: shortcuts.status(),
    }
}

#[tauri::command]
fn app_info(app: AppHandle) -> about::AppInfo {
    about::info(&app)
}

/// The main window's Capture Region button: the same path as the tray and the shortcut, on the
/// main thread like them.
#[tauri::command]
fn start_capture(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || overlay::start(&handle))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn show_about(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || about::show(&handle))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn open_link(app: AppHandle, link: about::Link) -> Result<(), String> {
    about::open(&app, link)
}

#[tauri::command]
fn open_screen_recording_settings() -> Result<(), String> {
    system::open_screen_recording_settings()
}

/// macOS may only apply a newly granted Screen Recording permission after a restart.
#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{ClosePolicy, MAIN_WINDOW, about, close_policy, overlay};

    #[test]
    fn only_the_main_window_survives_closing() {
        assert_eq!(close_policy(MAIN_WINDOW), ClosePolicy::Hide);
        assert_eq!(close_policy(about::LABEL), ClosePolicy::Destroy);
        assert_eq!(close_policy(&overlay::label(0)), ClosePolicy::Destroy);
    }

    /// Every window the app creates needs the frontend permissions (`core:default`).
    #[test]
    fn capabilities_cover_every_window() {
        let capabilities = include_str!("../capabilities/default.json");
        for label in [MAIN_WINDOW, about::LABEL, "overlay-*"] {
            assert!(capabilities.contains(&format!("\"{label}\"")), "{label}");
        }
        // Both windows size themselves to their content (useFitWindow).
        let fit = include_str!("../capabilities/fit-to-content.json");
        assert!(fit.contains("core:window:allow-set-size"));
        for label in [MAIN_WINDOW, about::LABEL] {
            assert!(fit.contains(&format!("\"{label}\"")), "{label}");
        }
    }

    /// The version lives in three manifests; a release must not ship with them disagreeing.
    #[test]
    fn manifest_versions_match() {
        let version = format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION"));
        assert!(include_str!("../tauri.conf.json").contains(&version));
        assert!(include_str!("../../package.json").contains(&version));
    }

    /// The text between `start` and the next `end` after it.
    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let rest = &text[text.find(start).expect("start marker") + start.len()..];
        &rest[..rest.find(end).expect("end marker")]
    }

    /// Apple's format for both bundle versions: one to three period-separated integers.
    fn is_apple_version(value: &str) -> bool {
        let parts: Vec<&str> = value.split('.').collect();
        parts.len() <= 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    }

    /// `CFBundleShortVersionString` is the package version without its pre-release suffix
    /// (`Info.plist` overrides the bundler); `CFBundleVersion` is an integer build number.
    #[test]
    fn bundle_versions_follow_apple_format() {
        let core = env!("CARGO_PKG_VERSION")
            .split(['-', '+'])
            .next()
            .expect("version");
        let plist = include_str!("../Info.plist");
        let short = between(plist, "<key>CFBundleShortVersionString</key>", "</string>")
            .trim()
            .strip_prefix("<string>")
            .expect("string value");
        assert_eq!(short, core);
        assert!(is_apple_version(short));

        let build = between(
            include_str!("../tauri.conf.json"),
            "\"bundleVersion\": \"",
            "\"",
        );
        assert!(is_apple_version(build), "bundleVersion {build:?}");
    }

    #[test]
    fn apple_version_format() {
        for valid in ["1", "0.1.0", "12.34", "2026.10.31"] {
            assert!(is_apple_version(valid), "{valid}");
        }
        for invalid in ["", "0.1.0-beta.1", "1.2.3.4", "1..2", "v1", "1.0b1"] {
            assert!(!is_apple_version(invalid), "{invalid}");
        }
    }

    /// Keep the dependency identical to tauri-build 2.7.4's default manifest. Embedding it into
    /// unit-test executables is necessary for the real MockRuntime updater tests to start on
    /// Windows; those tests also serve as the loader regression test on CI.
    #[test]
    fn windows_manifest_requests_common_controls_v6_only() {
        let manifest = include_str!("../windows-app-manifest.xml");
        assert!(manifest.contains("name=\"Microsoft.Windows.Common-Controls\""));
        assert!(manifest.contains("version=\"6.0.0.0\""));
        assert!(manifest.contains("publicKeyToken=\"6595b64144ccf1df\""));
        assert_eq!(manifest.matches("<dependency>").count(), 1);
        // No elevation, compatibility or DPI-policy change is part of this test-loader fix.
        for unexpected in [
            "trustInfo",
            "compatibility",
            "application",
            "requestedExecutionLevel",
        ] {
            assert!(!manifest.contains(unexpected), "{unexpected}");
        }
    }
}
