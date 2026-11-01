fn main() -> Result<(), Box<dyn std::error::Error>> {
    // tauri-build links its resource only into app binaries, not lib unit-test executables.
    // MockRuntime pulls in TaskDialogIndirect, which needs Common Controls v6 at process load.
    // Supply the same manifest through unscoped MSVC linker flags so tests receive it too
    // (tauri-apps/tauri#13419). Do not also embed it through tauri-build's app resource.
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let attributes = if windows_msvc {
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(attributes)?;

    if windows_msvc {
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?)
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // A skipped or conflicting manifest must fail the link rather than crash at startup.
        println!("cargo:rustc-link-arg=/WX");
    }
    Ok(())
}
