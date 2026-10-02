import { authorize, canCreateProposal } from "./authz.js";
import { type CommandContext, changedFields, record, touch } from "./context.js";
import { conflict, forbidden, notFound, validation } from "./errors.js";
import { assertEditable } from "./lifecycle.js";
import {
  type CommercialSettings,
  DELIVERY_TYPES,
  INTERNAL_PROPOSAL_ROLES,
  type Milestone,
  type Proposal,
  REQUIREMENT_CLASSIFICATIONS,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
  type Requirement,
  type Task,
} from "./types.js";
import {
  asObject,
  assertPermutation,
  has,
  newId,
  optBool,
  optEnum,
  optNumber,
  optString,
  optStringArray,
  reqCurrency,
  reqEnum,
  reqString,
} from "./util.js";

export const DEFAULT_COMMERCIAL: CommercialSettings = {
  hourlyRateMinor: 0,
  roleRatesMinor: {},
  contingencyPercent: 10,
  vendorMarkupPercent: 10,
  validityDays: 30,
  paymentTerms: "Payment within 14 days of invoice.",
  terms: "",
  assumptions: [],
};

const meta = (ctx: CommandContext) => ({
  createdAt: ctx.now,
  createdBy: ctx.actor.userId,
  updatedAt: ctx.now,
  updatedBy: ctx.actor.userId,
});

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export function createProposal(body: unknown, ctx: CommandContext): Proposal {
  if (!canCreateProposal(ctx.actor)) throw forbidden("Only Account Managers can create proposals.");
  const input = asObject(body);
  const p: Proposal = {
    id: newId("prop"),
    revision: 1,
    contentVersion: 1,
    state: "DRAFT",
    approvalReturnState: null,
    title: reqString(input, "title", { max: 200 }),
    customerReference: reqString(input, "customerReference", { max: 100 }),
    customerName: optString(input, "customerName", "", 200),
    description: optString(input, "description"),
    currency: reqCurrency(input, "currency"),
    ownerId: ctx.actor.userId,
    members: [{ userId: ctx.actor.userId, role: "ACCOUNT_MANAGER", addedBy: ctx.actor.userId, addedAt: ctx.now }],
    requiredRoles: ["SOLUTION_LEAD"],
    commercial: structuredClone(DEFAULT_COMMERCIAL),
    requirements: [],
    milestones: [],
    tasks: [],
    estimates: [],
    aiRequests: [],
    assignments: [],
    roleAgreements: [],
    vendorGrants: [],
    vendorOffers: [],
    offerVersions: [],
    history: [],
    createdAt: ctx.now,
    createdBy: ctx.actor.userId,
    updatedAt: ctx.now,
    updatedBy: ctx.actor.userId,
  };
  record(ctx, "proposal.created", "Proposal", p.id, null, summary(p));
  ctx.audit[ctx.audit.length - 1].proposalId = p.id;
  return p;
}

const summary = (p: Proposal) => ({
  title: p.title,
  customerReference: p.customerReference,
  customerName: p.customerName,
  description: p.description,
  currency: p.currency,
  requiredRoles: p.requiredRoles,
});

export function updateProposalDetails(p: Proposal, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "proposal.edit");
  assertEditable(p.state);
  const input = asObject(body);
  const before = summary(p);
  if (has(input, "title")) p.title = reqString(input, "title", { max: 200 });
  if (has(input, "customerReference")) p.customerReference = reqString(input, "customerReference", { max: 100 });
  if (has(input, "customerName")) p.customerName = optString(input, "customerName", "", 200);
  if (has(input, "description")) p.description = optString(input, "description");
  if (has(input, "currency")) {
    const currency = reqCurrency(input, "currency");
    if (currency !== p.currency && p.vendorOffers.some((o) => o.status === "ACCEPTED")) {
      throw conflict("CURRENCY_LOCKED", "Currency cannot change after a vendor offer has been accepted.");
    }
    p.currency = currency;
  }
  if (has(input, "requiredRoles")) p.requiredRoles = [...new Set(optStringArray(input, "requiredRoles").map((r) => r.toUpperCase()))];
  const after = summary(p);
  const changes = changedFields(before, after);
  if (changes.length === 0) return;
  touch(p, ctx, true);
  record(ctx, "proposal.updated", "Proposal", p.id, before, after, { changes });
}

export function updateCommercial(p: Proposal, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "proposal.edit");
  assertEditable(p.state, "Commercial settings");
  const input = asObject(body);
  const before = structuredClone(p.commercial);
  const c = p.commercial;
  c.hourlyRateMinor = optNumber(input, "hourlyRateMinor", c.hourlyRateMinor, { min: 0, integer: true });
  c.contingencyPercent = optNumber(input, "contingencyPercent", c.contingencyPercent, { min: 0, max: 100 });
  c.vendorMarkupPercent = optNumber(input, "vendorMarkupPercent", c.vendorMarkupPercent, { min: 0, max: 200 });
  c.validityDays = optNumber(input, "validityDays", c.validityDays, { min: 1, max: 365, integer: true });
  c.paymentTerms = optString(input, "paymentTerms", c.paymentTerms);
  c.terms = optString(input, "terms", c.terms);
  c.assumptions = optStringArray(input, "assumptions", c.assumptions);
  if (has(input, "roleRatesMinor")) {
    const rates = asObject(input.roleRatesMinor, "roleRatesMinor");
    const parsed: Record<string, number> = {};
    for (const [role, rate] of Object.entries(rates)) {
      if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0) {
        throw validation("FIELD_INVALID", `roleRatesMinor.${role} must be a non-negative integer.`, { field: `roleRatesMinor.${role}` });
      }
      parsed[role.toUpperCase()] = rate;
    }
    c.roleRatesMinor = parsed;
  }
  const changes = changedFields(before, c);
  if (changes.length === 0) return;
  touch(p, ctx, true);
  record(ctx, "proposal.commercial.updated", "Proposal", p.id, before, c, { changes });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function addMember(p: Proposal, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "members.manage");
  const input = asObject(body);
  const userId = reqString(input, "userId");
  const role = reqEnum(input, "role", INTERNAL_PROPOSAL_ROLES);
  const user = ctx.lookups.getUser(userId);
  if (!user) throw notFound("User", userId);
  if (user.kind !== "INTERNAL") throw validation("USER_NOT_INTERNAL", "Only internal users can be proposal members. Use vendor access grants for external users.");
  if (!user.roles.includes(role)) throw validation("ROLE_NOT_HELD", `${user.displayName} does not hold the ${role} role in the identity provider.`);
  if (p.members.some((m) => m.userId === userId && m.role === role)) {
    throw conflict("DUPLICATE_MEMBER", `${user.displayName} is already a ${role} on this proposal.`);
  }
  const member = { userId, role, addedBy: ctx.actor.userId, addedAt: ctx.now };
  p.members.push(member);
  touch(p, ctx, false);
  record(ctx, "member.added", "ProposalMember", `${userId}:${role}`, null, member);
}

/**
 * Removing a member who still has active task assignments or role agreements is
 * refused unless the caller explicitly asks to release those commitments.
 */
export function removeMember(p: Proposal, userId: string, role: string, releaseCommitments: boolean, ctx: CommandContext) {
  authorize(ctx.actor, p, "members.manage");
  const idx = p.members.findIndex((m) => m.userId === userId && m.role === role);
  if (idx < 0) throw notFound("ProposalMember", `${userId}:${role}`);
  if (userId === p.ownerId && role === "ACCOUNT_MANAGER") throw conflict("OWNER_REQUIRED", "The proposal owner cannot be removed.");
  const remainingMemberships = p.members.filter((m, i) => i !== idx && m.userId === userId);
  const activeAssignments = p.assignments.filter((a) => a.userId === userId && a.status !== "RELEASED");
  const activeAgreements = p.roleAgreements.filter((r) => r.userId === userId && (r.status === "PROPOSED" || r.status === "AGREED"));
  if (remainingMemberships.length === 0 && (activeAssignments.length > 0 || activeAgreements.length > 0)) {
    if (!releaseCommitments) {
      throw conflict(
        "MEMBER_HAS_ACTIVE_COMMITMENTS",
        "This person still has active task assignments or role agreements. Release them first or remove with releaseCommitments=true.",
        { assignmentIds: activeAssignments.map((a) => a.id), roleAgreementIds: activeAgreements.map((r) => r.id) },
      );
    }
    assertEditable(p.state, "Staffing");
    for (const a of activeAssignments) {
      const before = structuredClone(a);
      a.status = "RELEASED";
      a.updatedAt = ctx.now;
      a.updatedBy = ctx.actor.userId;
      record(ctx, "assignment.released", "TaskAssignment", a.id, before, a, { reason: "member removed" });
    }
    for (const r of activeAgreements) {
      const before = structuredClone(r);
      r.status = "REVOKED";
      r.revokedAt = ctx.now;
      r.revokedBy = ctx.actor.userId;
      r.revokeReason = "member removed";
      record(ctx, "roleAgreement.revoked", "RoleAgreement", r.id, before, r, { reason: "member removed" });
    }
  }
  const [removed] = p.members.splice(idx, 1);
  const material = activeAssignments.length > 0 || activeAgreements.length > 0;
  touch(p, ctx, material && releaseCommitments);
  record(ctx, "member.removed", "ProposalMember", `${userId}:${role}`, removed, null, { releaseCommitments });
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

function findRequirement(p: Proposal, id: string): Requirement {
  const r = p.requirements.find((x) => x.id === id);
  if (!r) throw notFound("Requirement", id);
  return r;
}

export function addRequirement(p: Proposal, body: unknown, ctx: CommandContext): Requirement {
  authorize(ctx.actor, p, "requirements.edit");
  assertEditable(p.state, "Requirements");
  const input = asObject(body);
  const r: Requirement = {
    id: newId("req"),
    title: reqString(input, "title", { max: 300 }),
    description: optString(input, "description"),
    source: optString(input, "source", "", 200),
    priority: optEnum(input, "priority", REQUIREMENT_PRIORITIES, "MUST"),
    classification: optEnum(input, "classification", REQUIREMENT_CLASSIFICATIONS, "FUNCTIONAL"),
    acceptanceNotes: optString(input, "acceptanceNotes"),
    status: optEnum(input, "status", REQUIREMENT_STATUSES, "DRAFT"),
    order: p.requirements.length,
    ...meta(ctx),
  };
  p.requirements.push(r);
  touch(p, ctx, true);
  record(ctx, "requirement.created", "Requirement", r.id, null, r);
  return r;
}

export function updateRequirement(p: Proposal, id: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "requirements.edit");
  assertEditable(p.state, "Requirements");
  const r = findRequirement(p, id);
  const input = asObject(body);
  const before = structuredClone(r);
  if (has(input, "title")) r.title = reqString(input, "title", { max: 300 });
  if (has(input, "description")) r.description = optString(input, "description");
  if (has(input, "source")) r.source = optString(input, "source", "", 200);
  if (has(input, "priority")) r.priority = reqEnum(input, "priority", REQUIREMENT_PRIORITIES);
  if (has(input, "classification")) r.classification = reqEnum(input, "classification", REQUIREMENT_CLASSIFICATIONS);
  if (has(input, "acceptanceNotes")) r.acceptanceNotes = optString(input, "acceptanceNotes");
  if (has(input, "status")) r.status = reqEnum(input, "status", REQUIREMENT_STATUSES);
  const changes = changedFields(before, r);
  if (changes.length === 0) return;
  r.updatedAt = ctx.now;
  r.updatedBy = ctx.actor.userId;
  touch(p, ctx, true);
  record(ctx, "requirement.updated", "Requirement", r.id, before, r, { changes });
}

export function deleteRequirement(p: Proposal, id: string, ctx: CommandContext) {
  authorize(ctx.actor, p, "requirements.edit");
  assertEditable(p.state, "Requirements");
  const r = findRequirement(p, id);
  const tracedBy = p.tasks.filter((t) => t.requirementIds.includes(id));
  if (tracedBy.length > 0) {
    throw conflict("REQUIREMENT_IN_USE", "This requirement is traced by tasks. Remove the trace links first.", {
      taskIds: tracedBy.map((t) => t.id),
    });
  }
  p.requirements = p.requirements.filter((x) => x.id !== id);
  renumber(p.requirements);
  touch(p, ctx, true);
  record(ctx, "requirement.deleted", "Requirement", id, r, null);
}

export function reorderRequirements(p: Proposal, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "requirements.edit");
  assertEditable(p.state, "Requirements");
  const ids = optStringArray(asObject(body), "ids");
  assertPermutation(ids, p.requirements.map((r) => r.id), "requirement");
  const before = sorted(p.requirements).map((r) => r.id);
  for (const r of p.requirements) r.order = ids.indexOf(r.id);
  p.requirements.sort((a, b) => a.order - b.order);
  touch(p, ctx, true);
  record(ctx, "requirement.reordered", "Proposal", p.id, before, ids);
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

function findMilestone(p: Proposal, id: string): Milestone {
  const m = p.milestones.find((x) => x.id === id);
  if (!m) throw notFound("Milestone", id);
  return m;
}

export function addMilestone(p: Proposal, body: unknown, ctx: CommandContext): Milestone {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const input = asObject(body);
  const m: Milestone = {
    id: newId("ms"),
    title: reqString(input, "title", { max: 300 }),
    description: optString(input, "description"),
    order: p.milestones.length,
    ...meta(ctx),
  };
  p.milestones.push(m);
  touch(p, ctx, true);
  record(ctx, "milestone.created", "Milestone", m.id, null, m);
  return m;
}

export function updateMilestone(p: Proposal, id: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const m = findMilestone(p, id);
  const input = asObject(body);
  const before = structuredClone(m);
  if (has(input, "title")) m.title = reqString(input, "title", { max: 300 });
  if (has(input, "description")) m.description = optString(input, "description");
  const changes = changedFields(before, m);
  if (changes.length === 0) return;
  m.updatedAt = ctx.now;
  m.updatedBy = ctx.actor.userId;
  touch(p, ctx, true);
  record(ctx, "milestone.updated", "Milestone", m.id, before, m, { changes });
}

export function deleteMilestone(p: Proposal, id: string, ctx: CommandContext) {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const m = findMilestone(p, id);
  const tasks = p.tasks.filter((t) => t.milestoneId === id);
  if (tasks.length > 0) {
    throw conflict("MILESTONE_HAS_TASKS", "Move or delete this milestone's tasks before deleting it.", { taskIds: tasks.map((t) => t.id) });
  }
  p.milestones = p.milestones.filter((x) => x.id !== id);
  renumber(p.milestones);
  touch(p, ctx, true);
  record(ctx, "milestone.deleted", "Milestone", id, m, null);
}

export function reorderMilestones(p: Proposal, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const ids = optStringArray(asObject(body), "ids");
  assertPermutation(ids, p.milestones.map((m) => m.id), "milestone");
  const before = sorted(p.milestones).map((m) => m.id);
  for (const m of p.milestones) m.order = ids.indexOf(m.id);
  p.milestones.sort((a, b) => a.order - b.order);
  touch(p, ctx, true);
  record(ctx, "milestone.reordered", "Proposal", p.id, before, ids);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function findTask(p: Proposal, id: string): Task {
  const t = p.tasks.find((x) => x.id === id);
  if (!t) throw notFound("Task", id);
  return t;
}

function validateDependencies(p: Proposal, taskId: string, dependsOn: string[]) {
  for (const dep of dependsOn) {
    if (dep === taskId) throw validation("DEPENDENCY_SELF", "A task cannot depend on itself.");
    if (!p.tasks.some((t) => t.id === dep)) throw validation("DEPENDENCY_UNKNOWN", `Dependency ${dep} is not a task of this proposal.`, { taskId: dep });
  }
  // Cycle detection over the dependency graph with the proposed edges.
  const graph = new Map<string, string[]>(p.tasks.map((t) => [t.id, t.id === taskId ? dependsOn : t.dependsOn]));
  if (!graph.has(taskId)) graph.set(taskId, dependsOn);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw validation("DEPENDENCY_CYCLE", "Task dependencies must not form a cycle.", { cycle: [...path, id] });
    state.set(id, 1);
    for (const next of graph.get(id) ?? []) visit(next, [...path, id]);
    state.set(id, 2);
  };
  for (const id of graph.keys()) visit(id, []);
}

function validateRequirementLinks(p: Proposal, ids: string[]) {
  for (const id of ids) {
    if (!p.requirements.some((r) => r.id === id)) throw validation("REQUIREMENT_UNKNOWN", `Requirement ${id} is not part of this proposal.`, { requirementId: id });
  }
}

export function addTask(p: Proposal, body: unknown, ctx: CommandContext): Task {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const input = asObject(body);
  const milestoneId = reqString(input, "milestoneId");
  findMilestone(p, milestoneId);
  const id = newId("task");
  const dependsOn = [...new Set(optStringArray(input, "dependsOn"))];
  const requirementIds = [...new Set(optStringArray(input, "requirementIds"))];
  validateDependencies(p, id, dependsOn);
  validateRequirementLinks(p, requirementIds);
  const t: Task = {
    id,
    milestoneId,
    title: reqString(input, "title", { max: 300 }),
    description: optString(input, "description"),
    scope: optString(input, "scope"),
    deliveryType: optEnum(input, "deliveryType", DELIVERY_TYPES, "INTERNAL"),
    mandatory: optBool(input, "mandatory", true),
    dependsOn,
    requirementIds,
    order: p.tasks.filter((x) => x.milestoneId === milestoneId).length,
    revision: 1,
    selectedEstimateId: null,
    ...meta(ctx),
  };
  p.tasks.push(t);
  touch(p, ctx, true);
  record(ctx, "task.created", "Task", t.id, null, t);
  return t;
}

/** Fields whose change alters what was estimated / committed to; they bump the task revision. */
const SCOPE_FIELDS = ["title", "description", "scope", "deliveryType", "mandatory"] as const;

export function updateTask(p: Proposal, id: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const t = findTask(p, id);
  const input = asObject(body);
  const before = structuredClone(t);
  if (has(input, "title")) t.title = reqString(input, "title", { max: 300 });
  if (has(input, "description")) t.description = optString(input, "description");
  if (has(input, "scope")) t.scope = optString(input, "scope");
  if (has(input, "deliveryType")) {
    const next = reqEnum(input, "deliveryType", DELIVERY_TYPES);
    if (next === "INTERNAL" && p.vendorOffers.some((o) => o.taskId === id && o.status === "ACCEPTED")) {
      throw conflict("TASK_HAS_VENDOR_COMMITMENT", "This task has an accepted vendor commitment and cannot become internal-only.");
    }
    t.deliveryType = next;
  }
  if (has(input, "mandatory")) t.mandatory = optBool(input, "mandatory", t.mandatory);
  if (has(input, "dependsOn")) {
    const deps = [...new Set(optStringArray(input, "dependsOn"))];
    validateDependencies(p, id, deps);
    t.dependsOn = deps;
  }
  if (has(input, "requirementIds")) {
    const reqs = [...new Set(optStringArray(input, "requirementIds"))];
    validateRequirementLinks(p, reqs);
    t.requirementIds = reqs;
  }
  if (has(input, "milestoneId")) {
    const target = reqString(input, "milestoneId");
    if (target !== t.milestoneId) {
      findMilestone(p, target);
      const from = t.milestoneId;
      t.milestoneId = target;
      t.order = p.tasks.filter((x) => x.milestoneId === target && x.id !== id).length;
      renumber(sorted(p.tasks.filter((x) => x.milestoneId === from)));
    }
  }
  const changes = changedFields(before, t);
  if (changes.length === 0) return;
  if (changes.some((c) => (SCOPE_FIELDS as readonly string[]).includes(c))) t.revision += 1;
  t.updatedAt = ctx.now;
  t.updatedBy = ctx.actor.userId;
  touch(p, ctx, true);
  record(ctx, changes.includes("milestoneId") ? "task.moved" : "task.updated", "Task", t.id, before, t, { changes });
}

/**
 * Deleting a task is refused while anything depends on it: other tasks, estimates
 * (evidence), active assignments, vendor offers or vendor access grants.
 */
export function deleteTask(p: Proposal, id: string, ctx: CommandContext) {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  const t = findTask(p, id);
  const blockers: Record<string, string[]> = {
    dependentTaskIds: p.tasks.filter((x) => x.dependsOn.includes(id)).map((x) => x.id),
    estimateIds: p.estimates.filter((e) => e.taskId === id).map((e) => e.id),
    assignmentIds: p.assignments.filter((a) => a.taskId === id && a.status !== "RELEASED").map((a) => a.id),
    vendorOfferIds: p.vendorOffers.filter((o) => o.taskId === id).map((o) => o.id),
    vendorGrantIds: p.vendorGrants.filter((g) => g.revokedAt === null && g.taskIds.includes(id)).map((g) => g.id),
  };
  const blocking = Object.fromEntries(Object.entries(blockers).filter(([, v]) => v.length > 0));
  if (Object.keys(blocking).length > 0) {
    throw conflict("TASK_HAS_DEPENDENT_DATA", "This task has dependent tasks, estimates, assignments or vendor records and cannot be deleted.", blocking);
  }
  p.tasks = p.tasks.filter((x) => x.id !== id);
  p.aiRequests = p.aiRequests.filter((r) => r.taskId !== id);
  renumber(sorted(p.tasks.filter((x) => x.milestoneId === t.milestoneId)));
  touch(p, ctx, true);
  record(ctx, "task.deleted", "Task", id, t, null);
}

export function reorderTasks(p: Proposal, milestoneId: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "workbreakdown.edit");
  assertEditable(p.state, "Work breakdown");
  findMilestone(p, milestoneId);
  const ids = optStringArray(asObject(body), "ids");
  const tasks = p.tasks.filter((t) => t.milestoneId === milestoneId);
  assertPermutation(ids, tasks.map((t) => t.id), "task");
  const before = sorted(tasks).map((t) => t.id);
  for (const t of tasks) t.order = ids.indexOf(t.id);
  touch(p, ctx, true);
  record(ctx, "task.reordered", "Milestone", milestoneId, before, ids);
}

// ---------------------------------------------------------------------------

export function sorted<T extends { order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

function renumber<T extends { order: number }>(items: T[]) {
  sorted(items).forEach((x, i) => (x.order = i));
}

/** Tasks in delivery order: milestone order, then task order. */
export function orderedTasks(p: Proposal): Task[] {
  const msOrder = new Map(p.milestones.map((m) => [m.id, m.order]));
  return [...p.tasks].sort((a, b) => (msOrder.get(a.milestoneId)! - msOrder.get(b.milestoneId)!) || a.order - b.order);
}
