CREATE TABLE mioty_gateway_session (
    gateway_id BYTEA PRIMARY KEY NOT NULL REFERENCES gateway(gateway_id) ON DELETE CASCADE,
    owner UUID NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0
);
