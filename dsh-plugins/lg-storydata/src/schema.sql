CREATE TABLE IF NOT EXISTS lg_outline_packs (
  id TEXT PRIMARY KEY, spec TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lg_outline_changes (
  token TEXT PRIMARY KEY, actor TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','committed')),
  reviewer TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lg_outline_revisions (
  id TEXT NOT NULL, module TEXT NOT NULL, revision INTEGER NOT NULL, section TEXT NOT NULL,
  token TEXT NOT NULL REFERENCES lg_outline_changes(token), item TEXT NOT NULL,
  PRIMARY KEY(id,module,revision)
);
CREATE TABLE IF NOT EXISTS lg_outline_heads (
  id TEXT NOT NULL, module TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(id,module), FOREIGN KEY(id,module,revision) REFERENCES lg_outline_revisions(id,module,revision)
);
CREATE INDEX IF NOT EXISTS lg_outline_section ON lg_outline_revisions(section,id,module,revision);
