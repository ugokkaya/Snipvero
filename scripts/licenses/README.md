# License texts for components published without one

`scripts/third-party-notices.mjs` uses these when a crate's package has no license file. Each
text comes from the component's source repository (fetched 2026-10-31):

| File                                    | Used for                                                       | Source                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `objc2-MIT.txt`                         | `objc2`, `objc2-*`, `block2`, `dispatch2` (MIT, or MIT chosen) | `LICENSE-MIT.txt` of github.com/madsmtm/objc2 (`main`; the tags of the versions in use only link to the MIT license) |
| `rust-alloc-no-stdlib-BSD-3-Clause.txt` | `alloc-stdlib`                                                 | `LICENSE` of github.com/dropbox/rust-alloc-no-stdlib (identical to the file shipped in the `alloc-no-stdlib` crate)  |
| `MPL-2.0.txt`                           | `selectors`                                                    | mozilla.org/media/MPL/2.0/index.txt; the crate's source is github.com/servo/stylo and crates.io                      |
| `webview2-rs-MIT.txt`                   | `webview2-com`, `webview2-com-sys`, `webview2-com-macros`      | `LICENSE` of github.com/wravery/webview2-rs (Windows build only)                                                     |
| `clipboard-win-BSL-1.0.txt`             | `clipboard-win`                                                | `LICENSE` of github.com/DoumanAsh/clipboard-win (Windows build only)                                                 |
| `rust-MIT.txt`                          | Rust standard library (linked into every Rust executable)      | `LICENSE-MIT` of github.com/rust-lang/rust                                                                           |

When a dependency update adds a crate without a license file, the script fails and names it: add
its text here, with its source, and a pattern in the script's `fallbacks` list.
