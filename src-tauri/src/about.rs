//! The About window, app metadata for the frontend and the app's fixed links (ADR-024).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, path::BaseDirectory};

use crate::system;

pub const LABEL: &str = "about";
const TITLE: &str = "About Snipvero";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 412.0;

/// Bundled with the app (`bundle.resources` in `tauri.conf.json`).
const LICENSE_RESOURCE: &str = "LICENSE.txt";

/// Shows the About window, creating it on first use. Closing it destroys it (see
/// `crate::close_policy`), so it costs nothing while it is not open. Call on the main thread, so
/// two requests can never both create it.
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build();
    match window {
        // An accessory app is not active when its tray menu is used; focus activates it.
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("[about] could not open the About window: {err}"),
    }
}

/// The project page and copyright. Tauri does not embed `bundle.homepage` or `bundle.copyright`
/// from `tauri.conf.json` in the app binary (checked in the 0.1.0-beta.1 release build), so they
/// come from here; a test keeps `tauri.conf.json` equal to them.
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");
const WEBSITE: &str = "https://snipvero.app";
const SUPPORT_EMAIL: &str = "support@snipvero.app";
const COPYRIGHT: &str = "© 2026 Snipvero Contributors";

/// App metadata for the frontend, which never repeats it. Name and version come from
/// `tauri.conf.json` (`PackageInfo`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    copyright: &'static str,
    website: &'static str,
    support_email: &'static str,
    repository: String,
    contributors: String,
}

pub fn info(app: &AppHandle) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        copyright: COPYRIGHT,
        website: WEBSITE,
        support_email: SUPPORT_EMAIL,
        repository: web_url(REPOSITORY, Link::Repository).unwrap_or_default(),
        contributors: web_url(REPOSITORY, Link::Contributors).unwrap_or_default(),
    }
}

/// The only things the frontend can ask to open; it never passes an address itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Link {
    Support,
    Website,
    Repository,
    Contributors,
    License,
}

/// Fixed destinations; repository-derived pages must use HTTPS.
fn web_url(homepage: &str, link: Link) -> Option<String> {
    if link == Link::Support {
        return Some(format!("mailto:{SUPPORT_EMAIL}"));
    }
    let homepage = homepage.trim_end_matches('/');
    if !homepage.starts_with("https://") {
        return None;
    }
    match link {
        Link::Website => Some(WEBSITE.to_string()),
        Link::Repository => Some(homepage.to_string()),
        Link::Contributors => Some(format!("{homepage}/graphs/contributors")),
        Link::License | Link::Support => None,
    }
}

pub fn open(app: &AppHandle, link: Link) -> Result<(), String> {
    if link == Link::License {
        let path = app
            .path()
            .resolve(LICENSE_RESOURCE, BaseDirectory::Resource)
            .map_err(|err| err.to_string())?;
        return system::open_file(&path);
    }
    let url = web_url(REPOSITORY, link).ok_or("the project page is not an https address")?;
    system::open_url(&url)
}

#[cfg(test)]
mod tests {
    use super::{COPYRIGHT, Link, REPOSITORY, WEBSITE, web_url};

    const HOMEPAGE: &str = "https://github.com/ugokkaya/Snipvero";

    #[test]
    fn project_page_is_the_public_repository() {
        assert_eq!(REPOSITORY, HOMEPAGE);
        assert_eq!(
            web_url(REPOSITORY, Link::Contributors).as_deref(),
            Some("https://github.com/ugokkaya/Snipvero/graphs/contributors")
        );
    }

    /// The bundle metadata (Info.plist, installer) and the About window must agree.
    #[test]
    fn tauri_config_matches_the_about_metadata() {
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains(&format!("\"homepage\": \"{WEBSITE}\"")));
        assert!(config.contains(&format!("\"copyright\": \"{COPYRIGHT}\"")));
    }

    #[test]
    fn links_derive_from_the_project_page() {
        assert_eq!(
            web_url(HOMEPAGE, Link::Support).as_deref(),
            Some("mailto:support@snipvero.app")
        );
        assert_eq!(
            web_url(HOMEPAGE, Link::Website).as_deref(),
            Some("https://snipvero.app")
        );
        assert_eq!(
            web_url(HOMEPAGE, Link::Repository).as_deref(),
            Some(HOMEPAGE)
        );
        assert_eq!(
            web_url(&format!("{HOMEPAGE}/"), Link::Contributors).as_deref(),
            Some("https://github.com/ugokkaya/Snipvero/graphs/contributors")
        );
        assert_eq!(web_url(HOMEPAGE, Link::License), None);
    }

    #[test]
    fn non_https_pages_are_refused() {
        for page in [
            "http://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert_eq!(web_url(page, Link::Repository), None, "{page}");
        }
    }

    #[test]
    fn link_names_match_the_frontend() {
        for (name, link) in [
            ("support", Link::Support),
            ("website", Link::Website),
            ("repository", Link::Repository),
            ("contributors", Link::Contributors),
            ("license", Link::License),
        ] {
            assert_eq!(from_name(name), link);
        }
    }

    /// Deserializes a variant from the string the frontend sends, without a JSON dependency.
    fn from_name(name: &str) -> Link {
        use serde::de::{IntoDeserializer, value::Error};
        let deserializer: serde::de::value::StrDeserializer<Error> = name.into_deserializer();
        serde::Deserialize::deserialize(deserializer).unwrap()
    }
}
