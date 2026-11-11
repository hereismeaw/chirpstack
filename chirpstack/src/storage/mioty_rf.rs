//! Optional, additive RF policy. Missing rows preserve existing installations.
use chirpstack_api::api;
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use lrwn::EUI64;

use super::{
    error::Error,
    get_async_db_conn,
    schema::{gateway, mioty_gateway_rf},
};

pub async fn get(eui: EUI64) -> Result<Option<api::MiotyRfConfig>, Error> {
    let value: Option<String> = mioty_gateway_rf::table
        .find(eui)
        .select(mioty_gateway_rf::config_json)
        .first(&mut get_async_db_conn().await?)
        .await
        .optional()?;
    value
        .map(|json| serde_json::from_str(&json).map_err(|e| Error::Anyhow(e.into())))
        .transpose()
}

pub async fn set(eui: EUI64, config: &api::MiotyRfConfig) -> Result<(), Error> {
    crate::mioty::rf::validate(config).map_err(|e| Error::Validation(e.to_string()))?;
    let json = serde_json::to_string(config).map_err(|e| Error::Anyhow(e.into()))?;
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<(), Error, _>(async |conn| {
        // Serialize policy replacement with the gateway row. Refuse changes while
        // a radio operation is outstanding; local policy cannot recall a send.
        lock_gateway(conn, eui).await?;
        let gw: super::gateway::Gateway = gateway::table.find(eui).first(conn).await?;
        if gw.gateway_type != 1 {
            return Err(Error::Validation(
                "RF policy requires a mioty gateway".into(),
            ));
        }
        if super::schema::mioty_downlink::table
            .filter(super::schema::mioty_downlink::gateway_id.eq(eui))
            .count()
            .get_result::<i64>(conn)
            .await?
            != 0
        {
            return Err(Error::NotAllowed(
                "wait for pending mioty downlinks before changing RF policy".into(),
            ));
        }
        diesel::insert_into(mioty_gateway_rf::table)
            .values((
                mioty_gateway_rf::gateway_id.eq(eui),
                mioty_gateway_rf::config_json.eq(&json),
            ))
            .on_conflict(mioty_gateway_rf::gateway_id)
            .do_update()
            .set(mioty_gateway_rf::config_json.eq(&json))
            .execute(conn)
            .await?;
        Ok(())
    })
    .await
}

// A write acquires the lock before any reads on both backends, including SQLite.
async fn lock_gateway(conn: &mut super::DbConnection, eui: EUI64) -> Result<(), Error> {
    if diesel::update(gateway::table.find(eui))
        .set(gateway::gateway_id.eq(eui))
        .execute(conn)
        .await?
        != 1
    {
        return Err(Error::NotFound(eui.to_string()));
    }
    Ok(())
}

pub async fn permits_tx_with_conn(
    conn: &mut super::DbConnection,
    eui: EUI64,
) -> Result<bool, Error> {
    lock_gateway(conn, eui).await?;
    let json: Option<String> = mioty_gateway_rf::table
        .find(eui)
        .select(mioty_gateway_rf::config_json)
        .first(conn)
        .await
        .optional()?;
    let config: Option<api::MiotyRfConfig> = json
        .map(|v| serde_json::from_str(&v))
        .transpose()
        .map_err(|e| Error::Anyhow(e.into()))?;
    crate::mioty::rf::permits_tx(config.as_ref()).map_err(|e| Error::Validation(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mioty_rf_migration_preserves_existing_gateway_and_endpoint() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = super::super::mioty::tests::fixture().await;
        let policy = api::MiotyRfConfig {
            profile_id: crate::mioty::rf::PROFILE_ID.into(),
            ..Default::default()
        };
        set(gw.gateway_id, &policy).await.unwrap();
        {
            let mut conn = get_async_db_conn().await.unwrap();
            #[cfg(feature = "postgres")]
            let (up, down) = (
                include_str!("../../migrations_postgres/2026-11-11-000000_mioty_rf_policy/up.sql"),
                include_str!(
                    "../../migrations_postgres/2026-11-11-000000_mioty_rf_policy/down.sql"
                ),
            );
            #[cfg(feature = "sqlite")]
            let (up, down) = (
                include_str!("../../migrations_sqlite/2026-11-11-000000_mioty_rf_policy/up.sql"),
                include_str!("../../migrations_sqlite/2026-11-11-000000_mioty_rf_policy/down.sql"),
            );
            diesel::sql_query(down).execute(&mut conn).await.unwrap();
            diesel::sql_query(up).execute(&mut conn).await.unwrap();
        }
        assert!(get(gw.gateway_id).await.unwrap().is_none());
        assert_eq!(
            super::super::gateway::get(&gw.gateway_id).await.unwrap(),
            gw
        );
        assert_eq!(super::super::device::get(&dev.dev_eui).await.unwrap(), dev);
        assert!(super::super::mioty::get(ep.dev_eui).await.unwrap() == ep);
        set(gw.gateway_id, &policy).await.unwrap();
        assert_eq!(get(gw.gateway_id).await.unwrap(), Some(policy));
    }

    #[tokio::test]
    async fn mioty_policy_persists_blocks_reservation_and_cascades() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = super::super::mioty::tests::fixture().await;
        assert!(get(gw.gateway_id).await.unwrap().is_none());
        let policy = api::MiotyRfConfig {
            profile_id: crate::mioty::rf::PROFILE_ID.into(),
            ..Default::default()
        };
        // A reservation made before policy selection must first be resolved.
        diesel::update(super::super::schema::mioty_device::table.find(ep.dev_eui))
            .set(super::super::schema::mioty_device::last_packet_counter.eq(1i64))
            .execute(&mut get_async_db_conn().await.unwrap())
            .await
            .unwrap();
        let queued =
            super::super::device_queue::enqueue_item(super::super::device_queue::DeviceQueueItem {
                dev_eui: ep.dev_eui,
                data: vec![1],
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            super::super::mioty::reserve_downlink(&ep, gw.gateway_id, 1)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            super::super::device_queue::get_item(&queued.id.into())
                .await
                .unwrap()
                .f_cnt_down
                .is_none()
        );
        assert!(set(gw.gateway_id, &policy).await.is_err());
        super::super::mioty::reset_gateway_downlinks(gw.gateway_id)
            .await
            .unwrap();
        set(gw.gateway_id, &policy).await.unwrap();
        assert_eq!(get(gw.gateway_id).await.unwrap(), Some(policy.clone()));
        diesel::update(super::super::schema::mioty_device::table.find(ep.dev_eui))
            .set(super::super::schema::mioty_device::last_packet_counter.eq(2i64))
            .execute(&mut get_async_db_conn().await.unwrap())
            .await
            .unwrap();
        assert!(
            super::super::mioty::reserve_downlink(&ep, gw.gateway_id, 2)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            super::super::mioty::get(ep.dev_eui)
                .await
                .unwrap()
                .last_downlink_counter,
            1
        );
        assert!(
            !super::super::device_queue::get_item(&queued.id.into())
                .await
                .unwrap()
                .is_pending
        );
        assert!(
            super::super::mioty::pending_downlink(ep.dev_eui)
                .await
                .is_err()
        );
        let legacy = super::super::gateway::create(super::super::gateway::Gateway {
            gateway_id: EUI64::from_be_bytes([9; 8]),
            tenant_id: gw.tenant_id,
            name: "legacy LoRaWAN".into(),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(set(legacy.gateway_id, &policy).await.is_err());
        assert!(get(legacy.gateway_id).await.unwrap().is_none());
        super::super::gateway::delete(&gw.gateway_id).await.unwrap();
        assert!(get(gw.gateway_id).await.unwrap().is_none());
        assert!(super::super::device::get(&dev.dev_eui).await.is_ok());
    }
}
