//! Persistent native MIOTY endpoint state. Secret fields must never be logged.
use super::{
    error::Error,
    fields, get_async_db_conn,
    schema::{application, device, device_queue_item, mioty_device, mioty_downlink, mioty_event},
};
use anyhow::Result;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use lrwn::EUI64;

#[derive(Queryable, Insertable, AsChangeset, Clone, PartialEq)]
#[diesel(table_name = mioty_device)]
#[diesel(treat_none_as_null = true)]
pub struct Endpoint {
    pub dev_eui: EUI64,
    pub ep_class: String,
    pub short_address: i32,
    pub network_key: Vec<u8>,
    pub application_key: Vec<u8>,
    pub session_key: Vec<u8>,
    pub application_crypto: i16,
    pub session_context: Vec<u8>,
    pub attach_counter: i64,
    pub last_packet_counter: i64,
    pub last_downlink_counter: i64,
    pub pre_attach: bool,
    pub attached: bool,
    pub radio_flags: i16,
    pub serving_gateway: Option<EUI64>,
}

pub async fn get(eui: EUI64) -> Result<Endpoint, Error> {
    mioty_device::table
        .find(eui)
        .first(&mut get_async_db_conn().await?)
        .await
        .map_err(|err| Error::from_diesel(err, eui.to_string()))
}

pub async fn update(
    ep: &Endpoint,
    dev: super::device::Device,
    preserve_network_key: bool,
    preserve_application_key: bool,
) -> Result<super::device::Device, Error> {
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<super::device::Device, Error, _>(async |conn| {
        let query = mioty_device::table.find(ep.dev_eui);
        #[cfg(feature = "postgres")]
        let query = query.for_update();
        let current: Endpoint = query.first(conn).await?;
        let mut ep = ep.clone();
        if preserve_network_key {
            ep.network_key.clone_from(&current.network_key);
        }
        if preserve_application_key {
            ep.application_key.clone_from(&current.application_key);
        }
        if ep.application_crypto != 0 && ep.application_key.len() != 16 {
            return Err(Error::Validation(
                "application key is required for the selected crypto mode".into(),
            ));
        }
        if mioty_downlink::table
            .find(ep.dev_eui)
            .count()
            .get_result::<i64>(conn)
            .await?
            != 0
        {
            return Err(Error::NotAllowed(
                "wait for the pending MIOTY downlink before changing device settings".into(),
            ));
        }
        let reset = ep.network_key != current.network_key
            || ep.pre_attach != current.pre_attach
            || ep.ep_class != current.ep_class;
        // Configuration changes never write a stale copy of runtime counters.
        diesel::update(mioty_device::table.find(ep.dev_eui))
            .set((
                mioty_device::ep_class.eq(&ep.ep_class),
                mioty_device::short_address.eq(ep.short_address),
                mioty_device::network_key.eq(&ep.network_key),
                mioty_device::application_key.eq(&ep.application_key),
                mioty_device::application_crypto.eq(ep.application_crypto),
                mioty_device::pre_attach.eq(ep.pre_attach),
                mioty_device::radio_flags.eq(ep.radio_flags),
                mioty_device::attached.eq(if reset {
                    ep.pre_attach || ep.ep_class == "Z"
                } else {
                    current.attached
                }),
                mioty_device::session_key.eq(if reset {
                    &ep.network_key
                } else {
                    &current.session_key
                }),
                mioty_device::session_context.eq(if reset {
                    &[][..]
                } else {
                    current.session_context.as_slice()
                }),
            ))
            .execute(conn)
            .await?;
        super::device::update_with_conn(dev, conn).await
    })
    .await
}

#[derive(Queryable, Insertable, Clone)]
#[diesel(table_name = mioty_downlink)]
pub struct Downlink {
    pub dev_eui: EUI64,
    pub queue_item_id: fields::Uuid,
    pub gateway_id: EUI64,
    pub queue_id: i64,
    pub packet_counter: i64,
}

/// Reserve one item for a receive window across all gateway connections.
#[cfg(test)]
pub async fn reserve_downlink(
    ep: &Endpoint,
    gateway_id: EUI64,
    counter: u32,
) -> Result<Option<(Downlink, super::device_queue::DeviceQueueItem)>, Error> {
    reserve_downlink_with_lease(ep, gateway_id, counter, None).await
}

pub async fn reserve_downlink_with_lease(
    ep: &Endpoint,
    gateway_id: EUI64,
    counter: u32,
    lease: Option<&super::mioty_session::Lease>,
) -> Result<Option<(Downlink, super::device_queue::DeviceQueueItem)>, Error> {
    let eui = ep.dev_eui;
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<_, Error, _>(async |conn| {
        super::mioty_session::fence(conn, gateway_id, lease).await?;
        // The conditional write serializes reservations on SQLite and PostgreSQL.
        let changed = diesel::update(
            mioty_device::table
                .find(eui)
                .filter(mioty_device::attached.eq(true))
                .filter(mioty_device::ep_class.eq("A"))
                .filter(mioty_device::session_key.eq(&ep.session_key))
                .filter(mioty_device::application_key.eq(&ep.application_key))
                .filter(mioty_device::application_crypto.eq(ep.application_crypto))
                .filter(mioty_device::attach_counter.eq(ep.attach_counter))
                .filter(
                    mioty_device::dev_eui.eq_any(
                        device::table
                            .select(device::dev_eui)
                            .filter(device::is_disabled.eq(false)),
                    ),
                )
                .filter(mioty_device::last_packet_counter.eq(i64::from(counter)))
                .filter(mioty_device::last_downlink_counter.lt(i64::from(counter))),
        )
        .set(mioty_device::last_downlink_counter.eq(i64::from(counter)))
        .execute(conn)
        .await?;
        if changed == 0 {
            return Ok(None);
        }
        if mioty_downlink::table
            .find(eui)
            .count()
            .get_result::<i64>(conn)
            .await?
            != 0
        {
            return Ok(None);
        }
        let qi = device_queue_item::table
            .filter(device_queue_item::dev_eui.eq(eui))
            .filter(device_queue_item::is_pending.eq(false))
            .order(device_queue_item::created_at.asc())
            .first::<super::device_queue::DeviceQueueItem>(conn)
            .await
            .optional()?;
        let Some(qi) = qi else {
            return Ok(None);
        };
        let queue_id =
            i64::from_be_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap()) & i64::MAX;
        let dl = Downlink {
            dev_eui: eui,
            queue_item_id: qi.id,
            gateway_id,
            queue_id,
            packet_counter: counter.into(),
        };
        diesel::insert_into(mioty_downlink::table)
            .values(&dl)
            .execute(conn)
            .await?;
        diesel::update(device_queue_item::table.find(qi.id))
            .set((
                device_queue_item::is_pending.eq(true),
                device_queue_item::f_cnt_down.eq(Some(i64::from(counter))),
            ))
            .execute(conn)
            .await?;
        Ok(Some((dl, qi)))
    })
    .await
}

pub async fn pending_downlink(eui: EUI64) -> Result<Downlink, Error> {
    Ok(mioty_downlink::table
        .find(eui)
        .first(&mut get_async_db_conn().await?)
        .await?)
}

pub async fn gateway_has_pending(gateway_id: EUI64) -> Result<bool, Error> {
    Ok(mioty_downlink::table
        .filter(mioty_downlink::gateway_id.eq(gateway_id))
        .count()
        .get_result::<i64>(&mut get_async_db_conn().await?)
        .await?
        != 0)
}

pub async fn flush_queue(eui: EUI64) -> Result<(), Error> {
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<(), Error, _>(async |conn| {
        // Serialize with reservations before checking and deleting queue entries.
        diesel::update(mioty_device::table.find(eui))
            .set(mioty_device::dev_eui.eq(eui))
            .execute(conn)
            .await?;
        if device_queue_item::table
            .filter(device_queue_item::dev_eui.eq(eui))
            .filter(device_queue_item::is_pending.eq(true))
            .count()
            .get_result::<i64>(conn)
            .await?
            != 0
        {
            return Err(Error::NotAllowed(
                "MIOTY downlink is pending at a gateway; wait for its result".into(),
            ));
        }
        diesel::delete(device_queue_item::table.filter(device_queue_item::dev_eui.eq(eui)))
            .execute(conn)
            .await?;
        Ok(())
    })
    .await
}

pub async fn delete_device(eui: EUI64) -> Result<(), Error> {
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<(), Error, _>(async |conn| {
        diesel::update(mioty_device::table.find(eui))
            .set(mioty_device::dev_eui.eq(eui))
            .execute(conn)
            .await?;
        if mioty_downlink::table
            .find(eui)
            .count()
            .get_result::<i64>(conn)
            .await?
            != 0
        {
            return Err(Error::NotAllowed(
                "wait for the pending MIOTY downlink before deleting the device".into(),
            ));
        }
        let count = diesel::delete(device::table.find(eui))
            .execute(conn)
            .await?;
        if count != 1 {
            return Err(Error::NotFound(eui.to_string()));
        }
        Ok(())
    })
    .await
}

/// Retire a confirmed result or release for a later window after an explicit rejection.
#[cfg(test)]
pub async fn finish_downlink(dl: &Downlink, sent: bool, event: &Event) -> Result<(), Error> {
    finish_downlink_with_lease(dl, sent, event, None).await
}

pub async fn finish_downlink_with_lease(
    dl: &Downlink,
    sent: bool,
    event: &Event,
    lease: Option<&super::mioty_session::Lease>,
) -> Result<(), Error> {
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<(), Error, _>(async |conn| {
        super::mioty_session::fence(conn, dl.gateway_id, lease).await?;
        let deleted = diesel::delete(
            mioty_downlink::table
                .find(dl.dev_eui)
                .filter(mioty_downlink::queue_id.eq(dl.queue_id)),
        )
        .execute(conn)
        .await?;
        if deleted != 1 {
            return Err(Error::NotFound(dl.queue_item_id.to_string()));
        }
        if sent {
            diesel::delete(device_queue_item::table.find(dl.queue_item_id))
                .execute(conn)
                .await?;
        } else {
            diesel::update(device_queue_item::table.find(dl.queue_item_id))
                .set(device_queue_item::is_pending.eq(false))
                .execute(conn)
                .await?;
        }
        diesel::insert_into(mioty_event::table)
            .values(event)
            .execute(conn)
            .await?;
        Ok(())
    })
    .await
}

/// A new BSSCI session discards the previous gateway queue. Retry in a newer
/// radio window; preserve last_downlink_counter to prevent counter reuse.
#[cfg(test)]
pub async fn reset_gateway_downlinks(gateway_id: EUI64) -> Result<(), Error> {
    reset_gateway_downlinks_with_lease(gateway_id, None).await
}

pub async fn reset_gateway_downlinks_with_lease(
    gateway_id: EUI64,
    lease: Option<&super::mioty_session::Lease>,
) -> Result<(), Error> {
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<(), Error, _>(async |conn| {
        super::mioty_session::fence(conn, gateway_id, lease).await?;
        let items: Vec<Downlink> = mioty_downlink::table
            .filter(mioty_downlink::gateway_id.eq(gateway_id))
            .load(conn)
            .await?;
        for dl in items {
            diesel::update(device_queue_item::table.find(dl.queue_item_id))
                .set(device_queue_item::is_pending.eq(false))
                .execute(conn)
                .await?;
        }
        diesel::delete(mioty_downlink::table.filter(mioty_downlink::gateway_id.eq(gateway_id)))
            .execute(conn)
            .await?;
        Ok(())
    })
    .await
}

#[derive(Queryable, Insertable, Clone)]
#[diesel(table_name = mioty_event)]
pub struct Event {
    pub id: fields::Uuid,
    pub application_id: fields::Uuid,
    pub payload: Vec<u8>,
    pub variables: String,
    pub ready_at: DateTime<Utc>,
    pub lease_until: DateTime<Utc>,
    pub kind: String,
    pub rx_key: Option<String>,
}

/// Commit acceptance and event together. A process crash cannot leave an
/// accepted packet without its integration event in the durable outbox.
#[cfg(test)]
pub async fn accept_event(
    ep: &Endpoint,
    counter: u32,
    gateway_id: EUI64,
    event: &Event,
    time: DateTime<Utc>,
) -> Result<bool, Error> {
    accept_event_with_lease(ep, counter, gateway_id, event, time, None).await
}

pub async fn accept_event_with_lease(
    ep: &Endpoint,
    counter: u32,
    gateway_id: EUI64,
    event: &Event,
    time: DateTime<Utc>,
    lease: Option<&super::mioty_session::Lease>,
) -> Result<bool, Error> {
    let mut conn = get_async_db_conn().await?;
    conn.transaction::<bool, Error, _>(async |conn| {
        super::mioty_session::fence(conn, gateway_id, lease).await?;
        let changed = diesel::update(
            mioty_device::table
                .find(ep.dev_eui)
                .filter(mioty_device::last_packet_counter.lt(i64::from(counter)))
                .filter(
                    mioty_device::dev_eui.eq_any(
                        device::table
                            .select(device::dev_eui)
                            .filter(device::is_disabled.eq(false)),
                    ),
                )
                .filter(mioty_device::session_key.eq(&ep.session_key))
                .filter(mioty_device::application_key.eq(&ep.application_key))
                .filter(mioty_device::application_crypto.eq(ep.application_crypto))
                .filter(mioty_device::attach_counter.eq(ep.attach_counter))
                .filter(mioty_device::attached.eq(true)),
        )
        .set((
            mioty_device::last_packet_counter.eq(i64::from(counter)),
            mioty_device::serving_gateway.eq(gateway_id),
        ))
        .execute(conn)
        .await?;
        if changed == 0 {
            return Ok(false);
        }
        diesel::insert_into(mioty_event::table)
            .values(event)
            .execute(conn)
            .await?;
        diesel::update(device::table.find(ep.dev_eui))
            .set(device::f_cnt_up.eq(i64::from(counter)))
            .execute(conn)
            .await?;
        diesel::update(
            device::table.find(ep.dev_eui).filter(
                device::last_seen_at
                    .is_null()
                    .or(device::last_seen_at.lt(time)),
            ),
        )
        .set(device::last_seen_at.eq(Some(time)))
        .execute(conn)
        .await?;
        Ok(true)
    })
    .await
}

pub async fn ready_events() -> Result<Vec<Event>, Error> {
    Ok(mioty_event::table
        .filter(mioty_event::ready_at.le(Utc::now()))
        .filter(mioty_event::lease_until.le(Utc::now()))
        .order(mioty_event::ready_at.asc())
        .limit(32)
        .load(&mut get_async_db_conn().await?)
        .await?)
}

pub async fn claim_event(event: &Event) -> Result<bool, Error> {
    Ok(diesel::update(
        mioty_event::table
            .find(event.id)
            .filter(mioty_event::lease_until.eq(event.lease_until)),
    )
    .set(mioty_event::lease_until.eq(Utc::now() + chrono::Duration::seconds(60)))
    .execute(&mut get_async_db_conn().await?)
    .await?
        == 1)
}

pub async fn delete_event(id: fields::Uuid) -> Result<(), Error> {
    diesel::delete(mioty_event::table.find(id))
        .execute(&mut get_async_db_conn().await?)
        .await?;
    Ok(())
}

pub async fn for_tenant(tenant_id: fields::Uuid) -> Result<Vec<Endpoint>, Error> {
    Ok(mioty_device::table
        .inner_join(device::table.inner_join(application::table))
        .select(mioty_device::all_columns)
        .filter(application::tenant_id.eq(tenant_id))
        .filter(device::is_disabled.eq(false))
        .load(&mut get_async_db_conn().await?)
        .await?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::storage::{self, device_queue, gateway};

    pub(crate) async fn fixture() -> (super::super::device::Device, Endpoint, gateway::Gateway) {
        crate::integration::set_mock().await;
        crate::integration::mock::reset().await;
        let dp = storage::device_profile::test::create_device_profile(None).await;
        let app =
            storage::application::test::create_application(dp.tenant_id.map(Into::into)).await;
        let eui = EUI64::from_be_bytes([1; 8]);
        let ep = Endpoint {
            dev_eui: eui,
            ep_class: "A".into(),
            short_address: 1,
            network_key: vec![1; 16],
            application_key: Vec::new(),
            session_key: vec![1; 16],
            application_crypto: 0,
            session_context: Vec::new(),
            attach_counter: -1,
            last_packet_counter: -1,
            last_downlink_counter: -1,
            pre_attach: true,
            attached: true,
            radio_flags: 0,
            serving_gateway: None,
        };
        let dev = storage::device::create_with_mioty(
            storage::device::Device {
                dev_eui: eui,
                application_id: app.id,
                device_profile_id: dp.id,
                device_type: 1,
                name: "mioty".into(),
                ..Default::default()
            },
            Some(ep.clone()),
        )
        .await
        .unwrap();
        let gw = gateway::create(gateway::Gateway {
            gateway_id: EUI64::from_be_bytes([2; 8]),
            tenant_id: app.tenant_id,
            name: "mioty gateway".into(),
            gateway_type: 1,
            ..Default::default()
        })
        .await
        .unwrap();
        (dev, ep, gw)
    }

    fn event(app: fields::Uuid) -> Event {
        Event {
            id: uuid::Uuid::new_v4().into(),
            application_id: app,
            payload: vec![1],
            variables: "{}".into(),
            ready_at: Utc::now(),
            lease_until: Utc::now(),
            kind: "uplink".into(),
            rx_key: None,
        }
    }

    #[tokio::test]
    async fn counter_and_outbox_commit_together() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = fixture().await;
        let bad = event(uuid::Uuid::nil().into());
        assert!(
            accept_event(&ep, 1, gw.gateway_id, &bad, Utc::now())
                .await
                .is_err()
        );
        assert_eq!(get(ep.dev_eui).await.unwrap().last_packet_counter, -1);
        let good = event(dev.application_id);
        assert!(
            accept_event(&ep, 1, gw.gateway_id, &good, Utc::now())
                .await
                .unwrap()
        );
        assert!(
            !accept_event(
                &ep,
                1,
                gw.gateway_id,
                &event(dev.application_id),
                Utc::now()
            )
            .await
            .unwrap()
        );
        assert!(
            !accept_event(
                &ep,
                0,
                gw.gateway_id,
                &event(dev.application_id),
                Utc::now()
            )
            .await
            .unwrap()
        );
        let events = ready_events().await.unwrap();
        assert_eq!(events.len(), 1);
        assert!(claim_event(&events[0]).await.unwrap());
        assert!(!claim_event(&events[0]).await.unwrap());
        assert!(ready_events().await.unwrap().is_empty());
        delete_event(good.id).await.unwrap();
        assert_eq!(storage::device::get(&ep.dev_eui).await.unwrap().f_cnt_up, 1);
    }

    #[tokio::test]
    async fn queue_reservations_survive_reset_without_counter_reuse() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = fixture().await;
        assert!(
            accept_event(
                &ep,
                1,
                gw.gateway_id,
                &event(dev.application_id),
                Utc::now()
            )
            .await
            .unwrap()
        );
        let item = device_queue::enqueue_item(device_queue::DeviceQueueItem {
            dev_eui: ep.dev_eui,
            data: vec![42],
            ..Default::default()
        })
        .await
        .unwrap();
        let (dl, _) = reserve_downlink(&ep, gw.gateway_id, 1)
            .await
            .unwrap()
            .unwrap();
        assert!(
            reserve_downlink(&ep, gw.gateway_id, 1)
                .await
                .unwrap()
                .is_none()
        );
        assert!(flush_queue(ep.dev_eui).await.is_err());
        assert!(update(&ep, dev.clone(), true, true).await.is_err());
        reset_gateway_downlinks(gw.gateway_id).await.unwrap();
        assert!(
            !device_queue::get_item(&item.id.into())
                .await
                .unwrap()
                .is_pending
        );
        assert!(
            reserve_downlink(&ep, gw.gateway_id, 1)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            accept_event(
                &ep,
                2,
                gw.gateway_id,
                &event(dev.application_id),
                Utc::now()
            )
            .await
            .unwrap()
        );
        let (next, _) = reserve_downlink(&ep, gw.gateway_id, 2)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.queue_item_id, dl.queue_item_id);
        assert_ne!(next.queue_id, dl.queue_id);
        finish_downlink(&next, true, &event(dev.application_id))
            .await
            .unwrap();
        assert!(
            device_queue::get_for_dev_eui(&ep.dev_eui)
                .await
                .unwrap()
                .is_empty()
        );
        // A stale configuration read cannot rewind either counter.
        update(&ep, dev, true, true).await.unwrap();
        let current = get(ep.dev_eui).await.unwrap();
        assert_eq!(current.last_packet_counter, 2);
        assert_eq!(current.last_downlink_counter, 2);
    }

    #[tokio::test]
    async fn native_create_and_settings_updates_are_atomic() {
        let _guard = crate::test::prepare().await;
        let (mut dev, mut ep, _) = fixture().await;
        ep.short_address = 999;
        dev.name = String::new();
        assert!(update(&ep, dev.clone(), true, true).await.is_err());
        assert_eq!(get(ep.dev_eui).await.unwrap().short_address, 1);
        dev.dev_eui = EUI64::from_be_bytes([3; 8]);
        dev.name = "new device".into();
        ep.dev_eui = dev.dev_eui;
        ep.network_key = vec![1];
        assert!(
            storage::device::create_with_mioty(dev.clone(), Some(ep))
                .await
                .is_err()
        );
        assert!(storage::device::get(&dev.dev_eui).await.is_err());
    }

    #[tokio::test]
    async fn downlink_result_and_event_roll_back_and_commit_together() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = fixture().await;
        accept_event(
            &ep,
            1,
            gw.gateway_id,
            &event(dev.application_id),
            Utc::now(),
        )
        .await
        .unwrap();
        let qi = device_queue::enqueue_item(device_queue::DeviceQueueItem {
            dev_eui: ep.dev_eui,
            data: vec![42],
            ..Default::default()
        })
        .await
        .unwrap();
        let (dl, _) = reserve_downlink(&ep, gw.gateway_id, 1)
            .await
            .unwrap()
            .unwrap();
        let mut result = event(uuid::Uuid::nil().into());
        result.kind = "txack".into();
        assert!(finish_downlink(&dl, true, &result).await.is_err());
        assert!(
            device_queue::get_item(&qi.id.into())
                .await
                .unwrap()
                .is_pending
        );
        assert_eq!(
            pending_downlink(ep.dev_eui).await.unwrap().queue_id,
            dl.queue_id
        );
        assert_eq!(ready_events().await.unwrap().len(), 1);
        result.application_id = dev.application_id;
        finish_downlink(&dl, true, &result).await.unwrap();
        assert!(device_queue::get_item(&qi.id.into()).await.is_err());
        assert!(pending_downlink(ep.dev_eui).await.is_err());
        assert_eq!(ready_events().await.unwrap().len(), 2);
        // Repeated finalization cannot append a second result event.
        assert!(
            finish_downlink(&dl, true, &event(dev.application_id))
                .await
                .is_err()
        );
        assert_eq!(ready_events().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn simultaneous_gateways_accept_and_reserve_only_once() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = fixture().await;
        let other = gateway::create(gateway::Gateway {
            gateway_id: EUI64::from_be_bytes([3; 8]),
            tenant_id: gw.tenant_id,
            name: "second gateway".into(),
            gateway_type: 1,
            ..Default::default()
        })
        .await
        .unwrap();
        let event1 = event(dev.application_id);
        let event2 = event(dev.application_id);
        let (first, second) = tokio::join!(
            accept_event(&ep, 1, gw.gateway_id, &event1, Utc::now()),
            accept_event(&ep, 1, other.gateway_id, &event2, Utc::now()),
        );
        assert_eq!(u8::from(first.unwrap()) + u8::from(second.unwrap()), 1);
        assert_eq!(ready_events().await.unwrap().len(), 1);
        device_queue::enqueue_item(device_queue::DeviceQueueItem {
            dev_eui: ep.dev_eui,
            data: vec![7],
            ..Default::default()
        })
        .await
        .unwrap();
        let (first, second) = tokio::join!(
            reserve_downlink(&ep, gw.gateway_id, 1),
            reserve_downlink(&ep, other.gateway_id, 1),
        );
        assert_eq!(
            u8::from(first.unwrap().is_some()) + u8::from(second.unwrap().is_some()),
            1
        );
        assert_eq!(
            device_queue::get_for_dev_eui(&ep.dev_eui)
                .await
                .unwrap()
                .iter()
                .filter(|qi| qi.is_pending)
                .count(),
            1
        );
    }
}
