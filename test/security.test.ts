import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HmacTokenVerifier } from "../src/infra/identity.js";
import { command, draftProposal, readyProposal, startApp, type TestApp } from "./helpers.js";

let h: TestApp;
beforeEach(async () => (h = await startApp()));
afterEach(async () => h.close());

const raw = (token: string | null, path = "/api/me") =>
  fetch(h.base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));

const identity = (over: Partial<Parameters<HmacTokenVerifier["sign"]>[0]> = {}) => ({
  subject: "new.person",
  displayName: "New Person",
  email: "new@redfunction.ee",
  kind: "INTERNAL" as const,
  roles: ["DEVELOPER" as const],
  vendorOrganizationId: null,
  vendorOrganizationName: null,
  ...over,
});

describe("authentication", () => {
  it("rejects missing, forged, expired and foreign tokens", async () => {
    expect((await raw(null)).status).toBe(401);
    expect((await raw("not-a-jwt")).body.error.code).toBe("UNAUTHENTICATED");
    const forged = new HmacTokenVerifier("wrong-secret", "https://idp.test").sign(identity());
    expect((await raw(forged)).status).toBe(401);
    const foreign = new HmacTokenVerifier("test-secret", "https://evil.example").sign(identity());
    expect((await raw(foreign)).status).toBe(401);
    const expired = h.app.verifier.sign(identity(), -10);
    expect((await raw(expired)).body.error.message).toMatch(/expired/);
  });

  it("maps identity-provider subjects to user records and distinguishes INTERNAL/EXTERNAL", async () => {
    const token = h.app.verifier.sign(identity());
    const me = await raw(token);
    expect(me.body).toMatchObject({ kind: "INTERNAL", displayName: "New Person", roles: ["DEVELOPER"] });
    const again = await raw(h.app.verifier.sign(identity({ displayName: "Renamed" })));
    expect(again.body.id).toBe(me.body.id);
    expect(again.body.displayName).toBe("Renamed");
    const u = h.app.service.users.get(me.body.id)!;
    expect(u).toMatchObject({ idpIssuer: "https://idp.test", idpSubject: "new.person", kind: "INTERNAL" });
  });

  it("stores no passwords or authentication secrets", () => {
    const columns = (h.app.store.db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(columns.filter((c) => /pass|secret|token|hash|credential/i.test(c))).toEqual([]);
    const dump = JSON.stringify(h.app.store.db.prepare("SELECT * FROM users").all());
    expect(dump).not.toContain("test-secret");
  });

  it("external identities can never carry internal roles", async () => {
    const token = h.app.verifier.sign(identity({ subject: "sneaky", kind: "EXTERNAL", roles: ["COMMERCIAL_APPROVER", "EXTERNAL_VENDOR"] as any, vendorOrganizationId: "vorg_x", vendorOrganizationName: "X" }));
    const me = await raw(token);
    expect(me.body.roles).toEqual(["EXTERNAL_VENDOR"]);
  });
});

describe("role boundaries", () => {
  it("each role can only do what it is for", async () => {
    const f = await draftProposal(h);
    const rev = await h.revision(f.id);
    // Developers cannot edit scope or commercial terms
    expect((await h.api("dana", "POST", `/api/proposals/${f.id}/requirements`, { title: "x" })).status).toBe(403);
    expect((await h.api("dana", "PATCH", `/api/proposals/${f.id}/commercial`, { hourlyRateMinor: 1 }, rev)).status).toBe(403);
    expect((await h.api("dana", "POST", `/api/proposals/${f.id}/members`, { userId: h.userIds.carl, role: "COMMERCIAL_APPROVER" })).status).toBe(403);
    // Commercial approvers can view but not edit
    expect((await h.api("carl", "GET", `/api/proposals/${f.id}`)).status).toBe(200);
    expect((await h.api("carl", "PATCH", `/api/proposals/${f.id}`, { title: "x" }, rev)).status).toBe(403);
    // Account managers do not estimate
    await command(h, "sam", f.id, "markRequirementsReady");
    await command(h, "sam", f.id, "startEstimation");
    const est = await h.api("anna", "POST", `/api/proposals/${f.id}/tasks/${f.internalTaskId}/estimates`, { effortMin: 1, effortExpected: 2, effortMax: 3 });
    expect(est.status).toBe(403);
  });

  it("proposal roles require the matching identity-provider role", async () => {
    const f = await draftProposal(h);
    const res = await h.api("anna", "POST", `/api/proposals/${f.id}/members`, { userId: h.userIds.dana, role: "SOLUTION_LEAD" });
    expect(res.body.error.code).toBe("ROLE_NOT_HELD");
  });

  it("internal users who are not on the team cannot see the proposal", async () => {
    const f = await draftProposal(h);
    const outsider = h.app.verifier.sign(identity({ subject: "outsider", roles: ["DEVELOPER", "SOLUTION_LEAD"] }));
    expect((await raw(outsider, `/api/proposals/${f.id}`)).status).toBe(403);
    expect((await raw(outsider, `/api/proposals/${f.id}`)).body.error.code).toBe("PROPOSAL_ACCESS_DENIED");
    expect((await raw(outsider, "/api/proposals")).body).toEqual([]);
  });

  it("an approver cannot approve an offer they requested themselves", async () => {
    const f = await readyProposal(h);
    const both = identity({ subject: "lead.approver", displayName: "Lead Approver", roles: ["SOLUTION_LEAD", "COMMERCIAL_APPROVER"] });
    const token = h.app.verifier.sign(both);
    const me = await raw(token);
    await h.ok("anna", "POST", `/api/proposals/${f.id}/members`, { userId: me.body.id, role: "SOLUTION_LEAD" });
    const call = (cmd: string, rev: number) =>
      fetch(`${h.base}/api/proposals/${f.id}/commands/${cmd}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "if-match": String(rev) },
        body: "{}",
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await call("requestApproval", await h.revision(f.id))).status).toBe(200);
    const self = await call("approveOffer", await h.revision(f.id));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
    expect((await command(h, "carl", f.id, "approveOffer")).status).toBe(200);
  });
});

describe("vendor isolation", () => {
  it("vendors are confined to granted scope on granted proposals", async () => {
    const a = await readyProposal(h);
    const b = await draftProposal(h);
    // Vera has a grant on proposal A only.
    expect((await h.api("vera", "GET", `/api/portal/proposals/${b.id}`)).status).toBe(403);
    expect((await h.api("vera", "POST", `/api/portal/proposals/${b.id}/tasks/${b.externalTaskId}/offers`, {})).status).toBe(403);
    // No internal endpoints for vendors.
    for (const path of [`/api/proposals/${a.id}`, `/api/proposals/${a.id}/audit`, `/api/proposals/${a.id}/readiness`, `/api/proposals/${a.id}/offer-versions`, "/api/users", "/api/vendor-organizations"]) {
      expect((await h.api("vera", "GET", path)).status).toBe(403);
    }
    expect((await h.api("vera", "GET", "/api/proposals")).body.map((p: any) => Object.keys(p).sort())).toEqual([["id", "sharedTasks", "state", "title"]]);
    // Internal users cannot use the vendor portal endpoints.
    expect((await h.api("sam", "GET", `/api/portal/proposals/${a.id}`)).status).toBe(403);
    expect((await h.api("sam", "POST", `/api/portal/proposals/${a.id}/tasks/${a.externalTaskId}/offers`, {})).status).toBe(403);
  });

  it("the vendor view excludes margins, internal estimates and other vendors", async () => {
    const f = await readyProposal(h);
    // A competing vendor is invited to the same task after Vera's offer was accepted.
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.otto, taskIds: [f.externalTaskId] });
    const view = await h.ok("otto", "GET", `/api/portal/proposals/${f.id}`);
    const text = JSON.stringify(view);
    expect(text).not.toContain("500000"); // Vera's accepted price
    expect(text).not.toMatch(/vorg_acme|Acme/);
    expect(text).not.toMatch(/Markup|contingency|hourlyRate|effort|estimat/i);
    expect(view.tasks.map((t: any) => t.id)).toEqual([f.externalTaskId]);
  });
});

describe("audit trail", () => {
  it("records sensitive commands with actor, action, entity, proposal, timestamp and change data", async () => {
    const f = await readyProposal(h);
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    await command(h, "anna", f.id, "issueOffer");
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    const expectations: [string, string, string][] = [
      ["estimate.submitted", "Estimate", "dana"],
      ["roleAgreement.agreed", "RoleAgreement", "sam"],
      ["vendorOffer.submitted", "VendorOffer", "vera"],
      ["vendorOffer.accepted", "VendorOffer", "sam"],
      ["proposal.approveOffer", "Proposal", "carl"],
      ["proposal.issueOffer", "Proposal", "anna"],
    ];
    for (const [action, entityType, who] of expectations) {
      const rec = audit.find((a: any) => a.action === action);
      expect(rec, action).toMatchObject({
        id: expect.any(String),
        actorUserId: h.userIds[who as "sam"],
        entityType,
        entityId: expect.any(String),
        proposalId: f.id,
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
      expect(rec.after, action).not.toBeNull();
    }
    expect(audit.find((a: any) => a.action === "roleAgreement.agreed")).toMatchObject({ before: { status: "PROPOSED" }, after: { status: "AGREED" } });
  });

  it("is append-only: there is no API to change it", async () => {
    const f = await draftProposal(h);
    for (const method of ["PATCH", "PUT", "DELETE", "POST"]) {
      const res = await h.api("anna", method, `/api/proposals/${f.id}/audit`, {});
      expect(res.status).toBe(405);
    }
  });

  it("vendors and outsiders cannot read the audit trail", async () => {
    const f = await readyProposal(h);
    expect((await h.api("vera", "GET", `/api/proposals/${f.id}/audit`)).status).toBe(403);
  });
});
