import { authorize } from "./authz.js";
import { type CommandContext, changedFields, record, touch } from "./context.js";
import { conflict, forbidden, notFound, validation } from "./errors.js";
import { assertEditable, assertEstimationPhase } from "./lifecycle.js";
import { findTask } from "./proposal.js";
import { ASSIGNMENT_STATUSES, type Proposal, type RoleAgreement, type TaskAssignment } from "./types.js";
import { asObject, has, newId, optNumber, optString, reqEnum, reqString } from "./util.js";

/**
 * Task assignments (who works on which task) are deliberately separate from
 * role agreements (who has agreed to hold which project role on the proposal).
 */

function requireMember(p: Proposal, userId: string, ctx: CommandContext) {
  const user = ctx.lookups.getUser(userId);
  if (!user) throw notFound("User", userId);
  if (user.kind !== "INTERNAL") throw validation("USER_NOT_INTERNAL", "Only internal users can be assigned or hold project roles.");
  if (!p.members.some((m) => m.userId === userId)) {
    throw validation("USER_NOT_MEMBER", `${user.displayName} must be added to the proposal team first.`);
  }
  return user;
}

export function assignToTask(p: Proposal, taskId: string, body: unknown, ctx: CommandContext): TaskAssignment {
  authorize(ctx.actor, p, "staffing.manage");
  assertEstimationPhase(p.state, "Staffing");
  const task = findTask(p, taskId);
  if (task.deliveryType === "EXTERNAL") throw conflict("TASK_EXTERNAL", "Externally sourced tasks are staffed by the vendor.");
  const input = asObject(body);
  const userId = reqString(input, "userId");
  requireMember(p, userId, ctx);
  if (p.assignments.some((a) => a.taskId === taskId && a.userId === userId && a.status !== "RELEASED")) {
    throw conflict("DUPLICATE_ASSIGNMENT", "This person is already assigned to the task.");
  }
  const a: TaskAssignment = {
    id: newId("asg"),
    taskId,
    userId,
    assignmentRole: reqString(input, "assignmentRole", { max: 100 }).toUpperCase(),
    allocationPercent: optNumber(input, "allocationPercent", 100, { min: 1, max: 100 }),
    status: "PLANNED",
    createdAt: ctx.now,
    createdBy: ctx.actor.userId,
    updatedAt: ctx.now,
    updatedBy: ctx.actor.userId,
  };
  p.assignments.push(a);
  touch(p, ctx, true);
  record(ctx, "assignment.created", "TaskAssignment", a.id, null, a, { taskId });
  return a;
}

export function updateAssignment(p: Proposal, assignmentId: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "staffing.manage");
  assertEditable(p.state, "Staffing");
  const a = p.assignments.find((x) => x.id === assignmentId);
  if (!a) throw notFound("TaskAssignment", assignmentId);
  if (a.status === "RELEASED") throw conflict("ASSIGNMENT_RELEASED", "A released assignment cannot be changed; create a new one.");
  const input = asObject(body);
  const before = structuredClone(a);
  if (has(input, "assignmentRole")) a.assignmentRole = reqString(input, "assignmentRole", { max: 100 }).toUpperCase();
  if (has(input, "allocationPercent")) a.allocationPercent = optNumber(input, "allocationPercent", a.allocationPercent, { min: 1, max: 100 });
  if (has(input, "status")) a.status = reqEnum(input, "status", ASSIGNMENT_STATUSES);
  const changes = changedFields(before, a);
  if (changes.length === 0) return;
  a.updatedAt = ctx.now;
  a.updatedBy = ctx.actor.userId;
  touch(p, ctx, true);
  record(ctx, a.status === "RELEASED" ? "assignment.released" : "assignment.updated", "TaskAssignment", a.id, before, a, { changes });
}

export const activeAssignments = (p: Proposal, taskId: string) =>
  p.assignments.filter((a) => a.taskId === taskId && a.status !== "RELEASED");

// ---------------------------------------------------------------------------
// Role agreements
// ---------------------------------------------------------------------------

function findAgreement(p: Proposal, id: string): RoleAgreement {
  const r = p.roleAgreements.find((x) => x.id === id);
  if (!r) throw notFound("RoleAgreement", id);
  return r;
}

export function proposeRole(p: Proposal, body: unknown, ctx: CommandContext): RoleAgreement {
  authorize(ctx.actor, p, "staffing.manage");
  assertEditable(p.state, "Role agreements");
  const input = asObject(body);
  const userId = reqString(input, "userId");
  requireMember(p, userId, ctx);
  const projectRole = reqString(input, "projectRole", { max: 100 }).toUpperCase();
  if (p.roleAgreements.some((r) => r.userId === userId && r.projectRole === projectRole && (r.status === "PROPOSED" || r.status === "AGREED"))) {
    throw conflict("DUPLICATE_ROLE_AGREEMENT", "This person already holds or has been proposed for that role.");
  }
  const r: RoleAgreement = {
    id: newId("role"),
    userId,
    projectRole,
    responsibilities: optString(input, "responsibilities"),
    status: "PROPOSED",
    proposedBy: ctx.actor.userId,
    proposedAt: ctx.now,
    respondedBy: null,
    respondedAt: null,
    revokedBy: null,
    revokedAt: null,
    revokeReason: null,
  };
  p.roleAgreements.push(r);
  touch(p, ctx, true);
  record(ctx, "roleAgreement.proposed", "RoleAgreement", r.id, null, r);
  return r;
}

/** Only the named person can agree to (or decline) their own project role. */
export function respondToRole(p: Proposal, agreementId: string, response: "AGREED" | "DECLINED", ctx: CommandContext) {
  const r = findAgreement(p, agreementId);
  authorize(ctx.actor, p, "proposal.view");
  if (r.userId !== ctx.actor.userId) throw forbidden("Only the named person can respond to a role agreement.", "NOT_ROLE_HOLDER");
  assertEditable(p.state, "Role agreements");
  if (r.status !== "PROPOSED") throw conflict("ROLE_AGREEMENT_NOT_PROPOSED", `This role agreement is already ${r.status}.`);
  const before = structuredClone(r);
  r.status = response;
  r.respondedBy = ctx.actor.userId;
  r.respondedAt = ctx.now;
  touch(p, ctx, true);
  record(ctx, response === "AGREED" ? "roleAgreement.agreed" : "roleAgreement.declined", "RoleAgreement", r.id, before, r);
}

export function revokeRole(p: Proposal, agreementId: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "staffing.manage");
  assertEditable(p.state, "Role agreements");
  const r = findAgreement(p, agreementId);
  if (r.status !== "PROPOSED" && r.status !== "AGREED") throw conflict("ROLE_AGREEMENT_INACTIVE", `This role agreement is already ${r.status}.`);
  const before = structuredClone(r);
  r.status = "REVOKED";
  r.revokedBy = ctx.actor.userId;
  r.revokedAt = ctx.now;
  r.revokeReason = optString(asObject(body ?? {}), "reason") || null;
  touch(p, ctx, true);
  record(ctx, "roleAgreement.revoked", "RoleAgreement", r.id, before, r);
}
