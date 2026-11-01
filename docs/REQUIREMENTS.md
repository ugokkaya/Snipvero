# Requirements

## Platforms

- macOS 14 (Sonoma) or later (the only platform of the 0.1 beta). Beta builds target Apple silicon
  only; Intel is planned through a universal build (ADR-022)
- Windows 10 version 1903 or later, Windows 11 (planned; compiled and tested in CI, not released)

## Functional requirements (MVP)

| ID    | Requirement                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Trigger capture with a global keyboard shortcut. Default: `Cmd+Shift+2` (macOS), `Ctrl+Shift+2` (Windows).                                           |
| FR-2  | Capture all monitors and show the frozen image as a fullscreen overlay on each monitor.                                                              |
| FR-3  | Select a rectangular region with the mouse (drag, then move/resize). Selection is confined to one monitor. See FR-3 details below.                   |
| FR-4  | Show an annotation toolbar next to the selection that stays on screen near monitor edges.                                                            |
| FR-5  | Annotate with arrows, rectangles and text. Undo/redo.                                                                                                |
| FR-6  | Copy the annotated region to the clipboard as an image at native (physical pixel) resolution.                                                        |
| FR-7  | Save the annotated region as PNG via a save dialog.                                                                                                  |
| FR-8  | Run in the macOS menu bar / Windows system tray with **Capture**, **About** and **Exit** actions. Closing the main window keeps the app running.     |
| FR-9  | `Escape` cancels the capture from any state and closes all overlays.                                                                                 |
| FR-10 | Only one instance runs at a time. A second launch brings the existing instance forward.                                                              |
| FR-11 | macOS: detect a missing Screen Recording permission and guide the user to grant it.                                                                  |
| FR-12 | The main window starts a capture (Capture Region), shows the shortcut, permission and shortcut status, and links to About, the website and GitHub.   |
| FR-13 | An About window (main window and tray **About Snipvero**) shows the name, the version from the app metadata, license, website and source repository. |
| FR-14 | The About window checks for a newer version only when the user asks and installs it only after explicit consent. See FR-14 details below.            |
| FR-15 | Change the capture shortcut from the main window and reset it to the default; it is kept across restarts. See ADR-030.                               |
| FR-16 | macOS: **Open at Login** in the menu bar, off by default. Opened at login, Snipvero shows only its menu bar icon. See ADR-033.                       |

### FR-3 details: region selection

| ID     | Requirement                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| FR-3.1 | Press and drag in any direction to create a selection; release finalizes it. The frame stays frozen throughout.              |
| FR-3.2 | Outside the selection is dimmed; the selection has a visible border and a width × height label in physical pixels.           |
| FR-3.3 | Drag inside to move; drag one of eight corner/edge handles to resize. Dragging an edge past the opposite one flips it.       |
| FR-3.4 | Dragging outside the current selection starts a new one; a click without dragging keeps the current selection.               |
| FR-3.5 | Selections stay inside their monitor. Finalized regions are never empty; a resize to zero size restores the previous region. |
| FR-3.6 | One selection per capture session: starting one on another monitor clears the previous monitor's selection.                  |
| FR-3.7 | Cursor: crosshair to create, move/resize cursors over the selection. No text selection, native drag or context menu.         |
| FR-3.8 | Exported region data is in the frame's physical pixels (integer, frame-local).                                               |

### FR-14 details: updates

| ID      | Requirement                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-14.1 | A click on **Check for Updates…** (main window Updates row, About window, menu bar) is the only trigger. No check at launch, in the background or on a timer. |
| FR-14.2 | The result shows the current version, and for a newer version its number and English release notes as plain text.                                             |
| FR-14.3 | Downloading and installing start only after **Download and Restart**, which states that the app quits and reopens.                                            |
| FR-14.4 | Progress, cancel, up to date, connection, verification and installation failures are shown; a failure leaves the running version working.                     |
| FR-14.5 | No install or restart while a capture, annotation or export is open; no capture starts while an update installs.                                              |
| FR-14.6 | Only packages signed with the release updater key for the announced, strictly newer version and this platform (macOS Apple silicon) install.                  |
| FR-14.7 | The update endpoint is fixed per channel (beta: a manifest in the repository); the page cannot choose a URL. Channels never switch silently.                  |

### FR-4 / FR-5 details: toolbar and annotations

| ID     | Requirement                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-4.1 | A compact toolbar appears below a finalized selection (above it, or inside a full-height one, when there is no room), clamped to its monitor.     |
| FR-4.2 | Tools: Select/move (default), Arrow, Rectangle, Text; the active tool is highlighted. Six colours, three sizes, undo, redo, delete.               |
| FR-5.1 | Arrow and outlined rectangle: drag to draw with a live preview; a click creates nothing. Colour and stroke width configurable.                    |
| FR-5.2 | Text: click to type in a native text field (Unicode, Turkish). Escape or a click elsewhere finishes; empty text is dropped. Colour and font size. |
| FR-5.3 | Annotations can be selected, moved and deleted; rectangles resized from eight handles; texts re-edited by clicking them.                          |
| FR-5.4 | Annotations stay on the same screenshot pixels when the region is moved, resized or replaced; parts outside the region are hidden, not deleted.   |
| FR-5.5 | Undo/redo (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Ctrl+Y on Windows) and Delete/Backspace for the selected annotation.                                     |
| FR-5.6 | Escape while editing text finishes the edit; otherwise it cancels the capture (FR-9).                                                             |

### FR-6 / FR-7 details: export

| ID     | Requirement                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-6.1 | The exported image is the selected region of the frozen frame at its physical pixel size, with the annotations drawn as in the preview, clipped to it. |
| FR-6.2 | No selection border, handles, toolbar, size label or other UI appears in the image. A region without annotations exports the plain screenshot.         |
| FR-6.3 | Copy (toolbar, Cmd/Ctrl+C, or Enter outside the text editor) puts an image on the clipboard (macOS: PNG and TIFF; Windows: DIB and PNG).               |
| FR-7.1 | Save (toolbar or Cmd/Ctrl+S) opens the native save dialog suggesting `Snipvero-YYYY-MM-DD-HHMMSS.png` (local time) and writes a valid PNG.             |
| FR-7.2 | After a successful copy or save the overlays close and focus returns to the previous app. A cancelled dialog or a failure keeps the overlay open.      |
| FR-7.3 | While editing text, Cmd/Ctrl+C and Enter keep their text meaning; Cmd/Ctrl+S commits the text and includes it. Escape keeps its two-stage behaviour.   |
| FR-7.4 | One export at a time; export is unavailable without a finalized region. Nothing but the chosen file is written to disk.                                |

## Non-functional requirements

| ID    | Requirement                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-1 | Correct on HiDPI/Retina displays, mixed scale factors and multiple monitors (including negative coordinates).                                                                                                                                  |
| NFR-2 | No telemetry, no uploads. Network access only for an update check the user starts (FR-14, ADR-028), over HTTPS to GitHub, without screenshots, annotations, file paths or identifiers. Captures are held in memory only until copied or saved. |
| NFR-3 | Low idle memory, fast startup. Capture buffers are released when a capture session ends.                                                                                                                                                       |
| NFR-4 | Optimization target (not an MVP gate): shortcut to visible overlay in under 150 ms on a 4K display.                                                                                                                                            |
| NFR-5 | MIT license. All dependencies MIT-compatible.                                                                                                                                                                                                  |
| NFR-6 | One codebase. Platform-specific code is isolated and used only where necessary.                                                                                                                                                                |

## Out of scope for the MVP

- Selection spanning multiple monitors
- A settings window, themes (changing the capture shortcut is FR-15; Open at Login on macOS is FR-16)
- Additional tools (blur, pen, highlighter, counters), upload/sharing of any kind
- Automatic update checks (a possible later opt-in setting, ADR-028)
- Linux support
