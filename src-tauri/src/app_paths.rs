use std::path::{Path, PathBuf};

/// Resolves the single global Sion configuration root for a user home. All
/// application-level state (settings, providers, recent-project metadata)
/// lives under `~/.sion/`; project data never resides here.
pub fn global_sion_root(home: &Path) -> PathBuf {
    home.join(".sion")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_global_configuration_under_the_user_home() {
        assert_eq!(
            global_sion_root(Path::new("/Users/test")),
            PathBuf::from("/Users/test/.sion")
        );
    }
}
