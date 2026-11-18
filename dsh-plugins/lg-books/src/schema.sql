CREATE TABLE IF NOT EXISTS project_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    parent_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    sequence INTEGER,
    active_version_id INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    state TEXT NOT NULL,
    content TEXT NOT NULL,
    reason TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_documents_parent_sequence ON documents(parent_id, sequence, id);
CREATE INDEX IF NOT EXISTS idx_document_versions_document ON document_versions(document_id, version_number DESC);

CREATE TABLE IF NOT EXISTS entity_tags (
    owner_type TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY(owner_type, owner_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_entity_tags_lookup ON entity_tags(owner_type, tag, owner_id);

CREATE TABLE IF NOT EXISTS story_facts (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    value TEXT NOT NULL,
    state TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    source_version_id INTEGER REFERENCES document_versions(id) ON DELETE SET NULL,
    rationale TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_story_facts_state_category ON story_facts(state, category, fact_key);

CREATE TABLE IF NOT EXISTS fact_history (
    id INTEGER PRIMARY KEY,
    fact_id INTEGER NOT NULL REFERENCES story_facts(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    rationale TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_proposals (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    value TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    source_version_id INTEGER REFERENCES document_versions(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fact_proposals_status ON fact_proposals(status, id DESC);

CREATE TABLE IF NOT EXISTS scene_cards (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    chapter_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    pov TEXT NOT NULL DEFAULT '',
    narrative_tense TEXT NOT NULL DEFAULT '',
    time_label TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    characters_json TEXT NOT NULL DEFAULT '[]',
    conflict TEXT NOT NULL DEFAULT '',
    required_information TEXT NOT NULL DEFAULT '',
    emotional_change TEXT NOT NULL DEFAULT '',
    end_state TEXT NOT NULL DEFAULT '',
    word_min INTEGER,
    word_max INTEGER,
    plan TEXT NOT NULL DEFAULT '',
    plan_state TEXT NOT NULL DEFAULT 'empty',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scene_cards_chapter ON scene_cards(chapter_id, document_id);

CREATE TABLE IF NOT EXISTS timeline_entries (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    sort_key TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    state TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_state_sort ON timeline_entries(state, sort_key, id);

CREATE TABLE IF NOT EXISTS foreshadowing (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    setup_note TEXT NOT NULL,
    setup_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    payoff_note TEXT NOT NULL DEFAULT '',
    payoff_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    state TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foreshadowing_state ON foreshadowing(state, id);

CREATE TABLE IF NOT EXISTS review_issues (
    id INTEGER PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    run_id TEXT,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    suggested_actions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_issues_document ON review_issues(document_id, status, id DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(slug,title,kind,content,tags);
