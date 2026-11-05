ALTER TABLE mioty_event ADD COLUMN kind TEXT NOT NULL DEFAULT 'uplink' CHECK (kind IN ('uplink', 'txack', 'log'));
ALTER TABLE mioty_event ADD COLUMN rx_key TEXT;
