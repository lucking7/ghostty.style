-- Track the original upstream (iTerm2) upload time for "iTerm2 order" sorting.
-- Populated from the first commit that added schemes/<name>.itermcolors upstream.

ALTER TABLE configs ADD COLUMN IF NOT EXISTS upstream_added_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_configs_upstream_added_at
  ON configs(upstream_added_at);
