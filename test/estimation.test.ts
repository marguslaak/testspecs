import { afterEach, describe, expect, it } from "vitest";
import { type EstimationInput, type EstimationProvider, EstimationProviderError, type ProviderEstimate } from "../src/infra/ai.js";
import { command, draftProposal, startApp, type TestApp } from "./helpers.js";

/** Provider whose results the test releases manually, to observe the PENDING state. */
class DeferredProvider implements EstimationProvider {
  readonly name = "deferred";
  calls: EstimationInput[] = [];
  private pending: { resolve: (v: ProviderEstimate) => void; reject: (e: unknown) => void }[] = [];
  estimate(input: EstimationInput) {
    this.calls.push(input);
    return new Promise<ProviderEstimate>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  async waitForCall() {
    while (this.pending.length === 0) await new Promise((r) => setTimeout(r, 5));
  }
  succeed() {
    this.pending.shift()!.resolve({
      provider: "test-ai",
      model: "test-model-1",
      effortMin: 10,
      effortExpected: 16,
      effortMax: 30,
      unit: "HOURS",
      assumptions: ["API exists"],
      rationale: "Comparable task",
      confidence: 0.6,
    });
  }
  fail() {
    this.pending.shift()!.reject(new EstimationProviderError("AI_UNAVAILABLE", "Service down"));
  }
}

let h: TestApp;
afterEach(async () => h.close());

async function inEstimation(provider?: EstimationProvider) {
  h = await startApp({ provider });
  const f = await draftProposal(h);
  await command(h, "sam", f.id, "markRequirementsReady");
  await command(h, "sam", f.id, "startEstimation");
  return f;
}

const figures = { effortMin: 20, effortExpected: 30, effortMax: 50, unit: "HOURS", assumptions: ["a"], rationale: "r", confidence: 0.8 };

describe("AI estimation", () => {
  it("runs asynchronously and stores provenance on success", async () => {
    const ai = new DeferredProvider();
    const f = await inEstimation(ai);
    const res = await h.api("sam", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/ai-estimates`);
    expect(res.status).toBe(202);
    await ai.waitForCall();
    let cmp = await h.ok("sam", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`);
    expect(cmp.aiRequests[0]).toMatchObject({ status: "PENDING", taskRevision: 1, requestedBy: h.userIds.sam });
    expect(ai.calls[0].task.title).toBe("Invoice list API");
    expect(ai.calls[0].requirements.map((r) => r.title)).toEqual(["Customers can view invoices"]);

    ai.succeed();
    await h.app.service.ai.idle();
    cmp = await h.ok("sam", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`);
    expect(cmp.aiRequests[0]).toMatchObject({ status: "COMPLETED", completedAt: expect.any(String) });
    expect(cmp.estimates[0]).toMatchObject({
      source: "AI",
      estimatorUserId: null,
      ai: { provider: "test-ai", model: "test-model-1", requestId: cmp.aiRequests[0].id },
      taskRevision: 1,
      effortMin: 10,
      effortExpected: 16,
      effortMax: 30,
      unit: "HOURS",
      assumptions: ["API exists"],
      rationale: "Comparable task",
      confidence: 0.6,
      createdAt: expect.any(String),
    });
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    expect(audit.find((a: any) => a.action === "aiEstimate.completed")).toMatchObject({ actorUserId: "system", actorKind: "SYSTEM" });
  });

  it("records failure without blocking human estimates made meanwhile", async () => {
    const ai = new DeferredProvider();
    const f = await inEstimation(ai);
    await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/ai-estimates`);
    await ai.waitForCall();
    // Human estimation proceeds while the AI request is pending.
    await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, figures);
    const dup = await h.api("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/ai-estimates`);
    expect(dup.body.error.code).toBe("AI_REQUEST_PENDING");
    ai.fail();
    await h.app.service.ai.idle();
    const cmp = await h.ok("sam", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`);
    expect(cmp.aiRequests[0]).toMatchObject({ status: "FAILED", error: { code: "AI_UNAVAILABLE", message: "Service down" } });
    expect(cmp.estimates).toHaveLength(1);
    expect(cmp.estimates[0].source).toBe("HUMAN");
    // A new request is allowed after a failure.
    expect((await h.api("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/ai-estimates`)).status).toBe(202);
    ai.succeed();
    await h.app.service.ai.idle();
  });

  it("the default heuristic provider produces a complete estimate", async () => {
    const f = await inEstimation();
    await h.ok("sam", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/ai-estimates`);
    await h.app.service.ai.idle();
    const cmp = await h.ok("sam", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`);
    const e = cmp.estimates[0];
    expect(e.ai).toMatchObject({ provider: "heuristic", model: "scope-heuristic-v1" });
    expect(e.effortMin).toBeLessThanOrEqual(e.effortExpected);
    expect(e.effortExpected).toBeLessThanOrEqual(e.effortMax);
    expect(e.assumptions.length).toBeGreaterThan(0);
  });

  it("fails the AI request if the proposal was locked before it finished", async () => {
    const ai = new DeferredProvider();
    const f = await inEstimation(ai);
    await h.ok("sam", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/ai-estimates`);
    await ai.waitForCall();
    await command(h, "anna", f.id, "cancel", { reason: "Customer withdrew" });
    ai.succeed();
    await h.app.service.ai.idle();
    const p = await h.proposal(f.id);
    expect(p.aiRequests[0]).toMatchObject({ status: "FAILED", error: { code: "PROPOSAL_LOCKED" } });
    expect(p.estimates).toHaveLength(0);
  });
});

describe("human estimates", () => {
  it("accepts multiple estimates per task, each identifying the estimator", async () => {
    const f = await inEstimation();
    await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, figures);
    await h.ok("sam", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { ...figures, effortExpected: 4, effortMin: 3, effortMax: 6, unit: "DAYS" });
    const cmp = await h.ok("sam", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`);
    expect(cmp.estimates.map((e: any) => e.estimatorUserId)).toEqual([h.userIds.dana, h.userIds.sam]);
    expect(cmp.estimates.map((e: any) => e.expectedHours)).toEqual([30, 32]);
    expect(cmp.summary).toMatchObject({ currentCount: 2, humanCount: 2, minExpectedHours: 30, maxExpectedHours: 32, meanExpectedHours: 31 });
  });

  it("corrections supersede; the original stays unchanged", async () => {
    const f = await inEstimation();
    const first = await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, figures);
    await h.ok("sam", "PUT", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/selected-estimate`, { estimateId: first.result.id });
    const fix = await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { ...figures, effortExpected: 35, supersedesId: first.result.id });
    const p = await h.proposal(f.id);
    const old = p.estimates.find((e: any) => e.id === first.result.id);
    expect(old).toMatchObject({ effortExpected: 30, supersededById: fix.result.id, supersededAt: expect.any(String) });
    expect(p.estimates.find((e: any) => e.id === fix.result.id)).toMatchObject({ effortExpected: 35, supersedesId: first.result.id });
    // The pricing selection follows the correction.
    expect(p.tasks.find((t: any) => t.id === f.internalTaskId).selectedEstimateId).toBe(fix.result.id);

    const again = await h.api("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { ...figures, supersedesId: first.result.id });
    expect(again.body.error.code).toBe("ESTIMATE_ALREADY_SUPERSEDED");
    const notOwn = await h.api("sam", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { ...figures, supersedesId: fix.result.id });
    expect(notOwn.body.error.code).toBe("ESTIMATE_NOT_OWN");
    const selectOld = await h.api("sam", "PUT", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/selected-estimate`, { estimateId: first.result.id });
    expect(selectOld.body.error.code).toBe("ESTIMATE_SUPERSEDED");
  });

  it("there is no API to modify or delete a submitted estimate", async () => {
    const f = await inEstimation();
    const e = await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, figures);
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const res = await h.api("dana", method, `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates/${e.result.id}`, {}, await h.revision(f.id));
      expect(res.status).toBe(404);
    }
  });

  it("validates effort ranges and the estimation phase", async () => {
    const f = await inEstimation();
    const bad = await h.api("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { ...figures, effortMin: 40 });
    expect(bad.body.error.code).toBe("EFFORT_RANGE_INVALID");
    const external = await h.api("dana", "POST", `/api/proposals/${f.id}/tasks/${f.externalTaskId}/estimates`, figures);
    expect(external.body.error.code).toBe("TASK_EXTERNAL");

    const draft = await draftProposal(h);
    const early = await h.api("dana", "POST", `/api/proposals/${draft.id}/tasks/${draft.internalTaskId}/estimates`, figures);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("PHASE_NOT_STARTED");
  });

  it("flags estimates made against an earlier task scope as stale", async () => {
    const f = await inEstimation();
    await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, figures);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { scope: "Now also exports to CSV" }, await h.revision(f.id));
    const cmp = await h.ok("sam", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`);
    expect(cmp.taskRevision).toBe(2);
    expect(cmp.estimates[0]).toMatchObject({ taskRevision: 1, stale: true });
  });

  it("external vendors cannot see internal estimates", async () => {
    const f = await inEstimation();
    await h.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, figures);
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.vera, taskIds: [f.externalTaskId] });
    expect((await h.api("vera", "GET", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`)).status).toBe(403);
    expect((await h.api("vera", "GET", `/api/proposals/${f.id}`)).status).toBe(403);
    const view = await h.ok("vera", "GET", `/api/portal/proposals/${f.id}`);
    expect(JSON.stringify(view)).not.toMatch(/estimate|effort|hourlyRate|margin|Markup/i);
  });
});
