import { authorize } from "./authz.js";
import { type CommandContext, record, touch } from "./context.js";
import { conflict, notFound, validation } from "./errors.js";
import { assertEstimationPhase, isWorkingState } from "./lifecycle.js";
import { findTask } from "./proposal.js";
import { type AiEstimateRequest, EFFORT_UNITS, type Estimate, HOURS_PER_DAY, type Proposal } from "./types.js";
import { asObject, newId, optEnum, optNumber, optString, optStringArray, reqNumber } from "./util.js";

/** Provider-neutral estimate payload produced by humans or the AI estimation engine. */
export interface EstimateFigures {
  effortMin: number;
  effortExpected: number;
  effortMax: number;
  unit: (typeof EFFORT_UNITS)[number];
  assumptions: string[];
  rationale: string;
  confidence: number | null;
}

export function parseFigures(body: unknown): EstimateFigures {
  const input = asObject(body);
  const f: EstimateFigures = {
    effortMin: reqNumber(input, "effortMin", { min: 0, max: 100_000 }),
    effortExpected: reqNumber(input, "effortExpected", { min: 0, max: 100_000 }),
    effortMax: reqNumber(input, "effortMax", { min: 0, max: 100_000 }),
    unit: optEnum(input, "unit", EFFORT_UNITS, "HOURS"),
    assumptions: optStringArray(input, "assumptions"),
    rationale: optString(input, "rationale"),
    confidence: input.confidence === undefined || input.confidence === null ? null : optNumber(input, "confidence", 0, { min: 0, max: 1 }),
  };
  validateFigures(f);
  return f;
}

export function validateFigures(f: EstimateFigures) {
  if (!(f.effortMin <= f.effortExpected && f.effortExpected <= f.effortMax)) {
    throw validation("EFFORT_RANGE_INVALID", "Effort must satisfy min ≤ expected ≤ max.");
  }
  if (f.effortExpected <= 0) throw validation("EFFORT_REQUIRED", "Expected effort must be greater than zero.");
}

export const toHours = (value: number, unit: Estimate["unit"]) => (unit === "DAYS" ? value * HOURS_PER_DAY : value);

export const isCurrent = (e: Estimate) => e.supersededById === null;

/**
 * Submits a human estimate. Estimates are immutable evidence: a correction is a
 * new estimate that names the one it supersedes; the old one is retained.
 */
export function submitHumanEstimate(p: Proposal, taskId: string, body: unknown, ctx: CommandContext): Estimate {
  authorize(ctx.actor, p, "estimate.submit");
  assertEstimationPhase(p.state, "Estimating");
  const task = findTask(p, taskId);
  if (task.deliveryType === "EXTERNAL") {
    throw conflict("TASK_EXTERNAL", "Externally sourced tasks are priced by vendor offers, not internal estimates.");
  }
  const input = asObject(body);
  const figures = parseFigures(input);
  const supersedesId = optString(input, "supersedesId") || null;
  let superseded: Estimate | undefined;
  if (supersedesId) {
    superseded = p.estimates.find((e) => e.id === supersedesId && e.taskId === taskId);
    if (!superseded) throw notFound("Estimate", supersedesId);
    if (!isCurrent(superseded)) throw conflict("ESTIMATE_ALREADY_SUPERSEDED", "That estimate has already been superseded.");
    if (superseded.source !== "HUMAN" || superseded.estimatorUserId !== ctx.actor.userId) {
      throw conflict("ESTIMATE_NOT_OWN", "Only the original estimator can correct a human estimate; submit your own estimate instead.");
    }
  }
  const e: Estimate = {
    id: newId("est"),
    taskId,
    source: "HUMAN",
    estimatorUserId: ctx.actor.userId,
    ai: null,
    taskRevision: task.revision,
    ...figures,
    createdAt: ctx.now,
    supersedesId: superseded?.id ?? null,
    supersededById: null,
    supersededAt: null,
  };
  p.estimates.push(e);
  if (superseded) supersede(p, superseded, e, ctx);
  touch(p, ctx, true);
  record(ctx, "estimate.submitted", "Estimate", e.id, null, e, { taskId, supersedesId: e.supersedesId });
  return e;
}

function supersede(p: Proposal, old: Estimate, next: Estimate, ctx: CommandContext) {
  old.supersededById = next.id;
  old.supersededAt = ctx.now;
  const task = findTask(p, old.taskId);
  if (task.selectedEstimateId === old.id) task.selectedEstimateId = next.id;
  record(ctx, "estimate.superseded", "Estimate", old.id, null, { supersededById: next.id }, { taskId: old.taskId });
}

/** Records an asynchronous AI estimate request. The job runner completes or fails it later. */
export function requestAiEstimate(p: Proposal, taskId: string, ctx: CommandContext): AiEstimateRequest {
  authorize(ctx.actor, p, "estimate.requestAi");
  assertEstimationPhase(p.state, "Requesting an AI estimate");
  const task = findTask(p, taskId);
  if (task.deliveryType === "EXTERNAL") throw conflict("TASK_EXTERNAL", "Externally sourced tasks are priced by vendor offers.");
  if (p.aiRequests.some((r) => r.taskId === taskId && r.status === "PENDING")) {
    throw conflict("AI_REQUEST_PENDING", "An AI estimate for this task is already in progress.");
  }
  const req: AiEstimateRequest = {
    id: newId("aireq"),
    taskId,
    taskRevision: task.revision,
    status: "PENDING",
    requestedBy: ctx.actor.userId,
    requestedAt: ctx.now,
    completedAt: null,
    estimateId: null,
    error: null,
  };
  p.aiRequests.push(req);
  touch(p, ctx, false);
  record(ctx, "aiEstimate.requested", "AiEstimateRequest", req.id, null, req, { taskId });
  return req;
}

function findPendingAi(p: Proposal, requestId: string): AiEstimateRequest {
  const req = p.aiRequests.find((r) => r.id === requestId);
  if (!req) throw notFound("AiEstimateRequest", requestId);
  if (req.status !== "PENDING") throw conflict("AI_REQUEST_NOT_PENDING", "This AI estimate request is already finished.");
  return req;
}

export function completeAiEstimate(
  p: Proposal,
  requestId: string,
  result: EstimateFigures & { provider: string; model: string },
  ctx: CommandContext,
): Estimate | null {
  const req = findPendingAi(p, requestId);
  if (!isWorkingState(p.state)) {
    failAiEstimate(p, requestId, { code: "PROPOSAL_LOCKED", message: `Proposal moved to ${p.state} before the AI estimate finished.` }, ctx);
    return null;
  }
  validateFigures(result);
  const task = findTask(p, req.taskId);
  const e: Estimate = {
    id: newId("est"),
    taskId: req.taskId,
    source: "AI",
    estimatorUserId: null,
    ai: { provider: result.provider, model: result.model, requestId },
    taskRevision: req.taskRevision,
    effortMin: result.effortMin,
    effortExpected: result.effortExpected,
    effortMax: result.effortMax,
    unit: result.unit,
    assumptions: result.assumptions,
    rationale: result.rationale,
    confidence: result.confidence,
    createdAt: ctx.now,
    supersedesId: null,
    supersededById: null,
    supersededAt: null,
  };
  // A newer AI estimate supersedes the previous current AI estimate for the task.
  const previousAi = p.estimates.find((x) => x.taskId === task.id && x.source === "AI" && isCurrent(x));
  if (previousAi) e.supersedesId = previousAi.id;
  p.estimates.push(e);
  if (previousAi) supersede(p, previousAi, e, ctx);
  req.status = "COMPLETED";
  req.completedAt = ctx.now;
  req.estimateId = e.id;
  touch(p, ctx, true);
  record(ctx, "aiEstimate.completed", "Estimate", e.id, null, e, { taskId: task.id, requestId });
  return e;
}

export function failAiEstimate(p: Proposal, requestId: string, error: { code: string; message: string }, ctx: CommandContext) {
  const req = findPendingAi(p, requestId);
  req.status = "FAILED";
  req.completedAt = ctx.now;
  req.error = error;
  touch(p, ctx, false);
  record(ctx, "aiEstimate.failed", "AiEstimateRequest", req.id, null, req, { taskId: req.taskId });
}

/** Chooses which current estimate prices the task in the commercial offer. */
export function selectEstimate(p: Proposal, taskId: string, body: unknown, ctx: CommandContext) {
  authorize(ctx.actor, p, "estimate.select");
  assertEstimationPhase(p.state, "Selecting the pricing estimate");
  const task = findTask(p, taskId);
  const estimateId = optString(asObject(body), "estimateId") || null;
  if (estimateId) {
    const e = p.estimates.find((x) => x.id === estimateId && x.taskId === taskId);
    if (!e) throw notFound("Estimate", estimateId);
    if (!isCurrent(e)) throw conflict("ESTIMATE_SUPERSEDED", "A superseded estimate cannot be used for pricing.");
  }
  const before = task.selectedEstimateId;
  if (before === estimateId) return;
  task.selectedEstimateId = estimateId;
  touch(p, ctx, true);
  record(ctx, "estimate.selected", "Task", task.id, { selectedEstimateId: before }, { selectedEstimateId: estimateId });
}

/** All estimates for a task, side by side, with summary statistics over current ones. */
export function estimateComparison(p: Proposal, taskId: string) {
  const task = findTask(p, taskId);
  const estimates = p.estimates.filter((e) => e.taskId === taskId);
  const current = estimates.filter(isCurrent);
  const hours = current.map((e) => toHours(e.effortExpected, e.unit));
  return {
    taskId,
    taskRevision: task.revision,
    selectedEstimateId: task.selectedEstimateId,
    estimates: estimates.map((e) => ({
      ...e,
      expectedHours: toHours(e.effortExpected, e.unit),
      current: isCurrent(e),
      stale: e.taskRevision !== task.revision,
    })),
    aiRequests: p.aiRequests.filter((r) => r.taskId === taskId),
    summary: {
      currentCount: current.length,
      humanCount: current.filter((e) => e.source === "HUMAN").length,
      aiCount: current.filter((e) => e.source === "AI").length,
      minExpectedHours: hours.length ? Math.min(...hours) : null,
      maxExpectedHours: hours.length ? Math.max(...hours) : null,
      meanExpectedHours: hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null,
    },
  };
}
