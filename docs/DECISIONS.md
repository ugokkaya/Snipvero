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
  part of **Version** is superseded by ADR-022. The "no entitlements" rule is replaced by the one
  `com.apple.security.device.audio-input` entitlement of ADR-037.
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

## ADR-033: Open at Login on macOS through SMAppService

- **Status:** implemented (2026-11-01). Unit tests and the maintainer's manual QA of the local
  signed build passed on macOS (Apple silicon): normal launch shows the window, the toggle
  registers and removes the login item, and a login launch shows only the menu bar icon. Windows:
  not offered; compile, lint and tests in CI only.
- **Context:** Snipvero is a menu bar app reached through a global shortcut; after a restart the
  shortcut does nothing until the user opens the app again. ADR-003 left launch at login out of the
  MVP; this supersedes that part of it, for macOS only.
- **Decision:** a checkable tray item **Open at Login**, between **Open Snipvero** and **About**,
  off by default. It calls `SMAppService.mainApp` `register`/`unregister` (macOS 13+; the app needs
  14). No settings window (ADR-003) and no frontend command or event: the tray is the only control.
- **State:** the system's `SMAppService` status is the only source; nothing is stored in
  `settings.json`, because the user can change it in System Settings › General › Login Items and a
  copy would drift. The check mark is read again at startup, after a toggle and on every tray click.
  When the user has turned Snipvero off there (`requiresApproval`), turning it on opens that page,
  since only the user can allow it again.
- **Off the main thread (2026-11-03):** every `SMAppService` call (status, register, unregister) is
  a synchronous request to `backgroundtaskmanagementd`. In beta.5 the status read ran on the main
  thread twice per tray click (button down and up). Two Macs froze with the tray menu open and
  the cursor spinning; the menu bar and Dock did not respond while other apps did. The status read
  measured up to 465 ms when idle (20 reads, macOS 27.2, Apple silicon) and is unbounded under
  load. All calls now run on a background thread, one at a time behind a lock. A click triggers one
  read, on button down, and skips it while another call runs. The check mark starts off and is
  updated once the first read returns.
- **Launch at login:** the main window is now created hidden (`"visible": false`) and shown at
  `RunEvent::Ready`, unless the launch Apple event (`oapp`) carries `keyAELaunchedAsLogInItem` as its
  `keyAEPropData`; then only the menu bar icon appears. Every other launch shows the window as
  before (ADR-004). The event is only current while the app finishes launching, which is when Tauri
  emits `Ready`.
- **Dependency:** `objc2-service-management` 0.3 (Zlib OR Apache-2.0 OR MIT), the ServiceManagement
  bindings of the objc2 family already used (ADR-008), with only the `SMAppService` feature. Two
  Apple Event methods are called with `msg_send!`, because objc2-foundation binds them only together
  with the objc2-core-services crate.
- **Alternatives:** `tauri-plugin-autostart` was rejected: it adds the `auto-launch` crate and on
  macOS writes a launch agent or uses AppleScript instead of the system login item API. A
  `--hidden` argument was not possible: `SMAppService.mainApp` passes no arguments.

## ADR-034: The capture shortcut also cancels an open capture

- **Status:** implemented (2026-11-03). Unit tests on macOS; manual QA of a signed build pending.
  Windows: compile, lint and tests in CI only.
- **Context:** the overlays cover every display above all other windows (`NSScreenSaverWindowLevel`)
  and show a frozen frame. Escape reaches only the overlay page. A page that crashes or hangs after
  it is shown therefore leaves no way out but Force Quit, and the screen looks frozen. The ready
  timeout (8 s) covers only overlays that never appear, and a second shortcut press was ignored
  while a capture was open. Not observed in use; found by reading the code while investigating a
  freeze (see ADR-033).
- **Decision:** pressing the capture shortcut while a capture is open ends it exactly as Escape does
  (`overlay::close`, focus back to the previous app). The OS delivers the shortcut to Rust, so it
  works whatever state the page is in. During an export it does nothing, as Escape: the save
  panel is a sheet on an overlay. A press while the frames are still being taken is ignored, as
  before. The tray's and the main window's Capture still only start a capture: the overlays cover
  both.
- **Alternatives:** a page heartbeat that closes the capture when the page stops answering was
  rejected for now (user decision). It would recover without the user knowing the shortcut, but
  a long legitimate stall could close a capture and lose its annotations.

## ADR-035: Delayed recapture of a selected region

- **Status:** implemented (2026-11-15). Automated verification on macOS Apple silicon; native
  dropdown/focus QA pending. Windows remains unimplemented for capture and not locally verified.
- **Context:** a capture shortcut or focus change can dismiss a dropdown before it is captured.
  The user requested choosing a region first, then opening the dropdown during a five-second wait.
- **Decision:** add a five-second recapture button to the region toolbar. Hide all overlays, return
  focus once to the previous app, then wait on a worker thread. Capture fresh screen pixels before
  showing/focusing any overlay. Reopen the editor with the same physical-pixel region; discard old
  annotations and undo history because they belong to a different screenshot. The tooltip states
  this. No automatic export, configurable timer or persistent setting in this first version.
- **Lifecycle:** keep the active session and capture/update lock while waiting. Reject selection,
  readiness and export requests during recapture. The global shortcut cancels it, without depending
  on a hidden webview receiving Escape. On completion, validate the original session before swapping
  in a new ID; stale timer/capture results cannot reopen or overwrite a later session. Start a new
  readiness watchdog only after the fresh frames exist. Reuse the hidden pages for the reload and
  reset their editor state; final cancellation/export retains ADR-013's destroy/recreate lifecycle.
- **Coordinates:** match the selected display by ID, not enumeration order; refuse changed bounds,
  pixel dimensions or scale and changed desktop arrangement rather than guessing a new region.
  The existing frame-pixel coordinate model and export pipeline remain unchanged.
- **Privacy/dependencies:** no new dependency, network path, intermediate screenshot file, clipboard
  write or settings entry. Old frame buffers are released when the session is replaced or cancelled.
- **Countdown feedback (2026-11-15, user choice):** after trying the local build, the user requested
  visible feedback for both the remaining time and region, and chose a blinking border plus counter.
  A native transparent `NSPanel` uses `NonactivatingPanel`, ignores mouse events and is ordered front
  without becoming key. Only the border alternates opacity every half second; a solid badge counts
  5 down to 1. Layout uses the existing tested geometry module with per-display pixel ratios and
  on-screen badge clamping. The worker uses a monotonic deadline, validates each tick's session on
  the main thread and waits for the final `orderOut` before invoking capture. Normal close also
  removes the matching indicator immediately. No overlay webview is made transparent or interactive
  during the wait, and no extra network/dependency is added; only AppKit binding features for native
  views/panels/labels are enabled. This is an exception to the earlier 'no window during wait' detail,
  not to the requirement that no focus is taken before capturing. Native indicator/input QA pending.

## ADR-036: Allow the dedicated Print Screen key without modifiers

- **Status:** implemented (2026-11-15). Automated tests on macOS Apple silicon; native key assignment,
  restart persistence and capture/cancel QA pending. Windows not locally verified.
- **Context:** the user tried assigning Print Screen alone, which ADR-030's generic modifier rule
  rejected, and explicitly requested allowing it.
- **Decision:** exempt only modifier-free `Code::PrintScreen` from the modifier count. All other
  modifier/reserved-key checks, registration failure handling, atomic settings updates and startup
  validation remain unchanged. This supersedes ADR-030's modifier minimum only for Print Screen
  alone; it does not allow arbitrary bare keys or one-modifier Print Screen combinations.
- **Limit:** OS or keyboard software interception still cannot be bypassed. Validation acceptance
  does not guarantee OS registration or delivery, as noted in ADR-014/ADR-030.
- **Verification:** Rust tests cover the exception and unchanged rejection of bare regular/function
  keys and single-modifier Print Screen. Frontend tests cover the unmodified accelerator and updated
  guidance. No dependency, permission, network or settings format change.
- **Observed F13 follow-up (2026-11-15):** the updated build still rejected the user's key. An
  explicit key-capture card reported `key=F13`, `code=F13` with no modifiers. Allow bare F13 on
  macOS in addition to literal PrintScreen; other function keys and Windows bare F13 keep their
  modifier rules. This extends the literal-only exception above. Do not normalize F13 to
  PrintScreen: global-hotkey's macOS backend registers F13 as native0x69 but PrintScreen as0x46,
  so renaming the accelerator would register the wrong physical key. The UI saves/displays F13
  honestly and the modifier guidance explains this keyboard mapping. Rust/frontend regression
  tests cover validation and retaining F13, but native registration/delivery still needs user QA.

### Beta 8 maintainer QA report (ADR-035 / ADR-036, 2026-11-15)

After testing the local development-signed macOS build with the F13 follow-up, the maintainer
reported that everything works and requested publication as a new release. Keep the timer fixed
at five seconds for this release. This supersedes the pending basic feature QA notes above, but
does not claim exhaustive mixed-DPI/display-change/keyboard coverage, clean-Mac installation,
Homebrew installation, Windows runtime support or runtime QA of the notarized distribution candidate.

## ADR-037: Screen recording: one pipeline, MP4 first, GIF as an export

- **Status:** proposed (2026-11-16); **task 2 (silent MP4 recording on macOS) implemented and partly verified
  on macOS only** (see "Task 2 outcome" below for what was measured and what was not). **Task 3 (optional audio) implemented
  on macOS; system audio and the entitlement behaviour measured, the microphone path built but not run against a granted
  microphone** (see "Task 3 outcome"). **Task 4 (GIF export) implemented on macOS; the crate, the decoder, the timing and the encoder were measured
  against real recordings, the save dialog, the progress events and the review-window panel were not driven by hand** (see "Task 4 outcome"). The API facts below come from the `objc2-*`
  0.3.2 bindings in the local registry and Apple's documentation. macOS is the target; Windows must keep compiling
  (unsupported stubs, type-checked against the shared code but not built on Windows).
- **Context:** the user asked for screen recording. Decisions already taken with the user:
  one recording pipeline; MP4 (H.264) first; GIF is an export of a finished recording, never a
  separate direct-record mode; system audio and microphone are optional, separately toggled and
  off by default (no permission prompt while off); no annotations on video in this version;
  recordings go to a temporary file with a duration cap; Windows only compiles; macOS uses
  ScreenCaptureKit and AVFoundation, preferring no new dependency.

### Scope and product behaviour

- A recording captures one rectangular region of one display, chosen with the existing overlay
  (FR-3 selection, frame pixels). The overlay closes before the first frame is requested, so
  the selection UI is never in the video. Snipvero's own windows are excluded from the stream
  (as in ADR-008), except the small native recording indicator, which is excluded from the
  content filter too (the user sees it, the video does not).
- States: `idle → starting → recording → stopping → finished` (or `failed`/`cancelled`). One
  recording at a time; it is mutually exclusive with a capture session and an update install
  (the same lock as ADR-035/FR-14.5). A finished recording is a temp MP4 that the user can
  **Save…** (NSSavePanel, as ADR-018), **Export as GIF…**, or **Discard**.
- Stopping: the tray item turns into **Stop Recording**, the capture shortcut stops it
  (as ADR-034), and the duration cap stops it. Escape in the review window discards nothing; only **Discard**,
  **Save** or quitting ends the temp file.
- No new settings in the first version except the two audio toggles and the cap's default, kept
  in the existing `settings.json` (ADR-030) with the same atomic writes. Defaults: both audio off, 300 s.

### Storage: temp file instead of memory (exception to the in-memory rule)

- **Rule being amended:** AGENTS.md and ADR-019 say screenshots stay in memory until the user
  copies or saves them. A video cannot: 5 minutes of 1080p at 60 fps is ~18 000 frames; held raw
  (BGRA, 8 MB each) that is >100 GB, and even encoded MP4 should not be buffered in the heap
  for minutes. `AVAssetWriter` also writes to a file URL, not to a buffer.
- **Decision:** the encoder writes `snipvero-recording-<random>.mp4` into a **private
  per-launch directory** `<NSTemporaryDirectory>/com.snipvero.app/recordings-<pid>-<nonce>/`,
  created with mode `0700` and exclusively (`create_dir`, never reused), under the per-user
  temp directory macOS already gives each user (not `/tmp`). The file is never
  uploaded, never opened by another program and never referenced by the page (the page receives only
  an opaque recording id, not a path; Save and GIF export run in Rust).
- **Lifetime:** deleted on Cancel/Discard, after a successful Save (the saved copy is separate),
  after a failed start, on normal quit (`RunEvent::Exit`), and on the next launch (stale
  `recordings-*` directories older than this process are removed at startup, covering crashes
  and force-quit). Delete failures are logged, never silently kept as "success".
  A finished-but-unsaved recording survives only until the app exits.
- **Disk space:** before starting, require free space for the cap at the chosen bitrate plus 20 %
  headroom (`volume available capacity for important usage`, via `NSURL resourceValues`); refuse
  with a message otherwise. A write failure mid-recording stops it and keeps what was written
  if the file finalizes, otherwise discards it with an error.
- **Privacy statement for docs:** "Screenshots stay in memory"; "recordings are written only to
  a private temporary file, deleted when you discard, save, quit, or at next launch". No telemetry, no network.

### Cap

- **Duration:** default 300 s, hard maximum 600 s in the first version (a constant in `recording/mod.rs`; the setting
  is clamped to 10..=600 s). At the cap the recording stops by itself as a normal stop (the file is
  finalized and valid), and the user gets a notice "stopped at the maximum length". A monotonic
  deadline on the worker (as in ADR-035) enforces it, not wall-clock time and not the frame count.
- **Size:** enforced by construction rather than by polling: capped bitrate × capped duration.
  Video bitrate is derived from the pixel count and frame rate (~0.1 bit per pixel per frame, clamped
  to 2..=20 Mbit/s), giving at most 750 MB at the extremes; a cheap guard also stops the recording
  if the file exceeds 1 GiB. No GIF-style size limits apply to the MP4.
- **Frame size/rate:** output dimensions are the region in physical pixels rounded down to even
  numbers (H.264 4:2:0 requires it); regions that exceed the H.264 level limit, or are smaller than 16 px, are refused with a message.
  30 fps by default (`minimumFrameInterval` 1/30 s); no 60 fps option in the first version.
  Cursor is shown (`showsCursor = true`), no click highlights.

### Frame source and encoder (macOS), and why no new framework crate beyond the objc2 family

- **Frame source:** `SCStream` with an `SCContentFilter` for the display (excluding Snipvero
  windows) and `SCStreamConfiguration`: `sourceRect` = the region in **display points**, `width`/`height` = the even
  output size in pixels, `pixelFormat = 'BGRA'` (or 420v if measured cheaper; decided in task 2),
  `queueDepth = 5`, `showsCursor = true`. The region is converted from frame pixels to points by the existing pure geometry
  module; no second scale-factor model (AGENTS.md HiDPI rule). An `SCStreamOutput`
  delegate (declared with `objc2::define_class!`, as the countdown panel does for its views) receives `CMSampleBuffer`s on a private serial
  dispatch queue and appends them to the writer. Only frames whose `SCStreamFrameInfoStatus` is `Complete` are appended (idle/blank
  frames are skipped; the writer's timeline uses the sample's presentation time, so static screens produce a valid, short-sample-count file).
- **Encoder:** `AVAssetWriter` (file type `mp4`) with an `AVAssetWriterInput` for video
  (`AVVideoCodecTypeH264`, `AVVideoProfileLevelH264HighAutoLevel`, bitrate from above, `expectedSourceFrameRate`)
  and `expectsMediaDataInRealTime = true`. VideoToolbox hardware H.264 is used by AVFoundation
  itself, so there is no own encoder, no ffmpeg and no libx264 (GPL/patent concerns, size, ADR-005).
  `movieFragmentInterval` is left default: the moov atom is written at `finishWriting`, so a crash leaves an
  unplayable temp file, which is acceptable because crash files are deleted at next launch anyway.
- **Rejected:**
  - `SCRecordingOutput` (macOS 15+): writes MP4 itself and even mixes the microphone, but is unavailable on our
    macOS 14 minimum (`minimumSystemVersion` 14.0, ADR-022). A second path for 15+ would double testing for no
    user benefit. Revisit if the minimum moves to 15.
  - `CGDisplayStream`: deprecated, no audio.
  - ffmpeg or any bundled encoder / `openh264`/`x264` crates: licenses (GPL/BSD with patent
    pool terms), binary size, and AVFoundation already encodes in hardware.
  - Capturing frames with `SCScreenshotManager` in a loop: no hardware path, no audio, wrong timing.
- **Dependencies:** needs the **same objc2 family** the tree already uses, enabled for the first
  time: `objc2-av-foundation` (AVAssetWriter, AVAssetWriterInput, AVCaptureDevice/Session for the
  microphone, AVMediaType, AVVideoSettings keys), `objc2-core-media` (`CMSampleBuffer`, `CMTime`),
  and, if the sample-buffer accessors need them, `objc2-core-video` (`CVPixelBuffer`) and
  `objc2-core-audio-types` (`AudioStreamBasicDescription`). All 0.3.x, `Zlib OR Apache-2.0 OR MIT`, same maintainers
  and generator as `objc2-screen-capture-kit` (ADR-008), versions already in the local registry, **default features off** with
  only the feature names the code needs (as in `Cargo.toml` today). Justification (one line for the PR): "typed bindings
  to AVAssetWriter and CMSampleBuffer for the MP4 encoder; the alternative is hand-written `extern "C"`/`msg_send!` for
  dozens of selectors, which is less safe and more code". `objc2-screen-capture-kit` gains `SCStreamConfiguration`, `SCStreamOutput`
  (its existing `SCStream` feature may already include them; check) plus its optional `objc2-core-media` /
  `objc2-av-foundation` features. `pnpm notices` regenerates `THIRD_PARTY_NOTICES.txt`; the objc2 licence texts in
  `scripts/licenses/` already apply. **No non-objc2 crate is added for video.**

### Audio

- **Both sources off by default and independent.** With both off, no `captureAudio`,
  no `AVCaptureDevice` is created and nothing touches the microphone permission or Info.plist keys at runtime.
  The first enabling of a toggle is when a prompt can appear.
- **System audio (macOS 14+):** `SCStreamConfiguration.capturesAudio = true`, `sampleRate = 48000`, `channelCount = 2`,
  `excludesCurrentProcessAudio = true` (Snipvero's own sounds, if any, stay out). Delivered as
  `SCStreamOutputType::Audio` sample buffers on the same stream. It needs only the Screen
  Recording permission Snipvero already has (shown as "Screen & System Audio Recording"); it adds no new prompt.
- **Microphone: decision — `AVCaptureSession` + `AVCaptureAudioDataOutput` on every supported macOS version, not
  SCK's `captureMicrophone`.** The check: `SCStreamConfiguration.captureMicrophone`,
  `microphoneCaptureDeviceID` and `SCStreamOutputType::Microphone` exist in the bindings but are
  **macOS 15.0+** (the same release as `SCRecordingOutput`). We support 14, so an `AVCaptureDevice` path is needed
  regardless; keeping a second SCK-only path for 15+ would be two implementations of the same feature, double QA, and
  differing sample formats, for no gain (MVP rule, ADR-003). One AVFoundation path is used on 14, 15 and later.
  Permission: `AVCaptureDevice.authorizationStatus(for: .audio)`; `requestAccess` is called
  only when the toggle is turned on **and** the status is `notDetermined`; `denied` shows guidance with a fixed System Settings
  URL (`Privacy_Microphone`, same mechanism as ADR-015, added to the allowed list in `system/macos.rs`) and leaves the toggle off.
  The default input device is used; no device picker in this version.
- **Mixing:** players generally play only the first audio track of an MP4, so system and mic
  audio are mixed into **one AAC track** (`kAudioFormatMPEG4AAC`, 48 kHz, stereo, 128 kbit/s).
  The mixer is a small pure Rust module (`recording/mixer.rs`): both sources are converted to
  interleaved `f32` 48 kHz stereo, aligned on their presentation timestamps (host clock; both SCK and AVCapture use `CMClockGetHostTimeClock()`),
  summed with a soft clamp and fed to one `AVAssetWriterInput` (linear PCM in, the writer's `outputSettings` do the AAC encoding). With one source
  enabled it is a pass-through. Gaps (a source stalling) are filled with silence; drift beyond 100 ms is corrected by dropping or padding. Unit tests cover
  alignment, gap filling, clamping and the single-source path. If task 3's measurement shows two AAC tracks are acceptable to QuickTime and the page
  preview, the mixer may be replaced by two tracks; the decision to prefer the mixer rests on the player behaviour above, to be re-measured.
- **Info.plist and signing (see RELEASE.md):**
  - `NSMicrophoneUsageDescription` is added to `src-tauri/Info.plist` (English, one sentence:
    "Snipvero records your microphone only when you turn on microphone audio for a screen recording."). Without the key the system terminates the app on the first microphone access.
  - Because the app uses the **hardened runtime** (required for notarization), microphone access
    also needs the entitlement **`com.apple.security.device.audio-input`**. This ends the "no entitlements" statement in RELEASE.md §signature and
    `scripts/verify-macos-bundle.mjs` (line ~225): add `src-tauri/Entitlements.plist` containing only that key, reference it via `bundle.macOS.entitlements` in
    `tauri.conf.json`, and change the verifier to require **exactly** that one entitlement (and still reject `get-task-allow`).
    Notarization accepts this entitlement; it is not on Apple's restricted list and needs no provisioning profile. No sandbox, no
    camera, no `screen-capture` entitlement (Screen Recording is a TCC grant, not an entitlement; ScreenCaptureKit system audio needs none).
  - **Trade-off, stated plainly:** the usage string and entitlement ship in every build even though audio is off by
    default; the prompt itself appears only when the user enables the microphone. The alternative — a separate build — is rejected.
  - **TCC and signing identity:** the Microphone grant, like Screen Recording (ADR-010/011), is tied to the signing identity; a
    change from ad-hoc to Developer ID, or of the local development identity, asks again. `tccutil reset Microphone com.snipvero.app` resets it for testing.
  - The ad-hoc beta (ADR-025) also needs the entitlement to be applied when signing, or the microphone is silently denied; task 3 verifies this on the local
    development identity first, and the notarized path in RELEASE.md afterwards.
  - **Windows:** no equivalent; stubs only.

### IPC names (mirrored in `src/ipc.ts` and `src-tauri/src/events.rs`)

| Kind    | Name                          | Direction / payload                                                                                                                |
| ------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| command | `recording_start`             | page → Rust: `{ session, region: PixelRect, systemAudio: bool, microphone: bool }` → `RecordingInfo`                               |
| command | `recording_stop`              | page/tray → Rust: stop and finalize; returns the finished `RecordingInfo`                                                          |
| command | `recording_discard`           | page → Rust: `{ id }` delete the temp file                                                                                         |
| command | `recording_save`              | page → Rust: `{ id }` opens the native save dialog; Rust copies/moves the temp file to the chosen `*.mp4`                          |
| command | `recording_export_gif`        | page → Rust: `{ id, fileName, options }` runs the GIF export (task 4), save dialog from Rust; answers `{ outcome, bytes, frames }` |
| command | `recording_gif_plan`          | page → Rust: `{ id, options }` → output size and size estimate, or the reason it cannot be made (added in task 4)                  |
| command | `recording_cancel_gif_export` | page → Rust: `{ id }` stops a running export (added in task 4)                                                                     |
| command | `recording_status`            | page → Rust: current state, elapsed ms, cap, audio availability (also used for the permission rows in the main window)             |
| command | `recording_set_audio`         | page → Rust: `{ kind: "system" \| "microphone", enabled }` validates permission, persists the setting, returns the new status      |
| event   | `recording-state`             | Rust → main/review window: `RecordingStatus` on every state change (not per frame)                                                 |
| event   | `recording-progress`          | Rust → windows, at most 2 per second: elapsed ms, file bytes                                                                       |
| event   | `recording-failed`            | Rust → main window: user-facing message (disk full, permission lost, encoder error)                                                |
| event   | `recording-export-progress`   | Rust → review window: `{ id, phase: running\|done\|cancelled\|failed, fraction 0..1, message }`, at most ~10 per second            |

Constants live in `events.rs` and `ipc.ts` with the existing "keep in sync" comments; the commands are registered
in `lib.rs`. All commands validate the session / recording id like `overlay_*` (ADR-019): a stale id is refused,
never acted on. The page never sends a path and never receives one.

### Module layout

```
src-tauri/src/recording/
  mod.rs        platform-independent: RecordingState machine, RecordingInfo/Status, errors, cap/bitrate/size
                math (pure, tested), temp directory lifecycle, commands, `unsupported` dispatch
  macos.rs      SCStream + SCStreamOutput delegate + AVAssetWriter + microphone session (objc2)
  windows.rs    `start`/`stop` return `RecordingError::Unsupported`; compiles with CI only
  mixer.rs      pure PCM mixing/alignment (tested on both OSes, no platform imports)
  gif.rs        pure GIF export: limits, plan and size estimate, timeline resampling, box downscale, delays, `gif` encoder (task 4)
  macos/reader.rs  the MP4 → BGRA pictures frame source (`AVAssetReader`), a submodule of macos.rs like audio.rs
  tempfiles.rs  private temp dir creation, stale cleanup, free-space check (pure parts tested)
src-tauri/src/system/macos.rs   + microphone settings URL; src-tauri/src/tray.rs  + Start/Stop Recording
src/recording/                  RecordingBar/ReviewWindow, pure state/formatting helpers, tests
```

`mod.rs` selects the backend with `#[cfg(target_os = "macos")] mod macos; use macos as platform;`
exactly like `capture/mod.rs`; shared code imports no platform module. HiDPI: region → points and
even-size rounding go through `geometry.rs` (new pure functions with tests), not into `macos.rs`.
Entry point: a new **Record Region** action in the overlay toolbar (reusing the selection) and a tray item that opens the
overlay in recording mode. No second shortcut in the first version.

### GIF crate selection criteria

GIF is an export of a finished MP4 (decode with `AVAssetReader`/`AVAssetImageGenerator` on macOS, no second capture, no second pipeline).
A crate qualifies only if it:

1. is licensed MIT, Apache-2.0 or a dual of them (AGENTS.md / ADR-021 policy), with all of its **transitive** dependencies inside
   that policy (`pnpm notices:check` is the gate);
2. is pure Rust, builds on both macOS and Windows with no C toolchain or system library, and adds no network/HTTP
   code (AGENTS.md privacy rule);
3. is maintained (a release in the last 18 months), `edition`/MSRV compatible with Rust 1.90;
4. has a small tree (target: at most 2 new crates beyond those already in `Cargo.lock`) and **default features off**;
5. encodes a global or per-frame palette with delays, loop count and frame disposal, and quantizes RGBA
   (NeuQuant or equivalent) so no second quantizer crate is needed.

**Candidate: `gif` 0.14.x (image-rs)**, `MIT OR Apache-2.0`. Its only dependencies are `color_quant` (MIT, NeuQuant)
and `weezl` (`MIT OR Apache-2.0`, **already in the tree**), so the net addition is `gif` and `color_quant`. It meets 1–5 on
paper; task 4 confirms with `cargo tree`, `pnpm notices:check` and a size comparison before adding it. Rejected up front:
`gifski` (AGPL-3.0, and ffmpeg-oriented, fails criterion 1), `image` with its GIF codec (pulls the whole `image` crate), shelling out to ffmpeg/gifsicle.

- **GIF export limits:** at most 15 fps (default 10), width at most 800 px (default: the region's width in points, i.e. 1×, capped),
  at most 60 s of source (a longer recording needs a trim, out of scope for the first version, and the dialog says so), a size estimate
  shown before saving. Export runs on a worker, is cancelable, writes a hidden sibling file and renames it (ADR-019), and never touches the MP4.

### Task 2 outcome (silent MP4 on macOS)

Implemented as planned in `recording/{mod,macos,windows,tempfiles}.rs`, `geometry.rs`, the overlay's Record entry points, the tray
row, the review window and the `snipvero-recording` preview protocol. Deviations and decisions taken while building it:

- **Dependencies.** `objc2-av-foundation` and `objc2-core-media` (default features off) are direct; `objc2-core-audio`,
  `objc2-core-audio-types` and `objc2-core-video` come in transitively because the two bindings depend on them
  (5 new crates in `Cargo.lock`, all `Zlib OR Apache-2.0 OR MIT`, the objc2 family; `pnpm notices:check` passes). `dispatch2` (already in the tree through
  `rfd` and `tao`) is now named directly for the frame queue, and `objc2-foundation` gained `NSDictionary` and `NSValue`.
  `libc` and `objc2-core-video` are not direct dependencies: free space uses `NSURL` resource values, the frame status uses the
  sample's attachment dictionary.
- **Whole-app exclusion.** The content filter excludes Snipvero's entire application, which covers the overlay, the native
  indicator and the review window with one rule, so the indicator needs no separate filter entry.
- **Indicator.** The red border and clock reuse the countdown panel (`overlay/macos/countdown.rs`, generalized with a text and a colour);
  the tray row becomes **Stop Recording** and the tray title shows a red dot and the elapsed time. Both only reflect state: they have no logic of their own.
- **Lock hand-off.** `overlay::hand_off_to_recording` closes the overlays like `close` but keeps the capture lock; the recording
  releases it when it ends or fails to start. A capture, a second recording and an update install are therefore excluded for the whole recording.
- **Stop sources.** Tray row, capture shortcut, cap, 1 GiB file guard, and a stream/encoder failure reported by the delegate. A repeated stop is
  ignored (`Machine::begin_stop` acts once). The writer's session ends at the host-clock time of the stop, so a static screen
  (SCK sends no frames) still yields a video as long as the recording.
- **Display removal / permission revoked.** Handled by `stream:didStopWithError:`: the recording is finalized with a notice. No
  separate `NSApplicationDidChangeScreenParametersNotification` observer was added; this path is **not tested** (no way to unplug a display or revoke the permission here).
- **File-size bound.** At 20 Mbit/s the default cap gives 750 MB; at the 600 s maximum it would be 1.5 GB, which the 1 GiB guard stops at about
  430 s. Regions of 5K displays do not fit H.264 level 5.2 (at most 8192 px per side and 36 864 macroblocks, 9.4 megapixels) and are refused with a message.
- **Not implemented (not needed yet):** `recording_stop` (the page has no stop control; the tray, shortcut and cap stop it) and the
  `recording-progress` event (nothing displays it; the clock is the tray title and the indicator). Mid-recording cancel is stop, then Discard;
  `Recorder::cancel` is only used when the app quits or a start is raced by exit.
- **Review window.** Plays the file through a custom protocol with HTTP range support instead of a path; the CSP gained a `media-src`
  for it. Closing the window keeps the recording; the tray row becomes **Review Last Recording…**; another recording is refused until it is saved or discarded.
  Save, Copy File and Copy Path run in Rust. Copies on the clipboard are valid only until the temporary file is deleted (documented in the window and README).
- **Settings.** `recordingMaxSeconds` (clamped to 10–600) in `settings.json`; changing the shortcut preserves it. No UI for it.
- **Measured, macOS (real ScreenCaptureKit + AVAssetWriter, run from a terminal that holds Screen Recording permission):**
  - The ignored test `records_a_region_to_a_finished_mp4` records 2 s of a 320×240 point region: 58–59 frames, 0 dropped, 2.01 s, 70–480 KB (screen-content dependent),
    `ftyp` + `moov` present; an AVFoundation probe reports `isPlayable`, one video track, `avc1`, 320×240, ~30 fps, duration 2.007 s; QuickLook produces a thumbnail.
  - The built-in harness (`--stress-record=2 --stress-record-quit`, debug binary with a temporary identifier) ran 2 full cycles through the real state
    machine: 960×540 px, 89 frames in 3.0 s, 783–788 KB, finalized, discarded, folder empty afterwards; then quit in the middle of a third recording left no
    `recordings-*` folder. After `kill -9` mid-recording the folder was left behind and the next launch removed it ("removed 1 leftover recording folder(s)").
  - **Not verified:** the picture's content and the region's placement. The test machine's screen was locked (lock-screen wallpaper), so frames were
    dark/moving and no app window could be placed over a known region. The overlay → Record flow, the tray row/title, the indicator panel, the review window with video
    playback, Save/Copy, the shortcut stop, a Retina vs 1× region, memory over many cycles, the signed `.app` smoke test with real clicks and Windows are
    **not run**; the Turkish QA checklist in the local `docs/PROGRESS.md` covers them.

### Task 3 outcome (optional audio, macOS)

**Measured, macOS 27.2 (build 26B123), Apple silicon, built-in microphone, run from a terminal and from ad-hoc hardened probe apps:**

- **SCK system audio** (`capturesAudio`, 48 kHz, 2 channels requested): every buffer is 48 000 Hz, 2 channels, 32-bit **float, non-interleaved**
  (`flags 0x29`, two planes of 3 840 bytes), **960 frames (20 ms)**; buffers keep coming while nothing plays (all-zero), so a quiet system is not
  "no buffers". A sound played with `afplay` shows as a peak of 0.36. Timestamps are on the host clock: the first audio buffer began 12–17 ms after the first
  picture; **delivery latency** (arrival minus end of buffer) was 0.6–102 ms (mean ≈ 30 ms), hence the mixer's 250 ms latency.
- **Microphone format** (`AVCaptureDevice.activeFormat`, built-in): 48 000 Hz, **1 channel, 32-bit float, interleaved** (`flags 0x9`). Not read from
  delivered `AVCaptureAudioDataOutput` buffers: see "not measured". The code therefore reads each buffer's own format (float32/int16, planar or
  interleaved, any channel count, any rate) instead of assuming this one, and resamples linearly if a device cannot give 48 kHz.
- **Hardened runtime without the entitlement:** a probe `.app` (ad-hoc, `-o runtime`, with `NSMicrophoneUsageDescription`, **no** entitlement) calling
  `AVCaptureDevice.requestAccess(for: .audio)` was **answered `false` after 0.00 s and the status became `denied`: no prompt**. The same probe signed with
  `com.apple.security.device.audio-input` **waited for the user** (no answer for 8 s, status stayed `notDetermined`, i.e. the prompt appeared). The
  entitlement is therefore required, as designed. (The probe grants are of throwaway identifiers.)
- **Decision: mono or stereo?** The output is **stereo** AAC, 48 kHz, 128 kbit/s: system audio is stereo, the (mono) microphone is copied to both channels.
  Measured result of a real recording (SCK system audio, 5 s, ad-hoc test): `soun` track `aac `, 48 kHz, 2 ch, starts at 0.000, 5.0879 s long, decoded
  with the same peak (0.36) as the capture; `vide` track 5.0883 s; QuickTime-compatible container (`isPlayable`).
- **One mixed track vs. two:** kept the mixer (players play the first audio track). Two tracks were not tried in QuickTime; the decision still rests on the
  player behaviour documented above, not on a new measurement.

**Implementation.** `recording/mixer.rs` (pure, 23 tests: alignment on the host clock, gap filling, overlap dropping, jitter and drift tolerance of 100 ms,
limiter that is the identity up to 0.9, planar/interleaved/int16/mono conversion, resampler, a clock-correction for a source not stamped on the host clock);
`recording/macos/audio.rs` (PCM sample buffers into one AAC `AVAssetWriterInput`, `AVCaptureSession` microphone, permission lookup and request);
`recording_audio` / `recording_set_audio` (the ADR planned this in `recording_status`; a separate query keeps the per-state event free of permission calls),
`settings.json` keys `recordSystemAudio` / `recordMicrophone` (absent = off), the two switches in the main window, and `recording_start` gaining
`withoutMicrophone`. The IPC table above is otherwise unchanged; `recording_start` still takes the audio choice from the stored settings rather than from the page.
Deviations and decisions taken while building it:

- **A pacer instead of a pull model.** A thread hands the mix to the writer every 100 ms, up to 250 ms before now on the host clock. A source that stalls,
  starts late or never delivers is silence and holds nothing back; late data is dropped. At stop the rest is flushed up to the end of the video.
- **Still screens (Task 2 interaction, measured).** With only a video input the writer stretched the last picture to `endSessionAtSourceTime` (a 4 s recording of
  a still lock screen: video track 3.995 s). **With an audio input present it did not**: video track 0.067 s, sound 5.12 s. With sound on, the newest picture
  is therefore appended once more, stamped one frame before the end (`hold_last_picture`); re-measured: video 5.088 s, sound 5.088 s. Silent recordings are unchanged.
- **No permission look-up while both are off.** `recording_start` does not even read the microphone status then (`plan_audio`); the main window's `recording_audio`
  reads the status only when the audio panel is shown (supported platforms), and it never prompts.
- **Microphone not allowed at start:** `recording_start` is refused with the code `microphoneUnavailable` before the overlay closes; the overlay offers
  **Record without microphone** (an explicit choice that is not stored). A source that fails mid-recording, or a microphone that delivered nothing, is named in the
  review window's notice. The review video is no longer `muted`, and a "Sound" row says what the file has.
- **Dependencies:** no new crate. `objc2-core-audio-types` is named directly (already in the tree), and more feature flags of `objc2-av-foundation` /
  `objc2-core-media` are enabled. The AAC keys are string literals (`AVFormatIDKey`, …): AVFAudio has no bindings in the tree and the constants are plain strings.
- **Packaging:** `src-tauri/Entitlements.plist` with the one entitlement, `bundle.macOS.entitlements`, `NSMicrophoneUsageDescription` in `src-tauri/Info.plist`;
  `pnpm verify:macos` requires the usage text and exactly that entitlement (verified on a built local-identity `.app` and DMG: all checks pass); RELEASE.md and
  AGENTS.md updated. This ends ADR-020's "no entitlements" statement for the one entitlement above (nothing else changes: no sandbox, no JIT).
- **Microphone, measured later by the maintainer on a live build (macOS 27.2, built-in microphone, unlocked screen):** the delivered buffers were
  **24 000 Hz** (958 frames ≈ 40 ms), not the 48 kHz the device reports as its active format, so the per-buffer format reading and the linear resampler were
  needed, not a fallback. They were **stamped on the host clock** (first buffer arrived 5 ms after it ended, no clock shift), like system audio (2–3 ms).
  Two recordings (14.0 s and 8.2 s) with both sources: 0 rejected buffers, 0 dropped audio frames, system and microphone buffer counts within 2 % of each other,
  the last picture held to the end. The maintainer confirmed by listening that system audio and the microphone are both audible, together and alone, and that
  the switches, the first-use prompt and the video recording work. The offset between the two sources was not measured numerically beyond "both on the host clock".
- **Still not verified:** (1) denied / reset / revoked-permission flows and a microphone that disappears mid-recording (the maintainer's pass covered the granted
  path; unconfirmed here), (2) long-run A/V drift over 5–10 minutes (the design tolerates ≈ 30 ms in ten minutes), (3) macOS 14 and 15 (only macOS 27 ran),
  (4) notarized builds and Windows (stubs only; `cargo check` for the MSVC target could not run here: no C compiler for `ring`).

### Task 4 outcome (GIF export, macOS)

**Crate verification (the criteria above, checked before adding `gif`).** `cargo tree -e normal --format "{p} {l}"` for `gif = { version = "0.14", default-features = false,
features = ["std", "color_quant"] }`: `gif 0.14.2` (`MIT OR Apache-2.0`) → `color_quant 1.1.0` (`MIT`), `weezl 0.1.12` (`MIT OR Apache-2.0`). Nothing else.

1. Licences: all three inside the policy; `pnpm notices:check` passes with the regenerated file (334 Rust components, licences allowed).
2. Pure Rust, no build script, no C, no network or HTTP code (read: its sources are the encoder, the decoder and `common.rs`, about 108 KB); it builds wherever the rest does.
3. Maintained: 0.14.2 was published on 2026-04-09 (crates.io), `rust-version = 1.62`, edition 2021, well below our 1.90.
4. Tree: `Cargo.lock` gains **two** packages (`gif`, `color_quant`); `weezl` was in the lock already (`arboard` → `image` → `tiff`, Windows only) but is compiled on macOS for the first time,
   so three small crates are new in a macOS build. Default features are off; `raii_no_panic` (a panic guard on drop) is not enabled; `std` and `color_quant` are the two the code needs.
5. It writes per-frame local palettes with delays, the NETSCAPE loop extension and disposal, and `Frame::from_rgba_speed` uses the **exact** palette when a picture has at most 256 colours
   (most screen content) and NeuQuant otherwise, so no second quantizer crate is needed.

Binary size: the release executable (LTO, `codegen-units = 1`, stripped) grew from 6 420 752 to 6 504 288 bytes, **+83 536 bytes (+1.3 %)**, for the whole of task 4 (the two crates and `weezl`, the pure module, the
reader and the commands), measured against a clean build of the previous commit. The crates alone are therefore under that.

**Design as built.**

- **Reader.** `macos/reader.rs`: `AVURLAsset` of the temporary MP4 → `AVAssetReader` + `AVAssetReaderTrackOutput` with `kCVPixelBufferPixelFormatTypeKey = 32BGRA`, `alwaysCopiesSampleData = NO`.
  Each sample's `CVPixelBuffer` is locked read-only, handed to the callback with its stride and presentation time and unlocked, inside one autorelease pool per picture. The pool matters on a worker thread
  with no run loop: without it every picture's autoreleased objects would live until the export ends. The cancel flag is checked before every picture.
  `tracksWithMediaType:` is deprecated since macOS 15 in favour of an asynchronous loader that needs a completion block and a run loop; a finished local file is ready at once, so the synchronous call
  is used with `#[allow(deprecated)]` and works on 14 and later. `objc2-core-video` is named directly (already in the tree); `objc2-av-foundation` gains `AVAsset`, `AVAssetReader`, `AVAssetReaderOutput`,
  `AVAssetTrack`, and `objc2-core-media` its `objc2-core-video` feature. No new crate beyond `gif` and `color_quant`.
- **Timing comes from timestamps.** The output is sampled on a fixed clock of `fps` ticks over the recording's own length (`Finished::duration`, which the writer set from the host clock, not the
  frame count). Each tick shows the newest picture at or before it; ticks that show the same picture are one GIF frame whose delay is their total. A still screen (SCK sends nothing) is therefore **one frame
  with the whole length as its delay**, which is how the measurement below came out. A picture that is replaced before any tick looks at it is dropped. Delays are rounded on the cumulative time, not per frame,
  so 15 fps (6.67 cs per tick) does not make a minute 4 s too long (test: 900 ticks sum to exactly 6000 cs); every delay is at least 6 cs, above the 2 cs that browsers still honour. Identical
  neighbouring pictures (compared after scaling) are merged as well, which also covers the held last picture (`hold_last_picture`, with sound on).
- **Scaling.** A box filter (each output pixel is the mean of the source pixels it covers), never nearest-neighbour, so text and thin lines survive. Output width is chosen from the limits and the aspect
  ratio is kept; no upscaling (the width cannot exceed the video's).
- **Limits (all enforced in Rust by `gif::plan`, and the page only displays its answer).** At most 15 fps (choices 5, 10, 15; default 10), width at most 800 px and the video's own width, at least 16 px, source
  at most 60 s (`TooLong`: "This recording is 1:20 long. A GIF can be made from at most 60 seconds of video; save it as an MP4 instead."). The default width is the region's width in **display points** (1×, so a Retina
  recording is not doubled), capped; `RecordingStatus` carries `gifMaxWidth`, `gifDefaultWidth` and `gifDefaultFps` so the page has no copy of these numbers. A recording over 60 s opens the panel with that message
  and no Export button.
- **Memory.** Streamed: the decoder's picture is scaled the moment it arrives and released; the writer holds at most three scaled pictures (one waiting for its duration, one waiting to be merged or written, one being built).
  The length of the source does not change that; it is bounded only by the 60 s limit on time.
- **Save flow.** The options are validated first (a too-long recording never opens a dialog), then `rfd` asks for the file (`*.gif` only; suggested plain name `Snipvero-<date>.gif`, validated by
  `export::valid_file_name_with`), then the export runs on a worker into a hidden sibling file renamed over the target by `export::replace_with` (ADR-019), so a cancelled or failed export leaves no
  partial file and never damages an existing one. The recording's `saving` guard is held for the whole time (no Save, Discard or second export under it). **The MP4 is never touched and the recording is not
  discarded** after a GIF: the user can still Save the MP4 afterwards.
- **UI.** **Export as GIF…** opens a panel in the review window: frame rate, width, the size line (`600 × 400 px, up to about 4.2 MB`), then **Export…**, a progress bar with **Cancel export**, the result
  (`GIF saved (2.5 MB, 24 frames).`) or the error. Other buttons of the window are disabled while it runs.
- **IPC.** Three additions to the table: `recording_gif_plan` (so the estimate and the limits are computed once, in Rust), `recording_cancel_gif_export`, and the answer of `recording_export_gif`
  (`{ outcome, bytes, frames }`). `recording-export-progress` carries `{ id, phase, fraction, message }`.
- **Windows.** `read_pictures` is a stub returning "not available on this platform"; `recording_export_gif` refuses before any dialog. The pure module compiles everywhere and its tests run on every OS
  (the `cargo check --target x86_64-pc-windows-msvc` could not run here: no C compiler for `ring`, as in task 3).

**Measured, macOS 27.2, Apple silicon, three displays, from a terminal with Screen Recording (the screen was unlocked this time):**

- **Real still screen (ignored test `exports_a_recording_as_a_gif`, 3 s and 5 s regions of a static desktop):** the MP4 has **1 picture**; the reader returned 1 picture; the GIF has **1 frame** whose delay is 300 cs /
  500 cs, 10 173 bytes at 240 × 180. This is the case the ticket warned about: the length comes from the stamps and the recording's duration, not from the frame count.
- **Real moving content** (a test window with a moving block and a counter at 30 Hz in the region, which stopped after 2.28 s of the 5 s recording): 65 pictures, stamps 0.00–2.28 s at about 30 fps, then the still
  desktop; **24 GIF frames** (23 ticks of motion at 10 fps plus the held ending), delays sum to **500 cs (5.0 s)**, 135 107 bytes at 240 × 180, decoded in 1.6 s in a _debug_ build. The first frame was looked at
  (scaled from 320 to 240 px, text legible). Per moving frame the output was about 5.6 KB for 43 200 pixels, i.e. 0.13 bytes per pixel per frame: `ESTIMATE_BYTES_PER_PIXEL` is **0.14**, a deliberately upper-ish figure
  (ticks that repeat or flat content cost much less, so the estimate says "up to about").
- **Worst case (ignored test `worst_case_export_time_and_size`, release):** 60 s of 1920 × 1080 pictures that all change, 15 fps, 800 px wide: **900 frames, 33.4 MB, 34.8 s** (including generating the 900 test
  pictures, so the export is somewhat under that) and a **peak resident size of 28 MB** (19.7 MB footprint). The plan's estimate for that case was 45.4 MB, an upper bound as intended. The reader
  does not hold more than one decoded picture at a time, so the 28 MB does not grow with the number of pictures.
- **Cancel:** with the flag set before the first picture, the real reader stops with `Cancelled` and the export reports it; the MP4 compared byte for byte before and after the export was identical.

**Not verified:** the save dialog and the whole command path through the review window (the panel, progress events, Cancel by hand, the result line) were not driven with real clicks and the page was
not run in the app, only in its unit tests with a mocked `ipc`; a GIF opened in Safari, Chrome and Preview (only decoded with the `gif` crate's decoder, `sips` and by eye as a still); the 60 s limit with a real
60 s recording (the plan refuses it in tests); a Retina region vs a 1× one for the default width (the arithmetic is tested; no 1× display here); an MP4 recorded with sound (the reader only asks for the video
track, and the held picture merges, but a recording with audio was not exported); macOS 14 and 15 (only 27 ran); memory over a long source (the 60 s limit prevents one; the 28 MB peak is the 60 s worst case);
notarized builds; Windows (a stub, compiled by CI only).

### Addendum: Stop button on the recording indicator

The indicator gained a control strip beside the border: the clock, a **Stop** button and "or press <capture shortcut>" (`shortcut::display_accelerator`, from the registered shortcut; absent when it is
not registered). It is a **second, small panel**, not part of the click-through one, so recorded apps still receive clicks through the border panel; it is nonactivating (`NonactivatingPanel`,
`becomesKeyOnlyIfNeeded`, `orderFrontRegardless`), so the recorded app keeps its focus, and it is a Snipvero window, so the whole-app exclusion keeps it out of the video. Placement is
`geometry::recording_layout` (above the region, else below, else inside its top edge, always on the display). The button calls `stop(id, User)` on a spawned thread: stopping removes the indicator, and
tearing the button's panel and target down inside the button's own action would free the object that is running. Measured on macOS 27.2 with the `--stress-record` harness and screenshots: the strip
renders above the region ("● 0:01 [Stop] or press F13") on a secondary display. **Not verified:** a real mouse click on the button (synthetic events from a terminal were not delivered, probably for lack of
the Accessibility permission), keyboard operation, VoiceOver, mixed-DPI placement, and that the strip is absent from the recorded video (by the whole-app exclusion, not re-measured).

### Plan for tasks 2–4 (follow in order; each ends with `pnpm check` and the cargo trio)

**Task 2: video (MP4, no audio)**

1. `Cargo.toml`: add the `objc2-av-foundation`, `objc2-core-media` (and, if needed, `objc2-core-video`) entries under the macOS target; add the
   `SCStream`-related SCK features; justification comment per ADR-005; `pnpm notices` and commit the regenerated file.
2. `geometry.rs`: pure functions `even_output_size`, `region_to_points`, `recording_bitrate` (+ tests incl. mixed-DPI and odd sizes).
3. `recording/{mod,tempfiles,windows}.rs` and `events.rs`/`ipc.ts`/`lib.rs` registration: the state machine, caps, temp-dir lifecycle,
   stale cleanup at startup (called from `lib.rs` setup), cleanup on `RunEvent::Exit`, `Unsupported` stubs; unit tests for the
   state machine, cap/deadline, free-space and cleanup logic (using a temp dir).
4. `recording/macos.rs`: SCStream + delegate + AVAssetWriter, start/stop/finalize, deadline stop, failure paths (permission revoked, display
   removed → `NSApplicationDidChangeScreenParametersNotification` stops with a message, writer `Failed`), indicator panel (reuse `overlay/macos/countdown.rs` patterns).
5. Entry points: overlay toolbar **Record**, tray **Start/Stop Recording**, shortcut stops it; the review window (Save…, Discard) and `recording_save`
   through `rfd` as in `export/mod.rs`; hand-off of the lock with `overlay::close` (the overlay must be gone before the first frame).
6. Tests + manual QA on macOS (record 10 s, region on a Retina and a 1× display, cap with a temporary low value, quit mid-recording → no leftover files,
   stale cleanup after `kill -9`, `ffprobe`/QuickTime opens the file, no Snipvero window in the video). A `--stress-record=N` harness in
   `devtools.rs` (records 3 s, stops, discards, checks memory and temp dir as `--stress-export` does).
7. Docs: ARCHITECTURE.md (module list, recording pipeline), REQUIREMENTS.md (new FR), README.md (user-visible), ADR-037 status line.

**Task 3: audio**

1. Measure first and record in this ADR: sample formats from SCK audio and `AVCaptureAudioDataOutput`, timestamp offset between them,
   and whether a signed hardened build without the entitlement is denied the microphone.
2. `Info.plist` key; `Entitlements.plist`; `tauri.conf.json` `bundle.macOS.entitlements`; `scripts/verify-macos-bundle.mjs` (+ its
   `*.spec-node.mjs` tests): require exactly the one entitlement; RELEASE.md (signature list, notarization, "Screen Recording/Microphone after a
   signature change", testing with `tccutil reset Microphone`); AGENTS.md macOS testing block.
3. `recording/mixer.rs` with tests; `macos.rs`: system-audio config, `AVCaptureSession` microphone input, permission flow, single AAC input;
   `recording_set_audio` and the two toggles in the pre-record UI (both off; denied state with guidance);
   `system/macos.rs` microphone settings URL (fixed, allow-listed).
4. QA: each toggle alone and both together (mic only must not require anything beyond the microphone grant), denied microphone, revoking mid-recording,
   output with no sound playing (silence, not an error), A/V sync over the maximum duration, both macOS 14 and 15+ if available (otherwise marked as untested).

**Task 4: GIF export**

1. Verify the crate against the criteria above (`cargo tree -e normal -i`, licenses, `pnpm notices:check`); add `gif` with default features
   trimmed; ADR-005 justification comment; regenerate notices; record the result in this ADR.
2. `recording/gif.rs`: pure frame decimation, nearest/box downscale and palette/delay math with tests; encoder wrapper writing to a hidden sibling file.
   `recording/macos.rs`: `AVAssetReader` frame source for the MP4 (BGRA), progress and cancel.
3. `recording_export_gif` + `recording-export-progress`, save dialog (`*.gif` only, plain suggested name as `rfd` today), UI: fps/width choice, size estimate, progress, cancel, error.
4. QA and docs: file plays in browsers/Preview, memory stays bounded for a 5-minute source (frames streamed, never all held), temp file untouched, README/ARCHITECTURE/REQUIREMENTS updates and the status line of this ADR.

- **Verification so far:** task 2 as listed under "Task 2 outcome", task 3 as listed under "Task 3 outcome", task 4 as listed under "Task 4 outcome". Still unverified: notarization acceptance of the entitlement, two tracks vs. the mixer in QuickTime, macOS 14/15 behaviour, the live microphone.

## ADR-038: Fill, Blur and Highlight tools; mosaic computed in the page

- **Status:** implemented (2026-11-19). Automated tests (vitest) pass on macOS Apple silicon; native
  macOS QA on Retina and mixed-DPI displays pending. Windows not locally verified.
- **Context:** users need to hide sensitive parts of a screenshot and to mark areas without an
  outline. The MVP listed blur and highlighter as out of scope (REQUIREMENTS.md).
- **Decision:** add three rectangle tools. **Fill** (opaque colour) and **Highlight** (colour at 40%
  opacity) are ordinary Konva rectangles in the existing layer. **Blur** is a mosaic: each block of
  `max(2, round(10 × scale))` frame pixels, aligned to the rectangle's top-left corner, becomes the
  average colour of its pixels. A mosaic is used rather than a Gaussian blur because it keeps one
  colour per block and nothing else, so it cannot be inverted the way a light blur sometimes can.
  The block size is stored when the area is drawn and does not change on resize.
- **Where the pixels are computed:** in the page, by one pure function (`pixelate.ts`) fed from the
  frame canvas, which already holds the capture at native resolution. The preview and the export
  therefore run the same code on the same pixels (FR-6.1), and the Rust export pipeline, IPC
  headers and the raw layer body are unchanged. The mosaic becomes part of the RGBA layer that
  Rust already blends. Computing it in Rust was considered and rejected: it would need a second
  implementation kept bit-identical to the preview, a new IPC field and a new Rust test surface.
  No new dependency, permission or network path; the screenshot still never leaves memory.
- **Layer order:** mosaics are drawn first, under all other annotations (`drawOrder`). A blur
  changes the screenshot itself, so an arrow or text drawn on it stays sharp and a later move of
  the blur never blurs an annotation. Fill and Highlight follow creation order like the rest.
- **Failure mode:** if a mosaic cannot be made (no 2D canvas, no frame canvas), the export fails
  with an error instead of silently exporting the unhidden pixels.
- **Toolbar:** Fill, Blur and Highlight join the first button group without a separator. Colour
  and size buttons that the active tool or selection ignores (Blur: both; Fill, Highlight: size)
  are dimmed, not hidden, so the toolbar width stays a constant the overlay can place without
  measuring. A fill or highlight selected keeps the toolbar's size, and a blur keeps its colour
  too, instead of resetting them.
- **Known limit:** the mosaic is as strong as its block size; text under a block of 10 CSS pixels
  is unreadable at normal sizes, but a very large font in a large capture may keep a hint of its
  shape. Fill is the choice for secrets.
- **Verification:** unit tests for `pixelate` (averaging, edge blocks, irreversibility, bad input),
  annotation geometry and hit tests, the drawing, resize, move and undo flows, shape specs, layer
  plans, the exporter's source hand-off and the toolbar's dimming. `tsc`, eslint, prettier and a
  Vite build pass. Rust is untouched.

## ADR-039: Interface language: English and Turkish, with no new dependency

- **Status:** implemented (2026-11-21). Unit tests (vitest, cargo) pass on macOS Apple silicon;
  the Turkish interface was not yet reviewed by a native speaker on every screen, the native
  recording indicator panel's width with the longer Turkish text was not seen, and Windows was not
  compiled locally.
- **Context:** the interface was English only. A Turkish user asked for it; more languages may follow.
- **Decision:** two languages, `en` and `tr`. The stored setting (`language` in `settings.json`) is
  absent (follow the system), `en` or `tr`. Rust owns it: `i18n.rs` resolves it (macOS
  `NSLocale.preferredLanguages`, first entry Turkish means Turkish), keeps the current language in
  an atomic, and exposes `language_get` / `language_set`. A change is stored, applied, relabels the
  tray and is announced with `language-changed`. Every page asks before its first paint, so no
  window shows the wrong language, and re-renders its tree when told of a change (no remount, so an
  open overlay keeps its state). The main window has a **Language** row (System default, English,
  Türkçe).
- **Where the text lives:** in Rust, an English/Turkish pair at the place of use (`tr!`), so the
  pair stays together and no key can be missing. In the page, one catalogue per area
  (`locales/{app,overlay,recording}.{en,tr}.ts`) with `{name}` parameters; the Turkish record type
  is derived from the English one, so a missing message fails `tsc`, and `i18n.test.ts` checks that
  both languages use the same parameters. Both rejected alternatives add weight for two languages:
  an i18n library (a dependency, against the minimal-dependency rule) and a single JSON shared by
  Rust and the page (a build step and a way for the two sides to drift).
- **Not translated:** log lines, error codes the page compares, the product name, file formats,
  and the macOS microphone usage text in `Info.plist` (shown by the system; a `tr.lproj` bundle
  would be needed). README and the documents stay English. Messages already on screen keep the
  language they were created in until replaced.
- **Turkish wording:** "alan" (not "bölge") for a screen region, as in "Alanı Yakala" and
  "Alan Kaydı Başlat" (user decision). Decimal comma for sizes (`4,2 MB`).
- **Verification:** `tsc`, eslint, prettier, 332 vitest tests and 196 cargo tests, all in English
  except the Turkish tests for the main window, toolbar, review window and size formatting. The
  language is a process-wide atomic in Rust, so Rust tests do not set Turkish; Rust Turkish text is
  unchecked by tests.
