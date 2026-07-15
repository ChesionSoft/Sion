use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let source = manifest_dir.join("../public/logo.png");
    let destination = manifest_dir.join("icons/icon.png");
    let rgba = image::open(&source)
        .unwrap_or_else(|error| panic!("failed to read app icon {}: {error}", source.display()))
        .to_rgba8();
    rgba.save(&destination).unwrap_or_else(|error| {
        panic!(
            "failed to write app icon {}: {error}",
            destination.display()
        )
    });
    println!("cargo:rerun-if-changed={}", source.display());
    tauri_build::build()
}
