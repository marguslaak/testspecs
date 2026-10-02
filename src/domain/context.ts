import type { Actor, AuditEvent, Proposal, ReadinessCheck, User, VendorOrganization } from "./types.js";

export interface Lookups {
  getUser(id: string): User | undefined;
  getVendorOrganization(id: string): VendorOrganization | undefined;
}

export interface StoredDocument {
  ref: string;
  contentType: string;
  content: string;
  sha256: string;
}

/**
 * Everything a domain command needs besides the aggregate: who is acting, what
 * time it is, reference data, and sinks for audit events and generated documents.
 * The application layer persists the sinks in the same transaction as the aggregate.
 */
export interface CommandContext {
  actor: Actor;
  now: string;
  lookups: Lookups;
  audit: AuditEvent[];
  documents: StoredDocument[];
  readinessChecks: ReadinessCheck[];
}

export function touch(p: Proposal, ctx: CommandContext, material: boolean) {
  p.updatedAt = ctx.now;
  p.updatedBy = ctx.actor.userId;
  if (material) p.contentVersion += 1;
}

export function record(
  ctx: CommandContext,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  metadata: Record<string, unknown> = {},
) {
  ctx.audit.push({
    action,
    entityType,
    entityId,
    before: before === undefined ? null : structuredClone(before),
    after: after === undefined ? null : structuredClone(after),
    metadata,
  });
}

/** Shallow diff of two records, for audit change metadata. */
export function changedFields(before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) {
    if (["updatedAt", "updatedBy"].includes(k)) continue;
    if (JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k])) out.push(k);
  }
  return out;
}
