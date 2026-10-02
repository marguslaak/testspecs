import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import { assertTransition, LIFECYCLE_COMMANDS, TRANSITIONS } from "../src/domain/lifecycle.js";
import { PROPOSAL_STATES } from "../src/domain/types.js";
import { command, draftProposal, readyProposal, startApp, type TestApp } from "./helpers.js";

describe("transition table", () => {
  const pairs = LIFECYCLE_COMMANDS.flatMap((c) => PROPOSAL_STATES.map((s) => [c, s] as const));

  it.each(pairs)("%s from %s is permitted only if listed", (cmd, state) => {
    const allowed = TRANSITIONS[cmd].from.includes(state);
    if (allowed) {
      expect(() => assertTransition(cmd, state)).not.toThrow();
    } else {
      let err: unknown;
      try {
        assertTransition(cmd, state);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("INVALID_TRANSITION");
      expect((err as DomainError).details).toEqual({ command: cmd, from: state, allowedFrom: TRANSITIONS[cmd].from });
    }
  });

  it("terminal states allow no commands", () => {
    for (const s of ["ACCEPTED", "REJECTED", "CANCELLED"] as const) {
      expect(LIFECYCLE_COMMANDS.filter((c) => TRANSITIONS[c].from.includes(s))).toEqual([]);
    }
  });
});

let h: TestApp;
beforeEach(async () => (h = await startApp()));
afterEach(async () => h.close());

const state = async (id: string) => (await h.proposal(id)).state;

describe("lifecycle commands (API)", () => {
  it("advances through the working phases and records history", async () => {
    const f = await readyProposal(h);
    const p = await h.proposal(f.id);
    expect(p.state).toBe("VENDOR_COMMITMENTS");
    expect(p.history.map((x: any) => `${x.from}->${x.to}`)).toEqual([
      "DRAFT->REQUIREMENTS_READY",
      "REQUIREMENTS_READY->ESTIMATION",
      "ESTIMATION->STAFFING",
      "STAFFING->VENDOR_COMMITMENTS",
    ]);
    expect(p.history[0]).toMatchObject({ command: "markRequirementsReady", by: h.userIds.sam });
  });

  it("returns invalid transitions as deterministic 409 errors", async () => {
    const f = await draftProposal(h);
    const res = await command(h, "sam", f.id, "approveOffer");
    expect(res.status).toBe(403); // sam may not approve at all
    const res2 = await command(h, "sam", f.id, "startStaffing");
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatchObject({ code: "INVALID_TRANSITION", details: { command: "startStaffing", from: "DRAFT", allowedFrom: ["ESTIMATION"] } });
    const unknown = await command(h, "sam", f.id, "teleport");
    expect(unknown.body.error.code).toBe("UNKNOWN_COMMAND");
  });

  it("guards phase transitions", async () => {
    const f = await draftProposal(h);
    await h.ok("anna", "PATCH", `/api/proposals/${f.id}/requirements/${f.requirementId}`, { status: "DRAFT" }, await h.revision(f.id));
    const noReq = await command(h, "sam", f.id, "markRequirementsReady");
    expect(noReq.status).toBe(422);
    expect(noReq.body.error).toMatchObject({ code: "TRANSITION_GUARD_FAILED" });
    await h.ok("anna", "PATCH", `/api/proposals/${f.id}/requirements/${f.requirementId}`, { status: "CONFIRMED" }, await h.revision(f.id));
    await command(h, "sam", f.id, "markRequirementsReady");
    await h.ok("sam", "POST", `/api/proposals/${f.id}/milestones`, { title: "Empty" });
    const empty = await command(h, "sam", f.id, "startEstimation");
    expect(empty.body.error.details.failures[0].message).toContain("Empty");
  });

  it("returns to an earlier phase only", async () => {
    const f = await readyProposal(h);
    const bad = await command(h, "sam", f.id, "returnToPhase", { target: "READY_FOR_APPROVAL" });
    expect(bad.body.error.code).toBe("FIELD_INVALID");
    await command(h, "sam", f.id, "returnToPhase", { target: "ESTIMATION" });
    expect(await state(f.id)).toBe("ESTIMATION");
  });

  it("requires a current If-Match revision for commands", async () => {
    const f = await readyProposal(h);
    const rev = await h.revision(f.id);
    await h.ok("anna", "POST", `/api/proposals/${f.id}/requirements`, { title: "Late addition", status: "REJECTED" });
    const stale = await h.api("sam", "POST", `/api/proposals/${f.id}/commands/requestApproval`, {}, rev);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    const missing = await h.api("sam", "POST", `/api/proposals/${f.id}/commands/requestApproval`, {});
    expect(missing.body.error.code).toBe("IF_MATCH_REQUIRED");
  });

  it("locks content while awaiting approval and after", async () => {
    const f = await readyProposal(h);
    await command(h, "sam", f.id, "requestApproval");
    const rev = await h.revision(f.id);
    const edits = [
      h.api("anna", "PATCH", `/api/proposals/${f.id}`, { title: "Changed" }, rev),
      h.api("anna", "POST", `/api/proposals/${f.id}/requirements`, { title: "New" }),
      h.api("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { scope: "x" }, rev),
      h.api("dana", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { effortMin: 1, effortExpected: 2, effortMax: 3 }),
      h.api("anna", "PATCH", `/api/proposals/${f.id}/commercial`, { hourlyRateMinor: 1 }, rev),
    ];
    for (const res of await Promise.all(edits)) {
      expect(res.status).toBe(409);
      expect(["PROPOSAL_LOCKED"]).toContain(res.body.error.code);
    }
  });

  it("increments the optimistic revision on every write and contentVersion only on material ones", async () => {
    const f = await draftProposal(h);
    const p1 = await h.proposal(f.id);
    await command(h, "sam", f.id, "markRequirementsReady");
    const p2 = await h.proposal(f.id);
    expect(p2.revision).toBe(p1.revision + 1);
    expect(p2.contentVersion).toBe(p1.contentVersion);
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.internalTaskId}`, { title: "Renamed" }, p2.revision);
    const p3 = await h.proposal(f.id);
    expect(p3.contentVersion).toBe(p2.contentVersion + 1);
  });

  it("cancels from any non-terminal state and then rejects every command", async () => {
    const f = await readyProposal(h);
    await command(h, "sam", f.id, "requestApproval");
    expect((await command(h, "sam", f.id, "cancel", { reason: "x" })).status).toBe(403);
    expect((await command(h, "anna", f.id, "cancel", {})).body.error.code).toBe("FIELD_REQUIRED");
    await command(h, "anna", f.id, "cancel", { reason: "Customer chose another supplier" });
    const p = await h.proposal(f.id);
    expect(p.state).toBe("CANCELLED");
    expect(p.offerVersions[0].status).toBe("SUPERSEDED");
    expect(p.history.at(-1)).toMatchObject({ command: "cancel", reason: "Customer chose another supplier" });
    for (const cmd of LIFECYCLE_COMMANDS) {
      const res = await command(h, "anna", f.id, cmd, {});
      expect([403, 409]).toContain(res.status);
    }
  });

  it("audits approval, issue, customer response and cancellation", async () => {
    const f = await readyProposal(h);
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer", { comment: "OK" });
    await command(h, "anna", f.id, "issueOffer");
    await command(h, "anna", f.id, "recordCustomerAcceptance", { note: "Signed" });
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    for (const action of ["proposal.requestApproval", "proposal.approveOffer", "proposal.issueOffer", "proposal.recordCustomerAcceptance"]) {
      const a = audit.find((x: any) => x.action === action);
      expect(a).toMatchObject({ entityType: "Proposal", entityId: f.id, proposalId: f.id, at: expect.any(String), before: { state: expect.any(String) }, after: { state: expect.any(String) } });
    }
    expect(audit.find((x: any) => x.action === "proposal.approveOffer").actorUserId).toBe(h.userIds.carl);
    expect(await state(f.id)).toBe("ACCEPTED");
  });

  it("records customer rejection", async () => {
    const f = await readyProposal(h);
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    await command(h, "anna", f.id, "issueOffer");
    await command(h, "anna", f.id, "recordCustomerRejection", { note: "Budget cut" });
    const p = await h.proposal(f.id);
    expect(p.state).toBe("REJECTED");
    expect(p.offerVersions[0]).toMatchObject({ status: "DECLINED", customerResponse: { response: "DECLINED", note: "Budget cut" } });
  });
});

describe("allowed actions", () => {
  it("reflects the caller's permissions and the proposal state", async () => {
    const f = await readyProposal(h);
    const actions = async (who: "anna" | "sam" | "dana" | "carl") =>
      (await h.ok(who, "GET", `/api/proposals/${f.id}`)).capabilities.actions.map((a: any) => a.command);
    expect(await actions("sam")).toEqual(["returnToPhase", "requestApproval"]);
    expect(await actions("anna")).toEqual(["returnToPhase", "requestApproval", "cancel"]);
    expect(await actions("dana")).toEqual([]);
    expect(await actions("carl")).toEqual([]);
    await command(h, "sam", f.id, "requestApproval");
    expect(await actions("carl")).toEqual(["approveOffer", "rejectOffer"]);
    expect(await actions("sam")).toEqual(["reopenForRevision"]);
    const caps = (await h.ok("sam", "GET", `/api/proposals/${f.id}`)).capabilities;
    expect(caps).toMatchObject({ editable: false, canEditWorkBreakdown: false, canSubmitEstimates: false });
  });
});
