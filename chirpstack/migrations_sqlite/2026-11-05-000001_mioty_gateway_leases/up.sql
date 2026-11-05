CREATE TABLE mioty_gateway_session (
    gateway_id BLOB PRIMARY KEY NOT NULL REFERENCES gateway(gateway_id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0
);
