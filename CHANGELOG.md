# Changelog

## Unreleased

### Added

- Links to **snipvero.app** in the main window footer and About window.
- A **Contact** link in About for **support@snipvero.app**, opened in the default email app.

### Distribution

- Generated Homebrew casks use **snipvero.app** as the homepage. No download or checksum change.
- Change the capture shortcut: **Change…** in the main window's Global shortcut row records a new
  combination, and **Reset to ⌘⇧2** restores the default. It is kept across restarts. Combinations
  the system or most apps rely on are refused, and a change that cannot be registered keeps the
  previous shortcut.

### Privacy

- The chosen shortcut is stored in `settings.json` in Snipvero's Application Support folder. The
  file holds only the shortcut, never screenshots or file names.

## 0.1.0-beta.3 — 2026-11-01

### Added

- In-app updates from **Check for Updates…** (main window Updates row, About Snipvero, menu bar),
  using Tauri's official updater.
  Checks run only when the user clicks; downloading and installing only after **Download and
  Restart**. Progress, cancel, up-to-date and failure states are shown.
- Updates must carry a valid signature from the release updater key, bound to the announced
  version; only strictly newer Apple silicon builds are offered. No update during a capture.

### Privacy

- The app now makes network requests, but only for a user-started update check and download,
  to GitHub over HTTPS, without identifiers. Requirements, README and decisions (ADR-028) updated.

### Distribution

- The release script builds, signs and verifies an updater package from the stapled app and
  writes the beta channel manifest (`updater/beta.json`, published after the release).
- Beta 2 and earlier have no updater: Beta 3 must be installed manually once.

## 0.1.0-beta.2 — 2026-11-01

### Security

- Create PNG save temporary files exclusively with unique names, preventing pre-existing
  temporary-file symlinks from redirecting writes to another file.
- Preserve restrictive Unix permission bits when replacing an existing regular PNG file.
- Update the development-only minimatch dependency to address GHSA-g3hv-75wg-m249.
- Add regression tests for temporary-file symlinks, restrictive permissions and occupied names.

### Distribution

- Prepare Developer ID Application signing, explicit hardened runtime, and separate Apple
  notarization and stapling for the application and DMG.
- Require the expected signing team, secure timestamps, valid signatures, stapled tickets and
  Gatekeeper acceptance before exporting distribution files.
- Generate a version-pinned Homebrew cask from the final stapled DMG's checksum. No tap is published.
- Document an inactive, opt-in manual release workflow template; self-hosted signing and automatic
  publication remain disabled. Apple signing credentials stay in local Keychain, not GitHub secrets.

### Platform support

- macOS 14 or later on Apple silicon only. No Intel, universal or Windows release is provided.

## 0.1.0-beta.1 — 2026-10-31

- First macOS beta: region capture on multiple displays; arrows, rectangles and text annotations;
  undo/redo; clipboard copy and PNG save; global shortcut and menu bar integration.
- Apple silicon only, macOS 14 or later.
- Original published DMG is ad-hoc signed and not notarized. Its release assets and tag are retained.
