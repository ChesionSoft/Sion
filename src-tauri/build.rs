fn main() {
    // Desktop icons live under icons/ (icon.icns / icon.ico / PNGs).
    // Regenerate with: npx tauri icon public/app-icon.png --output src-tauri/icons
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
