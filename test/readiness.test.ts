import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateReadiness, RULE_CODES } from "../src/domain/readiness.js";
import type { Proposal } from "../src/domain/types.js";
import { command, readyProposal, startApp, type TestApp } from "./helpers.js";

let h: TestApp;
let ready: Proposal;
let id: string;
let internalTaskId: string;
let externalTaskId: string;

beforeAll(async () => {
  h = await startApp();
  const f = await readyProposal(h);
  id = f.id;
  internalTaskId = f.internalTaskId;
  externalTaskId = f.externalTaskId;
  ready = await h.proposal(id);
});
afterAll(async () => h.close());

const NOW = "2026-10-01T10:00:00.000Z";
const failing = (p: Proposal) => evaluateReadiness(p, "tester", NOW).outcomes.filter((o) => !o.passed).map((o) => o.code);
const variant = (fn: (p: Proposal) => void) => {
  const p = structuredClone(ready);
  fn(p);
  return p;
};
const task = (p: Proposal, tid: string) => p.tasks.find((t) => t.id === tid)!;

describe("readiness rules", () => {
  it("the fixture passes every rule", () => {
    const check = evaluateReadiness(ready, "tester", NOW);
    expect(check.passed).toBe(true);
    expect(check.outcomes.map((o) => o.code)).toEqual(RULE_CODES);
    expect(check).toMatchObject({ proposalId: id, proposalContentVersion: ready.contentVersion, evaluatedBy: "tester", evaluatedAt: NOW });
  });

  const cases: [string, string, (p: Proposal) => void][] = [
    ["PROPOSAL_DATA_COMPLETE", "missing customer name", (p) => (p.customerName = "")],
    ["PROPOSAL_DATA_COMPLETE", "draft requirement", (p) => p.requirements.push({ ...p.requirements[0], id: "req_x", status: "DRAFT" })],
    ["PROPOSAL_DATA_COMPLETE", "no confirmed requirement", (p) => p.requirements.forEach((r) => (r.status = "DEFERRED"))],
    ["WORK_BREAKDOWN_COMPLETE", "empty milestone", (p) => p.milestones.push({ ...p.milestones[0], id: "ms_empty", title: "Empty" })],
    ["WORK_BREAKDOWN_COMPLETE", "mandatory task without scope", (p) => (task(p, externalTaskId).scope = "")],
    ["MANDATORY_TASKS_ESTIMATED", "no developer estimate", (p) => (p.estimates = p.estimates.map((e) => ({ ...e, source: "AI" as const })))],
    ["MANDATORY_TASKS_ESTIMATED", "scope changed after estimate", (p) => (task(p, internalTaskId).revision += 1)],
    ["PRICING_ESTIMATE_SELECTED", "no selected estimate", (p) => (task(p, internalTaskId).selectedEstimateId = null)],
    ["MANDATORY_TASKS_ASSIGNED", "no active assignment", (p) => p.assignments.forEach((a) => (a.status = "RELEASED"))],
    ["REQUIRED_ROLES_AGREED", "role only proposed", (p) => (p.roleAgreements[0].status = "PROPOSED")],
    ["REQUIRED_ROLES_AGREED", "extra required role", (p) => p.requiredRoles.push("PROJECT_MANAGER")],
    ["EXTERNAL_COMMITMENTS_ACCEPTED", "vendor offer not accepted", (p) => (p.vendorOffers[0].status = "SUBMITTED")],
    ["EXTERNAL_COMMITMENTS_ACCEPTED", "commitment for earlier scope", (p) => (task(p, externalTaskId).revision += 1)],
    ["COMMERCIAL_TOTALS_CALCULABLE", "no hourly rate", (p) => (p.commercial.hourlyRateMinor = 0)],
  ];

  it.each(cases)("%s fails alone on: %s", (code, _label, mutate) => {
    const p = variant(mutate);
    expect(failing(p)).toEqual([code]);
    const outcome = evaluateReadiness(p, "tester", NOW).outcomes.find((o) => o.code === code)!;
    expect(outcome.failures.length).toBeGreaterThan(0);
    for (const fail of outcome.failures) {
      expect(fail.message.length).toBeGreaterThan(10);
      expect(fail.entityType).toBeTruthy();
      expect(fail.entityId).toBeTruthy();
    }
  });

  it("optional tasks need no evidence", () => {
    const p = variant((x) => {
      task(x, internalTaskId).mandatory = false;
      task(x, internalTaskId).selectedEstimateId = null;
      x.assignments = [];
      x.estimates = [];
      // keep at least one mandatory task so the work breakdown rule still passes
    });
    expect(failing(p)).toEqual([]);
  });

  it("combines failures across rules", () => {
    const p = variant((x) => {
      x.customerName = "";
      x.assignments = [];
      x.vendorOffers = [];
      x.commercial.hourlyRateMinor = 0;
    });
    expect(failing(p).sort()).toEqual(["COMMERCIAL_TOTALS_CALCULABLE", "EXTERNAL_COMMITMENTS_ACCEPTED", "MANDATORY_TASKS_ASSIGNED", "PROPOSAL_DATA_COMPLETE"]);
  });
});

describe("readiness gate (API)", () => {
  it("a dry check records the result without changing the proposal", async () => {
    const before = await h.proposal(id);
    const check = await h.ok("dana", "POST", `/api/proposals/${id}/readiness`);
    expect(check).toMatchObject({ passed: true, proposalContentVersion: before.contentVersion, proposalRevision: before.revision, evaluatedBy: h.userIds.dana });
    const after = await h.proposal(id);
    expect(after.revision).toBe(before.revision);
    expect(after.state).toBe(before.state);
    const history = await h.ok("anna", "GET", `/api/proposals/${id}/readiness`);
    expect(history[0].id).toBe(check.id);
    const view = await h.ok("anna", "GET", `/api/proposals/${id}`);
    expect(view.readiness).toMatchObject({ id: check.id, current: true });
  });

  it("vendors cannot run readiness checks", async () => {
    expect((await h.api("vera", "POST", `/api/proposals/${id}/readiness`)).status).toBe(403);
  });
});

describe("readiness gate on approval", () => {
  it("blocks READY_FOR_APPROVAL with rule-level failures, then passes after remediation", async () => {
    const h2 = await startApp();
    try {
      const f = await readyProposal(h2);
      // Break readiness: change internal task scope → the developer estimate is now stale.
      await h2.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { scope: "Also CSV export" }, await h2.revision(f.id));
      const blocked = await command(h2, "sam", f.id, "requestApproval");
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe("READINESS_FAILED");
      const failed = blocked.body.error.details.readiness.outcomes.filter((o: any) => !o.passed);
      expect(failed.map((o: any) => o.code)).toEqual(["MANDATORY_TASKS_ESTIMATED"]);
      expect(failed[0].failures[0]).toMatchObject({ entityType: "Task", entityId: f.internalTaskId, message: expect.stringContaining("re-estimate") });
      expect((await h2.proposal(f.id)).state).toBe("VENDOR_COMMITMENTS");

      // Remediate: the developer re-estimates the changed scope.
      const p = await h2.proposal(f.id);
      const old = p.estimates.find((e: any) => e.source === "HUMAN");
      await h2.ok("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, {
        effortMin: 35, effortExpected: 45, effortMax: 65, unit: "HOURS", supersedesId: old.id,
      });
      const ok = await command(h2, "sam", f.id, "requestApproval");
      expect(ok.status).toBe(200);
      const after = await h2.proposal(f.id);
      expect(after.state).toBe("READY_FOR_APPROVAL");
      // The readiness check used for the transition is recorded against the same content version as the offer.
      const v = after.offerVersions[0];
      const check = h2.app.service.readiness.get(v.readinessCheckId)!;
      expect(check).toMatchObject({ passed: true, proposalContentVersion: v.proposalContentVersion });
      expect(v.proposalContentVersion).toBe(after.contentVersion);
    } finally {
      await h2.close();
    }
  });
});
