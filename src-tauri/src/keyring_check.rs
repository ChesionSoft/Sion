use keyring::Entry;
use uuid::Uuid;

const SERVICE: &str = "com.chesoft.sion.desktop";

pub fn round_trip_check() -> Result<(), String> {
    let account = format!("desktop-check-{}", Uuid::new_v4());
    let secret = format!("sion-desktop-check-{}", Uuid::new_v4());
    let entry = Entry::new(SERVICE, &account)
        .map_err(|error| format!("credential entry failed: {error}"))?;

    entry
        .set_password(&secret)
        .map_err(|error| format!("credential write failed: {error}"))?;
    let read_back = entry
        .get_password()
        .map_err(|error| format!("credential read failed: {error}"))?;

    let cleanup = entry.delete_credential();
    if read_back != secret {
        return Err("credential read-back does not match the temporary secret".to_string());
    }
    cleanup.map_err(|error| format!("credential cleanup failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a real operating-system credential store"]
    fn round_trips_a_real_system_credential() {
        round_trip_check().unwrap();
    }
}
