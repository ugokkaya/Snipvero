//! In-app updates (ADR-028). Nothing here runs until the user clicks **Check for Updates…** (main
//! window, About window or the menu bar item): no check at launch, in the background or on a timer.
//!
//! The endpoint and the public key are fixed in `tauri.conf.json` (`plugins.updater`); the page
//! passes neither, and it has no permission for the updater plugin's own commands, whose options
//! include proxies, headers and targets. The plugin verifies every package (a minisign signature
//! that also binds the announced version, `requireSignedVersion`) before anything is installed,
//! and swaps the app bundle in one step, restoring the previous one if that fails.

use std::cmp::Ordering;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tauri::async_runtime;
use tauri::ipc::Channel;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_updater::{Config, Error, Update, UpdaterExt};

use crate::overlay::CaptureState;
use crate::{MAIN_WINDOW, about, events};

/// Updates are offered for the macOS app bundle only; Windows is not released (ADR-020).
const SUPPORTED: bool = cfg!(target_os = "macos");

/// The whole manifest request. The download has no overall limit (its size varies with the
/// connection), only the idle limit below, and the user can cancel it.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Release notes longer than this are cut; the page shows them as plain text.
const NOTES_LIMIT: usize = 5000;

/// Stops a running download; the label of the window that started it.
type Cancel = (String, Box<dyn FnOnce() + Send>);

#[derive(Default)]
pub struct UpdateState {
    /// The update the last check found. Installing always uses this one; the page never names
    /// a version, a URL or a file.
    pending: Mutex<Option<Update>>,
    /// Set from the start of a download until the install fails or the app restarts, so the
    /// main and About windows cannot run two at once.
    installing: AtomicBool,
    cancel: Mutex<Option<Cancel>>,
}

impl UpdateState {
    fn pending(&self) -> MutexGuard<'_, Option<Update>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cancel(&self) -> MutexGuard<'_, Option<Cancel>> {
        self.cancel.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn try_begin_install(&self) -> Option<InstallGuard<'_>> {
        self.installing
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .is_ok()
            .then_some(InstallGuard(&self.installing))
    }
}

/// Allows the next install when an attempt ends without a restart.
struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, AtomicOrdering::Release);
    }
}

/// Why a check or an install did not succeed. The page words the message; in every case the
/// running version stays installed and keeps working. Mirrored in `src/ipc.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    /// This build cannot update itself (no public key, not a macOS app bundle).
    Unavailable,
    /// The update server could not be reached or did not answer successfully.
    Network,
    /// The update information was not a valid manifest.
    Manifest,
    /// The release has no package for this platform and architecture.
    NoBuild,
    /// The package's signature or signed version did not match: nothing was installed.
    Verification,
    /// The app runs from a disk image or a translocated copy, which cannot be replaced.
    Location,
    /// A capture is open; installing would restart the app under it.
    Busy,
    /// Replacing the app bundle failed (including a declined administrator prompt).
    Install,
    /// The user cancelled the download.
    Cancelled,
    /// Another window is already downloading or installing an update.
    InProgress,
    Failed,
}

fn classify(error: &Error) -> Failure {
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => Failure::Network,
        Error::Serialization(_) | Error::Semver(_) | Error::UrlParse(_) => Failure::Manifest,
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => Failure::NoBuild,
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => Failure::Verification,
        Error::Io(_)
        | Error::PreviousAppNotRestored(_)
        | Error::TempDirNotOnSameMountPoint
        | Error::TempDirNotFound
        | Error::BinaryNotFoundInArchive
        | Error::InvalidUpdaterFormat
        | Error::AuthenticationFailed => Failure::Install,
        Error::EmptyEndpoints | Error::UnsupportedArch | Error::UnsupportedOs => {
            Failure::Unavailable
        }
        _ => Failure::Failed,
    }
}

fn fail(step: &str, error: &Error) -> Failure {
    eprintln!("[update] {step} failed: {error}");
    classify(error)
}

/// The updater's version check: strictly newer by SemVer precedence. Build metadata does not
/// count (the `semver` crate's `Ord` would order it), so a rebuild is never offered as newer;
/// the same and older versions never are.
pub fn is_newer(current: &Version, release: &Version) -> bool {
    release.cmp_precedence(current) == Ordering::Greater
}

/// The updater plugin with Snipvero's version check. Its own commands stay unreachable: no
/// capability grants an `updater:` permission.
pub fn plugin<R: Runtime>() -> TauriPlugin<R, Config> {
    tauri_plugin_updater::Builder::new()
        .default_version_comparator(|current, release| is_newer(&current, &release.version))
        .build()
}

/// Whether the app at `bundle` can be replaced in place. A copy running from a disk image or
/// translocated by Gatekeeper sits on a read-only volume; anything but a `.app` bundle (for
/// example `pnpm tauri dev`'s bare binary) must never be replaced by one.
fn replaceable(bundle: &Path) -> bool {
    let in_disk_image = bundle
        .parent()
        .and_then(Path::parent)
        .is_some_and(|volumes| volumes == Path::new("/Volumes"));
    bundle.extension().is_some_and(|ext| ext == "app")
        && !in_disk_image
        && !bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
}

fn check_location() -> Result<(), Failure> {
    let bundle = std::env::current_exe()
        .map_err(Error::from)
        .and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe))
        .map_err(|err| fail("locating the app", &err))?;
    if replaceable(&bundle) {
        Ok(())
    } else {
        eprintln!(
            "[update] the app at {} cannot be replaced",
            bundle.display()
        );
        Err(Failure::Location)
    }
}

/// The plugin configuration fields this module relies on. `None` when this build cannot update.
struct Settings {
    https_only: bool,
}

impl Settings {
    fn read(app: &AppHandle) -> Option<Settings> {
        let config = app.config().plugins.0.get("updater")?;
        let has_key = config
            .get("pubkey")
            .and_then(|key| key.as_str())
            .is_some_and(|key| !key.trim().is_empty());
        let insecure = config
            .get("dangerousInsecureTransportProtocol")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        (SUPPORTED && has_key).then_some(Settings {
            https_only: !insecure,
        })
    }
}

/// The windows that show the update UI; capture overlays never reach these commands.
fn may_update(label: &str) -> bool {
    label == MAIN_WINDOW || label == about::LABEL
}

fn require_update_window(window: &WebviewWindow) -> Result<(), Failure> {
    if may_update(window.label()) {
        Ok(())
    } else {
        Err(Failure::Unavailable)
    }
}

/// The menu bar's **Check for Updates…**: shows the main window, whose update row starts the
/// check (its page is always loaded; the About window is created on demand).
pub fn request_check(app: &AppHandle) {
    crate::show_main_window(app);
    if let Err(err) = app.emit_to(MAIN_WINDOW, events::UPDATE_CHECK_REQUESTED, ()) {
        eprintln!("[update] could not ask the main window to check: {err}");
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    current: String,
    available: Option<Available>,
}

fn cut(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<CheckResult, Failure> {
    require_update_window(&window)?;
    let settings = Settings::read(&app).ok_or(Failure::Unavailable)?;
    let https_only = settings.https_only;
    let found = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        // Redirects too: a release download is redirected to GitHub's file storage.
        .configure_client(move |client| {
            client
                .https_only(https_only)
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
        .map_err(|err| fail("check", &err))?
        .check()
        .await
        .map_err(|err| fail("check", &err))?;
    let result = CheckResult {
        current: app.package_info().version.to_string(),
        available: found.as_ref().map(|update| Available {
            version: update.version.clone(),
            notes: cut(
                update.body.as_deref().unwrap_or_default().trim(),
                NOTES_LIMIT,
            ),
        }),
    };
    *state.pending() = found;
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum Progress {
    Started { content_length: Option<u64> },
    Downloaded { bytes: u64 },
    Installing,
    Restarting,
}

/// Downloads the pending update after the user agreed to install it and restart, verifies it
/// (the plugin does, before returning the bytes and again before installing), installs it and
/// restarts. Refused while a capture is open; once installing starts, no capture can start.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    captures: State<'_, CaptureState>,
    on_progress: Channel<Progress>,
) -> Result<(), Failure> {
    require_update_window(&window)?;
    Settings::read(&app).ok_or(Failure::Unavailable)?;
    let update = state.pending().clone().ok_or(Failure::Failed)?;
    check_location()?;
    if captures.is_busy() {
        return Err(Failure::Busy);
    }
    let _installing = state.try_begin_install().ok_or(Failure::InProgress)?;
    let bytes = download(&state, window.label(), update.clone(), on_progress.clone()).await?;
    // A capture may have started during the download; from here on none can.
    if !captures.reserve_for_update() {
        return Err(Failure::Busy);
    }
    let _ = on_progress.send(Progress::Installing);
    let installed = async_runtime::spawn_blocking(move || update.install(bytes)).await;
    match installed {
        Ok(Ok(())) => {
            eprintln!("[update] installed; restarting");
            let _ = on_progress.send(Progress::Restarting);
            app.request_restart();
            Ok(())
        }
        Ok(Err(err)) => {
            captures.release_update();
            Err(fail("install", &err))
        }
        Err(err) => {
            captures.release_update();
            eprintln!("[update] install failed: {err}");
            Err(Failure::Install)
        }
    }
}

async fn download(
    state: &UpdateState,
    owner: &str,
    update: Update,
    progress: Channel<Progress>,
) -> Result<Vec<u8>, Failure> {
    let task = async_runtime::spawn(async move {
        let mut started = false;
        let mut bytes = 0u64;
        update
            .download(
                |chunk, content_length| {
                    if !started {
                        started = true;
                        let _ = progress.send(Progress::Started { content_length });
                    }
                    bytes += chunk as u64;
                    let _ = progress.send(Progress::Downloaded { bytes });
                },
                || {},
            )
            .await
    });
    let abort = task.inner().abort_handle();
    *state.cancel() = Some((owner.to_string(), Box::new(move || abort.abort())));
    let result = task.await;
    state.cancel().take();
    match result {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(err)) => Err(fail("download", &err)),
        // Aborted (release builds abort on panic, so a join error is a cancellation).
        Err(_) => Err(Failure::Cancelled),
    }
}

/// Stops a running download, if `owner` (any window when `None`) started it; nothing has been
/// installed at that point.
pub fn cancel_download(app: &AppHandle, owner: Option<&str>) {
    let state = app.state::<UpdateState>();
    let mut running = state.cancel();
    if running
        .as_ref()
        .is_some_and(|(label, _)| owner.is_none_or(|owner| owner == label))
        && let Some((_, cancel)) = running.take()
    {
        cancel();
    }
}

#[tauri::command]
pub fn update_cancel(app: AppHandle, window: WebviewWindow) -> Result<(), Failure> {
    require_update_window(&window)?;
    cancel_download(&app, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        Failure, NOTES_LIMIT, UpdateState, classify, cut, is_newer, may_update, replaceable,
    };
    use semver::Version;
    use std::path::Path;
    use tauri_plugin_updater::Error;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn only_strictly_newer_versions_are_updates() {
        let current = v("0.1.0-beta.3");
        for newer in [
            "0.1.0-beta.4",
            "0.1.0-beta.10",
            "0.1.0-rc.1",
            "0.1.0",
            "0.2.0-beta.1",
        ] {
            assert!(is_newer(&current, &v(newer)), "{newer}");
        }
        for not_newer in ["0.1.0-beta.3", "0.1.0-beta.2", "0.1.0-alpha.9", "0.0.9"] {
            assert!(!is_newer(&current, &v(not_newer)), "{not_newer}");
        }
    }

    /// SemVer pre-release identifiers: numeric ones compare as numbers, not text.
    #[test]
    fn beta_ordering_is_numeric() {
        assert!(is_newer(&v("0.1.0-beta.9"), &v("0.1.0-beta.10")));
        assert!(!is_newer(&v("0.1.0-beta.10"), &v("0.1.0-beta.9")));
        assert!(is_newer(&v("0.1.0-beta.2"), &v("0.1.0")));
    }

    #[test]
    fn build_metadata_never_makes_a_version_newer() {
        assert!(!is_newer(&v("0.1.0-beta.3"), &v("0.1.0-beta.3+rebuild")));
        assert!(!is_newer(&v("0.1.0-beta.3+a"), &v("0.1.0-beta.3+b")));
    }

    #[test]
    fn only_an_installed_app_bundle_is_replaced() {
        for ok in [
            "/Applications/Snipvero.app",
            "/Users/someone/Applications/Snipvero.app",
            "/Volumes/External/Apps/Snipvero.app",
        ] {
            assert!(replaceable(Path::new(ok)), "{ok}");
        }
        for refused in [
            // The DMG: the app sits at the root of the mounted image.
            "/Volumes/Snipvero/Snipvero.app",
            "/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Snipvero.app",
            // `pnpm tauri dev`: the executable's directory, not a bundle.
            "/Users/someone/Snipvero/src-tauri/target/debug",
        ] {
            assert!(!replaceable(Path::new(refused)), "{refused}");
        }
    }

    #[test]
    fn errors_are_classified_for_the_page() {
        let cases = [
            (Error::ReleaseNotFound, Failure::Network),
            (Error::Network("503".into()), Failure::Network),
            (Error::Serialization(serde_json_error()), Failure::Manifest),
            (
                Error::TargetNotFound("darwin-aarch64".into()),
                Failure::NoBuild,
            ),
            (
                Error::TargetsNotFound(vec!["darwin-aarch64".into()]),
                Failure::NoBuild,
            ),
            (Error::MissingSignedVersion, Failure::Verification),
            (Error::SignatureUtf8("x".into()), Failure::Verification),
            (
                Error::Io(std::io::Error::other("rename failed")),
                Failure::Install,
            ),
            (Error::AuthenticationFailed, Failure::Install),
            (Error::UnsupportedArch, Failure::Unavailable),
        ];
        for (error, expected) in cases {
            assert_eq!(classify(&error), expected, "{error}");
        }
    }

    fn serde_json_error() -> serde_json::Error {
        serde_json::from_str::<u8>("not json").unwrap_err()
    }

    #[test]
    fn only_the_main_and_about_windows_may_update() {
        assert!(may_update("main"));
        assert!(may_update("about"));
        for label in ["overlay-0", "overlay-*", ""] {
            assert!(!may_update(label), "{label}");
        }
    }

    #[test]
    fn one_install_at_a_time() {
        let state = UpdateState::default();
        let first = state.try_begin_install();
        assert!(first.is_some());
        assert!(state.try_begin_install().is_none());
        // A failed or cancelled attempt allows the next one.
        drop(first);
        assert!(state.try_begin_install().is_some());
    }

    #[test]
    fn long_notes_are_cut_on_a_character_boundary() {
        assert_eq!(cut("short", NOTES_LIMIT), "short");
        assert_eq!(cut("çğüşöı", 3), "çğü…");
    }

    /// The fixed configuration in `tauri.conf.json`: one HTTPS endpoint per channel, signed
    /// versions required, and none of the plugin's escape hatches.
    #[test]
    fn production_configuration_is_fixed_and_strict() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        let channel = if env!("CARGO_PKG_VERSION").contains('-') {
            "beta"
        } else {
            "stable"
        };
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([format!(
                "https://raw.githubusercontent.com/ugokkaya/Snipvero/main/updater/{channel}.json"
            )])
        );
        assert_eq!(updater["requireSignedVersion"], true);
        let keys: Vec<&str> = updater
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        for key in keys {
            assert!(
                ["pubkey", "endpoints", "requireSignedVersion"].contains(&key),
                "unexpected updater setting {key}"
            );
        }
        // The release key's public half, or empty until it exists (updates then stay off and
        // the release verifier refuses the build). Never the test key.
        let pubkey = updater["pubkey"].as_str().unwrap();
        assert_ne!(pubkey.trim(), plugin_tests::PUBKEY.trim());
        // Packages are made from the stapled app by the release script, not by `tauri build`.
        assert!(config["bundle"].get("createUpdaterArtifacts").is_none());
    }

    /// The page reaches updates only through Snipvero's own commands.
    #[test]
    fn no_window_may_call_the_updater_plugin() {
        for capability in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/about.json"),
            include_str!("../capabilities/fit-to-content.json"),
        ] {
            assert!(!capability.contains("updater"), "{capability}");
        }
    }

    /// The real plugin, with Snipvero's comparator, on Tauri's mock runtime. `restore_update`
    /// runs the same manifest handling as a check without a request, and `verify` the same
    /// package verification as a download and an install.
    mod plugin_tests {
        use super::super::{Failure, classify, plugin};
        use semver::Version;
        use serde_json::{Value, json};
        use std::path::Path;
        use tauri::App;
        use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
        use tauri_plugin_updater::{Update, Updater, UpdaterExt};

        pub const PUBKEY: &str = include_str!("../test-fixtures/updater/test.pub");
        const PACKAGE: &[u8] = include_bytes!("../test-fixtures/updater/package.bin");
        const SIGNATURE: &str = include_str!("../test-fixtures/updater/package.bin.sig");
        const WRONG_VERSION: &str =
            include_str!("../test-fixtures/updater/package.wrong-version.sig");
        const OTHER_KEY: &str = include_str!("../test-fixtures/updater/package.other-key.sig");
        const TARGET: &str = "darwin-aarch64";

        fn updater() -> (App<MockRuntime>, Updater) {
            updater_with(PUBKEY, None)
        }

        /// The plugin as the app configures it, for an installed `0.1.0-beta.3`; `executable`
        /// chooses the bundle an install would replace.
        fn updater_with(pubkey: &str, executable: Option<&Path>) -> (App<MockRuntime>, Updater) {
            let mut context = mock_context(noop_assets());
            context.package_info_mut().version = Version::parse("0.1.0-beta.3").unwrap();
            context.config_mut().plugins.0.insert(
                "updater".into(),
                json!({
                    "pubkey": pubkey.trim(),
                    "endpoints": ["https://example.invalid/beta.json"],
                    "requireSignedVersion": true
                }),
            );
            let app = mock_builder().plugin(plugin()).build(context).unwrap();
            // A fixed target, so the test means the same on every CI runner.
            let mut builder = app.updater_builder().target(TARGET);
            if let Some(executable) = executable {
                builder = builder.executable_path(executable);
            }
            (app, builder.build().unwrap())
        }

        fn manifest(version: &str, platform: &str, signature: &str) -> Value {
            json!({
                "version": version,
                "notes": "Release notes.",
                "platforms": {
                    platform: {
                        "url": format!("https://example.invalid/Snipvero_{version}_aarch64.app.tar.gz"),
                        "signature": signature.trim()
                    }
                }
            })
        }

        fn offered(manifest: Value) -> Result<Option<Update>, Failure> {
            let (_app, updater) = updater();
            updater.restore_update(manifest).map_err(|e| classify(&e))
        }

        fn update(signature: &str) -> Update {
            offered(manifest("0.1.0-beta.4", TARGET, signature))
                .unwrap()
                .expect("an update")
        }

        #[test]
        fn a_newer_signed_release_is_offered_and_verifies() {
            let update = update(SIGNATURE);
            assert_eq!(update.version, "0.1.0-beta.4");
            assert_eq!(update.body.as_deref(), Some("Release notes."));
            assert!(update.verify(PACKAGE).is_ok());
        }

        #[test]
        fn the_same_or_an_older_release_is_not_offered() {
            for version in ["0.1.0-beta.3", "0.1.0-beta.2", "0.1.0-beta.3+rebuild"] {
                assert!(
                    offered(manifest(version, TARGET, SIGNATURE))
                        .unwrap()
                        .is_none(),
                    "{version}"
                );
            }
        }

        #[test]
        fn a_release_without_this_architecture_is_not_installable() {
            let result = offered(manifest("0.1.0-beta.4", "darwin-x86_64", SIGNATURE));
            assert_eq!(result.err(), Some(Failure::NoBuild));
        }

        #[test]
        fn malformed_manifests_are_rejected() {
            let mut missing_signature = manifest("0.1.0-beta.4", TARGET, SIGNATURE);
            missing_signature["platforms"][TARGET]
                .as_object_mut()
                .unwrap()
                .remove("signature");
            for broken in [
                manifest("not-a-version", TARGET, SIGNATURE),
                json!({ "version": "0.1.0-beta.4" }),
                missing_signature,
                json!("<html>Not Found</html>"),
            ] {
                assert_eq!(offered(broken).err(), Some(Failure::Manifest));
            }
        }

        #[test]
        fn a_corrupted_package_fails_verification() {
            let mut corrupted = PACKAGE.to_vec();
            corrupted[0] ^= 1;
            let error = update(SIGNATURE).verify(&corrupted).unwrap_err();
            assert_eq!(classify(&error), Failure::Verification);
        }

        #[test]
        fn a_signature_by_another_key_fails_verification() {
            let error = update(OTHER_KEY).verify(PACKAGE).unwrap_err();
            assert_eq!(classify(&error), Failure::Verification);
        }

        /// A tampered manifest pairing a new version number with a package signed for another
        /// version (here an older one) is refused, although the signature itself is genuine.
        #[test]
        fn a_package_signed_for_another_version_fails_verification() {
            let error = update(WRONG_VERSION).verify(PACKAGE).unwrap_err();
            assert_eq!(classify(&error), Failure::Verification);
        }

        #[test]
        fn a_malformed_signature_fails_verification() {
            let error = update("not base64!").verify(PACKAGE).unwrap_err();
            assert_eq!(classify(&error), Failure::Verification);
        }

        /// The real bundle swap on a copy of the local test builds (RELEASE.md §11):
        /// `SNIPVERO_UPDATE_TEST_DIR=/tmp/snipvero-update-test cargo test -- --ignored real_install`
        #[cfg(target_os = "macos")]
        #[test]
        #[ignore = "needs the builds made by scripts/updater-local-test.mjs"]
        fn real_install_replaces_the_bundle_only_with_a_verified_package() {
            use std::fs;
            use std::path::PathBuf;
            use std::process::Command;

            let dir = PathBuf::from(std::env::var("SNIPVERO_UPDATE_TEST_DIR").unwrap());
            let work = dir.join(format!("install-test-{}", std::process::id()));
            fs::create_dir(&work).unwrap();
            let app = work.join("Snipvero Update Test.app");
            let copied = Command::new("ditto")
                .arg(dir.join("builds/0.1.0-beta.3/Snipvero Update Test.app"))
                .arg(&app)
                .status()
                .unwrap();
            assert!(copied.success());
            let executable = app.join("Contents/MacOS/snipvero");
            let before = fs::read(&executable).unwrap();

            let pubkey = fs::read_to_string(dir.join("keys/test.key.pub")).unwrap();
            let (_app, updater) = updater_with(&pubkey, Some(&executable));
            let read_manifest = |name: &str| -> Value {
                let path = dir.join(format!("www/scenarios/{name}.json"));
                serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
            };
            let packages = dir.join("www/packages");

            // A corrupted package is refused before anything is touched.
            let update = updater
                .restore_update(read_manifest("corrupted"))
                .unwrap()
                .unwrap();
            let corrupted =
                fs::read(packages.join("Snipvero_0.1.0-beta.90_aarch64.corrupted.app.tar.gz"))
                    .unwrap();
            let error = update.install(&corrupted).unwrap_err();
            assert_eq!(classify(&error), Failure::Verification);
            assert_eq!(fs::read(&executable).unwrap(), before);

            // The genuine package replaces the bundle with a valid, signed newer app.
            let update = updater
                .restore_update(read_manifest("newer"))
                .unwrap()
                .unwrap();
            let package =
                fs::read(packages.join("Snipvero_0.1.0-beta.90_aarch64.app.tar.gz")).unwrap();
            update.install(&package).unwrap();
            let after = fs::read(&executable).unwrap();
            assert_ne!(after, before);
            assert!(after.windows(13).any(|w| w == b"0.1.0-beta.90"));
            let verified = Command::new("codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&app)
                .status()
                .unwrap();
            assert!(verified.success());
            // Only the replaced bundle is left in its folder.
            let left: Vec<_> = fs::read_dir(&work)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            assert_eq!(left, vec![app.clone()]);
            fs::remove_dir_all(&work).unwrap();
        }
    }
}
