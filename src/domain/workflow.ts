import { authorize, can, type Permission, permissionsFor } from "./authz.js";
import { type CommandContext, record, touch } from "./context.js";
import { renderOfferDocument, sha256 } from "./document.js";
import { conflict, forbidden, notFound, unprocessable, validation } from "./errors.js";
import {
  assertTransition,
  earlierPhases,
  ESTIMATION_STATES,
  isWorkingState,
  LIFECYCLE_COMMANDS,
  type LifecycleCommand,
  TRANSITIONS,
} from "./lifecycle.js";
import { buildSnapshot } from "./pricing.js";
import { evaluateReadiness } from "./readiness.js";
import type { Actor, OfferVersion, Proposal, ProposalState, RuleFailure } from "./types.js";
import { asObject, newId, optString, reqEnum } from "./util.js";

/**
 * Command-oriented lifecycle. Every state change goes through `executeLifecycle`,
 * which checks the transition table, the caller's permission and the command's
 * own guards, then records the change in history and the audit trail.
 */
export function executeLifecycle(p: Proposal, command: LifecycleCommand, body: unknown, ctx: CommandContext) {
  if (!LIFECYCLE_COMMANDS.includes(command)) throw validation("UNKNOWN_COMMAND", `Unknown lifecycle command ${command}.`);
  const rule = TRANSITIONS[command];
  authorize(ctx.actor, p, rule.permission);
  assertTransition(command, p.state);
  const input = asObject(body ?? {});
  const from = p.state;
  let to: ProposalState = rule.to ?? from;
  const metadata: Record<string, unknown> = {};

  switch (command) {
    case "markRequirementsReady":
      guard(command, requirementsGuard(p));
      break;
    case "startEstimation":
      guard(command, workBreakdownGuard(p));
      break;
    case "startStaffing":
    case "startVendorCommitments":
      break;
    case "returnToPhase": {
      to = reqEnum(input, "target", earlierPhases(from));
      break;
    }
    case "requestApproval": {
      const check = evaluateReadiness(p, ctx.actor.userId, ctx.now);
      if (!check.passed) {
        throw unprocessable("READINESS_FAILED", "The proposal is not ready for approval. Resolve the failing readiness rules first.", {
          readiness: check,
        });
      }
      ctx.readinessChecks.push(check);
      const version: OfferVersion = {
        id: newId("offer"),
        number: p.offerVersions.reduce((n, v) => Math.max(n, v.number), 0) + 1,
        status: "PENDING_APPROVAL",
        proposalContentVersion: p.contentVersion,
        readinessCheckId: check.id,
        snapshot: buildSnapshot(p, ctx),
        createdAt: ctx.now,
        createdBy: ctx.actor.userId,
        decision: null,
        document: null,
        issuedAt: null,
        issuedBy: null,
        customerResponse: null,
        supersededAt: null,
      };
      p.offerVersions.push(version);
      p.approvalReturnState = from;
      Object.assign(metadata, { offerVersionId: version.id, offerVersion: version.number, readinessCheckId: check.id, totals: version.snapshot.totals });
      record(ctx, "offerVersion.created", "OfferVersion", version.id, null, { number: version.number, totals: version.snapshot.totals, proposalContentVersion: version.proposalContentVersion });
      break;
    }
    case "approveOffer": {
      const v = versionInStatus(p, "PENDING_APPROVAL");
      if (v.createdBy === ctx.actor.userId) throw forbidden("You requested approval for this offer and cannot approve it yourself.", "SELF_APPROVAL_FORBIDDEN");
      if (v.proposalContentVersion !== p.contentVersion) {
        throw conflict("OFFER_OUTDATED", "The proposal changed after this offer version was created; request approval again.");
      }
      const content = renderOfferDocument(v.snapshot, v.number);
      const hash = sha256(content);
      const ref = `offers/${p.id}/v${v.number}-${hash.slice(0, 12)}.html`;
      ctx.documents.push({ ref, contentType: "text/html", content, sha256: hash });
      v.document = { ref, sha256: hash, format: "text/html", generatedAt: ctx.now };
      v.decision = { decision: "APPROVED", by: ctx.actor.userId, at: ctx.now, comment: optString(input, "comment") };
      v.status = "APPROVED";
      Object.assign(metadata, { offerVersionId: v.id, offerVersion: v.number, documentRef: ref, sha256: hash, totals: v.snapshot.totals });
      break;
    }
    case "rejectOffer": {
      const v = versionInStatus(p, "PENDING_APPROVAL");
      const comment = optString(input, "comment");
      if (!comment) throw validation("FIELD_REQUIRED", "Explain what must change before the offer can be approved.", { field: "comment" });
      v.decision = { decision: "REJECTED", by: ctx.actor.userId, at: ctx.now, comment };
      v.status = "REJECTED";
      to = p.approvalReturnState ?? "VENDOR_COMMITMENTS";
      p.approvalReturnState = null;
      Object.assign(metadata, { offerVersionId: v.id, offerVersion: v.number, comment });
      break;
    }
    case "issueOffer": {
      const v = versionInStatus(p, "APPROVED");
      if (!v.document) throw conflict("OFFER_DOCUMENT_MISSING", "The approved offer has no generated document.");
      if (new Date(v.snapshot.validUntil).getTime() < new Date(ctx.now).getTime()) {
        throw conflict("OFFER_EXPIRED", "The approved offer's validity has lapsed. Reopen the proposal and create a new version.");
      }
      v.status = "ISSUED";
      v.issuedAt = ctx.now;
      v.issuedBy = ctx.actor.userId;
      Object.assign(metadata, { offerVersionId: v.id, offerVersion: v.number, documentRef: v.document.ref, sha256: v.document.sha256 });
      break;
    }
    case "recordCustomerAcceptance":
    case "recordCustomerRejection": {
      const v = versionInStatus(p, "ISSUED");
      const accepted = command === "recordCustomerAcceptance";
      v.customerResponse = { response: accepted ? "ACCEPTED" : "DECLINED", recordedBy: ctx.actor.userId, at: ctx.now, note: optString(input, "note") };
      v.status = accepted ? "ACCEPTED" : "DECLINED";
      Object.assign(metadata, { offerVersionId: v.id, offerVersion: v.number });
      break;
    }
    case "reopenForRevision": {
      const reason = optString(input, "reason");
      if (!reason) throw validation("FIELD_REQUIRED", "Give a reason for reopening the proposal.", { field: "reason" });
      // Pending or approved versions can no longer be issued; issued versions stay as the immutable record of what was sent.
      for (const v of p.offerVersions.filter((x) => x.status === "PENDING_APPROVAL" || x.status === "APPROVED")) {
        v.status = "SUPERSEDED";
        v.supersededAt = ctx.now;
        record(ctx, "offerVersion.superseded", "OfferVersion", v.id, null, { status: v.status }, { reason });
      }
      to = p.approvalReturnState && isWorkingState(p.approvalReturnState) ? p.approvalReturnState : "VENDOR_COMMITMENTS";
      p.approvalReturnState = null;
      metadata.reason = reason;
      break;
    }
    case "cancel": {
      const reason = optString(input, "reason");
      if (!reason) throw validation("FIELD_REQUIRED", "Give a reason for cancelling the proposal.", { field: "reason" });
      for (const v of p.offerVersions.filter((x) => x.status === "PENDING_APPROVAL" || x.status === "APPROVED")) {
        v.status = "SUPERSEDED";
        v.supersededAt = ctx.now;
      }
      metadata.reason = reason;
      break;
    }
  }

  p.state = to;
  p.history.push({ from, to, command, at: ctx.now, by: ctx.actor.userId, ...(metadata.reason ? { reason: String(metadata.reason) } : {}) });
  touch(p, ctx, false);
  record(ctx, `proposal.${command}`, "Proposal", p.id, { state: from }, { state: to }, metadata);
}

function guard(command: LifecycleCommand, failures: RuleFailure[]) {
  if (failures.length > 0) {
    throw unprocessable("TRANSITION_GUARD_FAILED", `${TRANSITIONS[command].label} is not possible yet.`, { failures });
  }
}

function requirementsGuard(p: Proposal): RuleFailure[] {
  return p.requirements.some((r) => r.status === "CONFIRMED")
    ? []
    : [{ message: "Confirm at least one customer requirement.", entityType: "Proposal", entityId: p.id }];
}

function workBreakdownGuard(p: Proposal): RuleFailure[] {
  const f: RuleFailure[] = [];
  if (p.milestones.length === 0) f.push({ message: "Add at least one milestone.", entityType: "Proposal", entityId: p.id });
  for (const m of p.milestones) {
    if (!p.tasks.some((t) => t.milestoneId === m.id)) f.push({ message: `Milestone "${m.title}" has no tasks.`, entityType: "Milestone", entityId: m.id });
  }
  return f;
}

function versionInStatus(p: Proposal, status: OfferVersion["status"]): OfferVersion {
  const v = [...p.offerVersions].reverse().find((x) => x.status === status);
  if (!v) throw conflict("OFFER_VERSION_MISSING", `There is no offer version in status ${status}.`);
  return v;
}

export function findOfferVersion(p: Proposal, number: number): OfferVersion {
  const v = p.offerVersions.find((x) => x.number === number);
  if (!v) throw notFound("OfferVersion", String(number));
  return v;
}

// ---------------------------------------------------------------------------
// Capabilities for the caller — what the UI may offer.
// ---------------------------------------------------------------------------

export interface AllowedAction {
  command: LifecycleCommand;
  label: string;
  enabled: boolean;
  reason?: string;
  targets?: ProposalState[];
}

export function allowedActions(p: Proposal, actor: Actor): AllowedAction[] {
  const out: AllowedAction[] = [];
  for (const command of LIFECYCLE_COMMANDS) {
    const rule = TRANSITIONS[command];
    if (!rule.from.includes(p.state) || !can(actor, p, rule.permission)) continue;
    const action: AllowedAction = { command, label: rule.label, enabled: true };
    if (command === "returnToPhase") action.targets = earlierPhases(p.state);
    if (command === "approveOffer") {
      const v = p.offerVersions.find((x) => x.status === "PENDING_APPROVAL");
      if (v?.createdBy === actor.userId) Object.assign(action, { enabled: false, reason: "You requested this approval; another approver must decide." });
    }
    out.push(action);
  }
  return out;
}

export function capabilities(p: Proposal, actor: Actor) {
  const perms = permissionsFor(actor, p);
  const editable = isWorkingState(p.state);
  const estimationOpen = ESTIMATION_STATES.includes(p.state);
  const has = (x: Permission) => perms.has(x);
  return {
    permissions: [...perms],
    editable,
    estimationOpen,
    canEditDetails: editable && has("proposal.edit"),
    canManageMembers: has("members.manage"),
    canEditRequirements: editable && has("requirements.edit"),
    canEditWorkBreakdown: editable && has("workbreakdown.edit"),
    canSubmitEstimates: estimationOpen && has("estimate.submit"),
    canRequestAiEstimates: estimationOpen && has("estimate.requestAi"),
    canSelectEstimates: estimationOpen && has("estimate.select"),
    canManageStaffing: estimationOpen && has("staffing.manage"),
    canManageVendors: editable && has("vendor.manage"),
    canReviewVendorOffers: estimationOpen && has("vendor.manage"),
    canRunReadiness: has("readiness.run"),
    actions: allowedActions(p, actor),
  };
}
