//! Durable delivery of native radio events through the existing integrations.
use std::{collections::HashMap, time::Duration};

use anyhow::{Context, Result};
use chirpstack_api::{gw, integration as events};
use chrono::{DateTime, Utc};
use prost::Message;
use uuid::Uuid;

use super::uplink;
use crate::{
    integration,
    storage::{self, device, gateway, mioty},
};

pub fn start_outbox() {
    tokio::spawn(async {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            if let Err(err) = deliver_events().await {
                tracing::warn!(error = %err, "MIOTY outbox polling failed; will retry");
            }
        }
    });
}

pub(super) async fn deliver_events() -> Result<()> {
    for event in mioty::ready_events().await? {
        if !mioty::claim_event(&event).await? {
            continue;
        }
        // Decode, aggregation and integration calls all share a deadline shorter
        // than the SQL lease. One bad event must not stop the rest of the batch.
        match tokio::time::timeout(Duration::from_secs(30), deliver(&event)).await {
            Ok(Ok(())) => mioty::delete_event(event.id).await?,
            _ => {
                tracing::warn!(event_id = %event.id, kind = %event.kind, "MIOTY event delivery failed; event retained")
            }
        }
    }
    Ok(())
}

async fn deliver(event: &mioty::Event) -> Result<()> {
    let vars: HashMap<String, String> = serde_json::from_str(&event.variables)?;
    let application_id = event.application_id.into();
    match event.kind.as_str() {
        "uplink" => {
            let mut payload = events::UplinkEvent::decode(event.payload.as_slice())?;
            // Store the RX key with the event rather than looking up a device's
            // current session, which can change before a delayed event is sent.
            if let Some(key) = &event.rx_key {
                let aggregate: Result<Vec<gw::UplinkRxInfo>> = async {
                    let mut redis = storage::get_async_redis_conn().await?;
                    let values: Vec<String> =
                        redis::cmd("HVALS").arg(key).query_async(&mut redis).await?;
                    values
                        .into_iter()
                        .map(|value| Ok(serde_json::from_str(&value)?))
                        .collect()
                }
                .await;
                if let Ok(rx) = aggregate {
                    if !rx.is_empty() {
                        payload.rx_info = rx;
                    }
                }
            }
            integration::_uplink_event(application_id, &vars, &payload).await
        }
        "txack" => {
            integration::_txack_event(
                application_id,
                &vars,
                &events::TxAckEvent::decode(event.payload.as_slice())?,
            )
            .await
        }
        "log" => {
            integration::_log_event(
                application_id,
                &vars,
                &events::LogEvent::decode(event.payload.as_slice())?,
            )
            .await
        }
        _ => anyhow::bail!("unsupported MIOTY outbox event kind"),
    }
}

/// Record a verified gateway result together with its queue transition.
pub async fn downlink_result(
    gw: &gateway::Gateway,
    dev: &device::Device,
    dl: &mioty::Downlink,
    result: &str,
    tx_time: Option<DateTime<Utc>>,
    lease: Option<&storage::mioty_session::Lease>,
) -> Result<()> {
    anyhow::ensure!(
        dl.dev_eui == dev.dev_eui && dl.gateway_id == gw.gateway_id,
        "downlink ownership mismatch"
    );
    let id = Uuid::new_v4();
    let info = uplink::device_info(dev).await?;
    let now = Utc::now();
    let (kind, payload) = if result == "sent" {
        (
            "txack",
            events::TxAckEvent {
                time: Some(tx_time.context("transmission time missing")?.into()),
                device_info: Some(info),
                queue_item_id: dl.queue_item_id.to_string(),
                f_cnt_down: u32::try_from(dl.packet_counter)?,
                gateway_id: gw.gateway_id.to_string(),
                ..Default::default()
            }
            .encode_to_vec(),
        )
    } else {
        anyhow::ensure!(
            ["invalid", "expired", "rejected"].contains(&result),
            "invalid downlink failure result"
        );
        (
            "log",
            events::LogEvent {
                time: Some(now.into()),
                device_info: Some(info),
                level: events::LogLevel::Warning.into(),
                code: if result == "expired" {
                    events::LogCode::Expired
                } else {
                    events::LogCode::DownlinkGateway
                }
                .into(),
                description:
                    "Mioty downlink was not transmitted; queued for a newer receive window".into(),
                context: HashMap::from([
                    ("event_id".into(), id.to_string()),
                    ("queue_item_id".into(), dl.queue_item_id.to_string()),
                    ("gateway_id".into(), gw.gateway_id.to_string()),
                    ("packet_counter".into(), dl.packet_counter.to_string()),
                    ("result".into(), result.into()),
                ]),
            }
            .encode_to_vec(),
        )
    };
    mioty::finish_downlink_with_lease(
        dl,
        result == "sent",
        &mioty::Event {
            id: id.into(),
            application_id: dev.application_id,
            payload,
            variables: serde_json::to_string(&dev.variables.clone().into_hashmap())?,
            ready_at: now,
            lease_until: now,
            kind: kind.into(),
            rx_key: None,
        },
        lease,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::prelude::*;
    use diesel_async::RunQueryDsl;
    use storage::schema::mioty_event;

    #[tokio::test]
    async fn failed_event_is_retained_without_blocking_other_deliveries() {
        let _guard = crate::test::prepare().await;
        let (dev, _, gw) = mioty::tests::fixture().await;
        let txack = events::TxAckEvent {
            queue_item_id: Uuid::new_v4().to_string(),
            gateway_id: gw.gateway_id.to_string(),
            device_info: Some(uplink::device_info(&dev).await.unwrap()),
            ..Default::default()
        };
        let mut bad = mioty::Event {
            id: Uuid::new_v4().into(),
            application_id: dev.application_id,
            payload: vec![255],
            variables: "{}".into(),
            ready_at: Utc::now(),
            lease_until: Utc::now(),
            kind: "txack".into(),
            rx_key: None,
        };
        let good = mioty::Event {
            id: Uuid::new_v4().into(),
            payload: txack.encode_to_vec(),
            ..bad.clone()
        };
        let mut conn = storage::get_async_db_conn().await.unwrap();
        diesel::insert_into(mioty_event::table)
            .values(&bad)
            .execute(&mut conn)
            .await
            .unwrap();
        diesel::insert_into(mioty_event::table)
            .values(&good)
            .execute(&mut conn)
            .await
            .unwrap();
        drop(conn);
        deliver_events().await.unwrap();
        assert_eq!(
            integration::mock::get_txack_events().await,
            vec![txack.clone()]
        );
        let retained: Vec<mioty::Event> = mioty_event::table
            .load(&mut storage::get_async_db_conn().await.unwrap())
            .await
            .unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].id, bad.id);
        assert!(retained[0].lease_until > Utc::now());
        // Make the retained event deliverable and expire its lease, simulating
        // recovery by a new worker after the previous attempt failed.
        bad.payload = txack.encode_to_vec();
        diesel::update(mioty_event::table.find(bad.id))
            .set((
                mioty_event::payload.eq(&bad.payload),
                mioty_event::lease_until.eq(Utc::now()),
            ))
            .execute(&mut storage::get_async_db_conn().await.unwrap())
            .await
            .unwrap();
        deliver_events().await.unwrap();
        assert_eq!(integration::mock::get_txack_events().await, vec![txack]);
        assert!(
            mioty_event::table
                .load::<mioty::Event>(&mut storage::get_async_db_conn().await.unwrap())
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn failed_radio_send_emits_log_and_releases_only_its_reservation() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = mioty::tests::fixture().await;
        let now = Utc::now();
        let accepted = mioty::Event {
            id: Uuid::new_v4().into(),
            application_id: dev.application_id,
            payload: events::UplinkEvent::default().encode_to_vec(),
            variables: "{}".into(),
            ready_at: now,
            lease_until: now,
            kind: "uplink".into(),
            rx_key: None,
        };
        mioty::accept_event(&ep, 1, gw.gateway_id, &accepted, now)
            .await
            .unwrap();
        let qi = storage::device_queue::enqueue_item(storage::device_queue::DeviceQueueItem {
            dev_eui: ep.dev_eui,
            data: vec![1],
            ..Default::default()
        })
        .await
        .unwrap();
        let (dl, _) = mioty::reserve_downlink(&ep, gw.gateway_id, 1)
            .await
            .unwrap()
            .unwrap();
        downlink_result(&gw, &dev, &dl, "expired", None, None)
            .await
            .unwrap();
        assert!(
            !storage::device_queue::get_item(&qi.id.into())
                .await
                .unwrap()
                .is_pending
        );
        assert!(
            mioty::reserve_downlink(&ep, gw.gateway_id, 1)
                .await
                .unwrap()
                .is_none()
        );
        deliver_events().await.unwrap();
        assert!(integration::mock::get_txack_events().await.is_empty());
        let logs = integration::mock::get_log_events().await;
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].code, events::LogCode::Expired as i32);
        assert_eq!(logs[0].context["queue_item_id"], qi.id.to_string());
        assert_eq!(logs[0].context["result"], "expired");
        assert!(logs[0].context.contains_key("event_id"));
    }
}
