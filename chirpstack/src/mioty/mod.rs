//! Native MIOTY service center embedded in ChirpStack.
use crate::api::error::ToStatus;
use crate::{
    config,
    storage::{device, device_queue, mioty},
};
use chirpstack_api::{api, tonic::Status};
use lrwn::EUI64;

mod crypto;
mod events;
mod server;
mod uplink;
mod wire;

pub async fn setup() -> anyhow::Result<()> {
    let conf = config::get();
    if conf.mioty.enabled {
        server::start(&conf.mioty).await?;
        events::start_outbox();
    }
    Ok(())
}

pub fn enabled() -> Result<(), Status> {
    if !config::get().mioty.enabled {
        return Err(Status::failed_precondition(
            "native MIOTY backend is disabled",
        ));
    }
    Ok(())
}

pub async fn create_gateway(_gw: &crate::storage::gateway::Gateway) -> Result<(), Status> {
    enabled()
}
pub async fn update_gateway(
    gw: &crate::storage::gateway::Gateway,
    values: &api::Gateway,
) -> Result<(), Status> {
    if values.tenant_id != gw.tenant_id.to_string() {
        return Err(Status::invalid_argument(
            "Mioty gateways cannot move between tenants",
        ));
    }
    Ok(())
}
pub async fn delete_gateway(gw: &crate::storage::gateway::Gateway) -> Result<(), Status> {
    if mioty::gateway_has_pending(gw.gateway_id)
        .await
        .map_err(|e| e.status())?
    {
        return Err(Status::failed_precondition(
            "wait for pending Mioty downlinks before deleting this gateway",
        ));
    }
    server::disconnect(gw.gateway_id).await;
    Ok(())
}

fn key(value: &str, required: bool) -> Result<Vec<u8>, Status> {
    if value.is_empty() && !required {
        return Ok(Vec::new());
    }
    let key = hex::decode(value)
        .map_err(|_| Status::invalid_argument("MIOTY keys must be hexadecimal"))?;
    if key.len() != 16 {
        return Err(Status::invalid_argument(
            "MIOTY AES-128 keys must contain 16 bytes",
        ));
    }
    Ok(key)
}

pub fn validate_device(values: Option<&api::MiotyDevice>, create: bool) -> Result<(), Status> {
    enabled()?;
    let v =
        values.ok_or_else(|| Status::invalid_argument("MIOTY endpoint settings are required"))?;
    if !["A", "Z"].contains(&v.ep_class.as_str()) || v.short_address > 65535 {
        return Err(Status::invalid_argument(
            "invalid MIOTY endpoint class or short address",
        ));
    }
    if ![0, 1, 17].contains(&v.application_crypto) {
        return Err(Status::invalid_argument(
            "unsupported MIOTY application crypto mode",
        ));
    }
    if v.ep_class == "A" && !v.pre_attach {
        return Err(Status::invalid_argument(
            "OTA attachment is not supported yet; enable pre-attach for Class A devices",
        ));
    }
    key(&v.network_key, create)?;
    key(&v.application_key, create && v.application_crypto != 0)?;
    Ok(())
}

pub async fn validate_profile(
    application_id: crate::storage::fields::Uuid,
    profile_id: crate::storage::fields::Uuid,
) -> Result<(), Status> {
    let app = crate::storage::application::get(&application_id)
        .await
        .map_err(|e| e.status())?;
    let profile = crate::storage::device_profile::get(&profile_id)
        .await
        .map_err(|e| e.status())?;
    if profile.tenant_id.is_some_and(|id| id != app.tenant_id) {
        return Err(Status::invalid_argument(
            "Mioty device profile and application must belong to the same tenant",
        ));
    }
    Ok(())
}

fn flags(v: &api::MiotyDevice) -> i16 {
    i16::from(v.dual_channel)
        | (i16::from(v.repetition) << 1)
        | (i16::from(v.wide_carrier_offset) << 2)
        | (i16::from(v.long_block_distance) << 3)
}

pub async fn create_device(
    d: device::Device,
    v: &api::MiotyDevice,
) -> Result<device::Device, Status> {
    validate_device(Some(v), true)?;
    let network_key = key(&v.network_key, true)?;
    let ep = mioty::Endpoint {
        dev_eui: d.dev_eui,
        ep_class: v.ep_class.clone(),
        short_address: v.short_address as i32,
        session_key: network_key.clone(),
        network_key,
        application_key: key(&v.application_key, v.application_crypto != 0)?,
        application_crypto: v.application_crypto as i16,
        session_context: Vec::new(),
        attach_counter: -1,
        last_packet_counter: -1,
        last_downlink_counter: -1,
        pre_attach: v.pre_attach,
        attached: v.pre_attach || v.ep_class == "Z",
        radio_flags: flags(v),
        serving_gateway: None,
    };
    let d = device::create_with_mioty(d, Some(ep))
        .await
        .map_err(|e| e.status())?;
    server::reconcile(d.dev_eui).await;
    Ok(d)
}

pub async fn get_device(d: &device::Device) -> Result<api::MiotyDevice, Status> {
    let ep = mioty::get(d.dev_eui).await.map_err(|e| e.status())?;
    Ok(api::MiotyDevice {
        ep_class: ep.ep_class,
        short_address: ep.short_address as u32,
        pre_attach: ep.pre_attach,
        dual_channel: ep.radio_flags & 1 != 0,
        repetition: ep.radio_flags & 2 != 0,
        wide_carrier_offset: ep.radio_flags & 4 != 0,
        long_block_distance: ep.radio_flags & 8 != 0,
        application_crypto: ep.application_crypto as u32,
        ..Default::default()
    })
}

pub async fn update_device(
    d: device::Device,
    v: &api::MiotyDevice,
) -> Result<device::Device, Status> {
    validate_device(Some(v), false)?;
    let mut ep = mioty::get(d.dev_eui).await.map_err(|e| e.status())?;
    ep.ep_class = v.ep_class.clone();
    ep.short_address = v.short_address as i32;
    ep.pre_attach = v.pre_attach;
    ep.radio_flags = flags(v);
    ep.application_crypto = v.application_crypto as i16;
    if !v.network_key.is_empty() {
        ep.network_key = key(&v.network_key, true)?;
        ep.session_key = ep.network_key.clone();
        ep.session_context.clear();
        ep.attached = v.pre_attach || v.ep_class == "Z";
        // Counter state is retained: editing keys must not silently permit replay.
    }
    if !v.application_key.is_empty() {
        ep.application_key = key(&v.application_key, true)?;
    }
    if ep.application_crypto != 0 && ep.application_key.len() != 16 {
        return Err(Status::invalid_argument(
            "application key is required for the selected crypto mode",
        ));
    }
    if v.pre_attach || v.ep_class == "Z" {
        ep.attached = true;
    }
    mioty::update(
        &ep,
        d,
        v.network_key.is_empty(),
        v.application_key.is_empty(),
    )
    .await
    .map_err(|e| e.status())
}

pub async fn delete_device(d: &device::Device) -> Result<(), Status> {
    let app = crate::storage::application::get(&d.application_id)
        .await
        .map_err(|e| e.status())?;
    mioty::delete_device(d.dev_eui)
        .await
        .map_err(|e| e.status())?;
    // Notify after commit, with explicit ownership because the device is gone.
    server::notify_tenant(app.tenant_id, d.dev_eui, true).await;
    Ok(())
}

pub async fn device_updated(eui: EUI64) {
    server::reconcile(eui).await;
}

pub async fn send_downlink(d: &device::Device, data: Vec<u8>) -> Result<String, Status> {
    enabled()?;
    if d.is_disabled {
        return Err(Status::failed_precondition("device is disabled"));
    }
    let ep = mioty::get(d.dev_eui).await.map_err(|e| e.status())?;
    if ep.ep_class != "A" {
        return Err(Status::failed_precondition(
            "Mioty Class Z devices do not support downlinks",
        ));
    }
    let limit = if ep.application_crypto == 17 {
        241
    } else {
        245
    };
    if data.len() > limit {
        return Err(Status::invalid_argument(
            "MIOTY payload exceeds the supported length",
        ));
    }
    let qi = device_queue::enqueue_item(device_queue::DeviceQueueItem {
        dev_eui: d.dev_eui,
        data,
        f_port: 0,
        ..Default::default()
    })
    .await
    .map_err(|e| e.status())?;
    // Send when the next uplink announces an open receive window. This is also
    // essential for selecting a unique counter for application encryption.
    Ok(qi.id.to_string())
}

pub async fn get_queue(d: &device::Device) -> Result<Vec<api::DeviceQueueItem>, Status> {
    Ok(device_queue::get_for_dev_eui(&d.dev_eui)
        .await
        .map_err(|e| e.status())?
        .into_iter()
        .map(|qi| api::DeviceQueueItem {
            id: qi.id.to_string(),
            dev_eui: d.dev_eui.to_string(),
            data: qi.data,
            is_pending: qi.is_pending,
            ..Default::default()
        })
        .collect())
}

pub async fn flush_queue(d: &device::Device) -> Result<(), Status> {
    // Pending radio operations cannot be recalled by just deleting local rows.
    // Refuse until their result arrives; unsent entries can be flushed safely.
    mioty::flush_queue(d.dev_eui)
        .await
        .map_err(|e| e.status())?;
    Ok(())
}

pub fn application_session_key(ep: &mioty::Endpoint) -> anyhow::Result<Vec<u8>> {
    if ep.application_crypto == 0 {
        return Ok(Vec::new());
    }
    if ep.session_context.len() == 8 {
        crypto::session_key(
            ep.dev_eui,
            &ep.session_context[..4],
            &ep.session_context[4..],
            &ep.application_key,
        )
    } else {
        Ok(ep.application_key.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_aes_key_lengths() {
        assert!(key("", true).is_err());
        assert!(key("", false).unwrap().is_empty());
        assert!(key("01", true).is_err());
        assert_eq!(key(&"a1".repeat(16), true).unwrap().len(), 16);
    }
}
