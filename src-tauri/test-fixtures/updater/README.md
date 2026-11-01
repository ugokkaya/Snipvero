# Updater test fixtures

Test-only material for `src-tauri/src/update.rs` and `scripts/updater.spec-node.mjs`. **Not** the
release updater key: these keys were generated with `tauri signer generate` for the tests, and
their private keys were deleted right after signing. Nothing here can sign an update.

| File                        | Content                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `test.pub`                  | Public key of the test key (base64, as in `plugins.updater`)      |
| `package.bin`               | Stand-in package; only its signature matters                      |
| `package.bin.sig`           | Test key, signed for version `0.1.0-beta.4`                       |
| `package.wrong-version.sig` | Test key, signed for version `0.1.0-beta.1` (a downgrade attempt) |
| `package.other-key.sig`     | Another, discarded key, signed for `0.1.0-beta.4`                 |
