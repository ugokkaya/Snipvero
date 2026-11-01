# Architecture

> Sections marked _(planned)_ describe work that is not implemented yet.
> Record changes in `DECISIONS.md`.

## Overview

Snipvero is a Tauri 2 application. Rust owns the app lifecycle, the tray, global shortcuts,
native screen capture and the clipboard/file output. A React + TypeScript frontend running in the
system webview (WKWebView on macOS, WebView2 on Windows) renders the main window, the capture
overlays and the annotation UI (Konva.js via react-konva).

## Current layout

```
index.html, src/              React frontend (every window loads index.html)
  main.tsx                    renders App, About or Overlay based on the window label (route.ts)
  route.ts                    pure window label → view mapping
  App.tsx                     main window: Capture Region, features, permission/shortcut status, About, GitHub;
                              sizes the window to its content (useFitWindow.ts, fit.ts)
  About.tsx                   About window: name, version and copyright from Rust, license, project links
  StatusRow.tsx               one row of the main window's status list
  ShortcutRow.tsx, shortcut.ts  Global shortcut row: status, Change…/Reset; pure key → accelerator, messages (ADR-030)
  Updates.tsx, update.ts      Check for Updates: main window status row and About section; pure view reducer (ADR-028)
  ExternalLink.tsx            link opened by Rust (`open_link`); the web view never navigates
  useAppInfo.ts, icons.tsx    app metadata hook; line icons
  App.css                     theme tokens (light and dark), main/About window, overlay styles
  overlay/Overlay.tsx         frozen frame for one display; pointer/keyboard input → editor reducer; Escape cancels
  overlay/SelectionView.tsx   dim, border, handles, size label (visual only, no pointer input)
  overlay/AnnotationLayer.tsx Konva stage over the region (visual only; lazily loaded chunk)
  overlay/TextEditor.tsx      textarea for the text being edited
  overlay/Toolbar.tsx         floating toolbar (tools, colours, sizes, undo/redo/delete, copy/save)
  overlay/selection.ts        pure selection model: state machine, hit testing, cursors, resizeRect
  overlay/annotations.ts      pure annotation data and geometry (arrow head, bounds, hit tests, styles)
  overlay/annotate.ts         pure annotation reducer: tools, selected annotation, gestures, undo/redo
  overlay/editor.ts           pure combination of both: press routing, rebasing, cursors
  overlay/shapes.ts           Konva shape configs per annotation, shared by preview and export
  overlay/exporting.ts        pure export flow: layer plan, file name, one-at-a-time exporter
  overlay/rasterize.ts        annotations → region-sized RGBA layer (lazy, with Konva)
  overlay/keys.ts             keyboard commands per platform
  overlay/measure.ts          canvas text measurement shared with Konva's font string
  overlay/coords.ts           pure client ↔ frame-pixel conversion, label/toolbar placement
  frame.ts                    raw RGBA IPC → ImageData → ImageBitmap (ADR-007)
  ipc.ts                      typed commands/events, mirrored in src-tauri/src/events.rs
  platform.ts                 platform detection, accelerator display labels
src-tauri/
  tauri.conf.json             app config (identifier, CSP incl. ipc:, ad-hoc macOS signing)
  Info.plist                  macOS: LSUIElement (menu bar app, no Dock icon)
  icons/                      app icons generated from icons/source/app-icon.svg; tray-template.png (macOS menu bar)
  capabilities/default.json   frontend permissions for "main", "about" and "overlay-*" (core:default)
  capabilities/fit-to-content.json  main, about: window:allow-set-size (fit to content)
  capabilities/about.json     about: window:allow-close (Escape); no window has an `updater:` permission
  src/lib.rs                  builder, single instance, close→hide, exit policy, command registration
  src/tray.rs                 tray icon (macOS: template image) and menu (Capture, Open Snipvero, About Snipvero, Check for Updates…, Quit)
   src/about.rs                About window (created on demand), app metadata, fixed links (website, repository, contributors, license)
  src/update.rs               user-started update check, download, install and restart (tauri-plugin-updater, ADR-028)
  src/shortcut.rs             global shortcut registration, validation, change/suspend commands, status/error reporting
  src/settings.rs             settings.json in the app config directory (capture shortcut), atomic writes (ADR-030)
  src/system/{mod,macos}.rs   previous-app focus restoration, fixed System Settings URL, open URL / file (NSWorkspace)
  src/events.rs               event names shared with the frontend
  src/geometry.rs             pure coordinate math (LogicalRect, PixelRect, physical size, Cocoa flip)
  src/capture/mod.rs          platform-independent capture interface (Frame, errors)
  src/capture/macos.rs        ScreenCaptureKit backend
  src/overlay/mod.rs          capture session state (incl. the one selection), overlay windows, overlay commands,
                              readiness watchdog, display-change handling (ADR-019)
  src/overlay/macos.rs        window level / Spaces behaviour (lowered during the save dialog), cursor location,
                              display-change observer and current display bounds
  src/export/mod.rs           crop + blend + PNG, request validation, overlay_copy / overlay_save, save dialog
  src/export/macos.rs         NSPasteboard (PNG + TIFF)
  src/export/windows.rs       clipboard via arboard (CI-tested only)
  src/transfer.rs             BGRA → RGBA conversion
  src/devtools.rs             --stress=N capture/cancel and --stress-export=N capture/export harness
```

## App lifecycle

- **Background app:** on macOS the activation policy is `Accessory` (and `LSUIElement` in the bundle),
  so there is no Dock icon. On Windows the app lives in the notification area.
- **Main window:** shown at launch. Closing it hides it (`CloseRequested` → `prevent_close` + `hide`).
  It can be reopened from the tray (**Open Snipvero**) or by launching the app again. Its
  **Capture Region** button calls `start_capture`, which runs the same `overlay::start` as the tray
  and the shortcut, on the main thread.
- **About window:** label `about`, created on demand by `about::show` from the tray
  (**About Snipvero**) or the main window (`show_about`), both on the main thread, so there is
  never more than one. If it exists it is shown and focused. Closing it destroys it
  (`close_policy`: only `main` hides). It works while the main window is hidden.
- **Exit:** only the tray **Exit** / **Quit Snipvero** item ends the process (`app.exit(0)`).
  Implicit exit requests (`RunEvent::ExitRequested` with no exit code) are prevented.
- **Single instance:** `tauri-plugin-single-instance` is registered first. A second launch exits
  and the running instance shows its main window.
- **Global shortcut:** registered at startup by `tauri-plugin-global-shortcut`: the saved one from
  `settings.json`, else `CommandOrControl+Shift+2`. Key-down triggers the same capture function as
  the tray. OS-reported registration errors are displayed in the main window; tray capture stays
  usable. The main window changes it (`shortcut_set`), releasing it while recording
  (`shortcut_suspend`); a change that cannot be registered or saved keeps the previous one (ADR-030).
- **Focus:** on macOS, record the frontmost app before showing overlays. On cancellation,
  reactivate that app rather than showing Snipvero's main window. Windows focus restoration
  is not implemented yet; Windows capture itself is still unsupported.

## Capture pipeline

Implemented on macOS: global shortcut or tray **Capture** → frozen overlays → Escape → previous app.

```
Shortcut/Tray ─▶ overlay::start
                ├─ no permission? request it, emit `capture-failed`, show main window
                ├─ remember frontmost app (macOS)
                └─ worker thread: capture::capture_displays()
                     ├─ SCShareableContent (displays; own app excluded)
                     ├─ SCScreenshotManager per display, concurrently ─▶ BGRA CGImage
                     └─ Frame { bounds (points), scale, width×height px, bgra }
                   store Session { frames: Arc<Frame>, focus = display under cursor }
                   tell pre-created `overlay-<i>` windows to load; create missing ones on demand
Overlay webview ├─ overlay_frame_info(i), overlay_frame(i) ─▶ ArrayBuffer
                ├─ ImageData ─▶ ImageBitmap ─▶ canvas at native pixel size (CSS scales to the window)
                └─ overlay_ready ─▶ Rust raises it above the menu bar, shows it, focuses the cursor's display
Pointer (one)   ─▶ selection reducer in that page (no IPC while moving)
                 ├─ first real drag of a new selection ─▶ overlay_select(session, null)
                 │     Rust records the owner and emits `overlay-selection-cleared` to the previous one
                 └─ each finalized region ─▶ overlay_select(session, PixelRect) ─▶ Session.selection
Esc (any)       ─▶ overlay_cancel(session) ─▶ refused while exporting or for an ended capture
                                   otherwise destroy overlays, drop frames, restore previous app
                                   pre-create a fresh hidden set in the background
```

Every end of a capture names its session (`overlay::close(app, session)`), so a late or stale
request never closes a newer capture (ADR-019). Recovery paths end a capture with a message in
the main window: overlays not all shown 8 s after capture (watchdog), no display captured, or the
display bounds changed (`NSApplicationDidChangeScreenParametersNotification`, checked against the
captured bounds because AppKit also posts it without a change; ignored during an export).

Toolbar and annotation input stay in the page (editor reducer); no IPC while drawing.

```
Copy / Save     ─▶ commit a text being edited; exporter refuses a second request
(page)             layerPlan: annotations reaching into the region? → rasterize (Konva, 1 px = 1 frame px)
                   invoke overlay_copy | overlay_save, raw RGBA body (or empty), x-snipvero-* headers
Rust            ─▶ Session.begin_export (session, region fits, layer size, not already exporting)
                   compose: crop BGRA frame → RGBA, blend layer, alpha 255
                   copy: clipboard (macOS NSPasteboard PNG+TIFF, Windows arboard)
                   save: overlays step down, rfd save dialog (sheet) → cancelled: overlays back, keep editing
                         → PNG encode → hidden sibling file renamed over the chosen file
                   success ─▶ overlay::close(session) (as Escape: destroy overlays, drop frames, restore focus)
```

## Region selection

- **Model:** `src/overlay/selection.ts` is a pure reducer, independent of React and the DOM.
  Phases: `idle → creating → selected ⇄ moving | resizing`, plus terminal `cancelled` (Escape).
  `clear` (another display took the selection) returns any phase to `idle`. A press-release within
  the slop distance is a click: it creates nothing and keeps any previous selection.
- **One coordinate space:** pointer positions are converted once, in `coords.ts`, from window CSS
  pixels to the frame's physical pixels (rounded to pixel edges, clamped to the frame). All selection
  math, and the region sent to Rust, is in that integer space; it is converted back only to draw.
  The ratio is the per-axis frame/window size of that display, so mixed and fractional scales need
  no global factor, and negative display origins never enter the selection math (the window is local).
  Rust's `PixelRect::to_logical` maps a region back to desktop points for diagnostics.
- **Rendering:** the frozen canvas is untouched. One positioned element draws the border (`outline`,
  outside the region) and dims the rest with a large `box-shadow` spread. All drawn elements have
  `pointer-events: none`; hit testing (8 CSS px grab distance, at most a quarter of a side inward)
  lives in the model, so cursors and behaviour come from the same function.
- **Pointer capture** keeps a drag going when the pointer leaves the window or display; positions are clamped.
  Overlay windows set `accept_first_mouse`, so the first press on another display starts a selection.
- **One selection per session:** Rust's `Session::select` records the owning overlay and returns the
  previous owner to clear. Regions are validated against the frame (non-empty, inside). Two IPC calls
  per gesture at most; none while dragging.
- **Placement:** `placeOutside` positions the size label (above first) and the toolbar (below first);
  `placeLabel` moves the label off the toolbar when both end up on the same side.

## Annotations

- **Data:** plain serializable objects (`annotations.ts`): arrow (`from`, `to`), outlined rectangle
  (`rect`), text (`at`, `text`), each with an id, colour and stroke width or font size. All values are
  in frame physical pixels, relative to the region's top-left corner (`EditorState.origin`), so export
  can draw them onto the cropped region directly. Style presets are CSS sizes multiplied by the
  display's scale when an annotation is created, so strokes look the same on 1× and 2× displays.
- **Three pure reducers:** `selection.ts` (region), `annotate.ts` (tool, style, selected annotation,
  gesture, history) and `editor.ts`, which combines them. Press priority: (1) while a text is edited,
  a press only ends the edit; (2) the selected annotation's handles/body; (3) the region's handles and
  everything outside it (as without annotations: a drag outside starts a new selection); (4) inside, a drawing
  tool annotates, the select tool picks an annotation or else moves the region. Cursors use the same
  rules (`editorCursor`). Annotation input is clamped to the region.
- **Pinned to the screenshot:** annotations do not move with the region. When a region change is
  finalized with a new top-left corner, `editor.ts` rebases every history entry by the difference,
  so they keep their screenshot pixels and stay region-relative. Moving, resizing (from any edge)
  or replacing the region hides what falls outside (the Konva stage covers only the region), but
  deletes nothing; growing the region shows it again. Another display taking the selection drops
  this display's annotations (they belong to its frame). Region changes are not undo steps.
- **History:** immutable snapshots of the annotation list (max 100), one entry per finished gesture
  (draw, move, resize, text commit, restyle, delete). A drag, a click without movement or an
  unchanged text edit records nothing. Undo/redo deselects an annotation that disappears.
- **Rendering:** react-konva `Stage` positioned at the region in CSS pixels, layer scaled by
  `1 / pixelRatio`, so shapes are drawn in frame pixels; Konva's canvas uses the device pixel ratio.
  The arrow head is computed (`arrowGeometry`) rather than Konva's `Arrow`, so the shaft ends inside
  it. The stage does not listen to events: hit testing is in the pure model. It is mounted only while
  there are annotations. Konva core and three shapes are imported (not the full build) and loaded as
  a separate chunk after the frame is shown, so the main window and first paint do not pay for it.
- **Text:** a `<textarea>` with the same font, size and line height (1.25) replaces the Konva text
  while editing: native typing, dead keys and Unicode. Konva's alphabetic baseline and the CSS line
  box use the same centering, so the text does not jump when editing ends. Text bounds for hit testing
  come from canvas `measureText` with Konva's font string.
- **Keyboard:** Escape in the textarea ends the edit (stops propagation); anywhere else it cancels the
  capture as before. Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (Ctrl+Y on Windows), Delete/Backspace. Keys in the
  textarea are left to it. Toolbar buttons never take focus, so a text being edited keeps it.

## Export

- **One pipeline:** `export::compose` crops the frame Rust holds and blends the page's annotation
  layer; the clipboard and the PNG file both start from its result (ADR-018). The region comes from
  the selection model in frame pixels, so the output keeps the display's physical resolution on
  every scale, and the layer, sized exactly to the region, clips annotations like the preview stage.
- **Same drawing as the preview:** `shapes.ts` turns each annotation into Konva shape configs used
  by both `AnnotationLayer` (react-konva) and `rasterize.ts` (a detached Konva group drawn at pixel
  ratio 1). Selection marks, the region border, handles, label and toolbar are DOM or separate
  shapes and never reach the layer. Without annotations in the region no layer is sent.
- **IPC:** one request per export; the body is the raw layer, metadata travels in headers. Rust
  validates every input; the frame never returns to the page and nothing is base64-encoded.
- **Keyboard:** `keyCommand` gets whether the text editor has focus. There, only Cmd/Ctrl+S passes
  (the text is committed and included); Cmd/Ctrl+C, Enter and Escape keep their textarea meaning.
  Elsewhere Enter and Cmd/Ctrl+C copy and Cmd/Ctrl+S saves; auto-repeat does not export again.
- **Outcome:** success closes everything through `overlay::close`; a cancelled dialog returns
  `cancelled` and an error is shown in the overlay, which stays open with its annotations.
- **Disk:** only the file the user chose is written, through a hidden sibling
  (`.<name>.<pid>-<n>-<nanos>.snipvero-partial`) renamed over it and removed on failure, so a
  failed write never leaves a truncated PNG or destroys the file being replaced. The sibling is
  created exclusively (never opened through an existing entry or symlink) and, on Unix, with the
  replaced file's permission bits (ADR-026).
- **Clipboard memory:** the macOS clipboard code runs in its own autorelease pool; exports run on
  long-lived async runtime threads, which have none.

Key design points:

- **One overlay window per display.** Windows don't span displays reliably on macOS (Spaces) or on
  Windows (mixed DPI).
- **Opaque overlay** showing the captured frame. No transparent windows are needed.
- **Frame transport:** raw RGBA over Tauri IPC (ADR-007). The CSP must allow `ipc:`.
- **Overlay lifecycle:** pre-create small hidden windows only on macOS (where capture exists),
  destroy used windows on Escape, then replace them in the background (ADR-013). Reusing shown
  WebKit pages retained substantially more image memory. Session IDs prevent duplicate readiness
  from the startup path and the `overlay-load` event. Display counts are refreshed when recycling;
  a display change during a capture ends it (ADR-019).
- **Coordinates:** displays are described by logical bounds from the capture backend (`SCDisplay.frame`
  on macOS), not Tauri's monitor API, which mixes units on mixed-DPI macOS setups. Overlay windows
  are sized in logical units. The canvas backing store uses the frame's pixel size. Measured: the window
  CSS size equals the display bounds, and the image/CSS ratio equals the scale (1.000 and 2.000).
- **Platform code only where needed:** capture backend, overlay window level/focus, cursor location.

## Updates

Implemented on macOS (ADR-028); other platforms report updates as unavailable.

```
Check for Updates… ─▶ update_check (main or About window; the menu bar item emits
  (main row, About,     `update-check-requested` to the main window, whose row starts it)
   menu bar)
                             ├─ no public key / not macOS ─▶ "unavailable"
                             └─ GET fixed manifest (tauri.conf.json, HTTPS only, 30 s)
                                  ├─ not newer by SemVer precedence ─▶ up to date
                                  ├─ no darwin-aarch64 entry ─▶ "noBuild"
                                  └─ newer ─▶ kept in UpdateState; page shows version + notes
Download and Restart ─▶ update_install(progress channel)
                        ├─ app not a replaceable .app (DMG, translocated, dev binary) ─▶ "location"
                        ├─ capture open ─▶ "busy"
                        ├─ download (Cancel / About closed aborts) ─▶ minisign + signed version check
                        ├─ take the capture lock (no capture can start) ─▶ "busy" if one started
                        ├─ plugin swaps the bundle (admin prompt if needed; restores on failure)
                        └─ request_restart
```

- The page passes no URL, version or file; installing uses the update found by the last check.
- Every failure leaves the running app in place and is reported as one of the reasons in
  `update::Failure` (mirrored in `src/ipc.ts`); the page words the message.
- Release notes are shown as plain text, at most 5000 characters.

## Security and privacy

- CSP: `default-src 'self'`, plus `connect-src ipc: http://ipc.localhost` (required for fast IPC).
  The experimental `snipframe:` protocol and its CSP allowances are removed. No remote origins.
- Capabilities: `core:default` for `main`, `about` and `overlay-*`; in addition only
  `core:window:allow-set-size` for `main` and `about`, and `core:window:allow-close` for `about`. App commands are
  registered in `lib.rs`.
- Network access exists only in the updater (ADR-028), only after **Check for Updates…**, from
  Rust, to the fixed HTTPS endpoint and the release asset it names; no other code sends requests,
  and captures, annotations and file paths are never sent. Captured frames live only in memory
  (`CaptureState`) and are dropped when the capture ends. Only an explicit Save writes a file, to the path the user chose.
- The save dialog runs from Rust (`rfd`); the page cannot choose a path, and Rust accepts only a
  plain `*.png` suggested name.
- The permission UI opens only a fixed macOS System Settings URL via `NSWorkspace`, without a
  general URL-opening plugin. The About and main windows open only `open_link` targets: the
  fixed `https://snipvero.app` website (`bundle.homepage`), the source repository (`Cargo.toml`
  `repository`), its contributors page, and the
  bundled `LICENSE.txt` (ADR-024). Signing stays environment-controlled (ADR-011); no keychain changes.
  About's Contact link opens only the fixed `mailto:support@snipvero.app` in the default email
  application (ADR-032); it does not send a message or attach capture data.
