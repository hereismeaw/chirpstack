use super::{crypto, wire};
use crate::{
    codec, config,
    storage::{self, application, device, device_profile, gateway, metrics, mioty, tenant},
};
use anyhow::{Context, Result};
use chirpstack_api::{gw, integration as events};
use chrono::{DateTime, Utc};
use lrwn::EUI64;
use prost::Message;
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

pub fn eui(value: &Value) -> Result<EUI64> {
    Ok(EUI64::from_be_bytes(
        wire::uint(value, "epEui")?.to_be_bytes(),
    ))
}
pub fn timestamp(ns: i64) -> Result<DateTime<Utc>> {
    DateTime::from_timestamp(
        ns.div_euclid(1_000_000_000),
        ns.rem_euclid(1_000_000_000) as u32,
    )
    .context("invalid MIOTY time")
}

pub async fn endpoint(
    gw: &gateway::Gateway,
    eui: EUI64,
) -> Result<(device::Device, mioty::Endpoint)> {
    let dev = device::get(&eui).await?;
    anyhow::ensure!(
        dev.device_type == 1 && !dev.is_disabled,
        "MIOTY endpoint is unavailable"
    );
    let app = application::get(&dev.application_id).await?;
    anyhow::ensure!(
        app.tenant_id == gw.tenant_id,
        "MIOTY gateway and endpoint belong to different tenants"
    );
    Ok((dev, mioty::get(eui).await?))
}

pub async fn device_info(dev: &device::Device) -> Result<events::DeviceInfo> {
    let app = application::get(&dev.application_id).await?;
    let tenant = tenant::get(&app.tenant_id).await?;
    let dp = device_profile::get(&dev.device_profile_id).await?;
    let mut tags = app.tags.into_hashmap();
    tags.extend(dp.tags.into_hashmap());
    tags.extend(dev.tags.into_hashmap());
    tags.insert("protocol".into(), "mioty".into());
    Ok(events::DeviceInfo {
        tenant_id: tenant.id.to_string(),
        tenant_name: tenant.name,
        application_id: app.id.to_string(),
        application_name: app.name,
        device_profile_id: dp.id.to_string(),
        device_profile_name: dp.name,
        device_name: dev.name.clone(),
        dev_eui: dev.dev_eui.to_string(),
        tags,
        ..Default::default()
    })
}

pub async fn receive(
    gw: &gateway::Gateway,
    value: &Value,
) -> Result<Option<(mioty::Endpoint, u32, bool)>> {
    let eui = eui(value)?;
    let (dev, ep) = endpoint(gw, eui).await?;
    anyhow::ensure!(ep.attached, "MIOTY endpoint is not attached");
    let counter = u32::try_from(wire::uint(value, "packetCnt")?)?;
    let time = timestamp(wire::int(value, "rxTime")?)?;
    // Reject a base station clock far in the future before persisting last-seen.
    anyhow::ensure!(
        time <= Utc::now() + chrono::Duration::minutes(5),
        "MIOTY reception time is in the future"
    );
    let payload = wire::bytes(value, "userData", None)?;
    anyhow::ensure!(
        payload.len() <= 245,
        "MIOTY uplink payload exceeds 245 bytes"
    );
    let dl_open = wire::boolean(value, "dlOpen")?;
    let response_exp = wire::boolean(value, "responseExp")?;
    let _ack = wire::boolean(value, "dlAck")?;
    anyhow::ensure!(
        !response_exp || dl_open,
        "MIOTY response requires an open downlink window"
    );
    let data = crypto::decode(
        eui,
        &super::application_session_key(&ep)?,
        ep.application_crypto,
        counter,
        &payload,
    )?;
    let format = u8::try_from(value.get("format").and_then(Value::as_u64).unwrap_or(0))?;
    let rssi = value
        .get("rssi")
        .and_then(Value::as_f64)
        .context("MIOTY RSSI missing")?;
    let snr = value
        .get("snr")
        .and_then(Value::as_f64)
        .context("MIOTY SNR missing")?;
    let mut metadata = HashMap::from([
        ("protocol".into(), "mioty".into()),
        ("format".into(), format.to_string()),
    ]);
    for field in ["profile", "mode", "eqSnr", "rxDuration"] {
        if let Some(v) = value.get(field) {
            metadata.insert(
                field.into(),
                v.as_str()
                    .map(String::from)
                    .unwrap_or_else(|| v.to_string()),
            );
        }
    }
    let rx = gw::UplinkRxInfo {
        gateway_id: gw.gateway_id.to_string(),
        gw_time: Some(time.into()),
        ns_time: Some(Utc::now().into()),
        rssi: rssi as i32,
        snr: snr as f32,
        metadata,
        ..Default::default()
    };
    let redis_key = storage::redis_key(format!(
        "mioty:rx:{}:{}:{}",
        eui, ep.attach_counter, counter
    ));
    let mut redis = storage::get_async_redis_conn().await?;
    let _: () = redis::pipe()
        .hset(
            &redis_key,
            gw.gateway_id.to_string(),
            serde_json::to_string(&rx)?,
        )
        .ignore()
        .expire(&redis_key, 60)
        .ignore()
        .query_async(&mut redis)
        .await?;
    let info = device_info(&dev).await?;
    let dp = device_profile::get(&dev.device_profile_id).await?;
    let object = match codec::binary_to_struct(
        dp.payload_codec_runtime,
        time,
        format,
        &dev.variables,
        &dp.payload_codec_script,
        &data,
    )
    .await
    {
        Ok(object) => object,
        Err(err) => {
            tracing::warn!(dev_eui=%eui,error=%err,"MIOTY payload codec failed");
            None
        }
    };
    let id = Uuid::new_v4();
    let delay = config::get().network.deduplication_delay;
    let event = events::UplinkEvent {
        deduplication_id: id.to_string(),
        time: Some(time.into()),
        device_info: Some(info),
        f_cnt: counter,
        f_port: 0,
        data,
        object,
        rx_info: vec![rx],
        ..Default::default()
    };
    let ready_at = Utc::now() + chrono::Duration::from_std(delay)?;
    if !mioty::accept_event(
        &ep,
        counter,
        gw.gateway_id,
        &mioty::Event {
            id: id.into(),
            application_id: dev.application_id,
            payload: event.encode_to_vec(),
            variables: serde_json::to_string(&dev.variables.into_hashmap())?,
            ready_at,
            lease_until: ready_at,
            kind: "uplink".into(),
            rx_key: Some(redis_key),
        },
        time,
    )
    .await?
    {
        return Ok(None);
    }
    // Metrics are best effort after the acceptance transaction.
    if let Err(err) = metrics::save(
        &format!("gw:{}", gw.gateway_id),
        &metrics::Record {
            time: time.into(),
            kind: metrics::Kind::ABSOLUTE,
            metrics: HashMap::from([("rx_count".into(), 1.0)]),
        },
        &[
            metrics::Aggregation::MINUTE,
            metrics::Aggregation::HOUR,
            metrics::Aggregation::DAY,
            metrics::Aggregation::MONTH,
        ],
    )
    .await
    {
        tracing::warn!(error=%err,"MIOTY metrics update failed");
    }
    Ok(Some((ep, counter, dl_open)))
}
