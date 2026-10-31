# AGENTS.md: instructions for contributors and coding agents

Snipvero is an open-source (MIT) screenshot and annotation tool. macOS is the supported platform
for the beta; Windows support is planned and kept compiling in CI. Tauri 2 + React/TypeScript + Rust,
Konva.js for annotations. Present it as an independent application: no comparisons with other tools in
public-facing text.

## Read first, every session

1. `docs/PROGRESS.md`, if your checkout has one: current milestone, blockers, next steps. It is a
   local file, ignored by Git and never committed (ADR-023); a fresh clone does not have it.
2. `docs/REQUIREMENTS.md`: what we are building (FR/NFR IDs).
3. `docs/ARCHITECTURE.md`: how it fits together.
4. `docs/DECISIONS.md`: why. Do not silently reverse a recorded decision.

Contributor workflow and pull request checks: `CONTRIBUTING.md`.

## Commands

```sh
pnpm install                 # dependencies (pnpm only; never npm/yarn)
pnpm tauri dev               # run the app with hot reload
pnpm check                   # prettier --check, eslint, tsc, vitest
pnpm build                   # frontend build (required before cargo builds: dist/ is embedded)
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm tauri build             # release bundle for the current OS
pnpm notices                 # regenerate THIRD_PARTY_NOTICES.txt after a dependency change (CI: notices:check)
pnpm verify:macos            # check the built .app and DMG (docs/RELEASE.md §8)
```

Releases (packaging, Developer ID signing, notarization): `docs/RELEASE.md`. Never create or change
certificates, publish a GitHub Release or change repository visibility without the user asking.

### macOS capture testing

Screen Recording permission belongs to the signed `.app`, not to a terminal-launched binary.

```sh
# Stable local identity (see docs/DECISIONS.md ADR-011); without it, every rebuild needs a new grant.
APPLE_SIGNING_IDENTITY="Snipvero Local Development" pnpm tauri build --bundles app
open src-tauri/target/release/bundle/macos/Snipvero.app                        # tray → Capture
open -n --stderr /tmp/snipvero.log src-tauri/target/release/bundle/macos/Snipvero.app --args --stress=20
# capture/export cycles; copies onto a private pasteboard, never the user's clipboard (ADR-019)
open -n --stderr /tmp/snipvero.log src-tauri/target/release/bundle/macos/Snipvero.app --args --stress-export=20
tccutil reset ScreenCapture com.snipvero.app                                    # reset the grant
```

## Engineering rules

- **One codebase, macOS 14+ and Windows 10 1903+/11.** Put OS-specific code in
  `#[cfg(target_os = "...")]` modules (`macos.rs` / `windows.rs`), and only where it is truly needed.
  Shared code must not import platform modules directly.
- **MVP first.** No abstraction without a second real use. No speculative features.
- **Privacy:** no network access, no telemetry, no uploads. Screenshots stay in memory until the user
  copies or saves them. Never add an HTTP client or analytics dependency.
- **Dependencies:** minimise them. Every new dependency needs an MIT-compatible license
  (MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 for unmodified use) and a one-line justification in the PR / DECISIONS.md.
- **HiDPI:** keep coordinate math in one pure, tested module. Never assume a single scale factor.
- **Rust:** edition 2024, `clippy -D warnings`, no `unwrap()`/`expect()` outside startup and tests,
  and errors via `Result`.
- **TypeScript:** `strict` plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. No `any`. Event and command
  names live in `src/ipc.ts`, mirrored in `src-tauri/src/events.rs`.
- Match the surrounding style. Comment _why_, not _what_.

## Definition of done

- `pnpm check` and the cargo fmt/clippy/test trio pass locally.
- New logic has tests (pure logic: unit tests; platform behaviour: a manual QA note in the PR and,
  locally, in PROGRESS.md).
- Docs are updated: DECISIONS.md when an architectural choice is made or changed (with the
  measurements it rests on), README.md and RELEASE.md when user-visible behaviour or the release
  steps change.
- Anything verified on only one OS is marked as such (PR description, DECISIONS.md status line).

## Hand-off protocol (between sessions and agents)

Progress tracking is local: `docs/PROGRESS.md` is in `.gitignore` and must not be committed or
force-added. Create it if it is missing. Before ending a session, update it with:
what was done, what was verified and on which OS, open blockers, and the exact next step.
Do not start the next milestone unless asked.
