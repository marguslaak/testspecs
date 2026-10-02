import { authorize, requireVendorTask, vendorTaskScope } from "./authz.js";
import { type CommandContext, record, touch } from "./context.js";
import { conflict, forbidden, notFound, validation } from "./errors.js";
import { assertEditable, assertEstimationPhase } from "./lifecycle.js";
import { findTask, orderedTasks } from "./proposal.js";
import type { Actor, Proposal, VendorAccessGrant, VendorOffer, VendorOfferRevision } from "./types.js";
import { asObject, newId, optString, optStringArray, reqCurrency, reqIsoDate, reqNumber, reqString } from "./util.js";

const isExternallySourced = (deliveryType: string) => deliveryType === "EXTERNAL" || deliveryType === "MIXED";

// ---------------------------------------------------------------------------
// Access grants (internal side)
// ---------------------------------------------------------------------------

export function grantVendorAccess(p: Proposal, body: unknown, ctx: CommandContext): VendorAccessGrant {
  authorize(ctx.actor, p, "vendor.manage");
  assertEditable(p.state, "Vendor access");
  const input = asObject(body);
  const userId = reqString(input, "userId");
  const taskIds = [...new Set(optStringArray(input, "taskIds"))];
  if (taskIds.length === 0) throw validation("FIELD_REQUIRED", "taskIds must list at least one task.", { field: "taskIds" });
  const user = ctx.lookups.getUser(userId);
  if (!user) throw notFound("User", userId);
  if (user.kind !== "EXTERNAL" || !user.vendorOrganizationId || !user.roles.includes("EXTERNAL_VENDOR")) {
    throw validation("USER_NOT_VENDOR", "Access can only be granted to external vendor users.");
  }
  for (const id of taskIds) {
    const t = findTask(p, id);
    if (!isExternallySourced(t.deliveryType)) {
      throw validation("TASK_NOT_EXTERNAL", `Task "${t.title}" is internal; only EXTERNAL or MIXED tasks can be shared with vendors.`, { taskId: id });
    }
  }
  const existing = p.vendorGrants.find((g) => g.userId === userId && g.revokedAt === null);
  if (existing) {
    const before = structuredClone(existing);
    existing.taskIds = [...new Set([...existing.taskIds, ...taskIds])];
    touch(p, ctx, false);
    record(ctx, "vendorGrant.extended", "VendorAccessGrant", existing.id, before, existing, { userId });
    return existing;
  }
  const g: VendorAccessGrant = {
    id: newId("vgrant"),
    userId,
    vendorOrganizationId: user.vendorOrganizationId,
    taskIds,
    grantedBy: ctx.actor.userId,
    grantedAt: ctx.now,
    revokedBy: null,
    revokedAt: null,
  };
  p.vendorGrants.push(g);
  touch(p, ctx, false);
  record(ctx, "vendorGrant.created", "VendorAccessGrant", g.id, null, g, { userId });
  return g;
}

export function revokeVendorAccess(p: Proposal, grantId: string, ctx: CommandContext) {
  authorize(ctx.actor, p, "vendor.manage");
  const g = p.vendorGrants.find((x) => x.id === grantId);
  if (!g) throw notFound("VendorAccessGrant", grantId);
  if (g.revokedAt) throw conflict("GRANT_REVOKED", "This access grant is already revoked.");
  const before = structuredClone(g);
  g.revokedAt = ctx.now;
  g.revokedBy = ctx.actor.userId;
  touch(p, ctx, false);
  record(ctx, "vendorGrant.revoked", "VendorAccessGrant", g.id, before, g);
}

// ---------------------------------------------------------------------------
// Vendor offers (external side)
// ---------------------------------------------------------------------------

function findOffer(p: Proposal, id: string): VendorOffer {
  const o = p.vendorOffers.find((x) => x.id === id);
  if (!o) throw notFound("VendorOffer", id);
  return o;
}

export const latestRevision = (o: VendorOffer): VendorOfferRevision => o.revisions[o.revisions.length - 1];

export function acceptedRevision(o: VendorOffer): VendorOfferRevision | undefined {
  return o.acceptedRevision === null ? undefined : o.revisions.find((r) => r.revision === o.acceptedRevision);
}

function assertVendorActor(actor: Actor) {
  if (actor.kind !== "EXTERNAL" || !actor.vendorOrganizationId) throw forbidden("Only vendor users can submit vendor offers.", "NOT_VENDOR");
}

/**
 * Submits a binding vendor offer, or a new revision of the vendor's open offer
 * for the task. Earlier revisions are kept; an accepted offer can no longer change.
 */
export function submitVendorOffer(p: Proposal, taskId: string, body: unknown, ctx: CommandContext): VendorOffer {
  assertVendorActor(ctx.actor);
  requireVendorTask(ctx.actor, p, taskId);
  assertEstimationPhase(p.state, "Submitting vendor offers");
  const task = findTask(p, taskId);
  const input = asObject(body);
  if (input.confirmBinding !== true) {
    throw validation("BINDING_CONFIRMATION_REQUIRED", "You must explicitly confirm that the offer is binding for the shown scope and terms.", { field: "confirmBinding" });
  }
  const validUntil = reqIsoDate(input, "validUntil");
  if (new Date(validUntil).getTime() <= new Date(ctx.now).getTime()) {
    throw validation("OFFER_VALIDITY_PAST", "validUntil must be in the future.", { field: "validUntil" });
  }
  const orgId = ctx.actor.vendorOrganizationId!;
  const open = p.vendorOffers.find(
    (o) => o.taskId === taskId && o.vendorOrganizationId === orgId && ["SUBMITTED", "REVISION_REQUESTED", "ACCEPTED"].includes(o.status),
  );
  if (open?.status === "ACCEPTED") throw conflict("VENDOR_OFFER_ACCEPTED", "Your offer for this task has been accepted and is now binding; it can no longer be revised.");
  const revision: VendorOfferRevision = {
    revision: (open?.revisions.length ?? 0) + 1,
    priceMinor: reqNumber(input, "priceMinor", { min: 1, integer: true }),
    currency: reqCurrency(input, "currency"),
    terms: optString(input, "terms"),
    validUntil,
    scopeSnapshot: { title: task.title, scope: task.scope, taskRevision: task.revision },
    bindingConfirmed: true,
    submittedBy: ctx.actor.userId,
    submittedAt: ctx.now,
  };
  let offer: VendorOffer;
  if (open) {
    offer = open;
    const before = { status: open.status, revisions: open.revisions.length };
    open.revisions.push(revision);
    open.status = "SUBMITTED";
    record(ctx, "vendorOffer.revised", "VendorOffer", open.id, before, revision, { taskId });
  } else {
    offer = {
      id: newId("voffer"),
      taskId,
      vendorOrganizationId: orgId,
      status: "SUBMITTED",
      revisions: [revision],
      reviewNotes: [],
      acceptedRevision: null,
      acceptedAt: null,
      acceptedBy: null,
      createdAt: ctx.now,
    };
    p.vendorOffers.push(offer);
    record(ctx, "vendorOffer.submitted", "VendorOffer", offer.id, null, revision, { taskId });
  }
  touch(p, ctx, false);
  return offer;
}

export function withdrawVendorOffer(p: Proposal, offerId: string, ctx: CommandContext) {
  assertVendorActor(ctx.actor);
  const o = findOffer(p, offerId);
  if (o.vendorOrganizationId !== ctx.actor.vendorOrganizationId) throw forbidden("This offer belongs to another organisation.", "VENDOR_SCOPE_DENIED");
  requireVendorTask(ctx.actor, p, o.taskId);
  if (o.status !== "SUBMITTED" && o.status !== "REVISION_REQUESTED") throw conflict("VENDOR_OFFER_NOT_OPEN", `This offer is ${o.status} and cannot be withdrawn.`);
  const before = o.status;
  o.status = "WITHDRAWN";
  touch(p, ctx, false);
  record(ctx, "vendorOffer.withdrawn", "VendorOffer", o.id, { status: before }, { status: o.status });
}

// ---------------------------------------------------------------------------
// Internal review
// ---------------------------------------------------------------------------

export function acceptVendorOffer(p: Proposal, offerId: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "vendor.manage");
  assertEstimationPhase(p.state, "Accepting vendor offers");
  const o = findOffer(p, offerId);
  if (o.status !== "SUBMITTED") throw conflict("VENDOR_OFFER_NOT_SUBMITTED", `Only a submitted offer can be accepted (this one is ${o.status}).`);
  const rev = latestRevision(o);
  const task = findTask(p, o.taskId);
  if (new Date(rev.validUntil).getTime() < new Date(ctx.now).getTime()) {
    throw conflict("VENDOR_OFFER_EXPIRED", "This vendor offer has expired. Request a revision with a new validity date.");
  }
  if (rev.currency !== p.currency) {
    throw conflict("VENDOR_CURRENCY_MISMATCH", `The offer is in ${rev.currency} but the proposal is in ${p.currency}. Request a revision.`);
  }
  if (rev.scopeSnapshot.taskRevision !== task.revision) {
    throw conflict("VENDOR_SCOPE_STALE", "The task scope changed after the vendor submitted. Request a revision against the current scope.");
  }
  if (p.vendorOffers.some((x) => x.taskId === o.taskId && x.status === "ACCEPTED")) {
    throw conflict("TASK_ALREADY_COMMITTED", "Another vendor offer has already been accepted for this task.");
  }
  const before = { status: o.status };
  o.status = "ACCEPTED";
  o.acceptedRevision = rev.revision;
  o.acceptedAt = ctx.now;
  o.acceptedBy = ctx.actor.userId;
  o.reviewNotes.push({ at: ctx.now, by: ctx.actor.userId, action: "ACCEPTED", note: optString(asObject(body ?? {}), "note") });
  touch(p, ctx, true);
  record(ctx, "vendorOffer.accepted", "VendorOffer", o.id, before, { status: o.status, acceptedRevision: rev }, { taskId: o.taskId });
}

export function reviewVendorOffer(p: Proposal, offerId: string, action: "REJECTED" | "REVISION_REQUESTED", body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "vendor.manage");
  assertEditable(p.state, "Vendor review");
  const o = findOffer(p, offerId);
  const note = optString(asObject(body ?? {}), "note");
  if (action === "REVISION_REQUESTED" && o.status !== "SUBMITTED") {
    throw conflict("VENDOR_OFFER_NOT_SUBMITTED", `A revision can only be requested for a submitted offer (this one is ${o.status}).`);
  }
  if (action === "REJECTED" && o.status !== "SUBMITTED" && o.status !== "REVISION_REQUESTED") {
    throw conflict("VENDOR_OFFER_NOT_OPEN", `This offer is ${o.status} and cannot be rejected.`);
  }
  if (action === "REVISION_REQUESTED" && !note) throw validation("FIELD_REQUIRED", "Tell the vendor what to revise.", { field: "note" });
  const before = { status: o.status };
  o.status = action;
  o.reviewNotes.push({ at: ctx.now, by: ctx.actor.userId, action, note });
  touch(p, ctx, false);
  record(ctx, action === "REJECTED" ? "vendorOffer.rejected" : "vendorOffer.revisionRequested", "VendorOffer", o.id, before, { status: o.status, note });
}

export const acceptedOfferForTask = (p: Proposal, taskId: string) =>
  p.vendorOffers.find((o) => o.taskId === taskId && o.status === "ACCEPTED");

// ---------------------------------------------------------------------------
// Vendor projection: the only proposal data an external user ever receives.
// ---------------------------------------------------------------------------

export function vendorProposalView(p: Proposal, actor: Actor) {
  const scope = vendorTaskScope(actor, p);
  if (scope.size === 0) throw forbidden("You do not have access to this proposal.", "PROPOSAL_ACCESS_DENIED");
  const msTitle = new Map(p.milestones.map((m) => [m.id, m.title]));
  const canSubmit = ["ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS"].includes(p.state);
  return {
    id: p.id,
    title: p.title,
    currency: p.currency,
    acceptingOffers: canSubmit,
    tasks: orderedTasks(p)
      .filter((t) => scope.has(t.id))
      .map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        scope: t.scope,
        deliveryType: t.deliveryType,
        milestone: msTitle.get(t.milestoneId) ?? "",
        revision: t.revision,
      })),
    offers: p.vendorOffers
      .filter((o) => o.vendorOrganizationId === actor.vendorOrganizationId && scope.has(o.taskId))
      .map((o) => ({
        id: o.id,
        taskId: o.taskId,
        status: o.status,
        revisions: o.revisions,
        reviewNotes: o.reviewNotes.map((n) => ({ at: n.at, action: n.action, note: n.note })),
        acceptedRevision: o.acceptedRevision,
        acceptedAt: o.acceptedAt,
      })),
  };
}
