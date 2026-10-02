import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, draftProposal, type Fixture, startApp, type TestApp } from "./helpers.js";

let h: TestApp;
let f: Fixture;
beforeEach(async () => {
  h = await startApp();
  f = await draftProposal(h);
  await command(h, "sam", f.id, "markRequirementsReady");
  await command(h, "sam", f.id, "startEstimation");
});
afterEach(async () => h.close());

const assign = (who: "sam" | "anna" | "dana", userId: string, extra: object = {}) =>
  h.api(who, "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/assignments`, { userId, assignmentRole: "developer", allocationPercent: 50, ...extra });

describe("task assignments", () => {
  it("assigns multiple people with role, allocation and status", async () => {
    expect((await assign("sam", h.userIds.dana)).status).toBe(201);
    expect((await assign("sam", h.userIds.sam, { assignmentRole: "tech_lead", allocationPercent: 20 })).status).toBe(201);
    const p = await h.proposal(f.id);
    expect(p.assignments).toEqual([
      expect.objectContaining({ taskId: f.internalTaskId, userId: h.userIds.dana, assignmentRole: "DEVELOPER", allocationPercent: 50, status: "PLANNED" }),
      expect.objectContaining({ taskId: f.internalTaskId, userId: h.userIds.sam, assignmentRole: "TECH_LEAD", allocationPercent: 20, status: "PLANNED" }),
    ]);
  });

  it("prevents duplicate active assignments, but allows re-assigning after release", async () => {
    const a = await assign("sam", h.userIds.dana);
    const dup = await assign("sam", h.userIds.dana);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_ASSIGNMENT");
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/assignments/${a.body.result.id}`, { status: "RELEASED" }, await h.revision(f.id));
    expect((await assign("sam", h.userIds.dana)).status).toBe(201);
    const changeReleased = await h.api("sam", "PATCH", `/api/proposals/${f.id}/assignments/${a.body.result.id}`, { allocationPercent: 10 }, await h.revision(f.id));
    expect(changeReleased.body.error.code).toBe("ASSIGNMENT_RELEASED");
  });

  it("validates assignees and allocation", async () => {
    expect((await assign("sam", h.userIds.vera)).body.error.code).toBe("USER_NOT_INTERNAL");
    expect((await assign("sam", h.userIds.carl)).body.error.code).toBe("USER_NOT_MEMBER");
    expect((await assign("sam", h.userIds.dana, { allocationPercent: 150 })).body.error.code).toBe("FIELD_OUT_OF_RANGE");
    const ext = await h.api("sam", "POST", `/api/proposals/${f.id}/tasks/${f.externalTaskId}/assignments`, { userId: h.userIds.dana, assignmentRole: "DEV" });
    expect(ext.body.error.code).toBe("TASK_EXTERNAL");
  });

  it("only the solution lead manages staffing", async () => {
    expect((await assign("anna", h.userIds.dana)).status).toBe(403);
    expect((await assign("dana", h.userIds.dana)).status).toBe(403);
  });
});

describe("role agreements", () => {
  it("are separate from assignments and only the named person can agree", async () => {
    const r = await h.ok("sam", "POST", `/api/proposals/${f.id}/role-agreements`, { userId: h.userIds.dana, projectRole: "tech_lead", responsibilities: "Architecture decisions" });
    let p = await h.proposal(f.id);
    expect(p.assignments).toHaveLength(0);
    expect(p.roleAgreements[0]).toMatchObject({ userId: h.userIds.dana, projectRole: "TECH_LEAD", status: "PROPOSED", proposedBy: h.userIds.sam, respondedBy: null });

    const bySam = await h.api("sam", "POST", `/api/proposals/${f.id}/role-agreements/${r.result.id}/agree`);
    expect(bySam.status).toBe(403);
    expect(bySam.body.error.code).toBe("NOT_ROLE_HOLDER");

    await h.ok("dana", "POST", `/api/proposals/${f.id}/role-agreements/${r.result.id}/agree`);
    p = await h.proposal(f.id);
    expect(p.roleAgreements[0]).toMatchObject({ status: "AGREED", respondedBy: h.userIds.dana, respondedAt: expect.any(String) });
    const again = await h.api("dana", "POST", `/api/proposals/${f.id}/role-agreements/${r.result.id}/decline`);
    expect(again.body.error.code).toBe("ROLE_AGREEMENT_NOT_PROPOSED");
  });

  it("prevents duplicates; revocation allows a new agreement", async () => {
    const r = await h.ok("sam", "POST", `/api/proposals/${f.id}/role-agreements`, { userId: h.userIds.dana, projectRole: "TECH_LEAD" });
    const dup = await h.api("sam", "POST", `/api/proposals/${f.id}/role-agreements`, { userId: h.userIds.dana, projectRole: "TECH_LEAD" });
    expect(dup.body.error.code).toBe("DUPLICATE_ROLE_AGREEMENT");
    await h.ok("sam", "POST", `/api/proposals/${f.id}/role-agreements/${r.result.id}/revoke`, { reason: "Changed plan" });
    const p = await h.proposal(f.id);
    expect(p.roleAgreements[0]).toMatchObject({ status: "REVOKED", revokedBy: h.userIds.sam, revokeReason: "Changed plan" });
    expect((await h.api("sam", "POST", `/api/proposals/${f.id}/role-agreements`, { userId: h.userIds.dana, projectRole: "TECH_LEAD" })).status).toBe(201);
  });
});

describe("removing people", () => {
  it("is refused while they have active commitments, unless released explicitly", async () => {
    await assign("sam", h.userIds.dana);
    await h.ok("sam", "POST", `/api/proposals/${f.id}/role-agreements`, { userId: h.userIds.dana, projectRole: "TECH_LEAD" });
    const refused = await h.api("anna", "DELETE", `/api/proposals/${f.id}/members/${h.userIds.dana}/DEVELOPER`, undefined, await h.revision(f.id));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("MEMBER_HAS_ACTIVE_COMMITMENTS");
    expect(refused.body.error.details.assignmentIds).toHaveLength(1);

    await h.ok("anna", "DELETE", `/api/proposals/${f.id}/members/${h.userIds.dana}/DEVELOPER?releaseCommitments=true`, undefined, await h.revision(f.id));
    const p = await h.proposal(f.id);
    expect(p.members.some((m: any) => m.userId === h.userIds.dana)).toBe(false);
    expect(p.assignments[0].status).toBe("RELEASED");
    expect(p.roleAgreements[0]).toMatchObject({ status: "REVOKED", revokeReason: "member removed" });
  });
});

describe("audit", () => {
  it("records every assignment and agreement change", async () => {
    const a = await assign("sam", h.userIds.dana);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/assignments/${a.body.result.id}`, { status: "CONFIRMED" }, await h.revision(f.id));
    const r = await h.ok("sam", "POST", `/api/proposals/${f.id}/role-agreements`, { userId: h.userIds.dana, projectRole: "TECH_LEAD" });
    await h.ok("dana", "POST", `/api/proposals/${f.id}/role-agreements/${r.result.id}/decline`);
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    const actions = audit.map((x: any) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["assignment.created", "assignment.updated", "roleAgreement.proposed", "roleAgreement.declined"]));
    const updated = audit.find((x: any) => x.action === "assignment.updated");
    expect(updated).toMatchObject({ actorUserId: h.userIds.sam, entityType: "TaskAssignment", proposalId: f.id, before: { status: "PLANNED" }, after: { status: "CONFIRMED" }, metadata: { changes: ["status"] } });
  });
});
