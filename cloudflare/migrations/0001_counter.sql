CREATE TABLE IF NOT EXISTS download_totals (
  resource_key TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  last_download_at TEXT
);

CREATE TABLE IF NOT EXISTS download_events (
  event_id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS download_events_created_at_idx
  ON download_events (created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx
  ON rate_limits (window_start);

-- A trigger keeps event insertion and the aggregate counters atomic. INSERT OR
-- IGNORE retries do not fire this trigger twice because event_id is unique.
CREATE TRIGGER IF NOT EXISTS count_new_download
AFTER INSERT ON download_events
BEGIN
  INSERT INTO download_totals (resource_key, total, last_download_at)
  VALUES ('__total__', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (resource_key) DO UPDATE SET
    total = total + 1,
    last_download_at = excluded.last_download_at;

  INSERT INTO download_totals (resource_key, total, last_download_at)
  VALUES (NEW.resource_key, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (resource_key) DO UPDATE SET
    total = total + 1,
    last_download_at = excluded.last_download_at;
END;
