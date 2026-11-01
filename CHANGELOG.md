# Changelog

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
