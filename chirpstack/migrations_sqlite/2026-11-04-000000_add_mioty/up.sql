ALTER TABLE gateway ADD COLUMN gateway_type SMALLINT NOT NULL DEFAULT 0 CHECK (gateway_type IN (0, 1));
ALTER TABLE device ADD COLUMN device_type SMALLINT NOT NULL DEFAULT 0 CHECK (device_type IN (0, 1));

CREATE TABLE mioty_device (
    dev_eui BLOB PRIMARY KEY NOT NULL REFERENCES device(dev_eui) ON DELETE CASCADE,
    ep_class TEXT NOT NULL CHECK (ep_class IN ('A', 'Z')),
    short_address INTEGER NOT NULL CHECK (short_address BETWEEN 0 AND 65535),
    network_key BLOB NOT NULL CHECK (length(network_key) = 16),
    application_key BLOB NOT NULL CHECK (length(application_key) IN (0, 16)),
    session_key BLOB NOT NULL CHECK (length(session_key) = 16),
    application_crypto SMALLINT NOT NULL DEFAULT 0 CHECK (application_crypto IN (0, 1, 17)),
    session_context BLOB NOT NULL,
    attach_counter BIGINT NOT NULL DEFAULT -1,
    last_packet_counter BIGINT NOT NULL DEFAULT -1,
    last_downlink_counter BIGINT NOT NULL DEFAULT -1,
    pre_attach BOOLEAN NOT NULL DEFAULT FALSE,
    attached BOOLEAN NOT NULL DEFAULT FALSE,
    radio_flags SMALLINT NOT NULL DEFAULT 0,
    serving_gateway BLOB REFERENCES gateway(gateway_id) ON DELETE SET NULL
);

CREATE TABLE mioty_downlink (
    dev_eui BLOB PRIMARY KEY NOT NULL REFERENCES mioty_device(dev_eui) ON DELETE CASCADE,
    queue_item_id TEXT NOT NULL UNIQUE REFERENCES device_queue_item(id) ON DELETE CASCADE,
    gateway_id BLOB NOT NULL REFERENCES gateway(gateway_id),
    queue_id BIGINT NOT NULL,
    packet_counter BIGINT NOT NULL
);
CREATE TABLE mioty_event (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    payload BLOB NOT NULL,
    variables TEXT NOT NULL,
    ready_at TEXT NOT NULL,
    lease_until TEXT NOT NULL
);
CREATE INDEX mioty_event_ready ON mioty_event (lease_until, ready_at);
