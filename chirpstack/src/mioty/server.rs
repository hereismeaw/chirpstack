//! Native, mutually authenticated BSSCI listener.
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, LazyLock},
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::Utc;
use lrwn::EUI64;
use serde_json::{Value, json};
use tokio::{
    io::AsyncWrite,
    net::TcpListener,
    sync::{Mutex, Semaphore, mpsc, watch},
    time::{Instant, timeout},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{self, RootCertStore, server::WebPkiClientVerifier},
};
use uuid::Uuid;

use super::{
    uplink,
    wire::{self, Encoding},
};
use crate::{
    config,
    storage::{gateway, mioty},
};

const MAX_PENDING: usize = 128;
const OP_TIMEOUT: Duration = Duration::from_secs(30);

struct Handle {
    id: Uuid,
    control: mpsc::Sender<Control>,
    shutdown: watch::Sender<bool>,
    tenant_id: crate::storage::fields::Uuid,
}

enum Control {
    Reconcile(EUI64),
    Detach(EUI64),
}

static SESSIONS: LazyLock<Mutex<HashMap<EUI64, Handle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn disconnect(eui: EUI64) {
    if let Some(handle) = SESSIONS.lock().await.get(&eui) {
        let _ = handle.shutdown.send(true);
    }
}

pub async fn reconcile(eui: EUI64) {
    broadcast(eui, false).await;
}
pub async fn detach(eui: EUI64) {
    broadcast(eui, true).await;
}

async fn broadcast(eui: EUI64, detach: bool) {
    let tenant_id = async {
        let dev = crate::storage::device::get(&eui).await?;
        Ok::<_, anyhow::Error>(
            crate::storage::application::get(&dev.application_id)
                .await?
                .tenant_id,
        )
    }
    .await;
    let Ok(tenant_id) = tenant_id else {
        return;
    };
    let sessions = SESSIONS.lock().await;
    for handle in sessions.values() {
        if handle.tenant_id != tenant_id {
            continue;
        }
        let control = if detach {
            Control::Detach(eui)
        } else {
            Control::Reconcile(eui)
        };
        // Disconnect on overflow; reconnect performs a full reconciliation.
        if handle.control.try_send(control).is_err() {
            let _ = handle.shutdown.send(true);
        }
    }
}

pub async fn start(conf: &config::Mioty) -> Result<std::net::SocketAddr> {
    anyhow::ensure!(
        conf.service_center_eui != EUI64::default(),
        "mioty.service_center_eui must be configured"
    );
    anyhow::ensure!(
        conf.max_frame_size > 0 && conf.max_frame_size <= 16 * 1024 * 1024,
        "invalid mioty.max_frame_size"
    );
    anyhow::ensure!(
        conf.max_connections > 0 && conf.idle_timeout_secs >= 30,
        "invalid MIOTY connection limits"
    );
    let ca = tokio::fs::read(&config::get().gateway.ca_cert)
        .await
        .context("Read MIOTY gateway CA")?;
    let mut roots = RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut ca.as_slice()) {
        roots.add(cert?)?;
    }
    let cert = tokio::fs::read(&conf.server_cert)
        .await
        .context("Read MIOTY server certificate")?;
    let certs = rustls_pemfile::certs(&mut cert.as_slice()).collect::<std::io::Result<Vec<_>>>()?;
    let key = tokio::fs::read(&conf.server_key)
        .await
        .context("Read MIOTY server key")?;
    let key = rustls_pemfile::private_key(&mut key.as_slice())?
        .context("MIOTY server private key missing")?;
    let verifier = WebPkiClientVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()?;
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_client_cert_verifier(verifier)
    .with_single_cert(certs, key)?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let listener = TcpListener::bind(&conf.bind)
        .await
        .context("Bind MIOTY listener")?;
    let address = listener.local_addr()?;
    let conf = conf.clone();
    let limit = Arc::new(Semaphore::new(conf.max_connections));
    tracing::info!(bind = %address, "Starting native MIOTY BSSCI listener");
    tokio::spawn(async move {
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(err) => {
                    tracing::error!(error = %err, "MIOTY accept failed");
                    break;
                }
            };
            let Ok(permit) = limit.clone().try_acquire_owned() else {
                drop(socket);
                continue;
            };
            let acceptor = acceptor.clone();
            let conf = conf.clone();
            tokio::spawn(async move {
                let _permit = permit;
                // The timeout closes the connection, so cancellation cannot leave a partial frame in use.
                let result = async {
                    let stream =
                        timeout(Duration::from_secs(10), acceptor.accept(socket)).await??;
                    connection(stream, &conf).await
                }
                .await;
                if let Err(err) = result {
                    tracing::debug!(%peer, error = %err, "MIOTY connection closed");
                }
            });
        }
    });
    Ok(address)
}

fn validate_connect(value: &Value) -> Result<EUI64> {
    anyhow::ensure!(
        value["command"] == "con" && wire::int(value, "opId")? == 0,
        "expected MIOTY connect"
    );
    let version = value["version"].as_str().context("missing BSSCI version")?;
    let parts = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        parts.len() == 3 && parts[0] == 1 && parts[1] == 0,
        "unsupported BSSCI version"
    );
    wire::boolean(value, "bidi")?;
    wire::bytes(value, "snBsUuid", Some(16))?;
    Ok(EUI64::from_be_bytes(
        wire::uint(value, "bsEui")?.to_be_bytes(),
    ))
}

fn validate_certificate(gw: &gateway::Gateway, peer: &[u8]) -> Result<()> {
    anyhow::ensure!(gw.gateway_type == 1, "gateway is not MIOTY");
    let stored = gw
        .tls_certificate
        .as_ref()
        .context("gateway has no provisioned certificate")?;
    let stored = pem::parse(stored)?;
    anyhow::ensure!(
        stored.contents() == peer,
        "certificate does not belong to this gateway"
    );
    Ok(())
}

async fn connection(
    mut stream: tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    conf: &config::Mioty,
) -> Result<()> {
    let peer = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|v| v.first())
        .context("missing gateway certificate")?
        .as_ref()
        .to_vec();
    let (con, encoding) =
        timeout(OP_TIMEOUT, wire::read(&mut stream, conf.max_frame_size)).await??;
    let eui = validate_connect(&con)?;
    let gw = gateway::get(&eui).await?;
    validate_certificate(&gw, &peer)?;
    let id = Uuid::new_v4();
    send(&mut stream, &json!({"command":"conRsp","opId":0,"version":"1.0.0", "scEui":u64::from_be_bytes(conf.service_center_eui.to_be_bytes()),"snResume":false,"snScUuid":id.as_bytes()}), encoding).await?;
    let (complete, enc) =
        timeout(OP_TIMEOUT, wire::read(&mut stream, conf.max_frame_size)).await??;
    anyhow::ensure!(
        enc == encoding && complete["command"] == "conCmp" && wire::int(&complete, "opId")? == 0,
        "expected connect completion"
    );
    let (control_tx, mut control_rx) = mpsc::channel(MAX_PENDING);
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    {
        let mut sessions = SESSIONS.lock().await;
        anyhow::ensure!(
            !sessions.contains_key(&eui),
            "gateway already has an active session"
        );
        sessions.insert(
            eui,
            Handle {
                id,
                control: control_tx,
                shutdown: shutdown_tx,
                tenant_id: gw.tenant_id,
            },
        );
    }
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (input_tx, mut input_rx) = mpsc::channel(16);
    let max_size = conf.max_frame_size;
    let idle = Duration::from_secs(conf.idle_timeout_secs);
    // One dedicated reader owns the framing state. Controls never cancel a read.
    let reader_task = tokio::spawn(async move {
        loop {
            let frame = match timeout(idle, wire::read(&mut reader, max_size)).await {
                Ok(v) => v,
                Err(err) => Err(err.into()),
            };
            let failed = frame.is_err();
            if input_tx.send(frame).await.is_err() || failed {
                break;
            }
        }
    });
    let mut state = Session {
        bidirectional: wire::boolean(&con, "bidi")?,
        ..Default::default()
    };
    let result = async {
        seen(&gw).await?;
        connection_status(&gw, "online").await?;
        mioty::reset_gateway_downlinks(eui).await?;
        for ep in mioty::for_tenant(gw.tenant_id).await? {
            if ep.attached { state.propagate(&mut writer, &ep, encoding).await?; }
        }
        state.initiate(&mut writer, json!({"command":"status"}), encoding).await?;
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                frame = input_rx.recv() => {
                    let (value, enc) = frame.context("MIOTY reader stopped")??;
                    anyhow::ensure!(enc == encoding, "BSSCI encoding changed during session");
                    // Recheck ownership and certificate after CRUD / certificate rotation.
                    let current = gateway::get(&eui).await?;
                    anyhow::ensure!(current.tenant_id == gw.tenant_id, "gateway tenant changed");
                    validate_certificate(&current, &peer)?;
                    state.message(&mut writer, &gw, value, encoding).await?;
                    seen(&gw).await?;
                }
                control = control_rx.recv() => match control {
                    None => break,
                    Some(Control::Detach(eui)) => { state.remove(&mut writer, eui, encoding).await?; }
                    Some(Control::Reconcile(eui)) => {
                        match uplink::endpoint(&gw, eui).await {
                            Ok((_, ep)) if ep.attached => { state.propagate(&mut writer, &ep, encoding).await?; }
                            _ => { state.remove(&mut writer, eui, encoding).await?; }
                        }
                    }
                },
                _ = tick.tick() => {
                    anyhow::ensure!(state.pending.values().all(|(_,at)| at.elapsed() < OP_TIMEOUT), "BSSCI operation timed out");
                    anyhow::ensure!(state.inbound.values().all(|(_,_,at)| at.elapsed() < OP_TIMEOUT), "BSSCI completion timed out");
                    if !state.pending.values().any(|(v,_)| v["command"] == "status") {
                        state.initiate(&mut writer, json!({"command":"status"}), encoding).await?;
                    }
                }
            }
        }
        Ok(())
    }.await;
    reader_task.abort();
    let _ = reader_task.await;
    let mut sessions = SESSIONS.lock().await;
    if sessions.get(&eui).is_some_and(|h| h.id == id) {
        sessions.remove(&eui);
    }
    drop(sessions);
    if let Err(err) = connection_status(&gw, "offline").await {
        tracing::debug!(error = %err, "MIOTY disconnect status update failed");
    }
    result
}

async fn connection_status(gw: &gateway::Gateway, status: &str) -> Result<()> {
    let current = gateway::get(&gw.gateway_id).await?;
    let mut properties = current.properties.into_hashmap();
    properties.insert("mioty_status".into(), status.into());
    gateway::partial_update(
        gw.gateway_id,
        &gateway::GatewayChangeset {
            properties: Some(crate::storage::fields::KeyValue::new(properties)),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

async fn seen(gw: &gateway::Gateway) -> Result<()> {
    gateway::partial_update(
        gw.gateway_id,
        &gateway::GatewayChangeset {
            last_seen_at: Some(Some(Utc::now())),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

async fn send<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
    encoding: Encoding,
) -> Result<()> {
    timeout(
        Duration::from_secs(10),
        wire::write(writer, value, encoding),
    )
    .await??;
    Ok(())
}

#[derive(Default)]
struct Session {
    bidirectional: bool,
    last_bs: i64,
    last_sc: i64,
    pending: HashMap<i64, (Value, Instant)>,
    backlog: VecDeque<Value>,
    // Request, response and deadline; retransmission must use exactly the same request.
    inbound: HashMap<i64, (Value, Value, Instant)>,
}

impl Session {
    async fn initiate<W: AsyncWrite + Unpin>(
        &mut self,
        writer: &mut W,
        mut value: Value,
        enc: Encoding,
    ) -> Result<()> {
        if self.pending.len() >= MAX_PENDING {
            self.backlog.push_back(value);
            return Ok(());
        }
        self.last_sc = self
            .last_sc
            .checked_sub(1)
            .context("SC operation ID exhausted")?;
        value["opId"] = self.last_sc.into();
        self.pending
            .insert(self.last_sc, (value.clone(), Instant::now()));
        send(writer, &value, enc).await
    }

    async fn propagate<W: AsyncWrite + Unpin>(
        &mut self,
        writer: &mut W,
        ep: &mioty::Endpoint,
        enc: Encoding,
    ) -> Result<()> {
        self.initiate(writer, json!({"command":"attPrp", "epEui":u64::from_be_bytes(ep.dev_eui.to_be_bytes()),
            "bidi":ep.ep_class == "A", "nwkSnKey":ep.session_key, "shAddr":ep.short_address,
            "lastPacketCnt":ep.last_packet_counter.max(0), "dualChan":ep.radio_flags & 1 != 0,
            "repetition":ep.radio_flags & 2 != 0,"wideCarrOff":ep.radio_flags & 4 != 0,"longBlkDist":ep.radio_flags & 8 != 0}), enc).await
    }

    async fn remove<W: AsyncWrite + Unpin>(
        &mut self,
        writer: &mut W,
        eui: EUI64,
        enc: Encoding,
    ) -> Result<()> {
        self.initiate(
            writer,
            json!({"command":"detPrp", "epEui":u64::from_be_bytes(eui.to_be_bytes())}),
            enc,
        )
        .await
    }

    async fn message<W: AsyncWrite + Unpin>(
        &mut self,
        writer: &mut W,
        gw: &gateway::Gateway,
        value: Value,
        enc: Encoding,
    ) -> Result<()> {
        let command = value["command"].as_str().context("missing BSSCI command")?;
        let id = wire::int(&value, "opId")?;
        if command == "error" {
            let pending = self.pending.remove(&id);
            anyhow::ensure!(
                pending.is_some() || self.inbound.remove(&id).is_some(),
                "error for unknown operation"
            );
            wire::int(&value, "code")?;
            if let Some((request, _)) = pending {
                if request["command"] == "dlDataQue" {
                    let dl = mioty::pending_downlink(uplink::eui(&request)?).await?;
                    let (dev, _) = uplink::endpoint(gw, dl.dev_eui).await?;
                    super::events::downlink_result(gw, &dev, &dl, "rejected", None).await?;
                }
            }
            if let Some(next) = self.backlog.pop_front() {
                self.initiate(writer, next, enc).await?;
            }
            return send(writer, &json!({"command":"errorAck", "opId":id}), enc).await;
        }
        if id < 0 {
            let (request, _) = self.pending.get(&id).context("unknown SC operation")?;
            let operation = request["command"].as_str().context("missing SC command")?;
            anyhow::ensure!(
                command == format!("{operation}Rsp"),
                "unexpected BSSCI response"
            );
            let complete = format!("{operation}Cmp");
            if operation == "status" {
                wire::int(&value, "code")?;
                anyhow::ensure!(value["message"].is_string(), "invalid status message");
                wire::int(&value, "time")?;
                anyhow::ensure!(
                    value["dutyCycle"]
                        .as_f64()
                        .is_some_and(|v| (0.0..=1.0).contains(&v)),
                    "invalid duty cycle"
                );
            }
            send(writer, &json!({"command":complete,"opId":id}), enc).await?;
            self.pending.remove(&id);
            if let Some(next) = self.backlog.pop_front() {
                self.initiate(writer, next, enc).await?;
            }
            return Ok(());
        }
        anyhow::ensure!(id > 0, "invalid BS operation ID");
        if command.ends_with("Cmp") || command == "errorAck" {
            let (_, response, _) = self
                .inbound
                .get(&id)
                .context("completion for unknown operation")?;
            let expected = if response["command"] == "error" {
                "errorAck".into()
            } else {
                format!(
                    "{}Cmp",
                    response["command"]
                        .as_str()
                        .unwrap()
                        .trim_end_matches("Rsp")
                )
            };
            anyhow::ensure!(command == expected, "unexpected BS completion");
            self.inbound.remove(&id);
            return Ok(());
        }
        if let Some((request, response, _)) = self.inbound.get(&id) {
            anyhow::ensure!(
                request == &value,
                "operation ID reused with different request"
            );
            return send(writer, response, enc).await;
        }
        anyhow::ensure!(
            id > self.last_bs && self.inbound.len() < MAX_PENDING,
            "invalid BS operation sequence"
        );
        self.last_bs = id;
        let mut downlink = None;
        let result = match command {
            "ping" => Ok(()),
            "ulData" => match uplink::receive(gw, &value).await {
                Ok(accepted) => {
                    downlink = accepted;
                    Ok(())
                }
                Err(err) => Err(err),
            },
            "dlDataRes" => self.downlink_result(gw, &value).await,
            // OTA signatures are application-defined in the public MAC specification.
            // Never accept an attachment without an implemented authentication scheme.
            _ => Err(anyhow!("unsupported BSSCI operation")),
        };
        let response = match result {
            Ok(()) => json!({"command":format!("{command}Rsp"),"opId":id}),
            Err(err) => {
                tracing::debug!(gateway_id = %gw.gateway_id, command, error = %err, "MIOTY operation rejected");
                json!({"command":"error","opId":id,"code":if command == "ulData" {22} else {95},"message":"Operation rejected"})
            }
        };
        send(writer, &response, enc).await?;
        self.inbound.insert(id, (value, response, Instant::now()));
        if let Some((ep, counter, true)) = downlink {
            self.queue_downlink(writer, gw, &ep, counter, enc).await?;
        }
        Ok(())
    }

    async fn queue_downlink<W: AsyncWrite + Unpin>(
        &mut self,
        writer: &mut W,
        gw: &gateway::Gateway,
        ep: &mioty::Endpoint,
        counter: u32,
        enc: Encoding,
    ) -> Result<()> {
        // Do not reserve a receive window while earlier operations are backlogged.
        if !self.bidirectional || self.pending.len() >= MAX_PENDING {
            return Ok(());
        }
        let Some((dl, qi)) = mioty::reserve_downlink(ep, gw.gateway_id, counter).await? else {
            return Ok(());
        };
        let data = super::crypto::encode(
            ep.dev_eui,
            &super::application_session_key(ep)?,
            ep.application_crypto,
            counter,
            true,
            &qi.data,
        )?;
        self.initiate(writer, json!({"command":"dlDataQue", "epEui":u64::from_be_bytes(ep.dev_eui.to_be_bytes()),
            "queId":dl.queue_id, "cntDepend":true,"packetCnt":[counter],"userData":[data],"format":0}), enc).await
    }

    async fn downlink_result(&self, gw: &gateway::Gateway, value: &Value) -> Result<()> {
        let eui = uplink::eui(value)?;
        let (dev, _) = uplink::endpoint(gw, eui).await?;
        let dl = mioty::pending_downlink(eui).await?;
        anyhow::ensure!(
            dl.gateway_id == gw.gateway_id && wire::int(value, "queId")? == dl.queue_id,
            "downlink result does not match reservation"
        );
        let sent = match value["result"].as_str() {
            Some("sent") => {
                anyhow::ensure!(
                    wire::uint(value, "packetCnt")? == dl.packet_counter as u64,
                    "downlink counter mismatch"
                );
                uplink::timestamp(wire::int(value, "txTime")?)?;
                true
            }
            Some("invalid" | "expired") => false,
            _ => anyhow::bail!("invalid downlink result"),
        };
        super::events::downlink_result(
            gw,
            &dev,
            &dl,
            value["result"].as_str().unwrap(),
            if sent {
                Some(uplink::timestamp(wire::int(value, "txTime")?)?)
            } else {
                None
            },
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_connect_before_gateway_lookup() {
        let mut con = json!({"command":"con","opId":0,"version":"1.0.4","bsEui":u64::MAX,"bidi":true,"snBsUuid":vec![0;16]});
        assert_eq!(validate_connect(&con).unwrap().to_be_bytes(), [255; 8]);
        con["version"] = "2.0.0".into();
        assert!(validate_connect(&con).is_err());
        con["version"] = "1.0.0".into();
        con["opId"] = 1.into();
        assert!(validate_connect(&con).is_err());
    }
    #[tokio::test]
    async fn rejects_reused_ids_and_wrong_completions() {
        let mut state = Session::default();
        let gw = gateway::Gateway::default();
        let mut out = Vec::new();
        let ping = json!({"command":"ping","opId":1});
        state
            .message(&mut out, &gw, ping.clone(), Encoding::Json)
            .await
            .unwrap();
        state
            .message(&mut out, &gw, ping, Encoding::Json)
            .await
            .unwrap();
        assert!(
            state
                .message(
                    &mut out,
                    &gw,
                    json!({"command":"ulData","opId":1}),
                    Encoding::Json
                )
                .await
                .is_err()
        );
        assert!(
            state
                .message(
                    &mut out,
                    &gw,
                    json!({"command":"ulDataCmp","opId":1}),
                    Encoding::Json
                )
                .await
                .is_err()
        );
        state
            .message(
                &mut out,
                &gw,
                json!({"command":"pingCmp","opId":1}),
                Encoding::Json,
            )
            .await
            .unwrap();
        assert!(
            state
                .message(
                    &mut out,
                    &gw,
                    json!({"command":"ping","opId":1}),
                    Encoding::Json
                )
                .await
                .is_err()
        );
    }

    #[test]
    fn gateway_identity_requires_its_provisioned_certificate() {
        let mut gw = gateway::Gateway {
            gateway_type: 1,
            tls_certificate: Some(
                pem::encode(&pem::Pem::new("CERTIFICATE", vec![1, 2, 3])).into_bytes(),
            ),
            ..Default::default()
        };
        assert!(validate_certificate(&gw, &[1, 2, 3]).is_ok());
        assert!(validate_certificate(&gw, &[3, 2, 1]).is_err());
        gw.gateway_type = 0;
        assert!(validate_certificate(&gw, &[1, 2, 3]).is_err());
    }

    #[tokio::test]
    async fn standalone_python_simulator_uses_native_listener_and_preserves_counters() {
        let _guard = crate::test::prepare().await;
        let (_, ep, gw) = mioty::tests::fixture().await;
        let directory =
            std::env::temp_dir().join(format!("chirpstack-mioty-simulator-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "ChirpStack simulator CA");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
        ];
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let ca = params.self_signed(&ca_key).unwrap();
        let issuer = rcgen::Issuer::from_ca_cert_pem(&ca.pem(), ca_key).unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        params.use_authority_key_identifier_extension = true;
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![
            rcgen::ExtendedKeyUsagePurpose::ClientAuth,
            rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        ];
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &issuer).unwrap();
        let ca_path = directory.join("ca.pem");
        let cert_path = directory.join("gateway.pem");
        let key_path = directory.join("gateway-key.pem");
        let state_path = directory.join("counter.json");
        std::fs::write(&ca_path, ca.pem()).unwrap();
        std::fs::write(&cert_path, cert.pem()).unwrap();
        std::fs::write(&key_path, key.serialize_pem()).unwrap();
        gateway::partial_update(
            gw.gateway_id,
            &gateway::GatewayChangeset {
                tls_certificate: Some(Some(cert.pem().into_bytes())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut conf = (*config::get()).clone();
        conf.gateway.ca_cert = ca_path.to_string_lossy().into_owned();
        config::set(conf);
        let address = start(&config::Mioty {
            bind: "127.0.0.1:0".into(),
            service_center_eui: EUI64::from_be_bytes([9; 8]),
            server_cert: cert_path.to_string_lossy().into_owned(),
            server_key: key_path.to_string_lossy().into_owned(),
            ..Default::default()
        })
        .await
        .unwrap();
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/mioty/simulator.py");
        let python = std::env::var("MIOTY_SIMULATOR_PYTHON").unwrap_or_else(|_| "python3".into());
        let command = || {
            let mut command = tokio::process::Command::new(&python);
            command
                .kill_on_drop(true)
                .arg(&script)
                .args([
                    "--host",
                    "127.0.0.1",
                    "--server-name",
                    "localhost",
                    "--port",
                    &address.port().to_string(),
                ])
                .arg("--ca")
                .arg(&ca_path)
                .arg("--cert")
                .arg(&cert_path)
                .arg("--key")
                .arg(&key_path)
                .args([
                    "--gateway-eui",
                    &gw.gateway_id.to_string(),
                    "--device-eui",
                    &ep.dev_eui.to_string(),
                ])
                .arg("--state-file")
                .arg(&state_path)
                .args([
                    "--listen-seconds",
                    "0.25",
                    "--interval",
                    "0",
                    "--timeout",
                    "5",
                ]);
            command
        };
        crate::storage::device_queue::enqueue_item(crate::storage::device_queue::DeviceQueueItem {
            dev_eui: ep.dev_eui,
            data: vec![9, 8, 7],
            ..Default::default()
        })
        .await
        .unwrap();
        let output = timeout(
            Duration::from_secs(30),
            command()
                .args(["--count", "2", "--reconnect-after", "1"])
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "simulator failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let summary: Value = serde_json::from_str(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .last()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(summary["connections"], 2);
        assert_eq!(summary["uplinks"], 2);
        assert_eq!(summary["downlinks"], 1);
        assert_eq!(mioty::get(ep.dev_eui).await.unwrap().last_packet_counter, 2);
        assert!(
            crate::storage::device_queue::get_for_dev_eui(&ep.dev_eui)
                .await
                .unwrap()
                .is_empty()
        );
        // A second OS process reads the persisted counter and does not rewind.
        let output = timeout(
            Duration::from_secs(15),
            command().arg("--count").arg("1").output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "simulator failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(mioty::get(ep.dev_eui).await.unwrap().last_packet_counter, 3);
        let stored: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(stored["next_counter"], 4);
        let saved = std::fs::read(&state_path).unwrap();
        // Certificate hostname validation must fail before any packet is reserved.
        let output = timeout(
            Duration::from_secs(10),
            command().args(["--server-name", "wrong.invalid"]).output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success());
        assert_eq!(std::fs::read(&state_path).unwrap(), saved);
        super::super::events::deliver_events().await.unwrap();
        assert_eq!(crate::integration::mock::get_txack_events().await.len(), 1);
        for _ in 0..3 {
            assert_eq!(
                crate::integration::mock::get_uplink_event()
                    .await
                    .unwrap()
                    .data,
                vec![1, 2, 3]
            );
        }
        assert!(crate::integration::mock::get_uplink_event().await.is_none());
        timeout(Duration::from_secs(5), async {
            while SESSIONS.lock().await.contains_key(&gw.gateway_id) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        for path in [&ca_path, &cert_path, &key_path, &state_path] {
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(directory).unwrap();
    }

    #[tokio::test]
    async fn tls_gateway_connects_and_reconciles_its_tenant() {
        let _guard = crate::test::prepare().await;
        let (_, ep, gw) = mioty::tests::fixture().await;
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        gateway::partial_update(
            gw.gateway_id,
            &gateway::GatewayChangeset {
                tls_certificate: Some(Some(cert.pem().into_bytes())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut roots = RootCertStore::empty();
        roots.add(cert.der().clone()).unwrap();
        let verifier =
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots.clone()), provider.clone())
                .build()
                .unwrap();
        let server = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                vec![cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(signing_key.serialize_der().into()),
            )
            .unwrap();
        let client = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_client_auth_cert(
                vec![cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(signing_key.serialize_der().into()),
            )
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let stream = TlsAcceptor::from(Arc::new(server))
                .accept(socket)
                .await
                .unwrap();
            connection(
                stream,
                &config::Mioty {
                    service_center_eui: EUI64::from_be_bytes([9; 8]),
                    ..Default::default()
                },
            )
            .await
        });
        let socket = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut client = tokio_rustls::TlsConnector::from(Arc::new(client))
            .connect("localhost".try_into().unwrap(), socket)
            .await
            .unwrap();
        send(&mut client,&json!({"command":"con","opId":0,"version":"1.0.0","bsEui":u64::from_be_bytes(gw.gateway_id.to_be_bytes()),"bidi":true,"snBsUuid":Uuid::new_v4().as_bytes()}),Encoding::Json).await.unwrap();
        let (rsp, _) = timeout(OP_TIMEOUT, wire::read(&mut client, 4096))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rsp["command"], "conRsp");
        assert_eq!(rsp["snResume"], false);
        send(
            &mut client,
            &json!({"command":"conCmp","opId":0}),
            Encoding::Json,
        )
        .await
        .unwrap();
        let (attached, _) = timeout(OP_TIMEOUT, wire::read(&mut client, 4096))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attached["command"], "attPrp");
        assert_eq!(
            attached["epEui"],
            json!(u64::from_be_bytes(ep.dev_eui.to_be_bytes()))
        );
        send(
            &mut client,
            &json!({"command":"attPrpRsp","opId":attached["opId"]}),
            Encoding::Json,
        )
        .await
        .unwrap();
        // status may precede attPrpCmp because it was already sent in the initial batch.
        loop {
            let (message, _) = timeout(OP_TIMEOUT, wire::read(&mut client, 4096))
                .await
                .unwrap()
                .unwrap();
            if message["command"] == "attPrpCmp" {
                break;
            }
            assert_eq!(message["command"], "status");
            send(&mut client,&json!({"command":"statusRsp","opId":message["opId"],"code":0,"message":"ok","time":Utc::now().timestamp_nanos_opt().unwrap(),"dutyCycle":0.0}),Encoding::Json).await.unwrap();
        }
        drop(client);
        let _ = timeout(OP_TIMEOUT, server).await.unwrap().unwrap();
        assert!(!SESSIONS.lock().await.contains_key(&gw.gateway_id));
        assert_eq!(
            gateway::get(&gw.gateway_id)
                .await
                .unwrap()
                .properties
                .into_hashmap()["mioty_status"],
            "offline"
        );
    }

    #[tokio::test]
    async fn simulated_gateway_uplink_downlink_and_duplicate_cycle() {
        let _guard = crate::test::prepare().await;
        let (dev, ep, gw) = mioty::tests::fixture().await;
        let qi = crate::storage::device_queue::enqueue_item(
            crate::storage::device_queue::DeviceQueueItem {
                dev_eui: dev.dev_eui,
                data: vec![9, 8, 7],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for enc in [Encoding::Json, Encoding::MessagePack] {
            let counter = if enc == Encoding::Json { 1 } else { 2 };
            if counter == 2 {
                crate::storage::device_queue::enqueue_item(
                    crate::storage::device_queue::DeviceQueueItem {
                        dev_eui: dev.dev_eui,
                        data: vec![9, 8, 7],
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            }
            let mut state = Session {
                bidirectional: true,
                ..Default::default()
            };
            let ul = json!({"command":"ulData","opId":1,"epEui":u64::from_be_bytes(ep.dev_eui.to_be_bytes()),
                "rxTime":Utc::now().timestamp_nanos_opt().unwrap(),"packetCnt":counter,"rssi":-80,"snr":6,
                "userData":[1,2,3],"dlOpen":true,"responseExp":false,"dlAck":false});
            let mut out = Vec::new();
            state.message(&mut out, &gw, ul.clone(), enc).await.unwrap();
            let mut bytes = out.as_slice();
            let (rsp, _) = wire::read(&mut bytes, 4096).await.unwrap();
            assert_eq!(rsp["command"], "ulDataRsp");
            let (queued, _) = wire::read(&mut bytes, 4096).await.unwrap();
            assert_eq!(queued["command"], "dlDataQue");
            assert_eq!(queued["packetCnt"], json!([counter]));
            assert_eq!(queued["userData"], json!([[9, 8, 7]]));
            assert!(bytes.is_empty());
            // Retransmit before completion: resend only the cached response.
            out.clear();
            state.message(&mut out, &gw, ul, enc).await.unwrap();
            let mut bytes = out.as_slice();
            assert_eq!(
                wire::read(&mut bytes, 4096).await.unwrap().0["command"],
                "ulDataRsp"
            );
            assert!(bytes.is_empty());
            state
                .message(&mut out, &gw, json!({"command":"ulDataCmp","opId":1}), enc)
                .await
                .unwrap();
            state
                .message(
                    &mut out,
                    &gw,
                    json!({"command":"dlDataQueRsp","opId":queued["opId"]}),
                    enc,
                )
                .await
                .unwrap();
            state.message(&mut out,&gw,json!({"command":"dlDataRes","opId":2,"epEui":queued["epEui"],
                "queId":queued["queId"],"result":"sent","packetCnt":counter,"txTime":Utc::now().timestamp_nanos_opt().unwrap()}),enc).await.unwrap();
            state
                .message(
                    &mut out,
                    &gw,
                    json!({"command":"dlDataResCmp","opId":2}),
                    enc,
                )
                .await
                .unwrap();
            assert!(
                crate::storage::device_queue::get_for_dev_eui(&ep.dev_eui)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
        assert!(
            crate::storage::device_queue::get_item(&qi.id.into())
                .await
                .is_err()
        );
        // A gateway registered under another tenant cannot submit this endpoint.
        let foreign = gateway::test::create_gateway(EUI64::from_be_bytes([5; 8])).await;
        assert!(uplink::endpoint(&foreign, ep.dev_eui).await.is_err());
        tokio::time::sleep(config::get().network.deduplication_delay).await;
        super::super::events::deliver_events().await.unwrap();
        let first = crate::integration::mock::get_uplink_event().await.unwrap();
        let second = crate::integration::mock::get_uplink_event().await.unwrap();
        assert_eq!(first.data, vec![1, 2, 3]);
        assert_eq!(second.data, vec![1, 2, 3]);
        assert_ne!(first.deduplication_id, second.deduplication_id);
        let tx_events = crate::integration::mock::get_txack_events().await;
        assert_eq!(tx_events.len(), 2);
        assert!(
            tx_events
                .iter()
                .all(|e| e.gateway_id == gw.gateway_id.to_string())
        );
        assert!(mioty::ready_events().await.unwrap().is_empty());
    }
}
