# Contributing to Snipvero

Thank you for helping. Snipvero is a small, focused app, so please open an issue to discuss a new
feature before writing it; bug fixes and documentation improvements are welcome directly.

## Setup

Requirements and the build steps are in the [README](README.md#install-from-source). macOS 14 or
later on Apple silicon is the platform where the app runs; Windows is planned and only compiled and
tested in CI.

```sh
pnpm install
pnpm tauri dev
```

pnpm is the only supported package manager. Capture needs Screen Recording permission, which macOS
grants to a bundled `.app`, not to `pnpm tauri dev` run from a terminal. [AGENTS.md](AGENTS.md)
shows how to build a bundle with a stable local signing identity so the permission survives
rebuilds, and the developer stress flags.

## Before opening a pull request

All of these must pass; CI runs them on macOS and Windows:

```sh
pnpm check                                # Prettier, ESLint, TypeScript, Vitest
pnpm notices:check                        # license policy and THIRD_PARTY_NOTICES.txt
pnpm build                                # frontend build, embedded by the Rust build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

On macOS, `pnpm tauri build --bundles app,dmg` followed by `pnpm verify:macos` checks the bundle as
CI does.

On Windows/MSVC, `build.rs` embeds `src-tauri/windows-app-manifest.xml` into the application and
test executables (ADR-029). Keep it: the Tauri mock-runtime tests need Common Controls v6 to load.
No special test runner or local environment variable is required.

In the pull request, describe what you tested by hand and on which OS. Behaviour that was only
checked on one platform should say so.

## Rules

The full list is in [AGENTS.md](AGENTS.md#engineering-rules). The most important ones:

- **Privacy:** no telemetry, analytics or uploads. The only network access is the user-started
  update check (ADR-028); do not add another network path or HTTP client.
- **Dependencies:** as few as possible. A new one needs a license from the policy in
  [docs/DECISIONS.md](docs/DECISIONS.md) (ADR-021), a one-line justification in the pull request,
  and a regenerated notices file (`pnpm notices`).
- **Platform code** goes into `#[cfg(target_os = "...")]` modules (`macos.rs`, `windows.rs`).
- **Tests:** new pure logic gets unit tests. Do not weaken or remove tests to make a check pass.
- **Decisions:** an architectural change gets an entry in [docs/DECISIONS.md](docs/DECISIONS.md);
  do not silently reverse a recorded decision.
- Match the surrounding style, and comment why rather than what.

`docs/PROGRESS.md` is a local working log and is ignored by Git; do not add it to a commit.

## Security

Please report security problems privately to the maintainer through GitHub (the repository's
**Security** tab, if private reporting is enabled) rather than in a public issue.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
