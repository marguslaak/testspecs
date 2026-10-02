import { forbidden } from "./errors.js";
import type { Actor, Proposal, ProposalRole, VendorAccessGrant } from "./types.js";

/**
 * Authorization combines the caller's global role (from the identity provider)
 * with the proposal context: internal users act on a proposal only through a
 * proposal membership whose role they also hold globally. Commercial Approvers
 * are a cross-proposal function and may review any proposal.
 * External vendors never get proposal permissions; they act only through
 * explicit VendorAccessGrants scoped to tasks.
 */
export const PERMISSIONS = [
  "proposal.view",
  "proposal.edit",
  "members.manage",
  "requirements.edit",
  "workbreakdown.edit",
  "estimate.submit",
  "estimate.requestAi",
  "estimate.select",
  "staffing.manage",
  "vendor.manage",
  "lifecycle.advance",
  "readiness.run",
  "offer.decide",
  "offer.issue",
  "proposal.cancel",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<ProposalRole, Permission[]> = {
  ACCOUNT_MANAGER: [
    "proposal.view",
    "proposal.edit",
    "members.manage",
    "requirements.edit",
    "vendor.manage",
    "lifecycle.advance",
    "readiness.run",
    "offer.issue",
    "proposal.cancel",
    "audit.view",
  ],
  SOLUTION_LEAD: [
    "proposal.view",
    "proposal.edit",
    "requirements.edit",
    "workbreakdown.edit",
    "estimate.submit",
    "estimate.requestAi",
    "estimate.select",
    "staffing.manage",
    "vendor.manage",
    "lifecycle.advance",
    "readiness.run",
    "audit.view",
  ],
  DEVELOPER: ["proposal.view", "estimate.submit", "estimate.requestAi", "readiness.run", "audit.view"],
  COMMERCIAL_APPROVER: ["proposal.view", "readiness.run", "offer.decide", "audit.view"],
};

export function effectiveRoles(actor: Actor, proposal: Proposal): ProposalRole[] {
  if (actor.kind !== "INTERNAL") return [];
  const roles = new Set<ProposalRole>();
  for (const m of proposal.members) {
    if (m.userId === actor.userId && actor.roles.includes(m.role)) roles.add(m.role);
  }
  if (actor.roles.includes("COMMERCIAL_APPROVER")) roles.add("COMMERCIAL_APPROVER");
  return [...roles];
}

export function permissionsFor(actor: Actor, proposal: Proposal): Set<Permission> {
  const perms = new Set<Permission>();
  for (const role of effectiveRoles(actor, proposal)) for (const p of ROLE_PERMISSIONS[role]) perms.add(p);
  return perms;
}

export function can(actor: Actor, proposal: Proposal, permission: Permission): boolean {
  if (actor.kind === "SYSTEM") return true;
  return permissionsFor(actor, proposal).has(permission);
}

export function authorize(actor: Actor, proposal: Proposal, permission: Permission): void {
  if (!can(actor, proposal, permission)) {
    // Do not reveal existence of proposals the caller cannot see at all.
    if (!can(actor, proposal, "proposal.view")) throw forbidden("You do not have access to this proposal.", "PROPOSAL_ACCESS_DENIED");
    throw forbidden(`Your role on this proposal does not allow ${permission}.`, "PERMISSION_DENIED");
  }
}

export function canCreateProposal(actor: Actor): boolean {
  return actor.kind === "INTERNAL" && actor.roles.includes("ACCOUNT_MANAGER");
}

// ---------------------------------------------------------------------------
// External vendor scope
// ---------------------------------------------------------------------------

export function activeGrantsFor(actor: Actor, proposal: Proposal): VendorAccessGrant[] {
  if (actor.kind !== "EXTERNAL" || !actor.vendorOrganizationId || !actor.roles.includes("EXTERNAL_VENDOR")) return [];
  return proposal.vendorGrants.filter(
    (g) => g.revokedAt === null && g.userId === actor.userId && g.vendorOrganizationId === actor.vendorOrganizationId,
  );
}

export function vendorTaskScope(actor: Actor, proposal: Proposal): Set<string> {
  const ids = new Set<string>();
  for (const g of activeGrantsFor(actor, proposal)) for (const t of g.taskIds) ids.add(t);
  return ids;
}

export function requireVendorTask(actor: Actor, proposal: Proposal, taskId: string): void {
  if (!vendorTaskScope(actor, proposal).has(taskId)) {
    throw forbidden("This task has not been shared with your organisation.", "VENDOR_SCOPE_DENIED");
  }
}
