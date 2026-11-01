# Release process (macOS)

macOS on Apple silicon is the only release platform for the beta. Windows keeps its CI build
(NSIS smoke bundle) but is not released.

The inactive reference template `docs/workflows/release-macos.yml` describes an opt-in signing and
publication workflow. It is deliberately outside `.github/workflows`, so GitHub cannot dispatch it.
Moving it into the workflows directory and provisioning a runner require separate approval. Even
then, it needs `MACOS_SIGNING_ENABLED=true`; manual runs default to artifacts only (`publish=false`).
No workflow creates certificates or changes repository settings.
The existing `v0.1.0-beta.1` download remains the original ad-hoc build; do not replace its assets.
`0.1.0-beta.2` is published. The current source version is `0.1.0-beta.3`, the first with in-app
updates (ADR-028); it is not built for release, and the updater key it needs does not exist yet
(§6a). The workflow template predates updater packages and must be reviewed for them before any
activation. No release step authorises registering a self-hosted runner, moving/dispatching the
workflow template, enabling `MACOS_SIGNING_ENABLED`, or enabling automatic publication.

## 1. Version

There are two version numbers, because Apple's bundle fields accept integers only (ADR-022).

**Package version** `0.1.0-beta.3` (SemVer pre-release, never with `+build` metadata: the updater
ignores it when ordering versions, so a rebuild needs a new version). It lives in three manifests, and
`manifest_versions_match` (Rust test) fails if they differ:

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `version` (then run `cargo check` so `Cargo.lock` follows)
- `src-tauri/tauri.conf.json` → `version`

It names the Git tag (`v0.1.0-beta.3`), the DMG (`Snipvero_0.1.0-beta.3_aarch64.dmg`), the
updater package (`Snipvero_0.1.0-beta.3_aarch64.app.tar.gz`), the Windows installer and the GitHub
Release. A pre-release version selects the beta update channel (§9).

**Bundle versions** in the app's `Info.plist`, both one to three period-separated integers:

| Key                          | Value   | Set in                                                     |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `CFBundleShortVersionString` | `0.1.0` | `src-tauri/Info.plist` (overrides the bundler's value)     |
| `CFBundleVersion`            | `3`     | `tauri.conf.json` → `bundle.macOS.bundleVersion` (a build) |

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
RUSTFLAGS="--remap-path-prefix=$HOME/.cargo/registry/src=/cargo/registry/src --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$PWD=/snipvero" \
  pnpm tauri build --bundles app,dmg
pnpm verify:macos
strings src-tauri/target/release/bundle/macos/Snipvero.app/Contents/MacOS/snipvero | grep -c "$HOME"   # expect 0
```

Rust keeps the source paths of panic locations in the binary; without the remapping, a release
binary carries about 300 paths under the builder's home directory (and so the account name).
Changing `RUSTFLAGS` rebuilds every crate once.

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

Only `pnpm verify:macos --distribution` passing makes a build Apple-verified. The original ad-hoc
pre-release is historical (ADR-025); future releases must use Developer ID and notarization.

### Signing automation security boundary

The maintainer requires Apple certificates and private keys to remain on the signing Mac. Do not
export a `.p12`, upload a certificate/key as an artifact or add Apple private material to GitHub
secrets. Hosted GitHub runners therefore cannot perform the signing step with the current policy.
Normal `ci.yml` remains ad hoc and receives no Apple credentials.

The signing workflow needs a **dedicated self-hosted Apple silicon Mac**, an existing local
Developer ID identity, and an existing local `notarytool` Keychain profile. The runner account must
have access to those items without interactive prompts; never change keychain trust or export keys
to work around access failures. Do not use a personal daily-use Mac as a public repository runner.

- Self-hosted runners are not isolated security boundaries. Public repositories can expose them
  to hostile code; required reviewers alone do not prevent persistence from an earlier job.
- Restrict the runner to the reviewed release workflow where runner-group controls are available;
  never route PR jobs or arbitrary branches to it. Otherwise keep signing local until an isolated
  runner setup is approved. Provisioning/registering a runner is a separate maintainer action.
- Use manual dispatch from protected `main`, a reviewed immutable tag reachable from `main`, a
  protected signing environment and a separate protected publication environment. Review the
  source and dependency changes before approving access to the signing machine.
- Only allowlisted public distribution files may leave the runner. Never upload a whole workspace,
  `target/`, `.p8`, `.p12` or Keychain. Pin workflow actions to commit SHAs.
- Neither signing identity names, Team IDs nor Keychain profile names are private keys; they may
  be GitHub environment **variables**. The profile's password/API key stays in local Keychain.
- Same-repository publication can use the built-in short-lived `GITHUB_TOKEN` with `contents: write`
  only in the publication job; no personal access token or Apple GitHub secret is needed.

No signing workflow may proceed to distribution unless both submissions are `Accepted`, both
tickets are stapled, and `pnpm verify:macos --distribution --team-id <TEAM_ID>` passes. No release
creation (including a draft), push or publication is authorised by a local verification run.

### GitHub Actions setup (maintainer approval required)

The template is not registered or run on GitHub. Do not move it into `.github/workflows` for
the manually published Beta 2 release. Provisioning a runner,
configuring variables/environments, creating tags, and publishing are separate approval steps.

1. With separate approval, move the reviewed template into `.github/workflows/release-macos.yml`
   and provision a dedicated runner with labels `self-hosted`, `macOS`, `ARM64`, `snipvero-signing`.
   Install the project's pnpm version, Node 24+, Rust stable with rustfmt/clippy, Xcode/CLT and `gh`.
   The runner must have the local signing identity and notary profile available. Never put this
   runner on public PR jobs. Review runner isolation and repository write access before enabling.
2. Create protected environments `macos-signing` and `macos-publish`, both with required reviewers,
   deployment restricted to protected `main`, and administrator bypass disabled where available.
   Do not enable signing if the repository plan cannot enforce the required protections.
3. Configure `macos-signing` environment **variables**, not secrets:

   | Variable                  | Value                                                  |
   | ------------------------- | ------------------------------------------------------ |
   | `APPLE_SIGNING_IDENTITY`  | Full local `Developer ID Application: … (TEAMID)` name |
   | `APPLE_TEAM_ID`           | Expected 10-character signing Team ID                  |
   | `NOTARY_KEYCHAIN_PROFILE` | Local profile, e.g. `snipvero-notary`                  |

   Set repository variable `MACOS_SIGNING_ENABLED=true` only after those protections are in place.

4. **Required GitHub Actions secrets: none to create.** Publication uses the built-in `GITHUB_TOKEN`,
   scoped to `contents: write` only in its hosted publication job. Apple passwords, `.p8`, `.p12`,
   certificates and private keys stay off GitHub. No tap PAT is needed: tap changes are reviewed
   separately, not pushed by this workflow.
5. With approval, commit the release changes, increase package version and integer bundle build
   number, push and create an immutable version tag reachable from `main`. Do not reuse
   `v0.1.0-beta.1`. The workflow rejects an existing release and a build number not greater than
   published releases. Tag creation is deliberately not automated.
6. Dispatch **macOS release** from `main`, supplying the existing tag. Leave `publish=false` for
   validation. Hosted preflight resolves the tag to a commit SHA; only that SHA reaches the Mac.
   Approve `macos-signing` after reviewing the exact tag, dependencies and workflow.
7. Signing builds a fresh app in a run-specific target directory, checks tests/notices, submits
   app and DMG separately, staples both and runs the distribution verifier. Only the final DMG,
   checksum, notices and generated cask are uploaded as an immutable artifact (14-day retention).
   A timeout/error/Invalid result stops the job: no artifact publication and no release creation.
8. To publish a new run, choose `publish=true` explicitly, then separately approve `macos-publish`
   after the signing job succeeds. The hosted publication job verifies the artifact checksum and
   unchanged remote tag, then creates the release (pre-release for beta versions). There is no
   PR, push or tag trigger, and no Apple material reaches the publication job. Do not rerun the
   workflow just to publish an already published tag; it intentionally refuses reuse.

Self-hosted job work directories are retained for diagnosis; submission IDs/results stay there,
not in uploaded artifacts. Clean old run directories manually after review; never delete the local
Keychain. Rotate credentials if the machine or a trusted dependency is compromised.

## 6a. Updater signing key (ADR-028)

In-app updates are verified with a **minisign (Ed25519) key**, unrelated to the Apple Developer ID
certificate. Apple's signature lets macOS trust the app; the updater key lets the installed app
trust an update package. Both are needed. Only the public key is embedded in the app
(`plugins.updater.pubkey` in `tauri.conf.json`).

**Status:** generated on 2026-11-01 by the maintainer on the signing Mac. Key ID
**`F4466B8E6A74D65F`**; its public key is in `tauri.conf.json`. The private key is
`~/.tauri/snipvero-updater.key` (encrypted, mode 0600) and its password the login Keychain item
`snipvero-updater-key`. A build with an empty `pubkey` shows "Updates are not available in this
build", and `pnpm notarize:macos` and `pnpm verify:macos --distribution` refuse it.

Generation (on the signing Mac, in Terminal, never in a chat or script log). Run it from the
repository root: `pnpm tauri` uses the repository's Tauri CLI, and in another folder pnpm may
install that folder's own dependencies first:

```sh
cd ~/Projeler/Snipvero   # the repository root
mkdir -m 700 -p ~/.tauri
pnpm tauri signer generate -w ~/.tauri/snipvero-updater.key   # asks for a strong password
chmod 600 ~/.tauri/snipvero-updater.key
security add-generic-password -s snipvero-updater-key -a "$USER" -w   # asks for the same password
cat ~/.tauri/snipvero-updater.key.pub                          # public key: into tauri.conf.json
```

- **Storage:** the key file is encrypted with the password (scrypt). Keep the file in
  `~/.tauri/` (mode 0600), the password in the login Keychain item `snipvero-updater-key`, and two
  offline backups of the encrypted file (for example an encrypted external disk and a password
  manager attachment), with the password stored separately from them. The key ID is recorded
  above; a package's `.sig` names the key that made it.
- **Never** in the repository, GitHub secrets, an artifact, a log, a chat, the command line, or
  the environment of `tauri build`. `createUpdaterArtifacts` stays unset, so builds never need it.
  The release script reads only `TAURI_SIGNING_PRIVATE_KEY_PATH` (an absolute path outside the
  repository) and refuses `TAURI_SIGNING_PRIVATE_KEY` (key content); it takes the password from the
  Keychain item (or `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and passes it only to the signer process.
- **Loss:** installed copies can no longer be updated. Publish a release with a new key's public
  key; users must install it manually once, like the first updater release. Document it in the
  release notes.
- **Rotation:** ship a release signed with the old key that embeds the new public key; from then
  on sign with the new key. Keep the old key until no supported version needs it.
- **Compromise:** a stolen key alone cannot reach users, because the manifest is served from this
  repository; with repository write access it could. Rotate immediately as above, review the
  manifest history, and tell users to install the fixed release manually if a malicious manifest
  was ever published.

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
DMG=src-tauri/target/release/bundle/dmg/Snipvero_0.1.0-beta.2_aarch64.dmg
codesign -dv "$DMG"                     # if "not signed at all": codesign --timestamp -s "$APPLE_SIGNING_IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile snipvero-notary --wait
xcrun stapler staple "$DMG"
```

If a submission is rejected, `xcrun notarytool log <submission id> --keychain-profile
snipvero-notary` lists the reasons.

### Local Keychain-profile verification

Create credentials interactively in Terminal; never paste passwords into chat or command arguments:

```sh
xcrun notarytool store-credentials snipvero-notary --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID"
xcrun notarytool history --keychain-profile snipvero-notary --output-format json
```

Tauri does not use this profile automatically. With profile-based authentication, build/sign the
app without Tauri notarization credentials, ZIP it with `ditto -c -k --keepParent`, submit that ZIP
with `notarytool submit --keychain-profile snipvero-notary --wait --output-format json`, and require
the response's `status` to be exactly `Accepted` (not merely a successful process exit). Staple and
validate the app **before** copying it into a newly created DMG. Do not run a command that rebuilds
or re-signs the app after stapling. Sign the final DMG with `codesign --timestamp`, submit it
separately, require `Accepted`, then staple/validate the DMG and run the distribution verifier.

On timeout or a service error, keep the submission ID, inspect `notarytool info`/`log` and stop;
do not treat `In Progress` as success or automatically resubmit. Initial Apple processing can take
much longer than subsequent submissions. Never publish an unstapled or rejected candidate.

The reusable local command implements this sequence without rebuilding the input app:

```sh
# Build with APPLE_SIGNING_IDENTITY set; do not set Tauri's Apple password/API-key variables.
pnpm tauri build --bundles app -- --locked
APPLE_TEAM_ID=TEAMID1234 NOTARY_KEYCHAIN_PROFILE=snipvero-notary \
  pnpm notarize:macos --app src-tauri/target/release/bundle/macos/Snipvero.app \
  --output-dir src-tauri/target/release-candidates/unique-candidate-name
```

Set `APPLE_SIGNING_IDENTITY` in the environment for both commands, and for the second also
`TAURI_SIGNING_PRIVATE_KEY_PATH=$HOME/.tauri/snipvero-updater.key` (§6a). The output directory's parent
must exist; the candidate directory itself must not exist (no overwrites). The script preserves
the input app, notarizes a copy and exports only verified public files into `<output-dir>/dist/`.

After the app ticket is stapled, and before the DMG is made, the script builds the updater
package from that stapled app (`tar` without AppleDouble files or extended attributes), signs it
with `tauri signer sign --app-version <version>`, verifies the signature and its signed version
against the public key in `tauri.conf.json`, and writes the manifest from
`docs/releases/v<version>.md` (its summary as plain text plus a link). It checks the updater
configuration and key before submitting anything to Apple.
Submission IDs and results remain in `<output-dir>` for timeout/rejection diagnosis. This command
never creates, uploads or publishes a GitHub Release. Its DMG has a simple app + Applications
layout created by `hdiutil`, without Finder AppleScript/Automation permission.

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
  `THIRD_PARTY_NOTICES.txt`, code signature, and optional `Contents/CodeResources` Apple ticket,
  allowed only when `stapler validate` succeeds); the bundled notices and license equal the
  repository's files.
- Architectures (`--arch`, default `arm64`), `minos` of every slice, system libraries only.
- `codesign --verify --deep --strict`, signature identifier, hardened runtime, no entitlements;
  the Gatekeeper result is reported (and required with `--distribution`).
- The DMG: named `Snipvero_<package version>_<arch>.dmg`, `hdiutil verify` passes, it mounts
  read-only and holds only `Snipvero.app` and an `Applications` link to `/Applications`; the app
  inside passes the same checks and has the identical executable and `Info.plist`. With
  `--distribution`: the DMG's Developer ID signature, stapled ticket and Gatekeeper assessment.
- The embedded updater configuration: the channel's endpoint, no local `http://127.0.0.1` test
  endpoint, and with `--distribution` the release public key.
- With `--updater`: the updater package in `<bundle-dir>/updater/`, its signature (configured key,
  signed for this version), its manifest (one `darwin-aarch64` entry at the versioned release
  asset, the same signature), entries only under `Snipvero.app/` without AppleDouble files; the
  extracted app passes every app check and is byte-identical to the verified app, including
  modes and links.
- It prints the DMG's SHA-256 for the release notes.

Then on a Mac that has never run Snipvero: download the DMG through a browser (so it is
quarantined), install it, launch it, grant Screen Recording, take a capture, copy and save.

### Local candidate provenance and preservation

Use a new `src-tauri/target/release-candidates/v0.1.0-beta.2-<timestamp>/` directory for each
candidate. Freeze a copy of the approved tracked and non-ignored source files into its `source/`
directory, record their relative paths, modes and SHA-256 values, and build there with a previously
empty `CARGO_TARGET_DIR` under the candidate's `build/`. Do not reuse the standard bundle output
or a previous application's executable. Keep existing local DMGs, beta.1 tags and remote assets.

When preparation is approved but committing is not, the base commit SHA alone does **not** identify
the complete build source. Record the full base SHA, dirty status, working-tree diff and source
manifest; explicitly describe it as that commit plus approved uncommitted changes. Verify source
hashes before and after the build and compare the original runtime source files with the base
commit. Never claim an exact clean-commit build or create a synthetic commit without approval.

After final DMG stapling, mount it read-only and compare every app file's bytes, file modes and
symlink targets against the freshly built/stapled candidate app. In particular, record matching
executable and Info.plist hashes, Apple bundle version/build number, signing Team ID and arm64
architecture. Keep provenance and verification logs beside the candidate, not inside the signed
app. These checks document source-to-package custody; they are not a reproducible-build guarantee.

The final `notarized/dist/` directory contains the DMG, the updater package and its `.sig`,
`SHA256SUMS.txt` (DMG and package), notices, `snipvero.rb`,
`RELEASE_NOTES.md` (from `docs/releases/v0.1.0-beta.2.md`) and `CHANGELOG.md`. The repository changelog
keeps beta.2 marked **Unreleased** until publication is separately approved, then records the
release date. Documentation and inactive workflow-template moves do not change app build inputs;
record any such differences from the frozen source manifest before tagging. If an approved final
commit changes build inputs, rebuild and notarize again before publishing that commit's tag.

## 9. Publish

Manual alternative to the approved workflow: create a **draft** GitHub Release for tag `v<package version>`,
mark it as a pre-release, attach the DMG, the updater package with its `.sig` and
`SHA256SUMS.txt`, review, then publish.

### Update manifest (after the release is public)

Installed apps read `updater/beta.json` from `main` (`raw.githubusercontent.com`; the stable
channel would use `updater/stable.json`). The order makes a failed or partial publication
harmless: until the last step, apps keep seeing the previous manifest.

1. Publish the release with all assets (above). Do not touch the manifest yet.
2. Download the DMG, package and `.sig` anonymously from their public URLs, compare them with
   `SHA256SUMS.txt` and the candidate, and run `pnpm verify:macos --distribution --team-id <TEAM>
--updater` against a bundle directory holding the downloaded files.
3. Copy `<output-dir>/manifest/beta.json` to `updater/beta.json` in one commit, alone, and push it
   to `main` (with approval). Its URL points only at this release's versioned asset.
4. Fetch `https://raw.githubusercontent.com/ugokkaya/Snipvero/main/updater/beta.json` (it may take
   about five minutes to refresh) and compare it with the committed file.

Never delete or replace an asset a published manifest points to. To withdraw a broken update,
revert the manifest commit (apps then see the previous version as current) and publish a fixed,
higher version. A manifest is never edited to point at an older version: the app would ignore it. Write the
checksum file from inside the bundle directory, so it names the file without a local path:

```sh
cd src-tauri/target/release/bundle/dmg
shasum -a 256 Snipvero_0.1.0-beta.2_aarch64.dmg > SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

`LICENSE` and `THIRD_PARTY_NOTICES.txt` travel inside the app (§3) and in the tagged source. All new
releases must pass the distribution gate; the first beta's unnotarized warning is historical only.
Never suggest turning off Gatekeeper or removing the quarantine attribute. A public release, and the
README's links to it, need a public repository (changing visibility is the maintainer's
decision).

## 10. Homebrew Cask integration

There is no published Snipvero cask or tap yet. Apple acceptance does not register one. After a
**new notarized release is published**, a maintainer may create `ugokkaya/homebrew-tap` and add
the generated `<output-dir>/dist/snipvero.rb` as `Casks/snipvero.rb`. Do not publish the validation
cask for `0.1.0-beta.1`: its URL would download the old ad-hoc asset, not the new notarized candidate.

The generated cask uses the final **stapled DMG's** SHA-256 (stapling changes the file), immutable
versioned GitHub release URL, `app "Snipvero.app"`, `arch: :arm64` and `macos: :sonoma` (14+).
It declares `auto_updates true`, because the app can update itself (ADR-028). It never disables
Gatekeeper, clears quarantine, resets permissions, or deletes screenshots.
Beta livecheck is skipped so the stable GitHub latest-release feed cannot silently change channels.

After explicit approval to create/push the tap and a publicly downloadable signed release:

```sh
brew tap ugokkaya/tap
brew style --cask ugokkaya/tap/snipvero
brew audit --cask --online ugokkaya/tap/snipvero
brew fetch --cask ugokkaya/tap/snipvero
brew install --cask ugokkaya/tap/snipvero
```

Test on a clean Apple silicon Mac: install, launch, Screen Recording, capture/copy/save, upgrade,
and uninstall. Do not use `--no-quarantine` or bypass audit failures. Do not overwrite an existing
manual installation without backing it up. These online/install/upgrade tests cannot pass until
the new release URL and tap exist; they have not been claimed as completed.

For later releases, copy the newly generated cask into the tap in a reviewed change, verify the
public download's checksum against `SHA256SUMS.txt`, audit, then push only with approval. A separate
tap avoids assuming acceptance into `Homebrew/homebrew-cask`; upstream inclusion also depends on
[Homebrew's acceptance policy](https://docs.brew.sh/Acceptable-Casks), not just notarization.

## 11. Local updater test (macOS)

`scripts/updater-local-test.mjs` tests the real update path end to end without the internet, the
release key or the release endpoint. It builds two versions (`0.1.0-beta.3` installed,
`0.1.0-beta.90` offered) as **Snipvero Update Test** (`com.snipvero.updatetest`), so the installed
Snipvero, its settings and its Screen Recording grant are untouched. Their updater endpoint is
`http://127.0.0.1:8765/beta.json` with the plugin's insecure-transport setting and a throwaway
key, which only test builds may use; `pnpm verify:macos` rejects such a build.

Run the commands from the repository root (the script path is relative to it):

```sh
# Optional: a stable local signature keeps a Screen Recording grant across the update (ADR-011).
APPLE_SIGNING_IDENTITY="Snipvero Local Development" \
  node scripts/updater-local-test.mjs prepare --dir /tmp/snipvero-update-test
node scripts/updater-local-test.mjs serve --dir /tmp/snipvero-update-test --scenario newer [--slow]
open "/tmp/snipvero-update-test/Applications/Snipvero Update Test.app"   # Updates row in its window
```

Nothing happens until **Check for Updates…** (or **Check Again** / **Try Again**) is clicked in
the main window's Updates row, the About window or the menu bar menu: opening the app never
checks. Try each entry point once; the menu bar item must show the main window and start the
check in its row. Switch scenarios by typing a name (and ` slow`)
into the running `serve`; `offline` drops every connection. The server logs each request's path,
User-Agent and scenario: one `GET /beta.json` per check, then one `GET /packages/…` per download. Quit the regular Snipvero first, so the two menu bar icons and shortcuts are not
confused.

| Scenario / setup                                                      | Expected                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `newer`                                                               | Offer for 0.1.0-beta.90 with notes; Download and Restart installs and reopens   |
| `newer --slow`, then Cancel                                           | Progress, then back to the offer; app unchanged                                 |
| `newer --slow`, start a capture during the download                   | "Finish or cancel the current capture"; app unchanged; Try Again installs later |
| `same`, `older`                                                       | "is up to date"                                                                 |
| `wrong-arch`                                                          | "not available for your Mac"                                                    |
| `other-key`, `wrong-version`, `corrupted`                             | "could not be verified, so it was not installed"; app unchanged                 |
| `malformed`                                                           | "could not be read"                                                             |
| `server-error`, or no server running                                  | "could not reach the update server"                                             |
| `newer` with `chmod a-w .../Applications`, cancel the macOS prompt    | macOS administrator prompt; "could not be installed"; app unchanged and running |
| `newer` launched from a mounted DMG or a copy Gatekeeper translocated | "Move Snipvero to the Applications folder"                                      |
| After the update                                                      | About shows 0.1.0-beta.90; capture, copy and save work                          |

The bundle swap itself also runs without the UI, on a copy of the installed test build (a
corrupted package must leave it untouched, the genuine one must replace it with a valid signed
app):

```sh
(cd src-tauri && SNIPVERO_UPDATE_TEST_DIR=/tmp/snipvero-update-test cargo test -- --ignored real_install)
```

Afterwards: `chmod u+w` the folder if changed, quit the test app, delete the test directory, and
remove a test grant with `tccutil reset ScreenCapture com.snipvero.updatetest`. The first real
update between two published releases still has to be checked separately (Screen Recording
grant kept, Gatekeeper silent on the replaced app).
