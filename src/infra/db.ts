import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite persistence (node:sqlite, no native dependencies).
 *
 * - proposals: one JSON document per aggregate, guarded by an optimistic `revision`.
 * - proposal_access: denormalised index of who may list which proposal, rebuilt on every save.
 * - audit_log and documents are append-only; triggers reject UPDATE and DELETE.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vendor_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  idp_issuer TEXT NOT NULL,
  idp_subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INTERNAL','EXTERNAL')),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  roles TEXT NOT NULL,
  vendor_organization_id TEXT REFERENCES vendor_organizations(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (idp_issuer, idp_subject)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_access (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('MEMBER','VENDOR')),
  PRIMARY KEY (proposal_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS proposal_access_user ON proposal_access(user_id, kind);

CREATE TABLE IF NOT EXISTS readiness_checks (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  content_version INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  data TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS readiness_by_proposal ON readiness_checks(proposal_id, evaluated_at);

CREATE TABLE IF NOT EXISTS documents (
  ref TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS documents_no_update BEFORE UPDATE ON documents
  BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS documents_no_delete BEFORE DELETE ON documents
  BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  proposal_id TEXT,
  actor_user_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  at TEXT NOT NULL,
  before TEXT,
  after TEXT,
  metadata TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_proposal ON audit_log(proposal_id, seq);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

export class Database {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.db.close();
  }
}
