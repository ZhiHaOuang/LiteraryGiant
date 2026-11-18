CREATE TABLE IF NOT EXISTS lg_story_data_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lg_story_data_runs (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, metadata_json TEXT NOT NULL, coverage_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lg_story_data_records (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, branch TEXT NOT NULL CHECK(branch='main'), head TEXT NOT NULL, confirmed_head TEXT
);
CREATE TABLE IF NOT EXISTS lg_story_data_revisions (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES lg_story_data_records(id), previous_id TEXT REFERENCES lg_story_data_revisions(id),
 run_id TEXT NOT NULL REFERENCES lg_story_data_runs(id), approval TEXT NOT NULL CHECK(approval IN ('candidate','confirmed','rejected','withdrawn')),
 payload_json TEXT NOT NULL, dependencies_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lg_story_data_revision_record ON lg_story_data_revisions(record_id,created_at,id);
CREATE TABLE IF NOT EXISTS lg_story_data_operations (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
);
