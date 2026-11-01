//! Menu bar (macOS) / system tray (Windows) icon and menu.

use tauri::{
    AppHandle, Manager, Wry,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
};

use crate::login_item;

/// Black-and-alpha template image (`icons/source/tray-template.svg`, 18 pt at 2×). macOS tints a
/// template image itself, so one asset fits light and dark menu bars and tinted states. Windows
/// keeps the coloured app icon, which a black glyph would not suit on a dark taskbar.
#[cfg(any(target_os = "macos", test))]
const TEMPLATE_ICON: &[u8] = include_bytes!("../icons/tray-template.png");

#[cfg(target_os = "macos")]
const EXIT_LABEL: &str = "Quit Snipvero";
#[cfg(not(target_os = "macos"))]
const EXIT_LABEL: &str = "Exit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Capture,
    Open,
    OpenAtLogin,
    About,
    CheckForUpdates,
    Exit,
}

/// One row of the tray menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    Item(TrayAction),
    Separator,
}

/// Everyday actions first, then the login setting where the platform has one; About and updates
/// sit with Quit, as in the app menu of a Mac app.
fn menu(open_at_login: bool) -> Vec<Entry> {
    let mut entries = vec![
        Entry::Item(TrayAction::Capture),
        Entry::Item(TrayAction::Open),
        Entry::Separator,
    ];
    if open_at_login {
        entries.extend([Entry::Item(TrayAction::OpenAtLogin), Entry::Separator]);
    }
    entries.extend([
        Entry::Item(TrayAction::About),
        Entry::Item(TrayAction::CheckForUpdates),
        Entry::Item(TrayAction::Exit),
    ]);
    entries
}

/// The checkable **Open at Login** item, kept to show the OS's current state (ADR-033).
struct OpenAtLoginItem(CheckMenuItem<Wry>);

impl TrayAction {
    const ALL: [TrayAction; 6] = [
        TrayAction::Capture,
        TrayAction::Open,
        TrayAction::OpenAtLogin,
        TrayAction::About,
        TrayAction::CheckForUpdates,
        TrayAction::Exit,
    ];

    pub fn id(self) -> &'static str {
        match self {
            TrayAction::Capture => "capture",
            TrayAction::Open => "open",
            TrayAction::OpenAtLogin => "open-at-login",
            TrayAction::About => "about",
            TrayAction::CheckForUpdates => "check-for-updates",
            TrayAction::Exit => "exit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.id() == id)
    }

    fn label(self) -> &'static str {
        match self {
            TrayAction::Capture => "Capture",
            TrayAction::Open => "Open Snipvero",
            TrayAction::OpenAtLogin => "Open at Login",
            TrayAction::About => "About Snipvero",
            TrayAction::CheckForUpdates => "Check for Updates…",
            TrayAction::Exit => EXIT_LABEL,
        }
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for entry in self::menu(login_item::SUPPORTED) {
        match entry {
            Entry::Item(TrayAction::OpenAtLogin) => {
                let item = CheckMenuItem::with_id(
                    app,
                    TrayAction::OpenAtLogin.id(),
                    TrayAction::OpenAtLogin.label(),
                    true,
                    login_item::is_enabled(),
                    None::<&str>,
                )?;
                menu.append(&item)?;
                app.manage(OpenAtLoginItem(item));
            }
            Entry::Item(action) => {
                menu.append(&MenuItem::with_id(
                    app,
                    action.id(),
                    action.label(),
                    true,
                    None::<&str>,
                )?)?;
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Snipvero")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if let Some(action) = TrayAction::from_id(event.id().as_ref()) {
                crate::handle_tray_action(app, action);
            }
        })
        // The user can also change the login item in System Settings; check again on every click.
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { .. }) {
                refresh_open_at_login(tray.app_handle());
            }
        });
    #[cfg(target_os = "macos")]
    match decode_rgba(TEMPLATE_ICON) {
        Ok(icon) => builder = builder.icon(icon).icon_as_template(true),
        Err(err) => eprintln!("tray template icon: {err}"),
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Shows the OS's current login item state, which a click on the item does not track by itself.
pub fn refresh_open_at_login(app: &AppHandle) {
    if let Some(item) = app.try_state::<OpenAtLoginItem>()
        && let Err(err) = item.0.set_checked(login_item::is_enabled())
    {
        eprintln!("[tray] open at login: {err}");
    }
}

/// Decodes an 8-bit RGBA PNG with the `png` crate already used for export, rather than enabling
/// Tauri's `image-png` feature, which would add the `image` crate.
#[cfg(any(target_os = "macos", test))]
fn decode_rgba(bytes: &[u8]) -> Result<tauri::image::Image<'static>, String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|err| err.to_string())?;
    let size = reader
        .output_buffer_size()
        .ok_or("PNG too large".to_string())?;
    let mut rgba = vec![0; size];
    let info = reader
        .next_frame(&mut rgba)
        .map_err(|err| err.to_string())?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err(format!(
            "expected 8-bit RGBA, got {:?} {:?}",
            info.color_type, info.bit_depth
        ));
    }
    rgba.truncate(info.buffer_size());
    Ok(tauri::image::Image::new_owned(
        rgba,
        info.width,
        info.height,
    ))
}

#[cfg(test)]
mod tests {
    use super::{EXIT_LABEL, Entry, TEMPLATE_ICON, TrayAction, decode_rgba, menu};

    fn labels(entries: &[Entry]) -> Vec<&'static str> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Item(action) => action.label(),
                Entry::Separator => "---",
            })
            .collect()
    }

    #[test]
    fn ids_round_trip() {
        for action in TrayAction::ALL {
            assert_eq!(TrayAction::from_id(action.id()), Some(action));
        }
    }

    #[test]
    fn menu_lists_every_action_once_in_order() {
        let entries = menu(true);
        assert_eq!(
            labels(&entries),
            [
                "Capture",
                "Open Snipvero",
                "---",
                "Open at Login",
                "---",
                "About Snipvero",
                "Check for Updates…",
                EXIT_LABEL
            ]
        );
        for action in TrayAction::ALL {
            let count = entries
                .iter()
                .filter(|e| **e == Entry::Item(action))
                .count();
            assert_eq!(count, 1, "{action:?}");
        }
    }

    #[test]
    fn menu_without_login_items_has_no_login_row() {
        assert_eq!(
            labels(&menu(false)),
            [
                "Capture",
                "Open Snipvero",
                "---",
                "About Snipvero",
                "Check for Updates…",
                EXIT_LABEL
            ]
        );
    }

    #[test]
    fn login_row_is_shown_only_where_supported() {
        let shown =
            menu(crate::login_item::SUPPORTED).contains(&Entry::Item(TrayAction::OpenAtLogin));
        assert_eq!(shown, cfg!(target_os = "macos"));
    }

    #[test]
    fn about_item_maps_to_about_action() {
        assert_eq!(TrayAction::from_id("about"), Some(TrayAction::About));
    }

    #[test]
    fn unknown_id_is_ignored() {
        assert_eq!(TrayAction::from_id("nope"), None);
    }

    #[test]
    fn template_icon_is_black_and_alpha_at_2x() {
        let icon = decode_rgba(TEMPLATE_ICON).unwrap();
        assert_eq!((icon.width(), icon.height()), (36, 36));
        let (pixels, rest) = icon.rgba().as_chunks::<4>();
        assert_eq!((pixels.len(), rest.len()), (36 * 36, 0));
        let mut visible = 0;
        for pixel in pixels {
            if pixel[3] > 0 {
                // A template image is defined by alpha alone; colour would be discarded by macOS.
                assert_eq!(&pixel[..3], &[0, 0, 0]);
                visible += 1;
            }
        }
        assert!(visible > 100, "glyph has only {visible} visible pixels");
    }

    #[test]
    fn decode_rejects_non_png() {
        assert!(decode_rgba(b"not a png").is_err());
    }
}
