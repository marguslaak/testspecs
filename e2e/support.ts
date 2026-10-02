import { expect, type Page } from "@playwright/test";

export type Subject = "anna.am" | "sam.lead" | "dana.dev" | "carl.approver" | "vera.vendor" | "otto.other";

/** Signs in through the development identity provider picker. */
export async function signIn(page: Page, subject: Subject, path = "/") {
  // Drop any session from a previous user (from a same-origin page that never redirects).
  await page.goto("/styles.css");
  await page.evaluate(() => localStorage.clear());
  await page.goto(path);
  const picker = page.getByTestId("identity-picker");
  await picker.selectOption(subject);
  await expect(page.getByTestId("current-user")).toBeVisible();
}

export async function openTab(page: Page, proposalId: string, tab: string) {
  await page.goto(`/#/p/${proposalId}/${tab}`);
  await expect(page.getByTestId(`tab-${tab}`)).toHaveClass(/active/);
}

/** Runs a workflow action from the actions bar, optionally with a note, and waits for the new state badge. */
export async function action(page: Page, command: string, opts: { note?: string; expectState?: string } = {}) {
  if (opts.note !== undefined) await page.getByTestId("action-note").fill(opts.note);
  await page.getByTestId(`action-${command}`).click();
  if (opts.expectState) await expect(page.getByTestId("state-badge")).toHaveText(opts.expectState);
}

// ---------------------------------------------------------------------------
// API helpers for arranging state quickly (the scenarios under test use the UI).
// ---------------------------------------------------------------------------

export class Api {
  private tokens = new Map<string, string>();
  ids = new Map<string, string>();
  constructor(private readonly base: string) {}

  async token(subject: Subject) {
    if (!this.tokens.has(subject)) {
      const res = await fetch(`${this.base}/api/dev/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject }) });
      this.tokens.set(subject, (await res.json()).token);
      const me = await this.call(subject, "GET", "/api/me");
      this.ids.set(subject, me.id);
    }
    return this.tokens.get(subject)!;
  }

  async id(subject: Subject) {
    await this.token(subject);
    return this.ids.get(subject)!;
  }

  async call(subject: Subject, method: string, path: string, body?: unknown, ifMatch?: number) {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token(subject)}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
    return json;
  }

  async revision(id: string) {
    return (await this.call("anna.am", "GET", `/api/proposals/${id}`)).proposal.revision as number;
  }

  async command(subject: Subject, id: string, cmd: string, body: unknown = {}) {
    return this.call(subject, "POST", `/api/proposals/${id}/commands/${cmd}`, body, await this.revision(id));
  }

  /**
   * Arranges a proposal up to the vendor-commitment phase. Options leave out
   * individual pieces so scenarios can exercise them through the UI.
   */
  async arrange(title: string, opts: { skipAssignment?: boolean; skipVendorOffer?: boolean } = {}) {
    const created = await this.call("anna.am", "POST", "/api/proposals", { title, customerName: "Acme Retail AS", customerReference: "ACME-1", currency: "EUR" });
    const id = created.result.id as string;
    await this.call("anna.am", "POST", `/api/proposals/${id}/members`, { userId: await this.id("sam.lead"), role: "SOLUTION_LEAD" });
    await this.call("anna.am", "POST", `/api/proposals/${id}/members`, { userId: await this.id("dana.dev"), role: "DEVELOPER" });
    await this.call("anna.am", "PATCH", `/api/proposals/${id}/commercial`, { hourlyRateMinor: 9000 }, await this.revision(id));
    await this.call("anna.am", "POST", `/api/proposals/${id}/requirements`, { title: "Customers can view invoices", status: "CONFIRMED" });
    const ms = await this.call("sam.lead", "POST", `/api/proposals/${id}/milestones`, { title: "MVP" });
    const internal = await this.call("sam.lead", "POST", `/api/proposals/${id}/tasks`, { milestoneId: ms.result.id, title: "Invoice API", scope: "REST API for invoices", deliveryType: "INTERNAL" });
    const external = await this.call("sam.lead", "POST", `/api/proposals/${id}/tasks`, { milestoneId: ms.result.id, title: "Visual design", scope: "Portal page designs", deliveryType: "EXTERNAL" });
    await this.command("sam.lead", id, "markRequirementsReady");
    await this.command("sam.lead", id, "startEstimation");
    const est = await this.call("dana.dev", "POST", `/api/proposals/${id}/tasks/${internal.result.id}/estimates`, { effortMin: 30, effortExpected: 40, effortMax: 60 });
    await this.call("sam.lead", "PUT", `/api/proposals/${id}/tasks/${internal.result.id}/selected-estimate`, { estimateId: est.result.id });
    if (!opts.skipAssignment) {
      await this.call("sam.lead", "POST", `/api/proposals/${id}/tasks/${internal.result.id}/assignments`, { userId: await this.id("dana.dev"), assignmentRole: "DEVELOPER" });
    }
    const role = await this.call("sam.lead", "POST", `/api/proposals/${id}/role-agreements`, { userId: await this.id("sam.lead"), projectRole: "SOLUTION_LEAD" });
    await this.call("sam.lead", "POST", `/api/proposals/${id}/role-agreements/${role.result.id}/agree`);
    await this.call("sam.lead", "POST", `/api/proposals/${id}/vendor-grants`, { userId: await this.id("vera.vendor"), taskIds: [external.result.id] });
    if (!opts.skipVendorOffer) {
      const offer = await this.call("vera.vendor", "POST", `/api/portal/proposals/${id}/tasks/${external.result.id}/offers`, {
        priceMinor: 500000, currency: "EUR", terms: "Fixed price", validUntil: new Date(Date.now() + 60 * 86_400_000).toISOString(), confirmBinding: true,
      });
      await this.call("sam.lead", "POST", `/api/proposals/${id}/vendor-offers/${offer.result.id}/accept`, {});
    }
    await this.command("sam.lead", id, "startStaffing");
    await this.command("sam.lead", id, "startVendorCommitments");
    return { id, internalTaskId: internal.result.id as string, externalTaskId: external.result.id as string };
  }
}
