import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderOfferDocument, sha256 } from "../src/domain/document.js";
import { command, readyProposal, startApp, type Fixture, type TestApp } from "./helpers.js";

let h: TestApp;
let f: Fixture;
beforeEach(async () => {
  h = await startApp();
  f = await readyProposal(h);
});
afterEach(async () => h.close());

const versions = async () => (await h.proposal(f.id)).offerVersions;

describe("offer assembly", () => {
  it("creates a numbered version from a frozen snapshot with explained totals", async () => {
    await command(h, "sam", f.id, "requestApproval");
    const [v] = await versions();
    expect(v).toMatchObject({ number: 1, status: "PENDING_APPROVAL", createdBy: h.userIds.sam, document: null });
    const s = v.snapshot;
    expect(s.proposal).toMatchObject({ title: "Customer portal rebuild", customerName: "Acme Retail AS", currency: "EUR" });
    expect(s.requirements.map((r: any) => r.title)).toEqual(["Customers can view invoices"]);
    expect(s.milestones.map((m: any) => m.title)).toEqual(["MVP"]);
    // 40 h × 90.00 = 3 600.00; contingency 10 % = 360.00; vendor 5 000.00 + 15 % markup = 750.00
    expect(s.lines.find((l: any) => l.taskId === f.internalTaskId)).toMatchObject({ effortHours: 40, hourlyRateMinor: 9000, labourMinor: 360000, estimateId: expect.any(String) });
    expect(s.lines.find((l: any) => l.taskId === f.externalTaskId)).toMatchObject({ vendorCostMinor: 500000, vendorPriceMinor: 575000, vendorOfferId: expect.any(String) });
    expect(s.totals).toEqual({
      currency: "EUR",
      labourMinor: 360000,
      vendorCostMinor: 500000,
      vendorMarkupMinor: 75000,
      contingencyMinor: 36000,
      totalMinor: 971000,
      optionalTotalMinor: 0,
    });
    expect(s.vendorCommitments).toEqual([
      expect.objectContaining({ vendorOrganizationName: "Acme Design OÜ", priceMinor: 500000, revision: 1, terms: "Fixed price, two review rounds.", acceptedBy: h.userIds.sam }),
    ]);
    expect(s.commercial).toMatchObject({ contingencyPercent: 10, vendorMarkupPercent: 15, validityDays: 30, paymentTerms: expect.any(String) });
    expect(s.validUntil).toBe("2026-10-31T09:00:00.000Z");
  });

  it("uses role rates weighted by allocation when configured", async () => {
    await command(h, "sam", f.id, "returnToPhase", { target: "STAFFING" });
    await h.ok("anna", "PATCH", `/api/proposals/${f.id}/commercial`, { roleRatesMinor: { DEVELOPER: 10000 } }, await h.revision(f.id));
    const view = await h.ok("anna", "GET", `/api/proposals/${f.id}`);
    expect(view.pricing.lines.find((l: any) => l.taskId === f.internalTaskId)).toMatchObject({ hourlyRateMinor: 10000, labourMinor: 400000 });
  });
});

describe("approval", () => {
  it("only a commercial approver decides, and not on an offer they requested", async () => {
    await command(h, "sam", f.id, "requestApproval");
    expect((await command(h, "anna", f.id, "approveOffer")).status).toBe(403);
    expect((await command(h, "dana", f.id, "approveOffer")).status).toBe(403);
    expect((await command(h, "carl", f.id, "approveOffer", { comment: "Margin OK" })).status).toBe(200);
    const [v] = await versions();
    expect(v).toMatchObject({ status: "APPROVED", decision: { decision: "APPROVED", by: h.userIds.carl, comment: "Margin OK" } });
  });

  it("rejection requires a reason and returns the proposal to its working phase", async () => {
    await command(h, "sam", f.id, "requestApproval");
    expect((await command(h, "carl", f.id, "rejectOffer", {})).body.error.code).toBe("FIELD_REQUIRED");
    await command(h, "carl", f.id, "rejectOffer", { comment: "Contingency too low" });
    const p = await h.proposal(f.id);
    expect(p.state).toBe("VENDOR_COMMITMENTS");
    expect(p.offerVersions[0]).toMatchObject({ status: "REJECTED", decision: { decision: "REJECTED", by: h.userIds.carl, comment: "Contingency too low" } });
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    expect(audit.find((a: any) => a.action === "proposal.rejectOffer")).toMatchObject({ actorUserId: h.userIds.carl, metadata: { comment: "Contingency too low", offerVersion: 1 } });
  });

  it("numbers versions sequentially across revisions", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "rejectOffer", { comment: "Raise contingency" });
    await h.ok("anna", "PATCH", `/api/proposals/${f.id}/commercial`, { contingencyPercent: 20 }, await h.revision(f.id));
    await command(h, "sam", f.id, "requestApproval");
    const vs = await versions();
    expect(vs.map((v: any) => [v.number, v.status])).toEqual([
      [1, "REJECTED"],
      [2, "PENDING_APPROVAL"],
    ]);
    expect(vs[1].snapshot.totals.contingencyMinor).toBe(72000);
    expect(vs[0].snapshot.totals.contingencyMinor).toBe(36000); // frozen
  });
});

describe("document generation and issuance", () => {
  it("only an approved version can be issued", async () => {
    await command(h, "sam", f.id, "requestApproval");
    const res = await command(h, "anna", f.id, "issueOffer");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("records a durable document with integrity hash; issuance records who, when and which version", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    let [v] = await versions();
    expect(v.document).toMatchObject({ ref: expect.stringMatching(/^offers\/.+\/v1-/), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), format: "text/html" });
    const stored = h.app.service.documents.get(v.document.ref)!;
    expect(sha256(stored.content)).toBe(v.document.sha256);
    expect(stored.content).toContain("Customer portal rebuild");
    expect(stored.content).toContain("9 710.00 EUR");

    h.clock.advanceDays(2);
    await command(h, "anna", f.id, "issueOffer");
    [v] = await versions();
    expect(v).toMatchObject({ status: "ISSUED", issuedBy: h.userIds.anna, issuedAt: "2026-10-03T09:00:00.000Z" });
    const audit = await h.ok("anna", "GET", `/api/proposals/${f.id}/audit`);
    expect(audit.find((a: any) => a.action === "proposal.issueOffer").metadata).toMatchObject({ offerVersion: 1, sha256: v.document.sha256, documentRef: v.document.ref });

    const doc = await fetch(`${h.base}/api/proposals/${f.id}/offer-versions/1/document?download=1`, {
      headers: { authorization: `Bearer ${h.app.verifier.sign({ subject: "anna.am", displayName: "Anna Account", email: "", kind: "INTERNAL", roles: ["ACCOUNT_MANAGER"], vendorOrganizationId: null, vendorOrganizationName: null })}` },
    });
    expect(doc.headers.get("x-content-sha256")).toBe(v.document.sha256);
    expect(doc.headers.get("x-offer-document")).toBe("final");
    expect(doc.headers.get("content-disposition")).toContain("attachment");
    expect(sha256(await doc.text())).toBe(v.document.sha256);
  });

  it("regenerating from the snapshot reproduces the stored document byte for byte", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    const [v] = await versions();
    expect(sha256(renderOfferDocument(v.snapshot, v.number))).toBe(v.document.sha256);
    const verify = await h.ok("anna", "GET", `/api/proposals/${f.id}/offer-versions/1/verify`);
    expect(verify).toMatchObject({ intact: true, recordedSha256: v.document.sha256, regeneratedSha256: v.document.sha256 });
  });

  it("documents and audit rows cannot be modified at the storage level", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    const db = h.app.store.db;
    expect(() => db.exec("UPDATE documents SET content = 'tampered'")).toThrow(/immutable/);
    expect(() => db.exec("DELETE FROM documents")).toThrow(/immutable/);
    expect(() => db.exec("UPDATE audit_log SET action = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_log")).toThrow(/append-only/);
  });

  it("refuses to issue an approved offer whose validity has lapsed", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    h.clock.advanceDays(31);
    expect((await command(h, "anna", f.id, "issueOffer")).body.error.code).toBe("OFFER_EXPIRED");
  });
});

describe("changes after approval", () => {
  it("require reopening, a new version and re-approval", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    // Content is locked once approved.
    const locked = await h.api("anna", "PATCH", `/api/proposals/${f.id}/commercial`, { contingencyPercent: 5 }, await h.revision(f.id));
    expect(locked.body.error.code).toBe("PROPOSAL_LOCKED");
    expect((await command(h, "sam", f.id, "reopenForRevision", {})).body.error.code).toBe("FIELD_REQUIRED");
    await command(h, "sam", f.id, "reopenForRevision", { reason: "Customer asked for lower contingency" });
    let p = await h.proposal(f.id);
    expect(p.state).toBe("VENDOR_COMMITMENTS");
    expect(p.offerVersions[0].status).toBe("SUPERSEDED");
    await h.ok("anna", "PATCH", `/api/proposals/${f.id}/commercial`, { contingencyPercent: 5 }, await h.revision(f.id));
    // The superseded approved version can no longer be issued.
    expect((await command(h, "anna", f.id, "issueOffer")).status).toBe(409);
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    await command(h, "anna", f.id, "issueOffer");
    p = await h.proposal(f.id);
    expect(p.offerVersions.map((v: any) => [v.number, v.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, "ISSUED"],
    ]);
    expect(p.offerVersions[1].snapshot.totals.contingencyMinor).toBe(18000);
  });

  it("issued versions stay immutable when the proposal is revised again", async () => {
    await command(h, "sam", f.id, "requestApproval");
    await command(h, "carl", f.id, "approveOffer");
    await command(h, "anna", f.id, "issueOffer");
    const issued = structuredClone((await versions())[0]);
    await command(h, "sam", f.id, "reopenForRevision", { reason: "Customer negotiation" });
    await h.ok("anna", "PATCH", `/api/proposals/${f.id}/commercial`, { vendorMarkupPercent: 5 }, await h.revision(f.id));
    await command(h, "sam", f.id, "requestApproval");
    const vs = await versions();
    expect(vs[0]).toEqual(issued);
    expect(vs[1]).toMatchObject({ number: 2, status: "PENDING_APPROVAL" });
    const verify = await h.ok("anna", "GET", `/api/proposals/${f.id}/offer-versions/1/verify`);
    expect(verify.intact).toBe(true);
  });
});
