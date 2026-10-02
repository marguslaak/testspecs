import type { AddressInfo } from "node:net";
import { createApp, DEMO_IDENTITIES } from "../src/app/bootstrap.js";
import { type EstimationProvider, HeuristicEstimationProvider } from "../src/infra/ai.js";

export class FakeClock {
  constructor(public current = new Date("2026-10-01T09:00:00.000Z")) {}
  now() {
    return new Date(this.current);
  }
  advanceDays(days: number) {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

export type Who = "anna" | "sam" | "dana" | "carl" | "vera" | "otto";
const SUBJECT: Record<Who, string> = {
  anna: "anna.am",
  sam: "sam.lead",
  dana: "dana.dev",
  carl: "carl.approver",
  vera: "vera.vendor",
  otto: "otto.other",
};

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function startApp(opts: { provider?: EstimationProvider } = {}) {
  const clock = new FakeClock();
  const app = createApp({
    dbPath: ":memory:",
    tokenSecret: "test-secret",
    tokenIssuer: "https://idp.test",
    devLogin: true,
    estimationProvider: opts.provider ?? new HeuristicEstimationProvider(),
    clock,
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const tokens = Object.fromEntries(
    (Object.keys(SUBJECT) as Who[]).map((w) => [
      w,
      app.verifier.sign(DEMO_IDENTITIES.find((i) => i.subject === SUBJECT[w])!),
    ]),
  ) as Record<Who, string>;
  const userIds = Object.fromEntries(
    (Object.keys(SUBJECT) as Who[]).map((w) => [w, app.service.users.findBySubject("https://idp.test", SUBJECT[w])!.id]),
  ) as Record<Who, string>;

  async function api<T = any>(who: Who | null, method: string, path: string, body?: unknown, ifMatch?: number): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (ifMatch !== undefined) headers["if-match"] = `"${ifMatch}"`;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** Calls the API and throws with the error body unless the status is 2xx. */
  async function ok<T = any>(who: Who, method: string, path: string, body?: unknown, ifMatch?: number): Promise<T> {
    const res = await api<T>(who, method, path, body, ifMatch);
    if (res.status >= 300) throw new Error(`${method} ${path} as ${who} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  const revision = async (id: string) => (await ok("anna", "GET", `/api/proposals/${id}`)).proposal.revision as number;
  const proposal = async (id: string, who: Who = "anna") => (await ok(who, "GET", `/api/proposals/${id}`)).proposal;

  return {
    app,
    base,
    clock,
    api,
    ok,
    revision,
    proposal,
    userIds,
    async close() {
      await app.service.ai.idle();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      app.store.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** Runs a lifecycle command with the current revision. */
export async function command(h: TestApp, who: Who, id: string, cmd: string, body: unknown = {}) {
  return h.api(who, "POST", `/api/proposals/${id}/commands/${cmd}`, body, await h.revision(id));
}

export interface Fixture {
  id: string;
  requirementId: string;
  milestoneId: string;
  internalTaskId: string;
  externalTaskId: string;
}

/** Creates a proposal with team, one confirmed requirement, a milestone, an internal and an external task. */
export async function draftProposal(h: TestApp): Promise<Fixture> {
  const created = await h.ok("anna", "POST", "/api/proposals", {
    title: "Customer portal rebuild",
    customerReference: "ACME-2026-17",
    customerName: "Acme Retail AS",
    description: "Rebuild of the self-service customer portal.",
    currency: "EUR",
  });
  const id = created.result.id;
  await h.ok("anna", "POST", `/api/proposals/${id}/members`, { userId: h.userIds.sam, role: "SOLUTION_LEAD" });
  await h.ok("anna", "POST", `/api/proposals/${id}/members`, { userId: h.userIds.dana, role: "DEVELOPER" });
  const req = await h.ok("anna", "POST", `/api/proposals/${id}/requirements`, {
    title: "Customers can view invoices",
    description: "List and download invoices for the last 24 months.",
    source: "RFP section 3.2",
    priority: "MUST",
    classification: "FUNCTIONAL",
    acceptanceNotes: "Invoices visible within 5s",
    status: "CONFIRMED",
  });
  const ms = await h.ok("sam", "POST", `/api/proposals/${id}/milestones`, { title: "MVP", description: "First release" });
  const internal = await h.ok("sam", "POST", `/api/proposals/${id}/tasks`, {
    milestoneId: ms.result.id,
    title: "Invoice list API",
    scope: "REST API for invoice listing with pagination and PDF download integration.",
    deliveryType: "INTERNAL",
    requirementIds: [req.result.id],
  });
  const external = await h.ok("sam", "POST", `/api/proposals/${id}/tasks`, {
    milestoneId: ms.result.id,
    title: "Visual design",
    scope: "Design system and page designs for the portal.",
    deliveryType: "EXTERNAL",
  });
  await h.ok("anna", "PATCH", `/api/proposals/${id}/commercial`, { hourlyRateMinor: 9000, contingencyPercent: 10, vendorMarkupPercent: 15, validityDays: 30 }, await h.revision(id));
  return { id, requirementId: req.result.id, milestoneId: ms.result.id, internalTaskId: internal.result.id, externalTaskId: external.result.id };
}

/** Drives a draft proposal to the point where it passes readiness. */
export async function readyProposal(h: TestApp, f?: Fixture): Promise<Fixture> {
  f ??= await draftProposal(h);
  const { id } = f;
  const assert2xx = async (p: Promise<{ status: number; body: unknown }>) => {
    const r = await p;
    if (r.status >= 300) throw new Error(JSON.stringify(r.body));
  };
  await assert2xx(command(h, "sam", id, "markRequirementsReady"));
  await assert2xx(command(h, "sam", id, "startEstimation"));
  const est = await h.ok("dana", "POST", `/api/proposals/${id}/tasks/${f.internalTaskId}/estimates`, {
    effortMin: 30,
    effortExpected: 40,
    effortMax: 60,
    unit: "HOURS",
    assumptions: ["Existing invoice service has an API"],
    rationale: "Similar to the orders API we built last year.",
    confidence: 0.7,
  });
  await h.ok("sam", "PUT", `/api/proposals/${id}/tasks/${f.internalTaskId}/selected-estimate`, { estimateId: est.result.id });
  await h.ok("sam", "POST", `/api/proposals/${id}/tasks/${f.internalTaskId}/assignments`, { userId: h.userIds.dana, assignmentRole: "DEVELOPER", allocationPercent: 80 });
  const role = await h.ok("sam", "POST", `/api/proposals/${id}/role-agreements`, { userId: h.userIds.sam, projectRole: "SOLUTION_LEAD", responsibilities: "Technical delivery" });
  await h.ok("sam", "POST", `/api/proposals/${id}/role-agreements/${role.result.id}/agree`);
  await h.ok("sam", "POST", `/api/proposals/${id}/vendor-grants`, { userId: h.userIds.vera, taskIds: [f.externalTaskId] });
  const offer = await h.ok("vera", "POST", `/api/portal/proposals/${id}/tasks/${f.externalTaskId}/offers`, {
    priceMinor: 500000,
    currency: "EUR",
    terms: "Fixed price, two review rounds.",
    validUntil: "2026-12-31T00:00:00.000Z",
    confirmBinding: true,
  });
  await h.ok("sam", "POST", `/api/proposals/${id}/vendor-offers/${offer.result.id}/accept`, { note: "Good value" });
  await assert2xx(command(h, "sam", id, "startStaffing"));
  await assert2xx(command(h, "sam", id, "startVendorCommitments"));
  return f;
}
