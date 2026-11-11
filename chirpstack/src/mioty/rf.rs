//! Desired regional policy, independent of the base station's RF driver.
//!
//! BSSCI 1.0.0 rev1 does not specify radio channel-plan configuration or verified
//! hardware capability negotiation. Never translate this model to invented BSSCI
//! fields or treat a base station's `bidi` declaration as Thailand support.
use anyhow::{Result, ensure};
use chirpstack_api::api;

pub const PROFILE_ID: &str = "TH920_925";
pub const DISPLAY_NAME: &str = "Thailand 920–925 MHz (Experimental)";
pub const MIN_HZ: u32 = 920_000_000;
pub const MAX_HZ: u32 = 925_000_000;
pub const MAX_CHANNELS: usize = 128;

pub fn tx_blockers() -> Vec<String> {
    vec![
        "No verified TH920_925 hardware/firmware capability and channel-plan driver".into(),
        "Thailand interoperability and applicable NBTC requirements remain unvalidated".into(),
    ]
}

pub fn eirp_mdbm(config: &api::MiotyRfConfig) -> Option<i64> {
    Some(
        i64::from(config.conducted_power_mdbm?) + i64::from(config.antenna_gain_mdbi?)
            - i64::from(config.cable_loss_mdb?),
    )
}

/// Accept an incomplete receive-only policy; reject invalid supplied values.
pub fn validate(config: &api::MiotyRfConfig) -> Result<()> {
    ensure!(
        config.profile_id == PROFILE_ID,
        "config.profile_id: unsupported profile; expected TH920_925"
    );
    ensure!(
        config.channels.len() <= MAX_CHANNELS,
        "config.channels: maximum 128 channels"
    );
    let mut seen = std::collections::HashSet::new();
    for (index, channel) in config.channels.iter().enumerate() {
        let center = u64::from(channel.center_frequency_hz);
        let width = u64::from(channel.occupied_bandwidth_hz);
        // Twice the frequency avoids rounding away a half-Hz at odd bandwidths.
        // u64 arithmetic also avoids overflow for hostile uint32 inputs.
        ensure!(
            width > 0,
            "config.channels[{index}].occupied_bandwidth_hz: must be positive"
        );
        ensure!(
            2 * center >= 2 * u64::from(MIN_HZ) + width
                && 2 * center + width <= 2 * u64::from(MAX_HZ),
            "config.channels[{index}]: entire occupied envelope must be within 920000000..925000000 Hz"
        );
        ensure!(
            seen.insert(channel.center_frequency_hz),
            "config.channels[{index}].center_frequency_hz: duplicate center"
        );
    }
    if let (Some(eirp), Some(limit)) = (eirp_mdbm(config), config.max_eirp_mdbm) {
        ensure!(
            eirp <= i64::from(limit),
            "config.max_eirp_mdbm: conducted power + antenna gain - cable loss exceeds policy ceiling"
        );
    }
    // No operator-editable 'verified=true' flag can turn unsupported RF into TX.
    ensure!(
        !config.tx_enabled,
        "config.tx_enabled: TH920_925 transmission is unsupported: {}",
        tx_blockers().join("; ")
    );
    Ok(())
}

/// No policy preserves the previous native backend's behavior. Selecting the
/// experimental policy disables all SC-requested radio responses and downlinks.
pub fn permits_tx(config: Option<&api::MiotyRfConfig>) -> Result<bool> {
    match config {
        None => Ok(true),
        Some(config) => {
            validate(config)?;
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> api::MiotyRfConfig {
        api::MiotyRfConfig {
            profile_id: PROFILE_ID.into(),
            ..Default::default()
        }
    }

    #[test]
    fn unconfigured_receive_only_round_trips_without_enabling_tx() {
        let policy = config();
        let json = serde_json::to_string(&policy).unwrap();
        let decoded = serde_json::from_str(&json).unwrap();
        assert_eq!(policy, decoded);
        assert!(!permits_tx(Some(&decoded)).unwrap());
        assert!(permits_tx(None).unwrap());
    }

    #[test]
    fn validates_entire_envelope_including_half_hz_edges() {
        let mut policy = config();
        for (center, width, valid) in [
            (MIN_HZ, 1, false),
            (MIN_HZ + 1, 2, true),
            (MIN_HZ + 1, 3, false),
            (MAX_HZ - 1, 2, true),
            (MAX_HZ - 1, 3, false),
            (MAX_HZ, 1, false),
            (922_500_000, 5_000_000, true),
            (922_500_000, 5_000_001, false),
            (u32::MAX, u32::MAX, false),
            (0, u32::MAX, false),
            (922_500_000, 0, false),
        ] {
            policy.channels = vec![api::MiotyRfChannel {
                center_frequency_hz: center,
                occupied_bandwidth_hz: width,
            }];
            assert_eq!(valid, validate(&policy).is_ok(), "{center}/{width}");
        }
    }

    #[test]
    fn rejects_unsupported_hardware_tx_even_with_complete_desired_policy() {
        let mut policy = config();
        policy.tx_enabled = true;
        assert!(
            validate(&policy)
                .unwrap_err()
                .to_string()
                .contains("unsupported")
        );
        assert!(permits_tx(Some(&policy)).is_err());
        policy.profile_id = "eu1".into();
        assert!(validate(&policy).is_err());
    }

    #[test]
    fn eirp_uses_wide_integer_arithmetic() {
        let mut policy = config();
        assert_eq!(eirp_mdbm(&policy), None);
        policy.conducted_power_mdbm = Some(10_000);
        policy.antenna_gain_mdbi = Some(3_000);
        policy.cable_loss_mdb = Some(1_000);
        policy.max_eirp_mdbm = Some(12_000);
        assert_eq!(eirp_mdbm(&policy), Some(12_000));
        validate(&policy).unwrap();
        policy.max_eirp_mdbm = Some(11_999);
        assert!(validate(&policy).is_err());
        policy.conducted_power_mdbm = Some(i32::MAX);
        policy.antenna_gain_mdbi = Some(i32::MAX);
        assert_eq!(eirp_mdbm(&policy), Some(2 * i64::from(i32::MAX) - 1_000));
    }

    #[test]
    fn bounds_channel_count_and_rejects_duplicates() {
        let mut policy = config();
        let channel = api::MiotyRfChannel {
            center_frequency_hz: 922_500_000,
            occupied_bandwidth_hz: 1,
        };
        policy.channels = vec![channel; 2];
        assert!(validate(&policy).is_err());
        policy.channels = vec![channel; MAX_CHANNELS + 1];
        assert!(validate(&policy).is_err());
    }
}
