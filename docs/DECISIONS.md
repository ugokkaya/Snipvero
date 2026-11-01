# Architectural decisions

Lightweight ADRs. Newest last. Do not rewrite accepted entries: supersede them with a new one.

## ADR-001: Stack: Tauri 2, React + TypeScript, Rust, Konva.js

- **Status:** accepted (2026-10-29)
- **Context:** Cross-platform desktop app that must start fast and stay light in the background.
- **Decision:** Tauri 2 with the system webview. React/TS for UI. Konva.js (+ react-konva) for annotations,
  added with the annotation tools. Rust for lifecycle, tray, shortcuts, capture, clipboard and file output.
- **Consequences:** Much smaller footprint than Electron. Rendering differs slightly between WebKit
  and Chromium. Webview window creation latency must be handled (pre-warming overlays, ADR-013).

## ADR-002: Platform targets and identity

- **Status:** accepted (2026-10-29)
- **Decision:** Name **Snipvero**, identifier `com.snipvero.app`. macOS 14+ (enables
  `SCScreenshotManager`), Windows 10 1903+ and 11. Default shortcut `Cmd+Shift+2` / `Ctrl+Shift+2`.
  pnpm as package manager. MIT license.

## ADR-003: MVP scope and abstraction policy

- **Status:** accepted (2026-10-29)
- **Decision:** A working MVP comes first. No abstraction without a second real use. Platform-specific
  code only where necessary. Cross-monitor selection, launch at login and customization UI are out
  of the MVP. The 150 ms shortcut-to-overlay latency is an optimization target, not an MVP gate.

## ADR-004: Background app lifecycle

- **Status:** accepted (2026-10-29)
- **Decision:** On macOS, use `ActivationPolicy::Accessory` at runtime plus `LSUIElement` in `Info.plist`
  (no Dock icon). Closing the main window hides it. Only the tray Exit item quits. Implicit exit
  requests are prevented. `tauri-plugin-single-instance` (registered first) focuses the existing instance.
- **Alternatives:** A hidden main window at launch was rejected for now: on first run the user would
  see nothing. Revisit when onboarding exists.
- **Tray menu:** **Capture**, **Open Snipvero**, **Exit** (macOS label: "Quit Snipvero"). "Open Snipvero"
  was added because a hidden main window would otherwise only be reachable by relaunching the app.
  **About Snipvero** was added above Quit later (ADR-024).

## ADR-005: Minimal dependencies and tooling

- **Status:** accepted (2026-10-29)
- **Decision:** Rust: `tauri` (`tray-icon` feature) and `tauri-plugin-single-instance` only. No logging
  framework yet (`eprintln!` for the rare error path). Frontend: React, `@tauri-apps/api`. Dev:
  Vite, Vitest, ESLint (typescript-eslint strict), Prettier.
- **Note:** TypeScript is pinned to `~6.0` because typescript-eslint does not yet support TypeScript 7.

## ADR-006: Frame transport is decided by benchmark

- **Status:** superseded by ADR-007 (2026-10-29).
- **Context:** A 5K Retina frame is ~59 MB of RGBA. JSON IPC is not an option.
- **Options:** (a) Tauri binary IPC response (`ArrayBuffer`); (b) custom URI scheme (`snip://`) serving
  BMP or raw RGBA; (c) PNG-encoded bytes via either channel.
- **Decision criteria:** time from capture to first painted overlay on a 4K/5K display, peak memory,
  and implementation complexity. Prefer the simplest option that is fast enough.

## ADR-007: Frame transport: raw RGBA over Tauri IPC; no custom URI scheme

- **Status:** accepted (2026-10-29). Measured on macOS only.
- **Context:** the capture spike benchmarked seven methods on a release build (macOS 27.0.1, Apple Silicon,
  displays 3024×1964 @2× and 2× 1920×1080 @1×). Transfer + decode + draw of a 3024×1964 frame:
  raw RGBA over IPC 16 ms, BMP over IPC 41–45 ms, PNG over IPC 79–138 ms, BMP over a custom
  scheme 32 ms (1920×1080: 6–7, 12–15, 21–24 and 11–12 ms).
- **Decision:** Overlays load frames with `invoke("overlay_frame", { format: "rgba" })`, which returns
  `tauri::ipc::Response` raw bytes → `ImageData` → `createImageBitmap` → canvas.
  The experimental `snipframe://` scheme (BMP) stays in the temporary spike harness only and is
  not adopted. It was not faster than IPC and adds a protocol, CORS headers and canvas tainting.
- **Critical finding:** the CSP **must** allow Tauri's IPC protocol
  (`connect-src 'self' ipc: http://ipc.localhost`). With `default-src 'self'` alone, Tauri silently
  falls back to `postMessage` IPC. An 8 MB frame then took 159 ms instead of 5 ms.
- **Rejected:** PNG (encode 25–45 ms in Rust plus slower decode) and BMP (cheapest Rust encode,
  but slower WebKit decode than `ImageData`).
- **Dependency:** `png` 0.18 (MIT/Apache-2.0) was already in Tauri's tree. It is used by the benchmark
  now and will be used for PNG export. `serde` (MIT/Apache-2.0) is used for command payloads.

## ADR-008: Capture interface and backends

- **Status:** accepted for macOS (2026-10-29). Windows is investigated, **not implemented or tested**.
- **Interface** (`src-tauri/src/capture/mod.rs`): free functions `has_permission`,
  `request_permission` and `capture_displays() -> (Vec<Frame>, CaptureTimings)`. `Frame` has tightly packed BGRA8 pixels,
  logical display bounds and a scale factor. No trait, because there is only one implementation per OS
  (`#[cfg]` dispatch), per ADR-003. Non-macOS builds return `CaptureError::Unsupported`.
- **macOS:** ScreenCaptureKit via `objc2-screen-capture-kit` 0.3 (Zlib/MIT/Apache-2.0, same objc2
  0.3/0.6 stack Tauri already uses):
  - `SCShareableContent` enumerates the displays.
  - `SCContentFilter` per display excludes Snipvero's own windows.
  - `SCShareableContent.infoForFilter().pointPixelScale` gives the scale (macOS 14+).
  - `SCScreenshotManager.captureImage` returns a BGRA `CGImage`; all displays are captured concurrently.
  - Permission uses `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`.
  - **Display geometry comes from `SCDisplay.frame` (points), not Tauri's monitor API.** On mixed-DPI
    setups, Tauri's monitor positions mix units: for example, an external 1× display right of a
    1512-pt Retina panel reports x = 1512 "physical".
  - `captureImageInRect` (one call for all displays) needs macOS 15.2, above our macOS 14 minimum.
- **Windows options (not tested; to evaluate in a Windows spike):**
  - _GDI `BitBlt` per monitor:_ `EnumDisplayMonitors` plus a screen DC, with Per-Monitor-V2 DPI
    awareness for physical pixels, and `CAPTUREBLT` for layered windows. Simplest, works on every
    supported version; speed on large desktops is unknown. **Recommended first attempt.**
  - _DXGI Desktop Duplication:_ fast GPU path per output (Windows 8+). Needs D3D11 setup, must use
    the adapter that owns the output (hybrid-GPU laptops), and must handle rotation. Protected content is black.
  - _Windows.Graphics.Capture:_ modern API, `CreateForMonitor` (1903+). It is asynchronous and
    D3D-based. Windows 10 draws a yellow capture border; disabling it (`IsBorderRequired`) needs Windows 11.
  - All of these deliver physical pixels in virtual-screen coordinates, which can be negative.
    The `LogicalRect` semantics for Windows must be settled then.

## ADR-009: Overlay windows

- **Status:** accepted (2026-10-29). Verified on macOS only.
- **Decision:** one borderless, opaque, non-resizable webview window per display (`overlay-<index>`),
  created hidden after capture and shown when the page reports the frame is painted (`overlay_ready`).
  This avoids an empty flash. On macOS, `overlay/macos.rs` sets:
  - `NSScreenSaverWindowLevel`, because Tauri's `always_on_top` level sits below the menu bar;
  - collection behaviour `CanJoinAllSpaces | FullScreenAuxiliary | Stationary | IgnoresCycle`;
  - the exact frame, converted to Cocoa coordinates.

  The overlay on the display under the cursor (`CGEvent` location) gets keyboard focus. Escape on
  any overlay cancels all overlays and drops the frames.

- **Known cost:** windows are created cold for every capture: 255–346 ms from capture start to visible.
  Pre-warming hidden overlays is the main lever for the 150 ms target (NFR-4, an optimization target).

## ADR-010: macOS development signing and Screen Recording permission

- **Status:** accepted (2026-10-29); the deferred part is decided in ADR-011.
- **Context:** macOS ties the Screen Recording grant to the code signature. An ad-hoc build
  (`signingIdentity: "-"`, now set in `tauri.conf.json`) gets a new signature on every rebuild, so the
  grant stops applying (observed during the capture spike). Launching the binary from a terminal attributes the request
  to the terminal app instead.
- **Decision:** test capture from the bundled `.app`, launched via Finder or `open`. After each rebuild, run
  `tccutil reset ScreenCapture com.snipvero.app` and grant again. A stable self-signed "Snipvero Dev"
  signing certificate would remove this friction, but it modifies the developer's keychain.
  Deferred until the user decides.

## ADR-011: Stable local signing identity for macOS development

- **Status:** accepted (2026-10-29), with the user's approval. Supersedes the "deferred" part of ADR-010.
- **Decision:** local macOS builds that need Screen Recording are signed with a self-signed
  code-signing certificate, "Snipvero Local Development", stored in the developer's login keychain:
  - RSA 2048, valid 3 years, extended key usage `codeSigning` only;
  - **not** marked trusted; no admin rights or system trust settings were changed;
  - `codesign` was allowed to use the key once via the keychain "Always Allow" dialog.

  The identity is passed only through the environment:
  `APPLE_SIGNING_IDENTITY="Snipvero Local Development" pnpm tauri build --bundles app`.
  `tauri.conf.json` stays ad-hoc (`"-"`), so other contributors and CI are unaffected. No certificate
  or key is in the repository.

- **Effect (measured):** the signature requirement changed from `cdhash H"…"` (new on every build) to
  `identifier "com.snipvero.app" and certificate leaf = H"7dfd35fd…"`. The Screen Recording grant
  survived two rebuilds with no prompt.
- **Undo:** `security delete-identity -c "Snipvero Local Development"` and
  `tccutil reset ScreenCapture com.snipvero.app`.
- **Not for distribution:** public releases need a Developer ID certificate and notarization (ADR-020, RELEASE.md).

## ADR-012: Separate type-checking for Node-side config files

- **Status:** accepted (2026-10-29).
- **Context:** the first CI run failed on both runners: `tsc` could not find `process` in `vite.config.ts`.
  It had passed locally only because of an older `node_modules`; a fresh clone with `--frozen-lockfile` reproduced the failure.
- **Decision:** `tsconfig.json` checks only `src/` (browser code, `vite/client` types).
  `tsconfig.node.json` checks `vite.config.ts` and `eslint.config.js` with Node types.
  `pnpm typecheck` runs both.
- **Dependency:** `@types/node` ^24 (MIT, dev only). It provides Node types for the config files, and the browser code does not see them.

## ADR-013: Recycle pre-created overlays rather than retaining rendered pages

- **Status:** accepted (2026-10-30), macOS measurements only.
- **Experiment:** twenty capture/cancel cycles per strategy, on the same three-display setup as the capture spike.
  Raw RGBA IPC is unchanged. Timings end when Rust has called `show` on all windows, not at a
  measured physical screen refresh, and memory was sampled externally, so figures are indicative.
- **Decision:** pre-create hidden 1×1 overlay windows on macOS, destroy them after capture, then
  create fresh hidden replacements on a worker thread. Missing windows still have an on-demand path.
  Do not pre-create anything on Windows until there is a capture backend to use it.
- **Trade-off:** on-demand median 316 ms, retained pre-created pages 186 ms, recycled pre-created
  pages 236 ms. Fully reused pages retained about 281 MB total after two minutes idle, compared with
  75 MB for on-demand and 97 MB for recycling in the comparison runs. Memory varies between runs.
  The final recycled run measured 239 ms median; the 150 ms target is **not met**.
- **Memory investigation:** freed frame-sized allocations were absent from a `heap` inspection,
  but macOS malloc sometimes retained ~77 MB of dirty large-allocation pages. A trial of
  `malloc_zone_pressure_relief` released zero bytes and was reverted. No allocator workaround ships.
- **Cleanup:** remove the losing strategies, comparison flags, spike transfer encoders, benchmark UI,
  `spike.rs`, and the experimental custom protocol/CSP entries. Retain a Rust-only `--stress=N`
  diagnostic that uses the same capture and cancellation functions as the normal workflow.

## ADR-014: Global shortcut and focus restoration

- **Status:** accepted (2026-10-30).
- **Dependency:** `tauri-plugin-global-shortcut` 2 (MIT/Apache-2.0), the official cross-platform
  shortcut plugin; avoids separate native registration implementations. `png` is no longer a direct
  dependency because the overlay only needs raw pixels (reconsidered for export in ADR-018).
- **Decision:** register `CommandOrControl+Shift+2` at startup, respond only on press, and ignore
  duplicate triggers during an active capture. Keep the accelerator in a Rust constant and accept
  it as a registration argument, so future customization does not need a settings UI now.
  Show registration failure in the main window while preserving tray Capture.
- **Conflict limitation:** in a local experiment, macOS accepted Snipvero's registration even while
  a separate process held the same shortcut. Therefore registration success does not prove that
  the shortcut is exclusive. OS-reported errors are handled; reliable cross-app conflict detection
  is not claimed. The holder experiment is not a Windows runtime test.
- **Focus:** `NSWorkspace.frontmostApplication` supplies the prior macOS process ID before capture;
  after closing overlays, activate that `NSRunningApplication`, unless it was Snipvero itself.
  No Accessibility permission is required. Windows focus restoration remains unimplemented until
  its native capture workflow is available; compilation is covered by Windows CI only.

## ADR-015: Permission guidance without a general URL opener

- **Status:** accepted (2026-10-30).
- **Decision:** query capture support, shortcut status and Screen Recording permission from Rust.
  On missing permission, keep the existing preflight/request path and show numbered instructions,
  a fixed System Settings link (`Privacy_ScreenCapture` via `NSWorkspace.openURL`) and a restart button.
  Refresh status when the main window regains focus. No opener/shell dependency or arbitrary URL command.
- **Verification:** existing permission survived signed rebuilds. The user declined permission
  revocation/regrant testing, so opening the new settings link, restart behaviour and permission
  regrant without restarting remain **unverified**, not prerequisites assumed to work.

## ADR-016: Region selection in the overlay page, in frame pixels

- **Status:** accepted (2026-10-30). Verified on macOS only.
- **Decision:** selection interaction runs entirely in each overlay's webview, as a pure reducer
  (`src/overlay/selection.ts`) driven by pointer events. No IPC while the mouse moves. Rust hears
  about a selection twice per gesture at most: when a new selection is first dragged (to take
  ownership) and when a region is finalized (`overlay_select`).
- **Coordinates:** the model works in the captured frame's integer physical pixels, frame-local.
  `src/overlay/coords.ts` is the only place that converts pointer CSS pixels to frame pixels and back,
  using the per-axis frame/window size ratio of that display. The exported region therefore needs
  no further conversion for cropping (export), and no global scale factor is assumed. Rust validates it
  (`PixelRect::fits`) and can map it to desktop points (`PixelRect::to_logical`).
- **One selection per session:** `Session.selection` records which overlay owns it. A new owner
  causes an `overlay-selection-cleared` event to the previous one. Cross-monitor selection stays out
  of scope (ADR-003).
- **Behaviour choices:** a press-release within 3 CSS px is a click and creates nothing (a click
  outside a selection keeps it); edges flip when dragged past each other; a resize to zero size restores
  the previous region; moving shifts but never shrinks the selection at monitor edges.
- **Rendering:** DOM elements above the untouched frame canvas (border via `outline`, dimming via a large
  `box-shadow`), no canvas redraw per move. Drawn elements ignore pointer events; hit testing is in the model.
- **Native:** overlay windows set `accept_first_mouse(true)` (Tauri builder option, no new dependency),
  so the first press on another display starts a selection instead of only focusing it.
- **Dependencies:** none added.

## ADR-017: Annotations in the overlay page, pinned to the screenshot, drawn with Konva

- **Status:** accepted (2026-10-30). Verified on macOS only.
- **Dependencies:** `konva` 10 and `react-konva` 19 (both MIT; react-konva brings `react-reconciler`,
  `scheduler`, `its-fine`, all MIT), as planned in ADR-001: a maintained canvas scene graph for
  sharp HiDPI drawing now and rasterization at physical resolution for export. Only `konva/lib/Core` and
  the Line, Rect and Text shapes are imported, and the annotation layer is a lazily loaded chunk
  (≈264 kB, 82 kB gzip). The main bundle grew from 249 kB to 266 kB.
- **Decision:** annotation state is three pure reducers (`selection.ts`, `annotate.ts`, `editor.ts`)
  with plain serializable annotation objects; React and Konva only render. No IPC while drawing;
  Rust is unchanged and still only records the region.
- **Coordinates:** frame physical pixels relative to the region's top-left corner. Annotations are
  pinned to the frozen screenshot (user decision): moving, resizing or replacing the region rebases
  them (whole history) so they stay on the same pixels; anything outside the region is clipped,
  not deleted. Rejected: annotations travelling with the region (they would no longer match the
  pixels they point at).
- **Interaction choices (user decisions):** a drag outside the region with a drawing tool still
  starts a new selection and keeps the annotations; the first Escape while editing text finishes the
  edit, the next one cancels the capture. A Select/move tool is the default, so the region behaviour (drag
  inside moves the region) is unchanged until a drawing tool is chosen; clicking the active tool
  again returns to it. The selected annotation's handles win over the region's handles.
- **Text editing** uses a native `<textarea>` overlay rather than Konva text editing, for IME,
  dead keys and Unicode. Arrow heads are computed geometry, not Konva's `Arrow`.

## ADR-018: Export composed in Rust from the held frame, annotations rasterized by the page

- **Status:** accepted (2026-10-30). Verified on macOS only; Windows compiles and passes CI only.
- **Pipeline (one for clipboard and PNG):** the overlay page rasterizes only the annotations, with
  the same Konva shape configurations as the preview (`shapes.ts`), into a straight-alpha RGBA layer
  exactly the region's pixel size (a detached Konva group, `toCanvas` at pixel ratio 1: no stage, so
  no device-pixel-ratio or hit buffers). It is sent as a raw IPC body, with session and region in
  `x-snipvero-*` headers. Rust validates the session, the region against the frame (`PixelRect::fits`)
  and the layer length (exactly width × height × 4, or empty without annotations), crops the frame
  it still holds, blends the layer source-over and forces alpha to 255 (the capture is opaque).
  - The screenshot never travels back over IPC, nothing is base64, and no intermediate file exists;
    the region is already in frame pixels (ADR-016), so Retina, mixed and fractional scales need no
    conversion. The payload is bounded by the frame size and skipped entirely without annotations.
  - **Rejected:** composing the whole image in the page (the frame would have to be redrawn through
    a canvas and sent back, 24 MB for a Retina display, and canvas colour handling could alter
    screenshot pixels); rendering annotations in Rust (needs a font rasterizer and font files, and
    text would not match the webview's preview).
- **One export at a time:** `Session.exporting` rejects a second request (Rust), and the page's
  exporter ignores repeats while one runs; held keys do not repeat. The export takes the selection
  (the page may export before its last `overlay_select` arrived). Success closes the overlays
  through the same `overlay::close` as Escape, which ends the session and restores focus.
- **Save dialog:** `rfd` 0.17 (MIT), without default features (they only select Linux backends).
  It is the library Tauri's dialog plugin wraps; using it directly avoids that plugin's
  `tauri-plugin-fs` dependency and frontend permissions, since only Rust opens the dialog. The
  dialog is owned by the requesting overlay (a sheet on that display on macOS). **Finding:** AppKit
  runs the panel at the modal-panel level, so it first appeared behind the overlays
  (`NSScreenSaverWindowLevel`), and Escape then left a black screen until Quit. Fix: while the
  dialog is open, the overlays step down to `NSNormalWindowLevel` and return afterwards.
- **Clipboard:** macOS writes one `NSPasteboardItem` with PNG and TIFF data directly through
  objc2-app-kit (already a dependency; features added), so no crate is added there. Windows uses
  `arboard` 3 (MIT/Apache-2.0; CF_DIBV5 plus a registered "PNG" format), a target-only dependency,
  because a hand-written Win32 clipboard could not be tested without a Windows machine. arboard is
  not used on macOS, where its image support would also pull in the `image` crate with TIFF decoding.
- **PNG:** `png` 0.18 (MIT/Apache-2.0) becomes a direct dependency again; it was already in Tauri's
  tree (ADR-007, ADR-014). 8-bit RGBA, `Fast` compression for the clipboard, `Balanced` for files.
- **File name:** the page suggests `Snipvero-YYYY-MM-DD-HHMMSS.png` in local time (Rust's standard
  library has no time zones, and a time crate is not worth it); Rust accepts only a plain ASCII
  `*.png` name, never a path.

## ADR-019: Session-scoped capture lifecycle with recovery paths

- **Status:** accepted (2026-10-31). Verified on macOS only; Windows compiles and passes CI only.
- **Context (stabilization review and measurements):** every end of a capture called one unconditional
  `overlay::close`, so a late request (a failing page of an ended capture, an export finishing
  after Escape) could close a newer capture. A capture whose overlays never reported ready, or
  that found no display, stayed busy and invisible until Snipvero was restarted. Escape on another
  display could destroy the overlay that carries the save panel's sheet. AppKit objects of each
  clipboard copy stayed alive on the long-lived async runtime threads (main process +8 MB per
  Retina copy in 20 measured cycles, released only when the thread exited).
- **Decision:**
  - `overlay::close(app, session)` ends only the named capture and is a no-op otherwise;
    `overlay_cancel` takes the page's session and returns whether it closed. Readiness is
    recorded per overlay, not counted.
  - A watchdog ends a capture whose overlays are not all shown after 8 s, with an error in the
    main window. Capturing no display is an error, not an empty session.
  - Escape is refused while an export runs (`Session.exporting`); the save panel handles its own
    Escape.
  - On `NSApplicationDidChangeScreenParametersNotification` a capture ends, but only if the
    display bounds really differ from the captured ones: AppKit posted the notification once
    during stress runs without any display change. Not during an export.
  - Request validation completes before the export lock is taken. PNG files are written to a
    hidden sibling and renamed over the target, so a failed write leaves neither a truncated file
    nor a destroyed original. The macOS clipboard code runs in its own autorelease pool.
- **Dependencies:** none added; objc2-foundation features `block2`, `NSNotification`,
  `NSOperation` and objc2-app-kit `NSApplication` (same crates).
- **Developer harness:** `--stress-export=N` runs the Rust export path (lock, composition,
  PNG + TIFF) onto a private, released `NSPasteboard`, so the user's clipboard is not touched.
  It does not include the page's annotation rasterization.

## ADR-020: macOS beta packaging, version scheme and icons

- **Status:** accepted (2026-10-31). Verified on macOS only. The `CFBundleShortVersionString`
  part of **Version** is superseded by ADR-022.
- **Scope (user decision):** macOS is the only platform of the beta; Windows stays in CI (NSIS
  smoke bundle) and is presented as planned. Public text describes Snipvero on its own terms,
  without comparisons with other tools.
- **Version:** `0.1.0-beta.1` in `package.json`, `Cargo.toml` and `tauri.conf.json`, enforced
  equal by a Rust test. `CFBundleShortVersionString` carries the SemVer string; `CFBundleVersion`
  is a separate integer build number (`bundle.macOS.bundleVersion`), because Apple expects
  integers there and a pre-release suffix would otherwise end up in it.
- **Icons:** SVG sources in `src-tauri/icons/source/`, rasterized by `tauri icon` (no new tool).
  The app icon follows the macOS grid (824 px body in 1024 px) instead of the earlier full-bleed
  placeholder. The macOS menu bar uses a black-and-alpha **template image** with
  `icon_as_template(true)`, so macOS adapts it to light, dark and highlighted menu bars (blocker 1
  of the initial scaffold). Windows keeps the coloured app icon.
- **Decoding:** the template PNG is decoded with the `png` crate, already a direct dependency
  (ADR-018), instead of Tauri's `image-png` feature, which would add the `image` crate.
- **Packaging:** `app` and `dmg` bundles; CI's macOS smoke bundle now also builds the DMG.
  `signingIdentity` stays ad hoc (`"-"`); a Developer ID identity and notarization credentials are
  passed only through the environment (as in ADR-011). No entitlements: the app is not sandboxed and
  needs no JIT or other hardened-runtime exceptions. Requirements are in `docs/RELEASE.md`.
- **Dependencies:** none added.

## ADR-021: Third-party license policy and bundled notices

- **Status:** accepted (2026-10-31). Generated and checked on macOS; the file also covers the
  Windows crate set.
- **Context:** most licenses of the 278 Rust crates and 10 npm packages in the shipped code require
  their copyright and license text to accompany binary copies (RELEASE.md). Nothing enforced
  the AGENTS.md license policy either.
- **Decision:** `scripts/third-party-notices.mjs` generates `THIRD_PARTY_NOTICES.txt`, committed at
  the repository root and copied into `Snipvero.app/Contents/Resources/` together with `LICENSE`
  (`bundle.resources`). CI's macOS job runs `pnpm notices:check`, which fails on a stale file, a
  missing license text or a license outside the policy.
  - **Scope:** normal (not build or dev) dependencies of `snipvero` for `aarch64-apple-darwin`,
    `x86_64-apple-darwin` and `x86_64-pc-windows-msvc`, from `cargo metadata`; npm packages whose
    modules are in a production Vite build, including Vite's and Rolldown's injected helpers; the
    Rust standard library. Not included: build tools, type packages, macOS system frameworks
    (WebKit, AppKit, ScreenCaptureKit), which are not shipped.
  - **Policy:** an SPDX alternative must consist only of MIT, MIT-0, Apache-2.0 (also with
    LLVM-exception), BSD-2-Clause, BSD-3-Clause, ISC, Zlib, 0BSD, BSL-1.0, CC0-1.0, Unlicense,
    Unicode-3.0, Unicode-DFS-2016 or MPL-2.0 (unmodified use). Beyond the AGENTS.md list, only
    Unicode-3.0 (ICU4X crates, `unicode-ident`) has no alternative in the current tree; BSL-1.0
    is Windows-only (`clipboard-win`), and the others appear only as alternatives.
  - **Choice of license:** for `OR` expressions the notices name the alternative used, preferring
    the shortest obligations (MIT first) among those whose text the package ships, and include
    only that text plus license-neutral files (NOTICE, COPYRIGHT). A file is attributed by its name
    or, failing that, its text; when that is unclear, every file is kept.
  - **Packages without license files** (objc2 family, `alloc-stdlib`, `selectors`, the Windows
    `webview2-com` and `clipboard-win` crates) use texts from their source repositories in
    `scripts/licenses/`, with sources recorded there.
  - **MPL-2.0** (`selectors`, `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, via
    Tauri) is used unmodified; the notices name each component's source repository.
- **Rejected:** `cargo-about`/`cargo-deny` and an npm license tool: a new tool per contributor and
  in CI, while Cargo's metadata and Vite's module graph already give the exact sets. `pnpm licenses`
  lists type-only and other packages that are not bundled.
- **Noted:** the objc2 project remarks that its bindings derive from Apple SDK headers and that the
  Xcode license's view of this is unclear; every macOS app built with Xcode is in the same
  position, so it is recorded, not treated as a blocker.
- **Dependencies:** none added.

## ADR-022: Apple bundle versions and Apple silicon-only beta

- **Status:** accepted (2026-10-31). Verified on macOS only. Supersedes the
  `CFBundleShortVersionString` part of ADR-020.
- **Context:** Apple defines `CFBundleShortVersionString` and `CFBundleVersion` as one to three
  period-separated integers. The first beta packaging built `CFBundleShortVersionString` `0.1.0-beta.1`, outside that
  format. Tauri copies the package version into that key and has no separate setting for it.
- **Decision:**
  - The package version stays SemVer with the beta identifier (`0.1.0-beta.1`): manifests, Git
    tag `v0.1.0-beta.1`, DMG and installer names, GitHub Release.
  - `src-tauri/Info.plist` sets `CFBundleShortVersionString` to the version without its
    pre-release suffix (`0.1.0`). Tauri's bundler merges this file over its generated keys
    (checked in the tauri-cli 2.12.4 source and in the built bundle). A Rust test keeps it equal
    to the package version's core and checks both values' format.
  - `CFBundleVersion` remains the integer build number `bundle.macOS.bundleVersion`, increased for
    every published build, so betas and the final release of one version stay ordered.
  - **Apple silicon only:** the beta ships one `aarch64` DMG. Intel was never built or tested, and
    the README claimed an `x64` download that did not exist. A universal build is the documented
    path once an Intel Mac is available for testing.
- **Verification:** `scripts/verify-macos-bundle.mjs` checks the built app and the app inside the
  DMG (plist values, file list, architectures, `minos`, system-only libraries, signature, hardened
  runtime, no entitlements, DMG contents), and with `--distribution` the Developer ID signature,
  timestamp, stapled tickets and Gatekeeper. CI runs it on the debug bundle.
- **Dependencies:** none added.

## ADR-023: Progress log is local, not part of the repository

- **Status:** accepted (2026-10-31), user decision, in preparation for a public repository.
- **Context:** `docs/PROGRESS.md` was a running session log for hand-offs between contributors and
  coding agents: work notes, local measurements, machine details and QA status. It is useful
  while working but is not documentation for users or outside contributors.
- **Decision:** `docs/PROGRESS.md` is ignored by Git and kept only in local checkouts. Lasting
  content goes into tracked documents: decisions and their measurements here, requirements in
  `REQUIREMENTS.md`, build and release steps in `README.md`, `CONTRIBUTING.md` and `RELEASE.md`,
  working rules in `AGENTS.md`. Nothing in the build, tests or CI reads the file.
- **Consequence:** the public history starts from a single snapshot commit; earlier development
  history is not part of the public repository.

## ADR-024: Main window, About window and fixed external links

- **Status:** accepted (2026-10-31). Built and unit-tested on macOS (Apple silicon); Windows only
  through CI. Both windows were checked in the running release app in the dark appearance
  (window captures), and in a browser with mocked IPC in light and dark; no manual QA (user
  decision).
- **Context:** the main window was a page of text with much empty space; there was no About
  information in the app and no way to start a capture from the window.
- **Decision:**
  - **Main window:** header (icon, name, subtitle, version), a **Capture Region** button with the
    registered shortcut, three feature cards, status rows (menu bar, Screen Recording permission,
    global shortcut) and a footer with the version, About and GitHub. The button calls the
    `start_capture` command, which runs `overlay::start` on the main thread, the same path as the
    tray and the shortcut. Status shows "Checking…" until Rust answers; nothing is assumed. The
    main and About windows size their height to their content (`useFitWindow`,
    `core:window:allow-set-size` for those two windows), so the permission guidance appearing or
    going away neither scrolls nor leaves empty space. A single `setSize` is not enough: on macOS
    27 the requested height includes the title bar (About: 412 pt requested, 413 pt window frame,
    the footer of the main window cut off by about 28 pt in the first build), and concurrent
    requests could land out of order. `fit.ts` therefore runs one request at a time, asks first for
    the content height, corrects the last request by what is still missing after each native
    resize, and gives up after four corrections per content height.
  - **About window:** a separate small window (label `about`) in the style of a Mac About panel,
    created on demand and destroyed on close, because it is rarely open and a hidden web view would
    keep its memory. One function, `about::show`, serves the tray and the main window and runs on
    the main thread, so two requests cannot create two windows; an existing one is focused. It
    shows the developer name given by the maintainer but no email address or other contact
    details; contributors are credited through GitHub's contributor page, not a list in the app.
  - **Metadata from Rust:** the `app_info` command returns name and version from
    `tauri.conf.json` (`PackageInfo`), the project page from `Cargo.toml` (`repository`, read with
    `CARGO_PKG_REPOSITORY`), its contributors page, and the copyright `© 2026 Snipvero
Contributors`. Tauri does not embed `bundle.homepage` or `bundle.copyright` in the app binary
    (absent from the release build), so the first version of this window, which read them at
    runtime, showed no links; tests now keep `tauri.conf.json` equal to the Rust values. The
    version is never written in the frontend.
  - **Fixed links, no opener plugin (extends ADR-015):** `open_link` takes an enum (`repository`,
    `contributors`, `license`). Rust derives the web addresses from the project page, accepts only
    `https`, and opens them with `NSWorkspace`; `license` opens the bundled `LICENSE.txt`. Links in
    the page keep their real `href` for display but never navigate the web view. The app itself
    still makes no network requests; the browser opens the page after an explicit click. Not
    implemented on Windows yet (returns an error).
  - **Theme:** colour tokens on `:root` with a `prefers-color-scheme: dark` set; the main and
    About windows use only tokens. Indigo accent from the app icon (`#4f46e5` light, `#6366f1`
    dark).
- **Dependencies:** `happy-dom` (MIT), dev only: a DOM for Vitest so the main and About windows
  are tested by clicking them (React's `act`, no testing library). Its runtime dependencies are MIT
  or BSD-2-Clause; it is not part of the app or `THIRD_PARTY_NOTICES.txt`.
- **Verification:** Vitest (main window: metadata, Capture Region, permission states, shortcut,
  About, GitHub link; About: content, no email, links, Escape; window routing; theme tokens),
  Rust tests (tray menu order and About action, close policy, capabilities for every window, link
  derivation, the project page and copyright equal to `tauri.conf.json`). Release `.app` and DMG
  built, `pnpm verify:macos` passed, and the release binary contains the project page. Window
  fitting (`fit.test.ts`) is tested with and without a title bar in the requested size. Running
  app (macOS 27, dark): main window 520 × 504 pt frame with the footer and GitHub link visible and
  no scroll bar; About window 360 × 420 pt with all rows visible. Not verified: clicking the tray
  **About Snipvero** item and the links in the running app, and the light appearance there.

## ADR-025: First beta published ad hoc, without Developer ID or notarization

- **Status:** accepted (2026-10-31), user decision. Built and verified on macOS (Apple silicon)
  only; the Gatekeeper flow of a downloaded copy was not tried on another Mac.
- **Context:** RELEASE.md made a Developer ID signature with notarization the only publishable
  build. The project has no Apple Developer Program membership, so no Developer ID certificate or
  notarization credentials exist, and building from source was the only way to install Snipvero.
- **Decision:** `0.1.0-beta.1` is published as a GitHub **pre-release** with the release-profile,
  ad-hoc signed `Snipvero_0.1.0-beta.1_aarch64.dmg` (Apple silicon, macOS 14+) and
  `SHA256SUMS.txt`. It must pass `pnpm verify:macos` (not `--distribution`). The release notes and
  README state that it is not signed with a Developer ID and not notarized, describe Gatekeeper's
  **Open Anyway** step in System Settings → Privacy & Security, and never suggest disabling
  Gatekeeper or removing the quarantine attribute. No Windows asset is published.
- **Consequences:** macOS blocks the first launch until the user approves it. The Screen Recording
  grant is tied to the ad-hoc signature of this build; a later Developer ID build needs the
  permission granted again once (RELEASE.md §6). Once a Developer ID exists, ADR-020's path
  (Developer ID, notarization, `--distribution`) applies again and this exception ends.
- **Dependencies:** none added.

## ADR-026: Exclusive temporary file for saves; minimatch override

- **Status:** accepted (2026-10-31). Verified on macOS (Apple silicon) only; the Windows path is
  compiled in CI but its behaviour was not tried.
- **Context:** A security review found that the save sibling `.<name>.snipvero-partial` was
  predictable and opened with `std::fs::write`: a symlink planted under that name by anyone able
  to write to the folder redirected the PNG over another file. Replacing a mode-0600 file also
  left a 0644 file (umask default), widening access to the screenshot. `pnpm audit` reported
  GHSA-g3hv-75wg-m249 (ReDoS) in minimatch 10.2.6, pulled in by ESLint and typescript-eslint
  (dev only); the fix exists only in 11.0.1+.
- **Decision:** `write_replacing` creates the sibling with `create_new` (`O_EXCL`, which fails on
  an existing entry including a symlink) under a per-process, per-call name, retrying on a taken
  name. On Unix, a replaced regular file's permission bits are given to the sibling at creation;
  new files keep the umask default. `pnpm-workspace.yaml` overrides `minimatch@10` to `^11.0.3`
  until ESLint requires 11; lint and tests pass with it.
- **Consequences:** Regression tests cover the planted symlink, a 0600 replacement and a taken
  name. Owner, ACLs and extended attributes of a replaced file are still not carried over.
- **Dependencies:** none added (minimatch only moves a major version in dev tooling).

## ADR-027: Distribution signing keys stay on the Mac

- **Status:** accepted (2026-11-01), maintainer constraint. Developer ID app and DMG notarization,
  stapling and Gatekeeper acceptance verified on macOS Apple silicon. No Windows runtime test.
- **Context:** Developer ID Application is now available. The maintainer prohibits uploading Apple
  certificates and private keys to GitHub, requires successful local notarization before preparing
  release automation, and requires approval before commit, push or any release creation.
- **Decision:** retain ad-hoc contributor/CI builds and environment-controlled signing (ADR-011).
  Set hardened runtime explicitly; add no entitlements or runtime exceptions. Use a local Keychain
  notary profile, require `Accepted` for the app ZIP and final DMG, staple the app before DMG
  creation, then require the distribution verifier with the expected Team ID. A process exit alone
  is not proof of notarization success. A failed, timed-out or pending submission blocks release.
- **Automation boundary:** no `.p12`/`.p8` GitHub secrets or keychain export. Signing automation
  requires a separately approved, dedicated self-hosted Mac and protected manual workflow; hosted
  runners may publish only verified public artifacts. Untrusted PRs must never run on the signing
  runner. The Mac's local Keychain contains the secrets; GitHub needs only non-secret configuration
  variables and the built-in publication token. Runner isolation limits are documented in RELEASE.md.
- **Verification:** Developer ID app has hardened runtime and no entitlements; DMG signature has
  a secure timestamp. `verify:macos` passes. Before notarization, `--distribution --team-id` correctly
  fails six ticket/Gatekeeper checks. The verifier now also validates the DMG signature, timestamp
  and optional expected Team ID for both app copies and DMG. After Apple acceptance, all distribution
  checks pass. Stapling adds `Contents/CodeResources`; it is allowed only with successful Apple
  ticket validation, without relaxing the rest of the exact bundle file list.
- **Implementation:** manual-only opt-in GitHub workflow, default artifact-only, dedicated local
  signing runner and separate hosted/approved publication job. Shared notarization script fails
  closed on all non-Accepted statuses, preserves submission IDs, never rebuilds/re-signs the stapled
  app, creates candidates without overwriting and exports only verified public files. Unit tests
  cover status/config gates and a version/checksum-pinned Apple silicon/macOS 14+ Homebrew cask.
  No remote workflow, runner setup, tap push or publication was performed during implementation.
- **Dependencies:** none added. The published ad-hoc `v0.1.0-beta.1` remains unchanged; use a new
  package version and bundle build number for a future notarized release, not replacement assets.

## ADR-028: User-initiated, signed in-app updates over HTTPS

- **Status:** accepted (2026-11-01), maintainer decision. Supersedes NFR-2's "no network access"
  and ADR-024's statement that the app makes no network requests. Implemented and unit-tested on
  macOS (Apple silicon); the real install path is covered by a local test procedure (RELEASE.md
  §11). Windows builds compile the code but never
  offer an update.
- **Context:** installed betas could only be updated by downloading a new DMG by hand. The
  maintainer asked for an in-app update path built on Tauri's official updater, without automatic
  or background checks, with explicit consent before anything is downloaded or installed, and
  without weakening the privacy policy beyond what an update check needs.
- **Decision:**
  - **Trigger:** only a click on **Check for Updates…** starts network access: in the main
    window's **Updates** status row, the About window, or the menu bar item (which shows the main
    window and starts the check in its row). No check at launch, in the background or on a timer.
    The main window placement was the maintainer's choice after the first manual test found the
    About-only button too hidden. A later automatic check would be a separate,
    opt-in setting. Downloading and installing start only after **Download and Restart**, whose
    text says that Snipvero quits and reopens.
  - **Mechanism:** `tauri-plugin-updater` 2.14.1, driven from Rust (`src-tauri/src/update.rs`).
    The page calls three Snipvero commands (`update_check`, `update_install`, `update_cancel`),
    accepted only from the main and About windows (never the capture overlays), with one download
    or install at a time across both; no capability grants an `updater:` permission, because
    the plugin's JavaScript API accepts proxies, headers and targets. The endpoint and public key
    are fixed in `tauri.conf.json`; the page passes neither. Its check timeout is 30 s; the
    client is HTTPS-only (also across redirects), with connect and idle timeouts.
  - **Verification:** the plugin checks the package's minisign signature against the embedded
    public key and, with `requireSignedVersion`, that the signature was made for the announced
    version, so a tampered manifest cannot pair a new version number with an older genuine
    package. Since no earlier release has an updater, this applies from the first one. A version
    is an update only if newer by SemVer precedence (`cmp_precedence`; build metadata does not
    count, and release versions may not carry it); downgrades are never offered. The manifest
    lists only `darwin-aarch64`; any other platform gets "not available for your Mac".
  - **Install safety:** refused while a capture (including an export) is open; the install takes
    the capture lock, so no capture can start until the app restarts. Refused from a disk image,
    a translocated copy or anything but a `.app` bundle. The plugin swaps the bundle in one step
    (`renamex_np(RENAME_SWAP)` on APFS) and restores the previous app on failure; where the folder
    is not writable it uses macOS's own administrator prompt (AppleScript `with administrator
privileges`), and Snipvero never sees a password. After a successful install the app restarts
    through `AppHandle::request_restart`. Closing the About window cancels a download started there.
  - **Packages:** macOS updates are `Snipvero_<version>_aarch64.app.tar.gz` plus a `.sig`, not the
    DMG (Tauri updater documentation). `createUpdaterArtifacts` stays unset: it would need the
    private key during every `tauri build` (CI included) and would archive the app before
    notarization. `scripts/notarize-macos.mjs` archives the **stapled** app (no AppleDouble files
    or extended attributes), signs it with `tauri signer sign --app-version`, verifies the
    signature in Node (Ed25519 and BLAKE2b-512 from `node:crypto`) and writes the manifest.
    `verify-macos-bundle.mjs --updater` extracts the package, runs every app check on it and
    requires it to be byte-identical (files, modes, links) to the verified app.
  - **Keys:** the updater key is a minisign (Ed25519) key, separate from the Apple Developer ID
    certificate: Apple's signature makes macOS trust the app; the updater key makes the installed
    app trust a package. Only the public key is in the app. The private key stays an encrypted
    file outside the repository, its password in the login Keychain; neither goes into GitHub
    secrets, the build environment or logs (RELEASE.md §6a). The maintainer generated it on
    2026-11-01 (key ID `F4466B8E6A74D65F`). A build without a public key reports updates as
    unavailable, and the release script and `verify:macos --distribution` refuse it.
  - **Channel:** the endpoint is compiled in per channel. Pre-release versions use
    `https://raw.githubusercontent.com/ugokkaya/Snipvero/main/updater/beta.json`, a file in this
    repository, changed by one reviewed commit after the release is public and its assets were
    re-downloaded and verified. A failed or partial publication leaves the previous manifest in
    place. The manifest points only at immutable versioned release assets. GitHub's
    `/releases/latest` is not used (it ignores pre-releases). Moving beta users to a stable
    channel is a future, explicit decision, not something a manifest can do silently.
  - **Privacy:** requests go to `raw.githubusercontent.com` (manifest) and `github.com`, which
    redirects release downloads to `release-assets.githubusercontent.com`. They carry no version
    or other variable in the URL, no cookies or identifiers, and the User-Agent
    `tauri-plugin-updater/<version>`; GitHub sees the IP address, User-Agent, time and TLS
    connection data. No screenshot, annotation, file path or account data is sent; captures stay
    local. The web view's CSP is unchanged: the requests come from Rust.
- **Rejected:** the plugin's JavaScript API (wider surface than needed); `native-tls` (41 instead
  of 47 new crates, but macOS's deprecated Secure Transport without TLS 1.3); the plugin's
  `system-proxy` feature (left out to keep the dependency set small; proxy-only networks cannot
  check for updates, a documented limitation); a mutable "latest" GitHub release asset as the
  manifest (replacing an asset is not atomic); a self-written update engine.
- **Dependencies:** `tauri-plugin-updater` 2.14.1 (MIT OR Apache-2.0) with `rustls-tls` only.
  It adds 47 crates on macOS, all within ADR-021's policy, among them reqwest, hyper, rustls,
  `rustls-platform-verifier` (the macOS trust store), ring (Apache-2.0 AND ISC), subtle
  (BSD-3-Clause), minisign-verify, tar and osakit. `semver` and `serde_json` become direct
  dependencies; both were already in the tree (`tauri::generate_context!` needs `serde_json` once
  the configuration has a `plugins` section). Tauri's `test` feature (no crates) for the updater
  tests, dev only. Release executable 4.55 MB → 6.21 MB, DMG 2.67 MB → 3.12 MB (beta.2 → beta.3
  ad-hoc build).
- **Migration:** `v0.1.0-beta.2` has no updater, so the first updater-enabled version must be
  installed manually once from its DMG. Earlier releases, tags and assets are not changed. The
  Screen Recording grant is expected to survive updates, because the identifier and Developer ID
  team stay the same (to be confirmed in the first real update).
- **Verification:** Rust tests run the real plugin with Snipvero's comparator on Tauri's mock
  runtime with test-only fixtures (newer, same, older and build-metadata versions, wrong
  architecture, malformed manifests, corrupted package, another key, a package signed for another
  version, a malformed signature), plus the version order, error classification, install
  location, capture/install exclusion, the fixed configuration and the absence of updater
  permissions. Node tests cover signature verification, manifest validation, channel, key path
  and release configuration. Vitest covers the About window's update states and that nothing is
  requested or installed without a click. On macOS 27 (Apple silicon), with the local test builds
  of RELEASE.md §11: the plugin's bundle swap on APFS refused a corrupted package without touching
  the installed copy and replaced it with the genuine package (valid signature, new version, no
  leftovers), and `verify-macos-bundle.mjs --updater` accepted the genuine package and rejected a
  modified app, another key's signature and a mismatched manifest, and rejected the test build
  itself. The maintainer subsequently verified the local test-build UI scenarios, main-window
  row, menu-bar entry and install/restart on macOS Apple silicon. The production beta.3 candidate
  passed Developer ID signing, notarization/stapling, Gatekeeper, signed-version verification and
  byte-identical DMG/updater app checks. Not verified: the administrator prompt, a clean-Mac
  quarantined first launch and an update between two published releases.

## ADR-029: Common Controls v6 manifest in Windows test executables

- **Status:** verified (2026-11-01): CI runs `41301374338` (PR #3) and `41301846772`
  (merged main) pass on macOS and Windows, including tests and bundle smoke checks. Windows
  runtime support remains unimplemented/unverified.
- **Context:** updater PR #2 introduced tests using Tauri's MockRuntime. Windows CI run
  `41300382553` compiled the test program but it exited before any test with
  `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`). Tauri's upstream issue
  [#13419](https://github.com/tauri-apps/tauri/issues/13419) documents this exact failure:
  MockRuntime links the Common Controls v6 API `TaskDialogIndirect`, while a test executable
  without an assembly manifest resolves the legacy `comctl32.dll`, which lacks that export.
  The installed tauri-build 2.7.4 / tauri-winres 0.3.7 sources confirm that the manifest resource
  is linked only into app binaries, not the library unit-test executable. The failing Snipvero
  executable's imports have not been inspected directly; upstream diagnosis is the basis for
  this fix and a successful Windows CI run is still required.
- **Decision:** on Windows/MSVC targets only, `build.rs` disables tauri-build's app-manifest
  resource and embeds the equivalent Common Controls v6 manifest through unscoped
  `/MANIFEST:EMBED` and `/MANIFESTINPUT` linker flags. These cover the app and the lib unit-test
  executable; `rustc-link-arg-tests` alone would not cover lib unit tests. `/WX` fails on linker
  warnings rather than accepting a skipped/conflicting manifest. The target is determined from
  Cargo's target environment, not the build host. Other targets keep Tauri's default build path.
- **Scope:** no new dependencies, test exclusions, runner configuration, privileges or Windows
  release support. The XML matches tauri-build 2.7.4's minimal default dependency; icon/version
  resources still come from Tauri. Do not disable Common Controls support to hide the failure.
- **Verification:** a manifest-policy test checks the v6 dependency and absence of elevation or
  compatibility changes; the existing real-plugin MockRuntime tests are the Windows loader
  regression test. Windows packaging remains a CI smoke test, not a Windows runtime-support claim.

## ADR-030: Customizable capture shortcut and a local settings file

- **Status:** implemented (2026-11-01). Unit tests and the maintainer's manual QA of the local
  signed build passed on macOS (Apple silicon): change, rejection, cancel, reset and restart.
  Command+Print Screen never reached the recorder: the system (or keyboard software mapping
  that key to a screenshot combination) takes it first, which no app can prevent. Windows:
  compile, lint and unit tests in CI only.
- **Context:** the capture shortcut was a fixed constant (ADR-014), and the README told users whose
  `Cmd+Shift+2` is taken by another app to use the menu bar instead. ADR-014 already passed the
  accelerator to `register`, so changing it needs a store and a recorder, not a new registration path.
- **Decision:** the main window's **Global shortcut** row gets **Change…** and, for a custom
  shortcut, **Reset to** the default. No separate settings window yet (ADR-003: no abstraction
  without a second real use). Only the global capture shortcut is customizable; the overlay's keys
  stay the platform's standard ones.
- **Recording:** the page records the physical key (`KeyboardEvent.code`), not the character, so a
  Turkish or other non-US layout and Option-modified characters record the key the OS registers.
  The primary modifier is written `CommandOrControl` like the default. While recording, Rust
  releases the current shortcut (`shortcut_suspend`), so pressing it reaches the page instead of
  starting a capture; Escape, Cancel, a saved shortcut, or the main window losing focus (checked in
  Rust too, `WindowEvent::Focused(false)`) registers it again.
- **Validation in Rust only** (`shortcut::validate`), so the page cannot register what Rust would
  refuse: Command/Control/Option (Alt) is required, plus a second modifier except on F1–F24,
  because one-modifier combinations are apps' own commands and Option+key types characters.
  A short per-OS list of system combinations (macOS screenshot keys, log out, lock screen; Windows
  secure attention keys) and redo (`CommandOrControl+Shift+Z`) is refused. Rejections are named
  values (`shortcut::Rejection`) worded per platform by the page.
- **Change is all-or-nothing:** release the current shortcut, register the new one, then save; if
  registration or saving fails, the new one is released and the previous one registered again.
  ADR-014's limitation stands: macOS may accept a combination another app also holds, so a
  successful change does not prove the shortcut is exclusive.
- **Storage:** `settings.json` in Tauri's `app_config_dir`
  (`~/Library/Application Support/com.snipvero.app/` on macOS), written through a temporary file
  and a rename. No new dependency: `serde_json` is already used. A missing, unreadable or invalid
  file, or a saved shortcut that no longer passes validation, means the default; startup never
  fails on it. Unknown fields are ignored on read. The file holds only the accelerator; no
  screenshot data, paths or identifiers (NFR-2).
- **Commands:** `shortcut_set(accelerator | null)` and `shortcut_suspend(suspended)`, accepted from
  the main window only.

## ADR-031: Separate website and source repository links

- **Status:** implemented (2026-11-01); automated checks on macOS only, native link-opening QA pending.
- **Context:** the project now has an official website, `https://snipvero.app`.
- **Decision:** add a website link to the main footer and About details while keeping GitHub and
  contributors links. `bundle.homepage` now names the website; the Cargo repository remains GitHub.
  This supersedes ADR-024's equality of homepage and repository. Rust returns the fixed website in
  `app_info` and accepts `website` in the existing `open_link` enum; no arbitrary URL, webview
  navigation, network client or dependency is added. Only an explicit click opens the browser.
- **Verification:** frontend tests cover the website href and non-navigating click in both windows;
  Rust tests cover its fixed destination, enum name and bundle metadata consistency.

## ADR-032: Public support email in About

- **Status:** implemented (2026-11-01); automated checks on macOS only, native mail-app QA pending.
- **Decision:** About shows Contact with `support@snipvero.app`. This supersedes ADR-024's
  no-contact-details choice for this explicitly approved public address only. Rust supplies the
  address through `app_info`; `open_link` accepts a `support` enum variant and opens only the
  fixed mailto destination using the existing system opener. No arbitrary URL, email sender,
  subject/body, attachments, network client or dependency is added. The user composes and sends
  the message in their default mail app; the webview never navigates.
- **Verification:** frontend tests cover the displayed address, mailto href and non-navigating
  command dispatch; Rust tests cover the fixed destination and enum name. Windows remains
  without native link opening, as before.
