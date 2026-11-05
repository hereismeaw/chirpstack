//! Database-backed gateway ownership. Every radio mutation locks this row first,
//! so an expired process cannot mutate state after another owner takes over.
use chrono::{Duration, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use lrwn::EUI64;
use uuid::Uuid;

use super::{
    DbConnection,
    error::Error,
    fields, get_async_db_conn,
    schema::{gateway, mioty_gateway_session as sessions},
};

pub const LEASE_SECONDS: i64 = 60;

#[derive(Clone)]
pub struct Lease {
    pub gateway_id: EUI64,
    pub owner: fields::Uuid,
}

pub async fn acquire(gateway_id: EUI64) -> Result<Option<Lease>, Error> {
    let owner = fields::Uuid::from(Uuid::new_v4());
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<_, Error, _>(async |conn| {
        let now = Utc::now();
        let changed = diesel::update(
            sessions::table
                .find(gateway_id)
                .filter(sessions::expires_at.le(now)),
        )
        .set((
            sessions::owner.eq(owner),
            sessions::expires_at.eq(now + Duration::seconds(LEASE_SECONDS)),
        ))
        .execute(conn)
        .await?;
        if changed == 0 {
            let inserted = diesel::insert_into(sessions::table)
                .values((
                    sessions::gateway_id.eq(gateway_id),
                    sessions::owner.eq(owner),
                    sessions::expires_at.eq(now + Duration::seconds(LEASE_SECONDS)),
                    sessions::revision.eq(0i64),
                ))
                .on_conflict(sessions::gateway_id)
                .do_nothing()
                .execute(conn)
                .await?;
            if inserted == 0 {
                return Ok(None);
            }
        }
        Ok(Some(Lease { gateway_id, owner }))
    })
    .await
}

pub async fn renew(lease: &Lease) -> Result<i64, Error> {
    diesel::update(
        sessions::table
            .find(lease.gateway_id)
            .filter(sessions::owner.eq(lease.owner))
            .filter(sessions::expires_at.gt(Utc::now())),
    )
    .set(sessions::expires_at.eq(Utc::now() + Duration::seconds(LEASE_SECONDS)))
    .returning(sessions::revision)
    .get_result(&mut get_async_db_conn().await?)
    .await
    .map_err(|err| Error::from_diesel(err, "MIOTY session lease expired".into()))
}

pub async fn release(lease: &Lease) -> Result<(), Error> {
    diesel::delete(
        sessions::table
            .find(lease.gateway_id)
            .filter(sessions::owner.eq(lease.owner)),
    )
    .execute(&mut get_async_db_conn().await?)
    .await?;
    Ok(())
}

pub async fn owns(lease: &Lease) -> Result<bool, Error> {
    Ok(sessions::table
        .find(lease.gateway_id)
        .filter(sessions::owner.eq(lease.owner))
        .filter(sessions::expires_at.gt(Utc::now()))
        .count()
        .get_result::<i64>(&mut get_async_db_conn().await?)
        .await?
        == 1)
}

/// Keep this lock until the caller commits its transaction. Lease renewal,
/// takeover and mutation are serialized even when a process stalls mid-request.
pub async fn fence(
    conn: &mut DbConnection,
    gateway_id: EUI64,
    lease: Option<&Lease>,
) -> Result<(), Error> {
    let Some(lease) = lease else {
        return Ok(());
    }; // Unleased storage fixtures in unit tests.
    if gateway_id != lease.gateway_id {
        return Err(Error::NotAllowed("MIOTY gateway lease mismatch".into()));
    }
    let changed = diesel::update(
        sessions::table
            .find(gateway_id)
            .filter(sessions::owner.eq(lease.owner))
            .filter(sessions::expires_at.gt(Utc::now())),
    )
    .set(sessions::owner.eq(lease.owner))
    .execute(conn)
    .await?;
    if changed != 1 {
        return Err(Error::NotAllowed(
            "MIOTY gateway session is no longer owned by this connection".into(),
        ));
    }
    Ok(())
}

pub async fn notify(tenant_id: fields::Uuid) -> Result<(), Error> {
    diesel::update(
        sessions::table.filter(
            sessions::gateway_id.eq_any(
                gateway::table
                    .select(gateway::gateway_id)
                    .filter(gateway::tenant_id.eq(tenant_id)),
            ),
        ),
    )
    .set(sessions::revision.eq(sessions::revision + 1i64))
    .execute(&mut get_async_db_conn().await?)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn gateway_lease_serializes_owners_and_fences_expired_connections() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = super::super::mioty::tests::fixture().await;
        let (a, b) = tokio::join!(acquire(gw.gateway_id), acquire(gw.gateway_id));
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(usize::from(a.is_some()) + usize::from(b.is_some()), 1);
        let old = a.or(b).unwrap();
        assert_eq!(renew(&old).await.unwrap(), 0);
        notify(gw.tenant_id).await.unwrap();
        assert_eq!(renew(&old).await.unwrap(), 1);
        diesel::update(sessions::table.find(gw.gateway_id))
            .set(sessions::expires_at.eq(Utc::now() - Duration::seconds(1)))
            .execute(&mut get_async_db_conn().await.unwrap())
            .await
            .unwrap();
        let new = acquire(gw.gateway_id).await.unwrap().unwrap();
        assert!(renew(&old).await.is_err());
        assert!(
            fence(
                &mut *get_async_db_conn().await.unwrap(),
                gw.gateway_id,
                Some(&old)
            )
            .await
            .is_err()
        );
        release(&old).await.unwrap();
        assert!(owns(&new).await.unwrap());
        let now = Utc::now();
        let event = super::super::mioty::Event {
            id: Uuid::new_v4().into(),
            application_id: dev.application_id,
            payload: Vec::new(),
            variables: "{}".into(),
            ready_at: now,
            lease_until: now,
            kind: "uplink".into(),
            rx_key: None,
        };
        assert!(
            super::super::mioty::accept_event_with_lease(
                &ep,
                1,
                gw.gateway_id,
                &event,
                now,
                Some(&old)
            )
            .await
            .is_err()
        );
        assert_eq!(
            super::super::mioty::get(ep.dev_eui)
                .await
                .unwrap()
                .last_packet_counter,
            -1
        );
        assert!(
            super::super::mioty::accept_event_with_lease(
                &ep,
                1,
                gw.gateway_id,
                &event,
                now,
                Some(&new)
            )
            .await
            .unwrap()
        );
        super::super::device_queue::enqueue_item(super::super::device_queue::DeviceQueueItem {
            dev_eui: ep.dev_eui,
            data: vec![1],
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(
            super::super::mioty::reserve_downlink_with_lease(&ep, gw.gateway_id, 1, Some(&old))
                .await
                .is_err()
        );
        let (dl, _) =
            super::super::mioty::reserve_downlink_with_lease(&ep, gw.gateway_id, 1, Some(&new))
                .await
                .unwrap()
                .unwrap();
        let result = super::super::mioty::Event {
            id: Uuid::new_v4().into(),
            kind: "txack".into(),
            ..event.clone()
        };
        assert!(
            super::super::mioty::finish_downlink_with_lease(&dl, true, &result, Some(&old))
                .await
                .is_err()
        );
        assert!(
            super::super::mioty::pending_downlink(ep.dev_eui)
                .await
                .is_ok()
        );
        super::super::mioty::finish_downlink_with_lease(&dl, true, &result, Some(&new))
            .await
            .unwrap();
        release(&new).await.unwrap();
        assert!(acquire(gw.gateway_id).await.unwrap().is_some());
    }
}
