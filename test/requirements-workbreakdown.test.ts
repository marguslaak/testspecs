import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftProposal, startApp, type TestApp } from "./helpers.js";

let h: TestApp;
beforeEach(async () => (h = await startApp()));
afterEach(async () => h.close());

describe("proposal creation", () => {
  it("creates a proposal with title, customer reference, description, currency and owner", async () => {
    const res = await h.api("anna", "POST", "/api/proposals", {
      title: "Data platform",
      customerReference: "CUST-1",
      description: "Lakehouse",
      currency: "eur",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"1"');
    const p = await h.proposal(res.body.result.id);
    expect(p).toMatchObject({ title: "Data platform", customerReference: "CUST-1", description: "Lakehouse", currency: "EUR", state: "DRAFT", ownerId: h.userIds.anna });
    expect(p.members).toEqual([expect.objectContaining({ userId: h.userIds.anna, role: "ACCOUNT_MANAGER" })]);
  });

  it("returns machine-readable validation errors", async () => {
    const res = await h.api("anna", "POST", "/api/proposals", { title: "", customerReference: "X", currency: "EURO" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "FIELD_REQUIRED", details: { field: "title" } });
    expect(typeof res.body.error.message).toBe("string");
    const bad = await h.api("anna", "POST", "/api/proposals", { title: "T", customerReference: "X", currency: "EURO" });
    expect(bad.body.error).toMatchObject({ code: "FIELD_TOO_LONG", details: { field: "currency" } });
  });

  it("only account managers can create proposals", async () => {
    const res = await h.api("sam", "POST", "/api/proposals", { title: "T", customerReference: "X", currency: "EUR" });
    expect(res.status).toBe(403);
  });
});

describe("requirements", () => {
  it("supports create, edit, classify, order and delete with audit metadata", async () => {
    const f = await draftProposal(h);
    const second = await h.ok("anna", "POST", `/api/proposals/${f.id}/requirements`, {
      title: "GDPR compliant",
      classification: "CONSTRAINT",
      priority: "SHOULD",
    });
    let p = await h.proposal(f.id);
    expect(p.requirements.map((r: any) => r.id)).toEqual([f.requirementId, second.result.id]);
    expect(p.requirements[1]).toMatchObject({ status: "DRAFT", classification: "CONSTRAINT", priority: "SHOULD", createdBy: h.userIds.anna });

    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/requirements/${second.result.id}`, { status: "CONFIRMED", acceptanceNotes: "DPA signed" }, p.revision);
    await h.ok("anna", "POST", `/api/proposals/${f.id}/requirements/order`, { ids: [second.result.id, f.requirementId] }, await h.revision(f.id));
    p = await h.proposal(f.id);
    expect(p.requirements[0]).toMatchObject({ id: second.result.id, status: "CONFIRMED", acceptanceNotes: "DPA signed", updatedBy: h.userIds.sam, order: 0 });

    const badOrder = await h.api("anna", "POST", `/api/proposals/${f.id}/requirements/order`, { ids: [second.result.id] }, p.revision);
    expect(badOrder.body.error.code).toBe("ORDER_MISMATCH");

    await h.ok("anna", "DELETE", `/api/proposals/${f.id}/requirements/${second.result.id}`, undefined, p.revision);
    p = await h.proposal(f.id);
    expect(p.requirements).toHaveLength(1);
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(["requirement.created", "requirement.updated", "requirement.reordered", "requirement.deleted"]));
  });

  it("refuses to delete a requirement traced by a task", async () => {
    const f = await draftProposal(h);
    const res = await h.api("anna", "DELETE", `/api/proposals/${f.id}/requirements/${f.requirementId}`, undefined, await h.revision(f.id));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "REQUIREMENT_IN_USE", details: { taskIds: [f.internalTaskId] } });
  });

  it("rejects invalid enum values with the allowed list", async () => {
    const f = await draftProposal(h);
    const res = await h.api("anna", "POST", `/api/proposals/${f.id}/requirements`, { title: "x", priority: "URGENT" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "FIELD_INVALID", details: { field: "priority", allowed: ["MUST", "SHOULD", "COULD", "WONT"] } });
  });
});

describe("milestones and tasks", () => {
  it("orders milestones and tasks", async () => {
    const f = await draftProposal(h);
    const m2 = await h.ok("sam", "POST", `/api/proposals/${f.id}/milestones`, { title: "Phase 2" });
    await h.ok("sam", "POST", `/api/proposals/${f.id}/milestones/order`, { ids: [m2.result.id, f.milestoneId] }, await h.revision(f.id));
    await h.ok("sam", "POST", `/api/proposals/${f.id}/milestones/${f.milestoneId}/tasks/order`, { ids: [f.externalTaskId, f.internalTaskId] }, await h.revision(f.id));
    const p = await h.proposal(f.id);
    expect(p.milestones.map((m: any) => m.id)).toEqual([m2.result.id, f.milestoneId]);
    const tasks = p.tasks.filter((t: any) => t.milestoneId === f.milestoneId).sort((a: any, b: any) => a.order - b.order);
    expect(tasks.map((t: any) => t.id)).toEqual([f.externalTaskId, f.internalTaskId]);
  });

  it("records task scope, delivery type, mandatory flag and dependencies", async () => {
    const f = await draftProposal(h);
    const t = await h.ok("sam", "POST", `/api/proposals/${f.id}/tasks`, {
      milestoneId: f.milestoneId,
      title: "Go-live support",
      scope: "Hypercare for two weeks",
      deliveryType: "MIXED",
      mandatory: false,
      dependsOn: [f.internalTaskId, f.externalTaskId],
    });
    const p = await h.proposal(f.id);
    expect(p.tasks.find((x: any) => x.id === t.result.id)).toMatchObject({ deliveryType: "MIXED", mandatory: false, dependsOn: [f.internalTaskId, f.externalTaskId], revision: 1, order: 2 });
  });

  it("rejects dependency cycles, self and unknown dependencies", async () => {
    const f = await draftProposal(h);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.externalTaskId}`, { dependsOn: [f.internalTaskId] }, await h.revision(f.id));
    const cycle = await h.api("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { dependsOn: [f.externalTaskId] }, await h.revision(f.id));
    expect(cycle.body.error.code).toBe("DEPENDENCY_CYCLE");
    const self = await h.api("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { dependsOn: [f.internalTaskId] }, await h.revision(f.id));
    expect(self.body.error.code).toBe("DEPENDENCY_SELF");
    const unknown = await h.api("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { dependsOn: ["task_nope"] }, await h.revision(f.id));
    expect(unknown.body.error.code).toBe("DEPENDENCY_UNKNOWN");
  });

  it("moves a task between milestones and renumbers both", async () => {
    const f = await draftProposal(h);
    const m2 = await h.ok("sam", "POST", `/api/proposals/${f.id}/milestones`, { title: "Phase 2" });
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { milestoneId: m2.result.id }, await h.revision(f.id));
    const p = await h.proposal(f.id);
    expect(p.tasks.find((t: any) => t.id === f.internalTaskId)).toMatchObject({ milestoneId: m2.result.id, order: 0 });
    expect(p.tasks.find((t: any) => t.id === f.externalTaskId)).toMatchObject({ milestoneId: f.milestoneId, order: 0 });
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    expect(audit[0]).toMatchObject({ action: "task.moved", entityId: f.internalTaskId, metadata: { changes: expect.arrayContaining(["milestoneId"]) } });
  });

  it("does not orphan data when deleting milestones or tasks", async () => {
    const f = await draftProposal(h);
    const ms = await h.api("sam", "DELETE", `/api/proposals/${f.id}/milestones/${f.milestoneId}`, undefined, await h.revision(f.id));
    expect(ms.status).toBe(409);
    expect(ms.body.error).toMatchObject({ code: "MILESTONE_HAS_TASKS" });

    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.externalTaskId}`, { dependsOn: [f.internalTaskId] }, await h.revision(f.id));
    const task = await h.api("sam", "DELETE", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, undefined, await h.revision(f.id));
    expect(task.body.error).toMatchObject({ code: "TASK_HAS_DEPENDENT_DATA", details: { dependentTaskIds: [f.externalTaskId] } });

    // Removing the dependent task first makes deletion possible.
    await h.ok("sam", "DELETE", `/api/proposals/${f.id}/tasks/${f.externalTaskId}`, undefined, await h.revision(f.id));
    await h.ok("sam", "DELETE", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, undefined, await h.revision(f.id));
    await h.ok("sam", "DELETE", `/api/proposals/${f.id}/milestones/${f.milestoneId}`, undefined, await h.revision(f.id));
    expect((await h.proposal(f.id)).milestones).toHaveLength(0);
  });

  it("bumps the task revision only for scope changes", async () => {
    const f = await draftProposal(h);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { requirementIds: [] }, await h.revision(f.id));
    expect((await h.proposal(f.id)).tasks.find((t: any) => t.id === f.internalTaskId).revision).toBe(1);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { scope: "Bigger scope" }, await h.revision(f.id));
    expect((await h.proposal(f.id)).tasks.find((t: any) => t.id === f.internalTaskId).revision).toBe(2);
  });

  it("only the solution lead edits the work breakdown", async () => {
    const f = await draftProposal(h);
    const res = await h.api("anna", "POST", `/api/proposals/${f.id}/milestones`, { title: "Nope" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("optimistic concurrency", () => {
  it("rejects edits based on a stale revision and requires If-Match", async () => {
    const f = await draftProposal(h);
    const rev = await h.revision(f.id);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { title: "Edited by Sam" }, rev);
    const stale = await h.api("anna", "PATCH", `/api/proposals/${f.id}`, { title: "Edited by Anna" }, rev);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedRevision: rev, currentRevision: rev + 1 } });
    const missing = await h.api("anna", "PATCH", `/api/proposals/${f.id}`, { title: "No If-Match" });
    expect(missing.body.error.code).toBe("IF_MATCH_REQUIRED");
    const p = await h.proposal(f.id);
    expect(p.title).toBe("Customer portal rebuild");
    expect(p.tasks.find((t: any) => t.id === f.internalTaskId).title).toBe("Edited by Sam");
  });

  it("serialises concurrent appends without losing either write", async () => {
    const f = await draftProposal(h);
    await Promise.all([
      h.ok("anna", "POST", `/api/proposals/${f.id}/requirements`, { title: "A" }),
      h.ok("sam", "POST", `/api/proposals/${f.id}/requirements`, { title: "B" }),
    ]);
    const p = await h.proposal(f.id);
    expect(p.requirements.map((r: any) => r.title)).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("returns the new revision as an ETag on every mutation", async () => {
    const f = await draftProposal(h);
    const rev = await h.revision(f.id);
    const res = await h.api("anna", "PATCH", `/api/proposals/${f.id}`, { description: "New" }, rev);
    expect(res.body.revision).toBe(rev + 1);
    expect(res.headers.get("etag")).toBe(`"${rev + 1}"`);
  });
});
