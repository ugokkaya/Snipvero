// English messages of the main window, About, updates and shared helpers (ADR-039).
// Keys are `app.<thing>`; `{name}` is a parameter.
export const appEn = {
  "app.language.title": "Language",
  "app.language.system": "System default",
  // Language names are written in their own language, in every catalogue.
  "app.language.en": "English",
  "app.language.tr": "Türkçe",
  "app.language.failed": "The language could not be changed.",

  // Main window
  "app.subtitle": "Screen capture & annotation",
  "app.capture.section": "Capture",
  "app.capture.button": "Capture Region",
  "app.capture.shortcutLabel": "Shortcut {shortcut}",
  "app.capture.hint": "Freezes every display. Drag to select a region, press {esc} to cancel.",
  "app.record.button": "Record Region",
  "app.record.hint":
    "Records the selected region as an MP4 video. Stop it from the menu bar{shortcut}.",
  "app.record.orShortcut": " or with {shortcut}",
  "app.features.label": "Features",
  "app.features.capture.title": "Capture",
  "app.features.capture.text": "Select any screen region.",
  "app.features.annotate.title": "Annotate",
  "app.features.annotate.text": "Add arrows, rectangles, and text.",
  "app.features.export.title": "Export",
  "app.features.export.text": "Copy to clipboard or save as PNG.",
  "app.status.label": "Status",
  "app.status.runsInMenuBar": "Runs in the menu bar",
  "app.status.runsInSystemTray": "Runs in the system tray",
  "app.status.running": "Running",
  "app.status.keepsRunning": "Closing this window keeps Snipvero running.",
  "app.permission.title": "Screen Recording",
  "app.permission.checking": "Checking…",
  "app.permission.notAvailable": "Not available",
  "app.permission.allowed": "Allowed",
  "app.permission.notAllowed": "Not allowed",
  "app.permission.help":
    "Turn on Snipvero in System Settings → Privacy & Security → Screen & System Audio Recording. If capture still fails, restart Snipvero.",
  "app.permission.openSettings": "Open System Settings",
  "app.permission.restart": "Restart Snipvero",
  "app.permission.unsupported": "Screen capture is not available on this platform yet.",
  "app.footer.version": "Version {version}",
  "app.footer.about": "About Snipvero",

  // Global shortcut row
  "app.shortcut.title": "Global shortcut",
  "app.shortcut.recording": "Recording…",
  "app.shortcut.unavailable": "Unavailable",
  "app.shortcut.cancel": "Cancel",
  "app.shortcut.change": "Change…",
  "app.shortcut.prompt": "Press the new shortcut, or {esc} to cancel.",
  "app.shortcut.noReason": "no reason given",
  "app.shortcut.notRegisteredMenuBar":
    " could not be registered, probably because another app uses it ({reason}). Choose another shortcut, or use {capture} in the menu bar.",
  "app.shortcut.notRegisteredSystemTray":
    " could not be registered, probably because another app uses it ({reason}). Choose another shortcut, or use {capture} in the system tray.",
  "app.shortcut.trayCapture": "Capture",
  "app.shortcut.reset": "Reset to {shortcut}",
  "app.shortcut.example.macos": "⌘⇧ or ⌃⌥",
  "app.shortcut.example.other": "Ctrl+Shift or Ctrl+Alt",
  "app.shortcut.rejection.modifiers":
    "Use two modifier keys, such as {example}, so other apps keep their own shortcuts. With a function key (F1–F24), one is enough. Print Screen can be used on its own.",
  "app.shortcut.rejection.modifiersF13":
    " F13 is also allowed on its own, since some Mac keyboards report Print Screen as F13.",
  "app.shortcut.rejection.reserved":
    "The system or most apps use that combination. Choose another one.",
  "app.shortcut.rejection.unavailable":
    "That combination could not be registered, probably because another app uses it.",
  "app.shortcut.rejection.notSaved":
    "The shortcut could not be saved. The previous shortcut still works.",
  "app.shortcut.rejection.invalid": "That key cannot be used in a shortcut. Choose another one.",

  // About window
  "app.about.description":
    "A lightweight, open-source screenshot and annotation application for macOS.",
  "app.about.version": "Version {version}",
  "app.about.developer": "Developer",
  "app.about.website": "Website",
  "app.about.contact": "Contact",
  "app.about.sourceCode": "Source Code",
  "app.about.contributors": "Contributors",
  "app.about.viewOnGitHub": "View on GitHub",
  "app.about.license": "License",
  "app.about.licenseName": "MIT License",
  "app.about.viewLicense": "View",

  // Updates
  "app.update.title": "Updates",
  "app.update.privacy":
    "Checks GitHub only when you click. No screenshots or personal data are sent.",
  "app.update.restartNote":
    "Snipvero will download the update, then quit and reopen to finish installing. Close any open capture first.",
  "app.update.check": "Check for Updates…",
  "app.update.checking": "Checking…",
  "app.update.checkAgain": "Check Again",
  "app.update.upToDate": "Snipvero {current} is up to date.",
  "app.update.available": "Snipvero {version} is available.",
  "app.update.youHave": "You have {current}.",
  "app.update.releaseNotes": "Release notes",
  "app.update.download": "Download and Restart",
  "app.update.notNow": "Not Now",
  "app.update.progress": "Download progress",
  "app.update.downloading": "Downloading Snipvero {version}… {received}",
  "app.update.downloadingOf": "Downloading Snipvero {version}… {received} of {total}",
  "app.update.cancel": "Cancel",
  "app.update.installing": "Installing Snipvero {version}… It will restart in a moment.",
  "app.update.restarting": "Restarting Snipvero…",
  "app.update.keepsWorking": "Snipvero {current} keeps working.",
  "app.update.tryAgain": "Try Again",
  "app.update.failure.unavailable": "Updates are not available in this build.",
  "app.update.failure.network":
    "Snipvero could not reach the update server. Check your internet connection and try again.",
  "app.update.failure.manifest": "The update information could not be read.",
  "app.update.failure.noBuild": "This update is not available for your Mac.",
  "app.update.failure.verification": "The update could not be verified, so it was not installed.",
  "app.update.failure.location":
    "Move Snipvero to the Applications folder, open it from there, and try again.",
  "app.update.failure.busy": "Finish or cancel the current capture, then try again.",
  "app.update.failure.install": "The update could not be installed.",
  "app.update.failure.cancelled": "The download was cancelled.",
  "app.update.failure.inProgress":
    "An update is already being downloaded in another Snipvero window.",
  "app.update.failure.failed": "Something went wrong while updating.",
} as const;
