PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS catalog_versions (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_url TEXT,
  source_license TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at TEXT NOT NULL,
  parent_version_id TEXT REFERENCES catalog_versions(id),
  change_summary TEXT
);
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  catalog_version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  brand TEXT,
  variant_attributes_json TEXT NOT NULL,
  unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency)=3),
  available INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0,1)),
  product_url TEXT,
  image_url TEXT,
  source_record_json TEXT,
  UNIQUE(catalog_version_id, sku)
);
CREATE INDEX IF NOT EXISTS catalog_items_by_version ON catalog_items(catalog_version_id);
CREATE TABLE IF NOT EXISTS query_tests (
  id TEXT PRIMARY KEY,
  catalog_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  query_text TEXT NOT NULL,
  expected_sku TEXT NOT NULL,
  frozen_settings_json TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  query_test_id TEXT NOT NULL REFERENCES query_tests(id),
  catalog_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  phase TEXT NOT NULL CHECK (phase IN ('before','after')),
  selected_sku TEXT,
  outcome TEXT NOT NULL,
  diagnosis_json TEXT NOT NULL,
  model_id TEXT,
  prompt_version TEXT NOT NULL,
  candidate_skus_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  query_test_id TEXT NOT NULL REFERENCES query_tests(id),
  before_run_id TEXT NOT NULL REFERENCES test_runs(id),
  sku TEXT NOT NULL,
  field_path TEXT NOT NULL,
  original_value_json TEXT NOT NULL,
  proposed_value_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  approved_by TEXT,
  approved_at TEXT,
  new_catalog_version_id TEXT REFERENCES catalog_versions(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  catalog_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  after_run_id TEXT NOT NULL REFERENCES test_runs(id),
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency)=3),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor >= 0),
  snapshot_json TEXT NOT NULL,
  paypal_order_id TEXT,
  approval_url TEXT,
  paypal_capture_id TEXT,
  paypal_order_status TEXT,
  paypal_capture_status TEXT,
  app_status TEXT NOT NULL DEFAULT 'approval_pending' CHECK (app_status IN ('not_started','approval_pending','approved','capture_pending','completed','cancelled','failed','mismatch')),
  create_request_id TEXT NOT NULL UNIQUE,
  capture_request_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('ai','seller','buyer','paypal','system')),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_by_entity ON audit_events(entity_type, entity_id, created_at);
