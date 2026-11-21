//! The private temporary storage of recordings (ADR-037). Pure file-system logic with no platform
//! calls, so every rule here is tested on both operating systems.
//!
//! Layout: `<temp dir>/com.snipvero.app/recordings-<pid>-<nonce>/snipvero-recording-<nonce>.mp4`.
//! The per-launch directory is created exclusively with mode 0700 and never reused. Directories of
//! earlier launches (a crash, a force-quit) are removed at startup.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

/// The per-user temporary directory's subfolder for everything Snipvero writes there.
const ROOT_NAME: &str = "com.snipvero.app";
/// Every per-launch directory starts with this, which is also how stale ones are recognised.
const DIR_PREFIX: &str = "recordings-";
const FILE_PREFIX: &str = "snipvero-recording-";
/// Extra room required beyond the worst-case file size (ADR-037).
const HEADROOM_PERCENT: u64 = 20;

/// `<temp dir>/com.snipvero.app`: the per-user temp directory macOS gives each user, not `/tmp`.
pub fn root() -> PathBuf {
    std::env::temp_dir().join(ROOT_NAME)
}

/// A name part no other launch or file shares: the clock plus a counter. The directory is private
/// and entries are created exclusively, so this only has to avoid collisions, not guessing.
fn nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    format!("{nanos:x}{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Creates one directory, private to the user, failing if it already exists.
fn create_private(path: &Path) -> io::Result<()> {
    // `mut` is only needed where the mode can be set (Unix); Windows clippy rejects it otherwise.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Makes sure `root` exists as a real directory (not a link someone planted) that only the user
/// can enter.
fn ensure_root(root: &Path) -> io::Result<()> {
    match create_private(root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// Creates this launch's recording directory under `root`. Never reuses an existing one.
pub fn create_launch_dir(root: &Path, pid: u32) -> io::Result<PathBuf> {
    ensure_root(root)?;
    const ATTEMPTS: u32 = 16;
    for _ in 0..ATTEMPTS {
        let dir = root.join(format!("{DIR_PREFIX}{pid}-{}", nonce()));
        match create_private(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free name for the recording directory",
    ))
}

/// The path of a new recording inside `dir`. The file itself is created by the encoder.
pub fn new_recording_path(dir: &Path) -> PathBuf {
    dir.join(format!("{FILE_PREFIX}{}.mp4", nonce()))
}

/// Removes the recording directories of earlier launches: every `recordings-*` entry under
/// `root` except `keep`, that is a real directory (never a link, so nothing outside is touched) and
/// was last modified before `launched`. Returns how many were removed and the failures, which the
/// caller logs: a leftover is never reported as removed.
pub fn remove_stale(
    root: &Path,
    keep: Option<&Path>,
    launched: SystemTime,
) -> (usize, Vec<(PathBuf, io::Error)>) {
    let mut removed = 0;
    let mut failed = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return (0, failed); // No directory yet: nothing was ever recorded.
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ours = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(DIR_PREFIX));
        if !is_ours || keep == Some(path.as_path()) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.modified().is_ok_and(|time| time >= launched) {
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(error) => failed.push((path, error)),
        }
    }
    (removed, failed)
}

/// The free space a recording must be able to reach: the file size at the bitrate and the cap,
/// plus headroom.
pub fn required_free_bytes(bitrate: u32, cap_seconds: u64) -> u64 {
    let worst_case = u64::from(bitrate) / 8 * cap_seconds;
    worst_case + worst_case * HEADROOM_PERCENT / 100
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A fresh, empty directory per test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "snipvero-tempfiles-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn root_is_below_the_per_user_temp_directory() {
        assert_eq!(root(), std::env::temp_dir().join("com.snipvero.app"));
    }

    #[test]
    fn launch_dirs_are_new_and_never_reused() {
        let scratch = scratch("launch");
        let root = scratch.join(ROOT_NAME);
        let first = create_launch_dir(&root, 42).unwrap();
        let second = create_launch_dir(&root, 42).unwrap();
        assert_ne!(first, second);
        for dir in [&first, &second] {
            assert!(dir.is_dir());
            assert!(
                dir.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("recordings-42-"))
            );
        }
        let _ = fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn directories_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = scratch("private");
        let root = scratch.join(ROOT_NAME);
        // A root left open by something else is closed again.
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let dir = create_launch_dir(&root, 1).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&dir), 0o700);
        let _ = fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_root_is_refused() {
        let scratch = scratch("link");
        let target = scratch.join("elsewhere");
        fs::create_dir(&target).unwrap();
        let root = scratch.join(ROOT_NAME);
        std::os::unix::fs::symlink(&target, &root).unwrap();
        assert!(create_launch_dir(&root, 1).is_err());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn recording_paths_are_distinct_mp4_files_inside_the_directory() {
        let dir = Path::new("/tmp/example");
        let (a, b) = (new_recording_path(dir), new_recording_path(dir));
        assert_ne!(a, b);
        for path in [&a, &b] {
            assert_eq!(path.parent(), Some(dir));
            let name = path.file_name().and_then(|n| n.to_str()).unwrap();
            assert!(name.starts_with("snipvero-recording-") && name.ends_with(".mp4"));
        }
    }

    #[test]
    fn stale_directories_are_removed_and_the_current_one_and_others_are_kept() {
        let scratch = scratch("stale");
        let root = scratch.join(ROOT_NAME);
        let old = create_launch_dir(&root, 1).unwrap();
        fs::write(old.join("snipvero-recording-1.mp4"), b"half a movie").unwrap();
        let current = create_launch_dir(&root, 2).unwrap();
        let unrelated = root.join("something-else");
        fs::create_dir(&unrelated).unwrap();
        let loose_file = root.join("recordings-file");
        fs::write(&loose_file, b"not a directory").unwrap();

        // Launched after `old` was written, so it is stale; `current` is this launch's own.
        let launched = SystemTime::now() + Duration::from_secs(60);
        let (removed, failed) = remove_stale(&root, Some(&current), launched);
        assert_eq!(removed, 1);
        assert!(failed.is_empty());
        assert!(!old.exists());
        assert!(current.is_dir() && unrelated.is_dir() && loose_file.is_file());
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn directories_modified_after_launch_are_not_stale() {
        let scratch = scratch("fresh");
        let root = scratch.join(ROOT_NAME);
        let dir = create_launch_dir(&root, 1).unwrap();
        let launched = SystemTime::now() - Duration::from_secs(3600);
        assert_eq!(remove_stale(&root, None, launched).0, 0);
        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_named_like_a_recording_directory_is_not_followed() {
        let scratch = scratch("stale-link");
        let root = scratch.join(ROOT_NAME);
        ensure_root(&root).unwrap();
        let precious = scratch.join("precious");
        fs::create_dir(&precious).unwrap();
        fs::write(precious.join("keep.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(&precious, root.join("recordings-9-bad")).unwrap();
        let launched = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(remove_stale(&root, None, launched).0, 0);
        assert!(precious.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn nothing_to_clean_without_a_root() {
        let scratch = scratch("no-root");
        let launched = SystemTime::now();
        let (removed, failed) = remove_stale(&scratch.join("missing"), None, launched);
        assert_eq!((removed, failed.len()), (0, 0));
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn required_space_is_the_worst_case_file_plus_headroom() {
        // 8 Mbit/s for 300 s is 300 MB; 20 % headroom makes 360 MB.
        assert_eq!(required_free_bytes(8_000_000, 300), 360_000_000);
        // The default cap at the highest bitrate: 750 MB (ADR-037) plus headroom.
        assert_eq!(required_free_bytes(20_000_000, 300), 900_000_000);
        assert_eq!(required_free_bytes(0, 300), 0);
    }
}
