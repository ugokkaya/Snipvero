# Changelog

## 0.2.0-beta.1 — 2026-11-21

### Added

- The interface is available in Turkish. It follows the system language, and the **Language** row in the main window
  switches between System default, English and Türkçe without a restart. The menu bar, overlay, recording windows and
  messages change with it. The macOS microphone permission text stays English.
- macOS: record a region of one display as a silent MP4 (H.264, 30 fps). Start from **Record Region** in
  the menu bar or the main window, or from the record button of the screenshot toolbar; stop from the menu bar,
  the capture shortcut or the maximum length (five minutes by default). A review window plays the recording and offers
  Save, Copy File, Copy Path and Discard. The recording is a private temporary file, deleted when saved,
  discarded, on quit and at the next launch.
- macOS: a **Stop** button and the stop shortcut next to the clock beside the recorded area.
- macOS: optional system audio and microphone for recordings, two separate switches that are off by default.
- macOS: **Export as GIF…** in the recording window. Choose 5, 10 or 15 fps (10 by default) and a width up to 800 pixels;
  the window shows the size and an estimate, then progress with Cancel. GIFs are made from at most 60 seconds of video.
  The MP4 is not changed.

## 0.1.0-beta.9 — 2026-11-15

### Fixed

- Show reliable in-app tooltips for every capture toolbar button, including disabled actions.
  Hover to see the tool name and available keyboard shortcut. Labels wrap and stay within the
  display, disappear when leaving or pressing a button, and do not intercept drawing input.

## 0.1.0-beta.8 — 2026-11-15

### Fixed

- Allow Print Screen alone as the capture shortcut, without requiring modifier keys. Other keys
  keep their existing modifier requirements. The OS or keyboard software may still intercept the key.
- Accept bare F13 on macOS too: some keyboards send their Print Screen key as F13. Keep the
  physical F13 code when registering, rather than remapping to a different native key.

### Added

- Five-second recapture from the region toolbar: select an area, click the timer, then open a
  dropdown while the capture screen is hidden. Fresh pixels are read before Snipvero takes focus;
  the same region reopens for editing with old annotations cleared. The capture shortcut cancels
  the wait. Display changes end the capture rather than moving the region to another display.
- A click-through blinking region border and five-second countdown show where and when the delayed
  capture will happen, without taking focus from the app. Both disappear before capture.

## 0.1.0-beta.7 — 2026-11-11

### Security

- Update Vite to 8.3.7 and Rolldown to 1.2.18 to address
  [GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7).
  A network-exposed development server could allow arbitrary file reads and code execution.
  The default development configuration is local-only; setting `TAURI_DEV_HOST` to a network
  address or using `--host` can expose it. Published desktop apps do not run a Vite server and
  are not affected. Contributors should update their checkout and run `pnpm install`.

## 0.1.0-beta.6 — 2026-11-03

### Fixed

- Clicking the menu bar icon could freeze the open menu, and with it the menu bar and Dock, while
  macOS was slow to report the Open at Login setting. The setting is now read and changed in the
  background, so the menu never waits for it.

### Added

- Pressing the capture shortcut (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd> by default) during a
  capture cancels it, as <kbd>Esc</kbd> does. It works even if the capture screen stops responding.

## 0.1.0-beta.5 — 2026-11-01

### Added

- **Open at Login** in the menu bar (off by default). Snipvero then starts with the Mac in the menu
  bar, without opening its window. It is listed in System Settings › General › Login Items, where
  it can also be turned off; the menu shows the setting from there.

## 0.1.0-beta.4 — 2026-11-01

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
