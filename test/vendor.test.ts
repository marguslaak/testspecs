import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, draftProposal, type Fixture, startApp, type TestApp } from "./helpers.js";

let h: TestApp;
let f: Fixture;
beforeEach(async () => {
  h = await startApp();
  f = await draftProposal(h);
  await command(h, "sam", f.id, "markRequirementsReady");
  await command(h, "sam", f.id, "startEstimation");
  await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.vera, taskIds: [f.externalTaskId] });
});
afterEach(async () => h.close());

const offerBody = (extra: object = {}) => ({
  priceMinor: 400000,
  currency: "EUR",
  terms: "Net 30",
  validUntil: "2026-11-30T00:00:00.000Z",
  confirmBinding: true,
  ...extra,
});
const submit = (who: "vera" | "otto" = "vera", body = offerBody(), taskId = f.externalTaskId) =>
  h.api(who, "POST", `/api/portal/proposals/${f.id}/tasks/${taskId}/offers`, body);

describe("vendor access", () => {
  it("only external vendor users can be granted access, and only to externally sourced tasks", async () => {
    const internal = await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.dana, taskIds: [f.externalTaskId] });
    expect(internal.body.error.code).toBe("USER_NOT_VENDOR");
    const internalTask = await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.otto, taskIds: [f.internalTaskId] });
    expect(internalTask.body.error.code).toBe("TASK_NOT_EXTERNAL");
  });

  it("the vendor sees only shared task scope and their own offers", async () => {
    const list = await h.ok("vera", "GET", "/api/portal/proposals");
    expect(list).toEqual([{ id: f.id, title: "Customer portal rebuild", state: "ESTIMATION", sharedTasks: 1 }]);
    const view = await h.ok("vera", "GET", `/api/portal/proposals/${f.id}`);
    expect(view.tasks.map((t: any) => t.id)).toEqual([f.externalTaskId]);
    expect(view).not.toHaveProperty("estimates");
    expect(view).not.toHaveProperty("commercial");
    expect(view).not.toHaveProperty("members");
  });

  it("unrelated vendors and unrelated proposals are invisible", async () => {
    expect(await h.ok("otto", "GET", "/api/portal/proposals")).toEqual([]);
    expect((await h.api("otto", "GET", `/api/portal/proposals/${f.id}`)).status).toBe(403);
    expect((await submit("otto")).status).toBe(403);
    // Unknown proposal ids are indistinguishable from unshared ones.
    const unknown = await h.api("vera", "GET", "/api/portal/proposals/prop_doesnotexist");
    expect(unknown.status).toBe(403);
    // Internal-only task of a shared proposal is out of scope.
    const out = await submit("vera", offerBody(), f.internalTaskId);
    expect(out.body.error.code).toBe("VENDOR_SCOPE_DENIED");
  });

  it("competing vendors never see each other's offers", async () => {
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.otto, taskIds: [f.externalTaskId] });
    await submit("vera");
    await submit("otto", offerBody({ priceMinor: 350000 }));
    const vera = await h.ok("vera", "GET", `/api/portal/proposals/${f.id}`);
    const otto = await h.ok("otto", "GET", `/api/portal/proposals/${f.id}`);
    expect(vera.offers).toHaveLength(1);
    expect(otto.offers).toHaveLength(1);
    expect(vera.offers[0].revisions[0].priceMinor).toBe(400000);
    expect(JSON.stringify(otto)).not.toContain("400000");
    const p = await h.proposal(f.id);
    expect(p.vendorOffers).toHaveLength(2);
  });

  it("revoking access removes visibility", async () => {
    const p = await h.proposal(f.id);
    await h.ok("sam", "DELETE", `/api/proposals/${f.id}/vendor-grants/${p.vendorGrants[0].id}`);
    expect((await h.api("vera", "GET", `/api/portal/proposals/${f.id}`)).status).toBe(403);
    expect(await h.ok("vera", "GET", "/api/portal/proposals")).toEqual([]);
  });
});

describe("vendor offers", () => {
  it("captures task, organisation, submitter, price, currency, terms, validity and status", async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    const p = await h.proposal(f.id);
    expect(p.vendorOffers[0]).toMatchObject({
      taskId: f.externalTaskId,
      vendorOrganizationId: "vorg_acme",
      status: "SUBMITTED",
      revisions: [
        {
          revision: 1,
          priceMinor: 400000,
          currency: "EUR",
          terms: "Net 30",
          validUntil: "2026-11-30T00:00:00.000Z",
          submittedBy: h.userIds.vera,
          bindingConfirmed: true,
          scopeSnapshot: { title: "Visual design", taskRevision: 1 },
        },
      ],
    });
  });

  it("requires explicit binding confirmation and a future validity date", async () => {
    expect((await submit("vera", offerBody({ confirmBinding: false }))).body.error.code).toBe("BINDING_CONFIRMATION_REQUIRED");
    expect((await submit("vera", offerBody({ validUntil: "2026-09-01T00:00:00Z" }))).body.error.code).toBe("OFFER_VALIDITY_PAST");
  });

  it("revisions are appended without overwriting earlier submissions", async () => {
    const first = await submit();
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${first.body.result.id}/request-revision`, { note: "Please include accessibility audit" });
    let view = await h.ok("vera", "GET", `/api/portal/proposals/${f.id}`);
    expect(view.offers[0]).toMatchObject({ status: "REVISION_REQUESTED", reviewNotes: [{ action: "REVISION_REQUESTED", note: "Please include accessibility audit" }] });
    await submit("vera", offerBody({ priceMinor: 450000, terms: "Net 30, incl. a11y audit" }));
    view = await h.ok("vera", "GET", `/api/portal/proposals/${f.id}`);
    expect(view.offers).toHaveLength(1);
    expect(view.offers[0].status).toBe("SUBMITTED");
    expect(view.offers[0].revisions.map((r: any) => [r.revision, r.priceMinor])).toEqual([
      [1, 400000],
      [2, 450000],
    ]);
  });

  it("acceptance locks the terms and records who accepted when", async () => {
    const o = await submit();
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/accept`, {});
    const p = await h.proposal(f.id);
    expect(p.vendorOffers[0]).toMatchObject({ status: "ACCEPTED", acceptedRevision: 1, acceptedBy: h.userIds.sam, acceptedAt: expect.any(String) });
    const revise = await submit("vera", offerBody({ priceMinor: 999999 }));
    expect(revise.body.error.code).toBe("VENDOR_OFFER_ACCEPTED");
    expect((await h.api("vera", "POST", `/api/portal/proposals/${f.id}/offers/${o.body.result.id}/withdraw`)).body.error.code).toBe("VENDOR_OFFER_NOT_OPEN");
    expect((await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/reject`, { note: "x" })).body.error.code).toBe("VENDOR_OFFER_NOT_OPEN");
    expect((await h.proposal(f.id)).vendorOffers[0].revisions).toHaveLength(1);
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    expect(audit.find((a: any) => a.action === "vendorOffer.accepted")).toMatchObject({ actorUserId: h.userIds.sam, entityId: o.body.result.id, after: { status: "ACCEPTED" } });
  });

  it("rejects acceptance of expired, mismatched-currency or stale-scope offers", async () => {
    const o = await submit();
    h.clock.advanceDays(90);
    const expired = await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/accept`, {});
    expect(expired.body.error.code).toBe("VENDOR_OFFER_EXPIRED");

    await submit("vera", offerBody({ currency: "USD", validUntil: "2027-06-01T00:00:00Z" }));
    expect((await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/accept`, {})).body.error.code).toBe("VENDOR_CURRENCY_MISMATCH");

    await submit("vera", offerBody({ validUntil: "2027-06-01T00:00:00Z" }));
    await h.ok("sam", "PATCH", `/api/proposals/${f.id}/tasks/${f.externalTaskId}`, { scope: "Design system, pages and icon set" }, await h.revision(f.id));
    expect((await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/accept`, {})).body.error.code).toBe("VENDOR_SCOPE_STALE");
  });

  it("internal users can reject; vendors can then submit a fresh offer", async () => {
    const o = await submit();
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/reject`, { note: "Too expensive" });
    const again = await submit("vera", offerBody({ priceMinor: 300000 }));
    expect(again.body.result.id).not.toBe(o.body.result.id);
    const p = await h.proposal(f.id);
    expect(p.vendorOffers.map((x: any) => x.status)).toEqual(["REJECTED", "SUBMITTED"]);
  });

  it("only one offer per task can be accepted", async () => {
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-grants`, { userId: h.userIds.otto, taskIds: [f.externalTaskId] });
    const a = await submit("vera");
    const b = await submit("otto");
    await h.ok("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${a.body.result.id}/accept`, {});
    expect((await h.api("sam", "POST", `/api/proposals/${f.id}/vendor-offers/${b.body.result.id}/accept`, {})).body.error.code).toBe("TASK_ALREADY_COMMITTED");
  });

  it("vendors cannot review offers and developers cannot accept them", async () => {
    const o = await submit();
    expect((await h.api("vera", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/accept`, {})).status).toBe(403);
    expect((await h.api("dana", "POST", `/api/proposals/${f.id}/vendor-offers/${o.body.result.id}/accept`, {})).status).toBe(403);
  });
});
