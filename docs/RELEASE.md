# Release process (macOS)

macOS on Apple silicon is the only release platform for the beta. Windows keeps its CI build
(NSIS smoke bundle) but is not released.

Nothing in this repository publishes a release, creates certificates or changes repository
settings. Each of those steps is done by a maintainer, by hand.

## 1. Version

There are two version numbers, because Apple's bundle fields accept integers only (ADR-022).

**Package version** `0.1.0-beta.1` (SemVer pre-release). It lives in three manifests, and
`manifest_versions_match` (Rust test) fails if they differ:

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `version` (then run `cargo check` so `Cargo.lock` follows)
- `src-tauri/tauri.conf.json` → `version`

It names the Git tag (`v0.1.0-beta.1`), the DMG (`Snipvero_0.1.0-beta.1_aarch64.dmg`), the
Windows installer and the GitHub Release.

**Bundle versions** in the app's `Info.plist`, both one to three period-separated integers:

| Key                          | Value   | Set in                                                     |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `CFBundleShortVersionString` | `0.1.0` | `src-tauri/Info.plist` (overrides the bundler's value)     |
| `CFBundleVersion`            | `1`     | `tauri.conf.json` → `bundle.macOS.bundleVersion` (a build) |

`CFBundleShortVersionString` is the package version without its pre-release suffix;
`bundle_versions_follow_apple_format` (Rust test) fails if it differs or if either value is not in
Apple's format. All betas of 0.1.0 therefore show `0.1.0`, and `CFBundleVersion` tells them apart:
**increase it for every build you publish**, including a rebuild of the same version and the final
`0.1.0`; never reuse a number.

Example: `0.1.0-beta.2` → manifests `0.1.0-beta.2`, `Info.plist` stays `0.1.0`, `bundleVersion`
`2`. `0.2.0-beta.1` → `Info.plist` `0.2.0`, `bundleVersion` keeps counting (`3`, …).

`pnpm tauri dev` embeds the full package version in the development binary; only bundles carry the
values above.

## 2. Icons

| File                                                                                 | Use                                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `src-tauri/icons/source/app-icon.svg`                                                | Source of the app icon (1024 px, macOS grid: 824 px body, 100 px inset) |
| `src-tauri/icons/source/tray-template.svg`                                           | Source of the menu bar icon (black and alpha only)                      |
| `src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png`, `icon.icns`, `icon.ico` | Generated app icons                                                     |
| `src-tauri/icons/tray-template.png`                                                  | Generated menu bar template image, 36 × 36 px (18 pt at 2×)             |

The app icon is opaque (white glyph on an indigo body), so it reads on light and dark Dock, Finder
and Launchpad backgrounds. The menu bar icon is a **template image**: macOS uses only its alpha and
tints it for light, dark and highlighted menu bars. Windows keeps the coloured app icon in the tray.

Regenerate after editing a source (the CLI renders SVG itself; no extra tools):

```sh
pnpm tauri icon src-tauri/icons/source/app-icon.svg -o /tmp/snipvero-icons
cp /tmp/snipvero-icons/{32x32,64x64,128x128,128x128@2x,icon}.png /tmp/snipvero-icons/icon.{icns,ico} src-tauri/icons/
pnpm tauri icon src-tauri/icons/source/tray-template.svg -o /tmp/snipvero-tray --png 36
cp /tmp/snipvero-tray/36x36.png src-tauri/icons/tray-template.png
```

Only the files listed above are committed; the iOS, Android and Windows Store sizes are not needed.
`template_icon_is_black_and_alpha_at_2x` (Rust test) checks the tray image's size and colours.

## 3. Third-party notices

`THIRD_PARTY_NOTICES.txt` (repository root) lists every Rust crate compiled into the executable and
every npm package bundled into the frontend, with their license texts. The bundle copies it and
`LICENSE` (as `LICENSE.txt`) into `Snipvero.app/Contents/Resources/` (`bundle.resources`), so the
DMG carries both inside the app.

```sh
pnpm notices         # regenerate after any dependency change, then commit the file
pnpm notices:check   # CI (macOS job): fails if the file is stale or a license is not allowed
```

`scripts/third-party-notices.mjs` has no dependencies: it reads `cargo metadata` (normal
dependencies of `snipvero` for `aarch64-apple-darwin`, `x86_64-apple-darwin` and
`x86_64-pc-windows-msvc`; build and dev dependencies do not ship) and the module graph of a
production Vite build (including the runtime helpers Vite and Rolldown inject). For each component
it checks the SPDX expression against the allowed list (ADR-021), picks the alternative the
component is used under, and collects that license's files from the package. Crates published
without license files take their text from `scripts/licenses/` (sources listed there); a new one
fails the check until its text is added.

Attach `THIRD_PARTY_NOTICES.txt` to the GitHub Release as well.

## 4. Build the bundles

```sh
pnpm install --frozen-lockfile
pnpm check && pnpm notices:check && pnpm build
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
pnpm tauri build --bundles app,dmg
pnpm verify:macos
```

Output in `src-tauri/target/release/bundle/`:

- `macos/Snipvero.app`: `LSUIElement` (menu bar only), minimum macOS 14.0, hardened runtime.
- `dmg/Snipvero_<package version>_aarch64.dmg`: the app plus an `Applications` link.

Without a Developer ID identity (section 6), both are signed **ad hoc** (`signingIdentity: "-"`
in `tauri.conf.json`). Gatekeeper rejects such a download; it is fine for local testing only.

**DMG window layout:** Tauri's `bundle_dmg.sh` arranges the Finder window through AppleScript,
which needs Automation permission for Finder the first time. With `CI=true` it skips that step:
the image still contains the app and the `Applications` link, but without the arranged layout.
On macOS 27, `hdiutil attach` prints a deprecation notice (in favour of `diskutil image attach`);
it still works, and the bundler and the verification script use it.

## 5. Apple silicon

The beta ships one DMG, for Apple silicon (`aarch64`); Intel Macs are not supported (ADR-022).
`pnpm verify:macos` checks that the executable is `arm64` only, that every slice declares
`minos 14.0`, and that it links only system libraries (`/System/Library`, `/usr/lib`), so the
bundle needs no Rosetta and carries no third-party dylibs or frameworks. GitHub's `macos-latest`
runners are Apple silicon, so CI builds and verifies the same architecture.

Intel support later means a universal app (one DMG, `_universal`), not yet tried:

```sh
rustup target add x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin --bundles app,dmg
pnpm verify:macos --bundle-dir src-tauri/target/universal-apple-darwin/release/bundle --arch universal
```

It would also need a test on an Intel Mac and an update of the README's requirements.

## 6. Developer ID signing (requirements)

Distribution outside the Mac App Store needs an Apple **Developer ID** signature and
**notarization**. Without them, macOS 15 and later block the first launch until the user approves
it in System Settings (Control-click → Open no longer bypasses Gatekeeper).

What is needed (none of it exists in this repository, and none of it may be committed):

1. Membership in the **Apple Developer Program** (paid, individual or organisation), with
   two-factor authentication on the Apple Account.
2. A **Developer ID Application** certificate with its private key in the login keychain of the
   machine that builds. Only the team's Account Holder can create it (developer.apple.com →
   Certificates, or Xcode → Settings → Accounts → Manage Certificates). A _Developer ID Installer_
   certificate is not needed: Snipvero ships a DMG, not a `.pkg`.
3. Apple's intermediate **Developer ID Certification Authority (G2)** in the keychain (Xcode
   installs it; otherwise apple.com/certificateauthority). Without it, `codesign` reports
   "unable to build chain to self-signed root".
4. Xcode or the Command Line Tools with `notarytool` and `stapler` (`xcrun notarytool --version`).
5. The identity name, shown by `security find-identity -v -p codesigning`, for example
   `Developer ID Application: Example Name (TEAMID1234)`, and the 10-character **Team ID**.

Build with the identity from the environment, so `tauri.conf.json` stays ad hoc for contributors
and CI (same approach as ADR-011):

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Example Name (TEAMID1234)" \
  pnpm tauri build --bundles app,dmg
```

What the signature must have, and what `pnpm verify:macos --distribution` checks:

- **Developer ID Application** authority, a **secure timestamp** (`codesign --timestamp`, which
  Tauri passes for a real identity) and a team identifier.
- **Hardened runtime**, required by notarization. Tauri enables it by default
  (`bundle.macOS.hardenedRuntime`); the ad-hoc build already carries the `runtime` flag.
- **No entitlements.** Snipvero is not sandboxed, the web content runs in WebKit's own processes
  (no JIT entitlement), and Screen Recording is a privacy permission, not an entitlement.
  Notarization also rejects `com.apple.security.get-task-allow`, which Tauri does not add. Add an
  entitlements file only if notarization or a signed launch shows a need.
- **Screen Recording after a signature change:** macOS ties the grant to the signing identity.
  Testers moving from an ad-hoc beta to a Developer ID build must grant permission again once;
  later Developer ID builds keep it.

Local signing and public distribution differ:

| Build                                       | Signature                                  | Gatekeeper on a downloaded copy | Use                                                               |
| ------------------------------------------- | ------------------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| Default (`pnpm tauri build`, CI)            | ad hoc (`signingIdentity: "-"`)            | rejected                        | CI smoke bundle, local builds, unnotarized pre-releases (ADR-025) |
| `Snipvero Local Development` (ADR-011)      | self-signed, this Mac only                 | rejected                        | keeping the Screen Recording grant                                |
| Developer ID + notarized + stapled (§6, §7) | Developer ID Application, secure timestamp | accepted                        | the build to publish once available                               |

Only `pnpm verify:macos --distribution` passing makes a build Apple-verified. Until a Developer ID
exists, a release-profile ad-hoc build that passes `pnpm verify:macos` may be published as a
**pre-release** whose notes say it is not signed with a Developer ID or notarized (ADR-025, §9).

### Signing in GitHub Actions (not set up)

CI builds ad hoc and holds no Apple credentials. If release signing ever moves to CI:

- Put it in a **separate workflow** started by hand (`workflow_dispatch`) or by a tag, never in
  `ci.yml`: `pull_request` runs execute contributors' code, and secrets must not reach them.
- Keep the credentials in a protected **GitHub environment** (required reviewer, `main` and tags
  only), not as plain repository secrets: `APPLE_CERTIFICATE` (base64 `.p12`),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and either the API-key or the Apple ID set
  from §7. Tauri imports the certificate into a temporary keychain when these are set.
- Prefer an **App Store Connect API key** with the narrowest role over an Apple ID password; write
  the `.p8` into `$RUNNER_TEMP`, not the workspace, so no artifact upload can include it.
- Never `echo`, `set -x` or `cat` a secret-derived value; GitHub masks only exact secret strings,
  not decoded forms (mask a decoded value with `::add-mask::` first).
- Upload only the DMG and its checksum as artifacts, never `target/`, a keychain or a `.p12`.
- Pin third-party actions in that workflow to a commit SHA, and rotate the certificate password
  and API key if a log or artifact may have exposed them.

Adding any of this is the maintainer's decision.

## 7. Notarization (requirements)

Tauri submits the signed `.app` to Apple's notary service and staples the ticket (before it builds
the DMG, so the app inside the DMG is stapled too) when one of these credential sets is in the
environment:

| Method                    | Variables                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Apple ID                  | `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password, not the account password), `APPLE_TEAM_ID` |
| App Store Connect API key | `APPLE_API_KEY` (key ID), `APPLE_API_ISSUER` (issuer ID), `APPLE_API_KEY_PATH` (`.p8` file)        |

- App-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords.
- API key: App Store Connect → Users and Access → Integrations → Team Keys, role _Developer_ or
  higher. The `.p8` file can be downloaded only once; keep it outside the repository.

Without them the build prints `skipping app notarization` and continues.

The DMG is a separate download, so sign, notarize and staple it as well (a stapled ticket lets
Gatekeeper check it offline). A keychain profile keeps the password out of the shell history:

```sh
xcrun notarytool store-credentials snipvero-notary --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID"
DMG=src-tauri/target/release/bundle/dmg/Snipvero_0.1.0-beta.1_aarch64.dmg
codesign -dv "$DMG"                     # if "not signed at all": codesign --timestamp -s "$APPLE_SIGNING_IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile snipvero-notary --wait
xcrun stapler staple "$DMG"
```

If a submission is rejected, `xcrun notarytool log <submission id> --keychain-profile
snipvero-notary` lists the reasons.

## 8. Verify before uploading

`scripts/verify-macos-bundle.mjs` (`pnpm verify:macos`) inspects the bundles without launching
them. CI runs it on the macOS job's debug bundle; run it on every release build:

```sh
pnpm verify:macos                  # ad-hoc build: everything except Developer ID and notarization
pnpm verify:macos --distribution   # release candidate: also Developer ID, timestamp, tickets, Gatekeeper
```

It checks:

- `Info.plist`: identifier, name, package type, `CFBundleShortVersionString` (package version
  without suffix) and `CFBundleVersion` (`bundleVersion`) in Apple's format, minimum macOS 14.0,
  `LSUIElement`, copyright.
- The exact file list of the bundle (executable, `Info.plist`, icon, `LICENSE.txt`,
  `THIRD_PARTY_NOTICES.txt`, code signature); the bundled notices and license equal the
  repository's files.
- Architectures (`--arch`, default `arm64`), `minos` of every slice, system libraries only.
- `codesign --verify --deep --strict`, signature identifier, hardened runtime, no entitlements;
  the Gatekeeper result is reported (and required with `--distribution`).
- The DMG: named `Snipvero_<package version>_<arch>.dmg`, `hdiutil verify` passes, it mounts
  read-only and holds only `Snipvero.app` and an `Applications` link to `/Applications`; the app
  inside passes the same checks and has the identical executable and `Info.plist`. With
  `--distribution`: the DMG's Developer ID signature, stapled ticket and Gatekeeper assessment.
- It prints the DMG's SHA-256 for the release notes.

Then on a Mac that has never run Snipvero: download the DMG through a browser (so it is
quarantined), install it, launch it, grant Screen Recording, take a capture, copy and save.

## 9. Publish

Done by a maintainer, by hand: create a **draft** GitHub Release for tag `v<package version>`,
mark it as a pre-release, attach the DMG and `SHA256SUMS.txt`, review, then publish. Write the
checksum file from inside the bundle directory, so it names the file without a local path:

```sh
cd src-tauri/target/release/bundle/dmg
shasum -a 256 Snipvero_0.1.0-beta.1_aarch64.dmg > SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

`LICENSE` and `THIRD_PARTY_NOTICES.txt` travel inside the app (§3) and in the tagged source. If
the build is not notarized, say so in the release notes, describe Gatekeeper's **Open Anyway**
step (System Settings → Privacy & Security) and link to the README's Download section; never
suggest turning off Gatekeeper or removing the quarantine attribute. A public release, and the
README's links to it, need a public repository (changing visibility is the maintainer's
decision).
