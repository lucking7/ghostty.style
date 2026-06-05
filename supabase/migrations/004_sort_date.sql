-- Effective date for the "Newest" sort: prefer the real upstream (iTerm2) upload
-- time, falling back to our own created_at for community uploads (which have no
-- upstream date). Stored + indexed so PostgREST can order by it directly.

ALTER TABLE configs ADD COLUMN IF NOT EXISTS sort_date TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(upstream_added_at, created_at)) STORED;

CREATE INDEX IF NOT EXISTS idx_configs_sort_date ON configs(sort_date DESC);
