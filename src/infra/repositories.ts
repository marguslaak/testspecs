import { conflict, notFound } from "../domain/errors.js";
import type { StoredDocument } from "../domain/context.js";
import type { AuditRecord, Proposal, ReadinessCheck, User, VendorOrganization } from "../domain/types.js";
import type { Database } from "./db.js";

type Row = Record<string, unknown>;

export class UserRepository {
  constructor(private readonly store: Database) {}

  private map(r: Row): User {
    return {
      id: r.id as string,
      idpIssuer: r.idp_issuer as string,
      idpSubject: r.idp_subject as string,
      kind: r.kind as User["kind"],
      displayName: r.display_name as string,
      email: r.email as string,
      roles: JSON.parse(r.roles as string),
      vendorOrganizationId: (r.vendor_organization_id as string | null) ?? null,
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at as string,
    };
  }

  get(id: string): User | undefined {
    const r = this.store.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r ? this.map(r) : undefined;
  }

  findBySubject(issuer: string, subject: string): User | undefined {
    const r = this.store.db.prepare("SELECT * FROM users WHERE idp_issuer = ? AND idp_subject = ?").get(issuer, subject) as Row | undefined;
    return r ? this.map(r) : undefined;
  }

  list(): User[] {
    return (this.store.db.prepare("SELECT * FROM users ORDER BY display_name").all() as Row[]).map((r) => this.map(r));
  }

  upsert(u: User) {
    this.store.db
      .prepare(
        `INSERT INTO users (id, idp_issuer, idp_subject, kind, display_name, email, roles, vendor_organization_id, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name, email = excluded.email,
           roles = excluded.roles, vendor_organization_id = excluded.vendor_organization_id, last_seen_at = excluded.last_seen_at`,
      )
      .run(u.id, u.idpIssuer, u.idpSubject, u.kind, u.displayName, u.email, JSON.stringify(u.roles), u.vendorOrganizationId, u.createdAt, u.lastSeenAt);
  }
}

export class VendorOrganizationRepository {
  constructor(private readonly store: Database) {}

  get(id: string): VendorOrganization | undefined {
    const r = this.store.db.prepare("SELECT * FROM vendor_organizations WHERE id = ?").get(id) as Row | undefined;
    return r ? { id: r.id as string, name: r.name as string, createdAt: r.created_at as string } : undefined;
  }

  list(): VendorOrganization[] {
    return (this.store.db.prepare("SELECT * FROM vendor_organizations ORDER BY name").all() as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      createdAt: r.created_at as string,
    }));
  }

  upsert(o: VendorOrganization) {
    this.store.db
      .prepare("INSERT INTO vendor_organizations (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name")
      .run(o.id, o.name, o.createdAt);
  }
}

export class ProposalRepository {
  constructor(private readonly store: Database) {}

  get(id: string): Proposal {
    const r = this.store.db.prepare("SELECT data FROM proposals WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("Proposal", id);
    return JSON.parse(r.data as string);
  }

  /** Inserts a new aggregate (revision 1). */
  insert(p: Proposal) {
    this.store.db
      .prepare("INSERT INTO proposals (id, revision, state, data, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(p.id, p.revision, p.state, JSON.stringify(p), p.updatedAt);
    this.reindex(p);
  }

  /** Compare-and-swap save: succeeds only if nobody saved since `expectedRevision` was read. */
  save(p: Proposal, expectedRevision: number) {
    const res = this.store.db
      .prepare("UPDATE proposals SET revision = ?, state = ?, data = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(p.revision, p.state, JSON.stringify(p), p.updatedAt, p.id, expectedRevision);
    if (Number(res.changes) !== 1) {
      throw conflict("VERSION_CONFLICT", "The proposal was changed by someone else. Reload and try again.", { proposalId: p.id });
    }
    this.reindex(p);
  }

  private reindex(p: Proposal) {
    this.store.db.prepare("DELETE FROM proposal_access WHERE proposal_id = ?").run(p.id);
    const ins = this.store.db.prepare("INSERT OR IGNORE INTO proposal_access (proposal_id, user_id, kind) VALUES (?, ?, ?)");
    for (const m of p.members) ins.run(p.id, m.userId, "MEMBER");
    for (const g of p.vendorGrants) if (g.revokedAt === null) ins.run(p.id, g.userId, "VENDOR");
  }

  listForUser(userId: string, kind: "MEMBER" | "VENDOR"): Proposal[] {
    const rows = this.store.db
      .prepare(
        `SELECT p.data FROM proposals p JOIN proposal_access a ON a.proposal_id = p.id
         WHERE a.user_id = ? AND a.kind = ? ORDER BY p.updated_at DESC`,
      )
      .all(userId, kind) as Row[];
    return rows.map((r) => JSON.parse(r.data as string));
  }

  listAll(): Proposal[] {
    return (this.store.db.prepare("SELECT data FROM proposals ORDER BY updated_at DESC").all() as Row[]).map((r) => JSON.parse(r.data as string));
  }
}

export class ReadinessRepository {
  constructor(private readonly store: Database) {}

  insert(c: ReadinessCheck) {
    this.store.db
      .prepare("INSERT INTO readiness_checks (id, proposal_id, content_version, passed, data, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.id, c.proposalId, c.proposalContentVersion, c.passed ? 1 : 0, JSON.stringify(c), c.evaluatedAt);
  }

  list(proposalId: string, limit = 20): ReadinessCheck[] {
    return (
      this.store.db
        .prepare("SELECT data FROM readiness_checks WHERE proposal_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT ?")
        .all(proposalId, limit) as Row[]
    ).map((r) => JSON.parse(r.data as string));
  }

  get(id: string): ReadinessCheck | undefined {
    const r = this.store.db.prepare("SELECT data FROM readiness_checks WHERE id = ?").get(id) as Row | undefined;
    return r ? JSON.parse(r.data as string) : undefined;
  }
}

export class DocumentRepository {
  constructor(private readonly store: Database) {}

  insert(d: StoredDocument, at: string) {
    this.store.db
      .prepare("INSERT INTO documents (ref, content_type, content, sha256, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(d.ref, d.contentType, d.content, d.sha256, at);
  }

  get(ref: string): StoredDocument | undefined {
    const r = this.store.db.prepare("SELECT * FROM documents WHERE ref = ?").get(ref) as Row | undefined;
    return r ? { ref: r.ref as string, contentType: r.content_type as string, content: r.content as string, sha256: r.sha256 as string } : undefined;
  }
}

/** Append-only from the application's perspective: there is no update or delete method, and the DB rejects both. */
export class AuditRepository {
  constructor(private readonly store: Database) {}

  append(a: AuditRecord) {
    this.store.db
      .prepare(
        `INSERT INTO audit_log (id, proposal_id, actor_user_id, actor_kind, action, entity_type, entity_id, at, before, after, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.proposalId,
        a.actorUserId,
        a.actorKind,
        a.action,
        a.entityType,
        a.entityId,
        a.at,
        JSON.stringify(a.before ?? null),
        JSON.stringify(a.after ?? null),
        JSON.stringify(a.metadata ?? {}),
      );
  }

  listForProposal(proposalId: string, limit = 500): AuditRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM audit_log WHERE proposal_id = ? ORDER BY seq DESC LIMIT ?").all(proposalId, limit) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      proposalId: (r.proposal_id as string | null) ?? null,
      actorUserId: r.actor_user_id as string,
      actorKind: r.actor_kind as AuditRecord["actorKind"],
      action: r.action as string,
      entityType: r.entity_type as string,
      entityId: r.entity_id as string,
      at: r.at as string,
      before: JSON.parse((r.before as string) ?? "null"),
      after: JSON.parse((r.after as string) ?? "null"),
      metadata: JSON.parse(r.metadata as string),
    }));
  }
}
