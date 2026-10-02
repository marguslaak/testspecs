import { authorize, can, canCreateProposal, vendorTaskScope } from "../domain/authz.js";
import type { CommandContext, Lookups } from "../domain/context.js";
import { renderOfferDocument, sha256 } from "../domain/document.js";
import { conflict, DomainError, forbidden, notFound } from "../domain/errors.js";
import * as estimation from "../domain/estimation.js";
import type { LifecycleCommand } from "../domain/lifecycle.js";
import { calculatePricing } from "../domain/pricing.js";
import * as proposals from "../domain/proposal.js";
import { evaluateReadiness } from "../domain/readiness.js";
import * as staffing from "../domain/staffing.js";
import { type Actor, type AuditRecord, type Proposal, SYSTEM_ACTOR, type User } from "../domain/types.js";
import { type Clock, newId, systemClock } from "../domain/util.js";
import * as vendor from "../domain/vendor.js";
import { capabilities, executeLifecycle, findOfferVersion } from "../domain/workflow.js";
import type { EstimationInput, EstimationProvider } from "../infra/ai.js";
import { EstimationProviderError } from "../infra/ai.js";
import type { Database } from "../infra/db.js";
import type { IdentityClaims } from "../infra/identity.js";
import {
  AuditRepository,
  DocumentRepository,
  ProposalRepository,
  ReadinessRepository,
  UserRepository,
  VendorOrganizationRepository,
} from "../infra/repositories.js";

export interface ServiceOptions {
  clock?: Clock;
  estimationProvider: EstimationProvider;
}

/**
 * Application service: loads the aggregate, runs a domain command against a
 * copy, then saves the aggregate (compare-and-swap on revision) together with
 * its audit records, readiness checks and generated documents in one transaction.
 */
export class OfferService {
  readonly users: UserRepository;
  readonly vendorOrgs: VendorOrganizationRepository;
  readonly proposals: ProposalRepository;
  readonly readiness: ReadinessRepository;
  readonly documents: DocumentRepository;
  readonly audit: AuditRepository;
  readonly clock: Clock;
  readonly ai: AiEstimationRunner;
  private readonly lookups: Lookups;

  constructor(
    readonly store: Database,
    opts: ServiceOptions,
  ) {
    this.users = new UserRepository(store);
    this.vendorOrgs = new VendorOrganizationRepository(store);
    this.proposals = new ProposalRepository(store);
    this.readiness = new ReadinessRepository(store);
    this.documents = new DocumentRepository(store);
    this.audit = new AuditRepository(store);
    this.clock = opts.clock ?? systemClock;
    this.lookups = { getUser: (id) => this.users.get(id), getVendorOrganization: (id) => this.vendorOrgs.get(id) };
    this.ai = new AiEstimationRunner(this, opts.estimationProvider);
  }

  now() {
    return this.clock.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** Maps verified identity-provider claims to a local user record (identity reference only). */
  syncIdentity(claims: IdentityClaims): User {
    const now = this.now();
    return this.store.transaction(() => {
      if (claims.vendorOrganizationId && !this.vendorOrgs.get(claims.vendorOrganizationId)) {
        this.vendorOrgs.upsert({ id: claims.vendorOrganizationId, name: claims.vendorOrganizationName ?? claims.vendorOrganizationId, createdAt: now });
      }
      const existing = this.users.findBySubject(claims.issuer, claims.subject);
      const user: User = {
        id: existing?.id ?? newId("usr"),
        idpIssuer: claims.issuer,
        idpSubject: claims.subject,
        kind: claims.kind,
        displayName: claims.displayName,
        email: claims.email,
        roles: claims.roles,
        vendorOrganizationId: claims.vendorOrganizationId,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
      };
      this.users.upsert(user);
      return user;
    });
  }

  actorFor(user: User): Actor {
    return { userId: user.id, kind: user.kind, roles: user.roles, vendorOrganizationId: user.vendorOrganizationId, displayName: user.displayName };
  }

  /** Internal directory for staffing pickers. External users only ever see themselves. */
  listUsers(actor: Actor) {
    if (actor.kind !== "INTERNAL") throw forbidden();
    return this.users.list().map((u) => ({
      id: u.id,
      kind: u.kind,
      displayName: u.displayName,
      email: u.email,
      roles: u.roles,
      vendorOrganizationId: u.vendorOrganizationId,
    }));
  }

  listVendorOrganizations(actor: Actor) {
    if (actor.kind !== "INTERNAL") throw forbidden();
    return this.vendorOrgs.list();
  }

  // -------------------------------------------------------------------------
  // Command plumbing
  // -------------------------------------------------------------------------

  private context(actor: Actor): CommandContext {
    return { actor, now: this.now(), lookups: this.lookups, audit: [], documents: [], readinessChecks: [] };
  }

  private persist(ctx: CommandContext, proposal: Proposal) {
    for (const d of ctx.documents) this.documents.insert(d, ctx.now);
    for (const c of ctx.readinessChecks) this.readiness.insert(c);
    for (const e of ctx.audit) {
      const rec: AuditRecord = {
        id: newId("aud"),
        actorUserId: ctx.actor.userId,
        actorKind: ctx.actor.kind,
        at: ctx.now,
        ...e,
        proposalId: e.proposalId ?? proposal.id,
      };
      this.audit.append(rec);
    }
  }

  create(actor: Actor, body: unknown): Proposal {
    if (!canCreateProposal(actor)) throw forbidden("Only Account Managers can create proposals.");
    const ctx = this.context(actor);
    const p = proposals.createProposal(body, ctx);
    this.store.transaction(() => {
      this.proposals.insert(p);
      this.persist(ctx, p);
    });
    return p;
  }

  /**
   * Runs a command. `expectedRevision`, when given, must equal the stored
   * revision (If-Match) so a user never silently overwrites changes they have
   * not seen. The save itself is always compare-and-swap.
   */
  mutate<T>(actor: Actor, proposalId: string, expectedRevision: number | undefined, fn: (p: Proposal, ctx: CommandContext) => T): { proposal: Proposal; result: T } {
    const current = this.proposals.get(proposalId);
    if (actor.kind === "INTERNAL" && !can(actor, current, "proposal.view")) {
      throw forbidden("You do not have access to this proposal.", "PROPOSAL_ACCESS_DENIED");
    }
    if (actor.kind === "EXTERNAL" && vendorTaskScope(actor, current).size === 0) {
      throw forbidden("You do not have access to this proposal.", "PROPOSAL_ACCESS_DENIED");
    }
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw conflict("VERSION_CONFLICT", "The proposal was changed by someone else. Reload and try again.", {
        expectedRevision,
        currentRevision: current.revision,
      });
    }
    const draft = structuredClone(current);
    const ctx = this.context(actor);
    const result = fn(draft, ctx);
    if (ctx.audit.length === 0) return { proposal: current, result };
    draft.revision = current.revision + 1;
    this.store.transaction(() => {
      this.proposals.save(draft, current.revision);
      this.persist(ctx, draft);
    });
    return { proposal: draft, result };
  }

  /** For background jobs: retries on concurrent modification instead of failing. */
  mutateWithRetry<T>(actor: Actor, proposalId: string, fn: (p: Proposal, ctx: CommandContext) => T, attempts = 5) {
    for (let i = 0; ; i++) {
      try {
        return this.mutate(actor, proposalId, undefined, fn);
      } catch (err) {
        if (err instanceof DomainError && err.code === "VERSION_CONFLICT" && i < attempts - 1) continue;
        throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  listProposals(actor: Actor) {
    let list: Proposal[];
    if (actor.kind === "EXTERNAL") list = this.proposals.listForUser(actor.userId, "VENDOR");
    else if (actor.roles.includes("COMMERCIAL_APPROVER")) list = this.proposals.listAll();
    else list = this.proposals.listForUser(actor.userId, "MEMBER");
    if (actor.kind === "EXTERNAL") {
      return list
        .filter((p) => vendorTaskScope(actor, p).size > 0)
        .map((p) => ({ id: p.id, title: p.title, state: p.state, sharedTasks: vendorTaskScope(actor, p).size }));
    }
    return list
      .filter((p) => can(actor, p, "proposal.view"))
      .map((p) => {
        const check = this.readiness.list(p.id, 1)[0];
        return {
          id: p.id,
          title: p.title,
          customerName: p.customerName,
          customerReference: p.customerReference,
          state: p.state,
          ownerId: p.ownerId,
          updatedAt: p.updatedAt,
          counts: {
            requirements: p.requirements.length,
            milestones: p.milestones.length,
            tasks: p.tasks.length,
            estimates: p.estimates.length,
            offerVersions: p.offerVersions.length,
          },
          readiness: check ? { passed: check.passed, current: check.proposalContentVersion === p.contentVersion, evaluatedAt: check.evaluatedAt } : null,
          totals: calculatePricing(p).totals,
        };
      });
  }

  /** Full internal view of a proposal with the caller's capabilities. */
  getProposal(actor: Actor, id: string) {
    const p = this.proposals.get(id);
    if (actor.kind !== "INTERNAL") throw forbidden("You do not have access to this proposal.", "PROPOSAL_ACCESS_DENIED");
    authorize(actor, p, "proposal.view");
    const latest = this.readiness.list(id, 1)[0] ?? null;
    return {
      proposal: p,
      capabilities: capabilities(p, actor),
      pricing: calculatePricing(p),
      readiness: latest ? { ...latest, current: latest.proposalContentVersion === p.contentVersion } : null,
    };
  }

  estimates(actor: Actor, proposalId: string, taskId: string) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden("Internal estimates are not visible to external users.", "PROPOSAL_ACCESS_DENIED");
    authorize(actor, p, "proposal.view");
    return estimation.estimateComparison(p, taskId);
  }

  readinessHistory(actor: Actor, proposalId: string) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden();
    authorize(actor, p, "proposal.view");
    return this.readiness.list(proposalId);
  }

  auditTrail(actor: Actor, proposalId: string) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden();
    authorize(actor, p, "audit.view");
    return this.audit.listForProposal(proposalId);
  }

  /** Dry readiness check: evaluates and records the result without touching the proposal. */
  runReadinessCheck(actor: Actor, proposalId: string) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden();
    authorize(actor, p, "readiness.run");
    const check = evaluateReadiness(p, actor.userId, this.now());
    this.store.transaction(() => {
      this.readiness.insert(check);
      this.audit.append({
        id: newId("aud"),
        actorUserId: actor.userId,
        actorKind: actor.kind,
        action: "readiness.evaluated",
        entityType: "OfferReadinessCheck",
        entityId: check.id,
        proposalId,
        at: check.evaluatedAt,
        before: null,
        after: { passed: check.passed, failing: check.outcomes.filter((o) => !o.passed).map((o) => o.code) },
        metadata: { proposalContentVersion: check.proposalContentVersion },
      });
    });
    return check;
  }

  offerVersions(actor: Actor, proposalId: string) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden();
    authorize(actor, p, "proposal.view");
    return p.offerVersions;
  }

  /**
   * Returns the offer document. For a version with a stored final document the
   * stored bytes are returned; otherwise a preview is rendered from the snapshot.
   */
  offerDocument(actor: Actor, proposalId: string, versionNumber: number) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden();
    authorize(actor, p, "proposal.view");
    const v = findOfferVersion(p, versionNumber);
    if (v.document) {
      const doc = this.documents.get(v.document.ref);
      if (!doc) throw notFound("Document", v.document.ref);
      return { content: doc.content, final: true, sha256: doc.sha256, filename: `${slug(p.title)}-offer-v${v.number}.html` };
    }
    const content = renderOfferDocument(v.snapshot, v.number);
    return { content, final: false, sha256: sha256(content), filename: `${slug(p.title)}-offer-v${v.number}-preview.html` };
  }

  /** Regenerates the document from the frozen snapshot and compares it with the stored hash. */
  verifyOfferDocument(actor: Actor, proposalId: string, versionNumber: number) {
    const p = this.proposals.get(proposalId);
    if (actor.kind !== "INTERNAL") throw forbidden();
    authorize(actor, p, "proposal.view");
    const v = findOfferVersion(p, versionNumber);
    if (!v.document) throw conflict("OFFER_DOCUMENT_MISSING", "This offer version has no final document yet.");
    const stored = this.documents.get(v.document.ref);
    const regenerated = sha256(renderOfferDocument(v.snapshot, v.number));
    return {
      version: v.number,
      recordedSha256: v.document.sha256,
      storedSha256: stored ? sha256(stored.content) : null,
      regeneratedSha256: regenerated,
      intact: !!stored && sha256(stored.content) === v.document.sha256 && regenerated === v.document.sha256,
    };
  }

  // -------------------------------------------------------------------------
  // Vendor portal
  // -------------------------------------------------------------------------

  vendorView(actor: Actor, proposalId: string) {
    if (actor.kind !== "EXTERNAL") throw forbidden("The vendor portal is for external vendor users.", "NOT_VENDOR");
    let p: Proposal;
    try {
      p = this.proposals.get(proposalId);
    } catch {
      // Do not reveal whether an unshared proposal exists.
      throw forbidden("You do not have access to this proposal.", "PROPOSAL_ACCESS_DENIED");
    }
    return vendor.vendorProposalView(p, actor);
  }

  // -------------------------------------------------------------------------
  // Commands (thin wrappers so the HTTP layer stays declarative)
  // -------------------------------------------------------------------------

  readonly commands = {
    updateDetails: proposals.updateProposalDetails,
    updateCommercial: proposals.updateCommercial,
    addMember: proposals.addMember,
    addRequirement: proposals.addRequirement,
    updateRequirement: proposals.updateRequirement,
    deleteRequirement: proposals.deleteRequirement,
    reorderRequirements: proposals.reorderRequirements,
    addMilestone: proposals.addMilestone,
    updateMilestone: proposals.updateMilestone,
    deleteMilestone: proposals.deleteMilestone,
    reorderMilestones: proposals.reorderMilestones,
    addTask: proposals.addTask,
    updateTask: proposals.updateTask,
    deleteTask: proposals.deleteTask,
    reorderTasks: proposals.reorderTasks,
    submitEstimate: estimation.submitHumanEstimate,
    selectEstimate: estimation.selectEstimate,
    assign: staffing.assignToTask,
    updateAssignment: staffing.updateAssignment,
    proposeRole: staffing.proposeRole,
    respondToRole: staffing.respondToRole,
    revokeRole: staffing.revokeRole,
    grantVendorAccess: vendor.grantVendorAccess,
    revokeVendorAccess: vendor.revokeVendorAccess,
    submitVendorOffer: vendor.submitVendorOffer,
    withdrawVendorOffer: vendor.withdrawVendorOffer,
    acceptVendorOffer: vendor.acceptVendorOffer,
    reviewVendorOffer: vendor.reviewVendorOffer,
    removeMember: proposals.removeMember,
  };

  lifecycle(actor: Actor, proposalId: string, expectedRevision: number | undefined, command: LifecycleCommand, body: unknown) {
    return this.mutate(actor, proposalId, expectedRevision, (p, ctx) => executeLifecycle(p, command, body, ctx));
  }

  requestAiEstimate(actor: Actor, proposalId: string, taskId: string) {
    const res = this.mutate(actor, proposalId, undefined, (p, ctx) => estimation.requestAiEstimate(p, taskId, ctx));
    this.ai.enqueue(proposalId, res.result.id);
    return res;
  }

  /** Re-queues AI requests left pending by a previous process. */
  resumePendingAiRequests() {
    for (const p of this.proposals.listAll()) for (const r of p.aiRequests) if (r.status === "PENDING") this.ai.enqueue(p.id, r.id);
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "offer";

/**
 * Runs AI estimate requests in the background, one at a time. Results are
 * written back as the system actor; any provider error marks only that request
 * as FAILED.
 */
export class AiEstimationRunner {
  private queue: { proposalId: string; requestId: string }[] = [];
  private running: Promise<void> | null = null;

  constructor(
    private readonly service: OfferService,
    private readonly provider: EstimationProvider,
  ) {}

  enqueue(proposalId: string, requestId: string) {
    this.queue.push({ proposalId, requestId });
    if (!this.running) this.running = this.drain().finally(() => (this.running = null));
  }

  /** Resolves when the queue is empty (used by tests and graceful shutdown). */
  async idle() {
    while (this.running) await this.running;
  }

  private async drain() {
    await Promise.resolve();
    while (this.queue.length) {
      const job = this.queue.shift()!;
      await this.process(job.proposalId, job.requestId);
    }
  }

  private async process(proposalId: string, requestId: string) {
    let input: EstimationInput;
    try {
      const p = this.service.proposals.get(proposalId);
      const req = p.aiRequests.find((r) => r.id === requestId);
      if (!req || req.status !== "PENDING") return;
      const task = p.tasks.find((t) => t.id === req.taskId);
      if (!task) throw new EstimationProviderError("TASK_NOT_FOUND", "The task no longer exists.");
      const ms = p.milestones.find((m) => m.id === task.milestoneId);
      input = {
        proposal: { title: p.title, description: p.description },
        requirements: p.requirements
          .filter((r) => task.requirementIds.length === 0 || task.requirementIds.includes(r.id))
          .map((r) => ({ title: r.title, description: r.description, priority: r.priority })),
        milestone: { title: ms?.title ?? "", description: ms?.description ?? "" },
        task: {
          title: task.title,
          description: task.description,
          scope: task.scope,
          deliveryType: task.deliveryType,
          dependsOn: task.dependsOn.map((id) => p.tasks.find((t) => t.id === id)?.title ?? id),
        },
      };
    } catch (err) {
      this.fail(proposalId, requestId, err);
      return;
    }
    try {
      const result = await this.provider.estimate(input);
      this.service.mutateWithRetry(SYSTEM_ACTOR, proposalId, (p, ctx) => estimation.completeAiEstimate(p, requestId, result, ctx));
    } catch (err) {
      this.fail(proposalId, requestId, err);
    }
  }

  private fail(proposalId: string, requestId: string, err: unknown) {
    const error =
      err instanceof EstimationProviderError || err instanceof DomainError
        ? { code: err.code, message: err.message }
        : { code: "AI_ESTIMATION_FAILED", message: "The AI estimate could not be produced." };
    if (!(err instanceof EstimationProviderError) && !(err instanceof DomainError)) console.error("AI estimation failed", err);
    try {
      this.service.mutateWithRetry(SYSTEM_ACTOR, proposalId, (p, ctx) => estimation.failAiEstimate(p, requestId, error, ctx));
    } catch (inner) {
      if (!(inner instanceof DomainError)) console.error("Could not record AI estimate failure", inner);
    }
  }
}

