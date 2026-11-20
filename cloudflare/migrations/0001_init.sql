CREATE TABLE IF NOT EXISTS state_store (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS action_log (
  action_id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS action_log_room_idx ON action_log(room);

-- Assertion statements intentionally try to insert NULL into this table when
-- a transactional precondition fails, causing D1 to roll the whole batch back.
CREATE TABLE IF NOT EXISTS batch_guard (
  value INTEGER NOT NULL
);
