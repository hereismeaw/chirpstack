CREATE TABLE mioty_gateway_rf (
    gateway_id BLOB PRIMARY KEY REFERENCES gateway(gateway_id) ON DELETE CASCADE,
    config_json TEXT NOT NULL
);
