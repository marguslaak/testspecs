import { expect, test } from "@playwright/test";
import { action, Api, openTab, signIn } from "./support.js";

let api: Api;
test.beforeEach(({ baseURL }) => {
  api = new Api(baseURL!);
});

test("happy path: proposal to issued customer offer", async ({ page }) => {
  // Account manager creates the proposal and sets up the team and commercial basis.
  await signIn(page, "anna.am");
  const create = page.getByTestId("create-proposal");
  await create.getByLabel("Title").fill("Field service app");
  await create.getByLabel("Customer", { exact: true }).fill("Northwind OÜ");
  await create.getByLabel("Customer reference").fill("NW-42");
  await create.getByRole("button", { name: "Create proposal" }).click();
  await expect(page.getByTestId("proposal-title")).toHaveText("Field service app");
  const proposalId = page.url().split("/p/")[1].split("/")[0];

  const addMember = page.getByTestId("add-member");
  await addMember.getByLabel("Person").selectOption({ label: "Sam Lead (SOLUTION_LEAD, DEVELOPER)" });
  await addMember.getByLabel("Role").selectOption("SOLUTION_LEAD");
  await addMember.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Added to team.")).toBeVisible();
  await addMember.getByLabel("Person").selectOption({ label: "Dana Developer (DEVELOPER)" });
  await addMember.getByLabel("Role").selectOption("DEVELOPER");
  await addMember.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("cell", { name: "Dana Developer" })).toBeVisible();
  await page.getByTestId("hourly-rate").fill("95");
  await page.getByRole("button", { name: "Save commercial settings" }).click();
  await expect(page.getByText("Commercial settings saved.")).toBeVisible();

  await page.getByTestId("tab-requirements").click();
  const addReq = page.getByTestId("add-requirement");
  await addReq.getByLabel("Title").fill("Technicians see today's jobs offline");
  await addReq.getByLabel("Status").selectOption("CONFIRMED");
  await addReq.getByRole("button", { name: "Add requirement" }).click();
  await expect(page.getByTestId("requirement-row")).toHaveCount(1);

  // Solution lead decomposes the work and moves to estimation.
  await signIn(page, "sam.lead");
  await openTab(page, proposalId, "work");
  const addMs = page.getByTestId("add-milestone");
  await addMs.getByLabel("New milestone").fill("Release 1");
  await addMs.getByRole("button", { name: "Add milestone" }).click();
  const addTask = page.getByTestId("add-task");
  await addTask.getByLabel("New task").fill("Offline job sync");
  await addTask.getByLabel("Scope").fill("Sync jobs to the device and queue updates while offline.");
  await addTask.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("task-row")).toHaveCount(1);
  await addTask.getByLabel("New task").fill("App icon and screens");
  await addTask.getByLabel("Scope").fill("Visual design of six screens.");
  await addTask.getByLabel("Delivery").selectOption("EXTERNAL");
  await addTask.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("task-row")).toHaveCount(2);
  await action(page, "markRequirementsReady", { expectState: "Requirements ready" });
  await action(page, "startEstimation", { expectState: "Estimation" });

  // Developer estimates; an AI estimate runs asynchronously alongside.
  await signIn(page, "dana.dev");
  await openTab(page, proposalId, "estimates");
  await page.getByTestId("request-ai").click();
  await page.getByText("Submit an estimate").click();
  const est = page.getByTestId("estimate-form");
  await est.getByLabel("Min").fill("24");
  await est.getByLabel("Expected").fill("32");
  await est.getByLabel("Max").fill("48");
  await est.getByLabel("Rationale").fill("Similar sync engine built for another customer.");
  await est.getByRole("button", { name: "Submit estimate" }).click();
  await expect(page.getByTestId("ai-status")).toContainText("COMPLETED");
  await expect(page.getByTestId("estimate-row")).toHaveCount(2);

  // Solution lead selects pricing estimate, staffs the task, agrees the role and invites the vendor.
  await signIn(page, "sam.lead");
  await openTab(page, proposalId, "estimates");
  await page.getByTestId("estimate-row").filter({ hasText: "Dana Developer" }).getByTestId("select-estimate").click();
  await expect(page.getByTestId("selected-estimate")).toBeVisible();
  await page.getByTestId("tab-staffing").click();
  const assignForm = page.getByTestId("assign-form");
  await assignForm.getByLabel("Person").selectOption({ label: "Dana Developer" });
  await assignForm.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByTestId("assignments")).toContainText("Dana Developer");
  const roleForm = page.getByTestId("role-form");
  await roleForm.getByLabel("Person").selectOption({ label: "Sam Lead" });
  await roleForm.getByRole("button", { name: "Propose role" }).click();
  await page.getByTestId("agree-role").click();
  await expect(page.getByTestId("role-row")).toContainText("AGREED");
  await page.getByTestId("tab-vendors").click();
  const grantForm = page.getByTestId("grant-form");
  await grantForm.getByLabel("Vendor user").selectOption({ label: "Vera Vendor" });
  await grantForm.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByText("Access granted.")).toBeVisible();

  // Vendor submits a binding offer through the portal.
  await signIn(page, "vera.vendor", "/portal");
  await page.getByTestId("portal-proposal").click();
  await page.getByText("Submit an offer").click();
  await page.getByTestId("portal-price").fill("4200");
  await page.getByTestId("portal-terms").fill("Fixed price, two review rounds.");
  await page.getByTestId("portal-confirm").check();
  await page.getByRole("button", { name: "Submit binding offer" }).click();
  await expect(page.getByTestId("portal-offer-status")).toHaveText("SUBMITTED");

  // Solution lead accepts, completes the phases, checks readiness and requests approval.
  await signIn(page, "sam.lead");
  await openTab(page, proposalId, "vendors");
  await page.getByTestId("accept-vendor-offer").click();
  await expect(page.getByTestId("vendor-offer-status")).toHaveText("ACCEPTED");
  await action(page, "startStaffing", { expectState: "Staffing" });
  await action(page, "startVendorCommitments", { expectState: "Vendor commitments" });
  await openTab(page, proposalId, "readiness");
  await page.getByTestId("run-readiness").click();
  await expect(page.getByTestId("readiness-result")).toHaveText("All rules pass");
  await action(page, "requestApproval", { expectState: "Awaiting approval" });
  // Content is no longer editable.
  await openTab(page, proposalId, "work");
  await expect(page.getByTestId("add-task")).toHaveCount(0);

  // Commercial approver approves.
  await signIn(page, "carl.approver");
  await openTab(page, proposalId, "offers");
  await expect(page.getByTestId("offer-status")).toHaveText("PENDING_APPROVAL");
  await action(page, "approveOffer", { note: "Margin acceptable", expectState: "Approved" });

  // Account manager issues the approved version.
  await signIn(page, "anna.am");
  await openTab(page, proposalId, "offers");
  await action(page, "issueOffer", { expectState: "Issued" });
  await expect(page.getByTestId("offer-status")).toHaveText("ISSUED");
  await expect(page.getByTestId("issued-info")).toContainText("Anna Account");
  await expect(page.getByText("Issued offer versions are immutable.")).toBeVisible();
  await page.getByTestId("verify-document").click();
  await expect(page.getByText("Document integrity verified")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("download-document").click();
  expect((await download).suggestedFilename()).toBe("field-service-app-offer-v1.html");
  // Issued: no editing actions beyond recording the customer's response.
  const actions = await page.getByTestId("actions").getByRole("button").allTextContents();
  expect(actions).toEqual(["Record customer acceptance", "Record customer rejection", "Reopen for revision (new offer version)", "Cancel proposal"]);
});

test("approval rejection and revision", async ({ page }) => {
  const { id } = await api.arrange("Rejection scenario");
  await api.command("sam.lead", id, "requestApproval");

  await signIn(page, "carl.approver");
  await openTab(page, id, "offers");
  await page.getByTestId("action-rejectOffer").click();
  await expect(page.getByTestId("toast-error")).toContainText("Enter a reason");
  await action(page, "rejectOffer", { note: "Contingency must be at least 15%", expectState: "Vendor commitments" });
  await expect(page.getByTestId("offer-status")).toHaveText("REJECTED");
  await expect(page.getByText("Contingency must be at least 15%")).toBeVisible();

  await signIn(page, "sam.lead");
  await openTab(page, id, "overview");
  await page.getByLabel("Contingency %").fill("15");
  await page.getByRole("button", { name: "Save commercial settings" }).click();
  await expect(page.getByText("Commercial settings saved.")).toBeVisible();
  await action(page, "requestApproval", { expectState: "Awaiting approval" });
  await openTab(page, id, "offers");
  await expect(page.getByTestId("offer-version")).toHaveCount(2);
  await expect(page.getByTestId("offer-version").first()).toContainText("Version 2");
  await expect(page.getByTestId("offer-status").first()).toHaveText("PENDING_APPROVAL");
  // The requester sees no approve action.
  await expect(page.getByTestId("action-approveOffer")).toHaveCount(0);

  await signIn(page, "carl.approver");
  await openTab(page, id, "offers");
  await action(page, "approveOffer", { expectState: "Approved" });
});

test("vendor revision", async ({ page }) => {
  const { id } = await api.arrange("Vendor revision scenario", { skipVendorOffer: true });

  await signIn(page, "vera.vendor", "/portal");
  await page.goto(`/portal#/p/${id}`);
  await expect(page.getByTestId("portal-task")).toHaveCount(1);
  await expect(page.getByTestId("portal-scope")).toHaveText("Portal page designs");
  await page.getByText("Submit an offer").click();
  await page.getByTestId("portal-price").fill("6000");
  await page.getByRole("button", { name: "Submit binding offer" }).click();
  await expect(page.getByTestId("toast-error")).toContainText("binding");
  await page.getByTestId("portal-confirm").check();
  await page.getByRole("button", { name: "Submit binding offer" }).click();
  await expect(page.getByTestId("portal-offer-status")).toHaveText("SUBMITTED");

  await signIn(page, "sam.lead");
  await openTab(page, id, "vendors");
  await page.getByTestId("vendor-review-note").fill("Please include an accessibility review");
  await page.getByTestId("request-vendor-revision").click();
  await expect(page.getByTestId("vendor-offer-status")).toHaveText("REVISION_REQUESTED");

  await signIn(page, "vera.vendor", "/portal");
  await page.goto(`/portal#/p/${id}`);
  await expect(page.getByTestId("portal-offer-status")).toHaveText("REVISION_REQUESTED");
  await expect(page.getByTestId("portal-review-note")).toContainText("accessibility review");
  await page.getByTestId("portal-price").fill("6500");
  await page.getByTestId("portal-terms").fill("Includes WCAG 2.2 AA review");
  await page.getByTestId("portal-confirm").check();
  await page.getByRole("button", { name: "Submit binding offer" }).click();
  await expect(page.getByTestId("portal-offer-status")).toHaveText("SUBMITTED");
  await expect(page.getByTestId("portal-offer").locator("li")).toHaveCount(3); // 2 revisions + 1 review note

  await signIn(page, "sam.lead");
  await openTab(page, id, "vendors");
  await expect(page.getByText("2 revisions")).toBeVisible();
  await page.getByTestId("accept-vendor-offer").click();
  await expect(page.getByTestId("vendor-offer-status")).toHaveText("ACCEPTED");

  await signIn(page, "vera.vendor", "/portal");
  await page.goto(`/portal#/p/${id}`);
  await expect(page.getByTestId("portal-offer-status")).toHaveText("ACCEPTED");
  await expect(page.getByTestId("portal-offer-form")).toHaveCount(0);
  await expect(page.getByText("is now binding")).toBeVisible();

  // A different vendor sees nothing.
  await signIn(page, "otto.other", "/portal");
  await expect(page.getByText("Nothing has been shared with you yet.")).toBeVisible();
});

test("readiness failure remediation", async ({ page }) => {
  const { id } = await api.arrange("Readiness scenario", { skipAssignment: true });

  await signIn(page, "sam.lead");
  await openTab(page, id, "readiness");
  await page.getByTestId("run-readiness").click();
  await expect(page.getByTestId("readiness-result")).toHaveText("Not ready");
  const rule = page.getByTestId("rule-MANDATORY_TASKS_ASSIGNED");
  await expect(rule).toContainText('Assign at least one person to task "Invoice API".');
  await expect(page.getByTestId("rule-PROPOSAL_DATA_COMPLETE")).toHaveClass(/pass/);

  // Requesting approval is refused with the rule-level reason.
  await action(page, "requestApproval");
  await expect(page.getByTestId("toast-error")).toContainText("Assign at least one person");
  await expect(page.getByTestId("state-badge")).toHaveText("Vendor commitments");

  // Remediate via the Fix link, then re-check.
  await rule.getByRole("link", { name: "Fix" }).click();
  await expect(page.getByTestId("tab-staffing")).toHaveClass(/active/);
  const assignForm = page.getByTestId("assign-form");
  await assignForm.getByLabel("Person").selectOption({ label: "Dana Developer" });
  await assignForm.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByTestId("assignments")).toContainText("Dana Developer");
  await openTab(page, id, "readiness");
  await expect(page.getByText("Proposal changed since")).toBeVisible();
  await page.getByTestId("run-readiness").click();
  await expect(page.getByTestId("readiness-result")).toHaveText("All rules pass");
  await action(page, "requestApproval", { expectState: "Awaiting approval" });
});

test("roles see only the actions they may take", async ({ page }) => {
  const { id } = await api.arrange("Permissions scenario");
  await signIn(page, "dana.dev");
  await openTab(page, id, "overview");
  await expect(page.getByTestId("no-actions")).toBeVisible();
  await expect(page.getByTestId("commercial-form").getByRole("button")).toHaveCount(0);
  await openTab(page, id, "requirements");
  await expect(page.getByTestId("add-requirement")).toHaveCount(0);

  // Vendors are redirected away from the internal workspace and cannot open it.
  await signIn(page, "vera.vendor", "/portal");
  await page.goto(`/#/p/${id}/overview`);
  await expect(page).toHaveURL(/\/portal/);
});
