import { api, ApiError, date, devLoginPicker, fill, formData, h, money, showError, store, toast } from "./common.js";

// Internal Offer Management Workspace.

const STEPS = ["DRAFT", "REQUIREMENTS_READY", "ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS", "READY_FOR_APPROVAL", "APPROVED", "ISSUED", "ACCEPTED"];
const STATE_LABEL = {
  DRAFT: "Draft", REQUIREMENTS_READY: "Requirements ready", ESTIMATION: "Estimation", STAFFING: "Staffing",
  VENDOR_COMMITMENTS: "Vendor commitments", READY_FOR_APPROVAL: "Awaiting approval", APPROVED: "Approved",
  ISSUED: "Issued", ACCEPTED: "Accepted", REJECTED: "Rejected by customer", CANCELLED: "Cancelled",
};
const TABS = [
  ["overview", "Overview"], ["requirements", "Requirements"], ["work", "Work breakdown"], ["estimates", "Estimates"],
  ["staffing", "Staffing & roles"], ["vendors", "Vendors"], ["readiness", "Readiness"], ["offers", "Approval & offers"], ["audit", "Audit"],
];
/** Where each readiness rule is remedied; falls back to the failing entity's tab. */
const RULE_TAB = {
  WORK_BREAKDOWN_COMPLETE: "work", MANDATORY_TASKS_ESTIMATED: "estimates", PRICING_ESTIMATE_SELECTED: "estimates",
  MANDATORY_TASKS_ASSIGNED: "staffing", REQUIRED_ROLES_AGREED: "staffing", EXTERNAL_COMMITMENTS_ACCEPTED: "vendors", COMMERCIAL_TOTALS_CALCULABLE: "overview",
};
const ENTITY_TAB = { Requirement: "requirements", Milestone: "work", Task: "work", RoleAgreement: "staffing", VendorOffer: "vendors", Proposal: "overview" };
const NOTE_COMMANDS = new Set(["rejectOffer", "reopenForRevision", "cancel"]);

const app = { me: null, users: [], view: null, pollTimer: null };
const root = document.getElementById("app");
const userName = (id) => (id === "system" ? "System" : app.users.find((u) => u.id === id)?.displayName ?? id);
const stateBadge = (s) => h("span.badge", { class: ["ACCEPTED", "APPROVED", "ISSUED"].includes(s) ? "ok" : ["CANCELLED", "REJECTED"].includes(s) ? "bad" : "", "data-testid": "state-badge" }, STATE_LABEL[s] ?? s);

function route() {
  const [, page, id, tab] = (location.hash.replace(/^#/, "") || "/").split("/");
  return { page: page || "home", id, tab: tab || "overview" };
}
window.addEventListener("hashchange", () => render());

async function boot() {
  if (!store.token) return renderLogin();
  try {
    app.me = await api("GET", "/api/me");
    if (app.me.kind !== "INTERNAL") {
      location.href = "/portal";
      return;
    }
    app.users = await api("GET", "/api/users");
  } catch (e) {
    store.token = null;
    return renderLogin();
  }
  render();
}

function header() {
  return h("header.top",
    h("h1", h("a", { href: "#/" }, "Offer Management")),
    h("span.spacer"),
    app.me && h("span.small", { "data-testid": "current-user" }, `${app.me.displayName} · ${app.me.roles.join(", ")}`),
    h("button", { on: { click: () => { store.token = null; app.me = null; renderLogin(); } } }, "Sign out"));
}

function renderLogin() {
  const picker = h("div");
  fill(root, h("header.top", h("h1", "Offer Management")), h("main", h("div.card.stack",
    h("h2", "Sign in"), h("p.muted", "Internal workspace for proposals and customer offers. Vendors use the ", h("a", { href: "/portal" }, "vendor portal"), "."), picker)));
  devLoginPicker(picker, { filter: (i) => i.kind === "INTERNAL", onLogin: boot });
}

async function render() {
  clearInterval(app.pollTimer);
  const r = route();
  if (!app.me) return boot();
  try {
    if (r.page === "p" && r.id) await renderProposal(r.id, r.tab);
    else await renderDashboard();
  } catch (e) {
    showError(e);
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) location.hash = "#/";
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function renderDashboard() {
  const list = await api("GET", "/api/proposals");
  const canCreate = app.me.roles.includes("ACCOUNT_MANAGER");
  const createForm = h("form.inline", { "data-testid": "create-proposal", on: { submit: async (e) => {
    e.preventDefault();
    try {
      const res = await api("POST", "/api/proposals", formData(e.target));
      location.hash = `#/p/${res.result.id}/overview`;
    } catch (err) { showError(err); }
  } } },
    h("label", "Title", h("input", { name: "title", required: true })),
    h("label", "Customer", h("input", { name: "customerName" })),
    h("label", "Customer reference", h("input", { name: "customerReference", required: true })),
    h("label", "Currency", h("input", { name: "currency", value: "EUR", maxlength: 3, required: true })),
    h("button.primary", { type: "submit" }, "Create proposal"));

  fill(root, header(), h("main",
    h("h2", "Proposals"),
    canCreate && h("div.card", h("h3", { style: "margin-top:0" }, "New proposal"), createForm),
    list.length === 0 ? h("p.muted", "No proposals yet.") : h("div.grid", { "data-testid": "proposal-list" }, list.map((p) => h("a.card", { href: `#/p/${p.id}/overview`, style: "text-decoration:none;color:inherit", "data-testid": "proposal-card" },
      h("div.row", h("strong", p.title), h("span.spacer"), stateBadge(p.state)),
      h("div.muted.small", `${p.customerName || "—"} · ${p.customerReference}`),
      h("div.small", `${p.counts.requirements} requirements · ${p.counts.tasks} tasks · ${p.counts.estimates} estimates`),
      h("div.row.small", "Readiness: ", p.readiness ? h("span.badge", { class: p.readiness.passed && p.readiness.current ? "ok" : p.readiness.current ? "bad" : "warn" }, p.readiness.passed ? (p.readiness.current ? "Ready" : "Out of date") : "Not ready") : h("span.badge.muted", "Not checked")),
      h("div.small", "Current total: ", h("strong", money(p.totals.totalMinor, p.totals.currency))))))));
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

async function load(id) {
  app.view = await api("GET", `/api/proposals/${id}`);
  return app.view;
}

/** Runs a mutation, sending If-Match when the endpoint edits existing data, then reloads. */
async function mut(method, path, body, { ifMatch = false, success } = {}) {
  const p = app.view.proposal;
  try {
    const res = await api(method, `/api/proposals/${p.id}${path}`, body, ifMatch ? { ifMatch: p.revision } : {});
    if (success) toast(success, { info: true });
    await render();
    return res;
  } catch (e) {
    if (e instanceof ApiError && e.code === "VERSION_CONFLICT") toast("Someone else changed this proposal. The latest version has been loaded — please redo your change.", { code: e.code });
    else showError(e);
    if (e instanceof ApiError && e.code === "VERSION_CONFLICT") await render();
    return null;
  }
}

async function renderProposal(id, tab) {
  const view = await load(id);
  const { proposal: p, capabilities: caps } = view;
  const body = h("div");
  const renderers = { overview: tabOverview, requirements: tabRequirements, work: tabWork, estimates: tabEstimates, staffing: tabStaffing, vendors: tabVendors, readiness: tabReadiness, offers: tabOffers, audit: tabAudit };
  fill(root, header(), h("main",
    h("div.row", h("a", { href: "#/" }, "← Proposals")),
    h("div.row", h("h2", { "data-testid": "proposal-title" }, p.title), stateBadge(p.state)),
    h("div.muted.small", `${p.customerName || "—"} · ${p.customerReference} · ${p.currency} · revision ${p.revision}`),
    stepper(p),
    actionsBar(view),
    readinessBanner(view),
    h("nav.tabs", TABS.map(([key, label]) => h("a", { href: `#/p/${id}/${key}`, class: key === tab ? "active" : "", "data-testid": `tab-${key}` }, label))),
    body));
  await (renderers[tab] ?? tabOverview)(body, view);
}

function stepper(p) {
  const idx = STEPS.indexOf(p.state);
  return h("ol.stepper", { "aria-label": "Proposal progress" }, STEPS.map((s, i) =>
    h("li", { class: i < idx ? "done" : i === idx ? "current" : "" }, STATE_LABEL[s])),
  idx < 0 && h("li.current", STATE_LABEL[p.state]));
}

function actionsBar(view) {
  const { capabilities: caps, proposal: p } = view;
  if (caps.actions.length === 0) return h("p.muted.small", { "data-testid": "no-actions" }, "No workflow actions are available to you in this state.");
  const note = h("input", { placeholder: "Reason / comment", "data-testid": "action-note", "aria-label": "Reason or comment", style: "flex:1 1 220px" });
  const run = async (command, extra = {}) => {
    const text = note.value.trim();
    if (NOTE_COMMANDS.has(command) && !text) {
      note.focus();
      return toast("Enter a reason or comment for this action first.");
    }
    const body = { ...extra, comment: text || undefined, reason: text || undefined, note: text || undefined };
    await mut("POST", `/commands/${command}`, body, { ifMatch: true, success: "Done." });
  };
  return h("div.card.row", { "data-testid": "actions" },
    h("strong.small", "Actions:"),
    caps.actions.map((a) => {
      if (a.command === "returnToPhase") {
        const sel = h("select", { "data-testid": "return-target", "aria-label": "Return to phase" }, a.targets.map((t) => h("option", { value: t }, STATE_LABEL[t])));
        return h("span.row", sel, h("button", { on: { click: () => run("returnToPhase", { target: sel.value }) }, "data-testid": "action-returnToPhase" }, "Return to phase"));
      }
      return h("button", {
        class: a.command === "cancel" ? "danger" : ["requestApproval", "approveOffer", "issueOffer"].includes(a.command) ? "primary" : "",
        disabled: !a.enabled, title: a.reason, "data-testid": `action-${a.command}`,
        on: { click: () => run(a.command) },
      }, a.label);
    }),
    note);
}

function readinessBanner(view) {
  const r = view.readiness;
  const p = view.proposal;
  if (!["ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS"].includes(p.state)) return null;
  if (!r) return h("p.small.muted", "Readiness has not been checked yet — see the Readiness tab.");
  const failing = r.outcomes.filter((o) => !o.passed);
  return h("div.card.small", { "data-testid": "readiness-banner" },
    r.passed && r.current ? h("span.badge.ok", "Ready for approval") : !r.current ? h("span.badge.warn", "Readiness check is out of date") : h("span.badge.bad", `${failing.length} readiness rule(s) failing`),
    " ", h("a", { href: `#/p/${p.id}/readiness` }, "Details"));
}

// --- Overview --------------------------------------------------------------

function tabOverview(el, { proposal: p, capabilities: caps, pricing }) {
  const ro = !caps.canEditDetails;
  const details = h("form.stack", { on: { submit: (e) => { e.preventDefault(); const d = formData(e.target); d.requiredRoles = (d.requiredRoles ?? "").split(",").map((s) => s.trim()).filter(Boolean); mut("PATCH", "", d, { ifMatch: true, success: "Saved." }); } } },
    h("div.grid",
      h("label", "Title", h("input", { name: "title", value: p.title, disabled: ro })),
      h("label", "Customer name", h("input", { name: "customerName", value: p.customerName, disabled: ro })),
      h("label", "Customer reference", h("input", { name: "customerReference", value: p.customerReference, disabled: ro })),
      h("label", "Currency", h("input", { name: "currency", value: p.currency, disabled: ro, maxlength: 3 })),
      h("label", "Required project roles (comma separated)", h("input", { name: "requiredRoles", value: p.requiredRoles.join(", "), disabled: ro }))),
    h("label", "Description", h("textarea", { name: "description", disabled: ro }, p.description)),
    !ro && h("button.primary", { type: "submit" }, "Save details"));

  const c = p.commercial;
  const commercial = h("form.stack", { "data-testid": "commercial-form", on: { submit: (e) => {
    e.preventDefault();
    const d = formData(e.target);
    d.hourlyRateMinor = Math.round((d.hourlyRate ?? 0) * 100);
    delete d.hourlyRate;
    d.assumptions = (d.assumptions ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    mut("PATCH", "/commercial", d, { ifMatch: true, success: "Commercial settings saved." });
  } } },
    h("div.grid",
      h("label", `Default hourly rate (${p.currency})`, h("input", { name: "hourlyRate", type: "number", step: "0.01", min: 0, value: c.hourlyRateMinor / 100, disabled: ro, "data-testid": "hourly-rate" })),
      h("label", "Contingency %", h("input", { name: "contingencyPercent", type: "number", step: "0.1", min: 0, value: c.contingencyPercent, disabled: ro })),
      h("label", "Vendor markup %", h("input", { name: "vendorMarkupPercent", type: "number", step: "0.1", min: 0, value: c.vendorMarkupPercent, disabled: ro })),
      h("label", "Validity (days)", h("input", { name: "validityDays", type: "number", min: 1, value: c.validityDays, disabled: ro }))),
    h("label", "Payment terms", h("input", { name: "paymentTerms", value: c.paymentTerms, disabled: ro })),
    h("label", "Other terms", h("textarea", { name: "terms", disabled: ro }, c.terms)),
    h("label", "Assumptions (one per line)", h("textarea", { name: "assumptions", disabled: ro }, c.assumptions.join("\n"))),
    !ro && h("button.primary", { type: "submit" }, "Save commercial settings"));

  const t = pricing.totals;
  const team = h("div",
    h("table", h("thead", h("tr", h("th", "Person"), h("th", "Role"), h("th", ""))), h("tbody", p.members.map((m) =>
      h("tr", h("td", userName(m.userId)), h("td", m.role), h("td", caps.canManageMembers && m.userId !== p.ownerId && h("button.small", { on: { click: async () => {
        const res = await mut("DELETE", `/members/${m.userId}/${m.role}`, undefined, { ifMatch: true });
        if (res === null && confirm("This person has active assignments or role agreements. Release them and remove the person?")) {
          await mut("DELETE", `/members/${m.userId}/${m.role}?releaseCommitments=true`, undefined, { ifMatch: true, success: "Removed." });
        }
      } } }, "Remove")))))),
    caps.canManageMembers && h("form.inline", { "data-testid": "add-member", on: { submit: (e) => { e.preventDefault(); mut("POST", "/members", formData(e.target), { success: "Added to team." }); } } },
      h("label", "Person", h("select", { name: "userId" }, app.users.filter((u) => u.kind === "INTERNAL").map((u) => h("option", { value: u.id }, `${u.displayName} (${u.roles.join(", ")})`)))),
      h("label", "Role", h("select", { name: "role" }, ["SOLUTION_LEAD", "DEVELOPER", "ACCOUNT_MANAGER", "COMMERCIAL_APPROVER"].map((r) => h("option", r)))),
      h("button", { type: "submit" }, "Add")));

  fill(el, 
    h("div.grid",
      h("div.card", h("h3", { style: "margin-top:0" }, "Current price"), h("div.total", { "data-testid": "current-total" }, money(t.totalMinor, t.currency)),
        h("dl.kv.small",
          h("dt", "Internal delivery"), h("dd", money(t.labourMinor, t.currency)),
          h("dt", "Contingency"), h("dd", money(t.contingencyMinor, t.currency)),
          h("dt", "Vendor cost"), h("dd", money(t.vendorCostMinor, t.currency)),
          h("dt", "Vendor markup"), h("dd", money(t.vendorMarkupMinor, t.currency)),
          h("dt", "Optional items"), h("dd", money(t.optionalTotalMinor, t.currency)))),
      h("div.card", h("h3", { style: "margin-top:0" }, "Team"), team)),
    h("div.card", h("h3", { style: "margin-top:0" }, "Details"), details),
    h("div.card", h("h3", { style: "margin-top:0" }, "Commercial settings"), commercial));
}

// --- Requirements ----------------------------------------------------------

function tabRequirements(el, { proposal: p, capabilities: caps }) {
  const reqs = [...p.requirements].sort((a, b) => a.order - b.order);
  const editable = caps.canEditRequirements;
  const move = (i, d) => {
    const ids = reqs.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    mut("POST", "/requirements/order", { ids }, { ifMatch: true });
  };
  const select = (r, field, options) => h("select", { disabled: !editable, "aria-label": field, "data-testid": `req-${field}`, on: { change: (e) => mut("PATCH", `/requirements/${r.id}`, { [field]: e.target.value }, { ifMatch: true }) } },
    options.map((o) => h("option", { value: o, selected: r[field] === o ? true : undefined }, o)));
  fill(el, 
    h("div.card.table-wrap", h("table", { "data-testid": "requirements" },
      h("thead", h("tr", h("th", "#"), h("th", "Requirement"), h("th", "Class"), h("th", "Priority"), h("th", "Status"), h("th", ""))),
      h("tbody", reqs.map((r, i) => h("tr", { "data-testid": "requirement-row" },
        h("td", i + 1),
        h("td", h("strong", r.title), r.description && h("div.small", r.description), h("div.small.muted", [r.source && `Source: ${r.source}`, r.acceptanceNotes && `Acceptance: ${r.acceptanceNotes}`].filter(Boolean).join(" · "))),
        h("td", select(r, "classification", ["FUNCTIONAL", "NON_FUNCTIONAL", "CONSTRAINT", "ASSUMPTION", "ACCEPTANCE"])),
        h("td", select(r, "priority", ["MUST", "SHOULD", "COULD", "WONT"])),
        h("td", select(r, "status", ["DRAFT", "CONFIRMED", "DEFERRED", "REJECTED"])),
        h("td.row", editable && [
          h("button.small", { disabled: i === 0, on: { click: () => move(i, -1) }, "aria-label": "Move up" }, "↑"),
          h("button.small", { disabled: i === reqs.length - 1, on: { click: () => move(i, 1) }, "aria-label": "Move down" }, "↓"),
          h("button.small.danger", { on: { click: () => mut("DELETE", `/requirements/${r.id}`, undefined, { ifMatch: true }) } }, "Delete"),
        ])))))),
    editable && h("div.card", h("h3", { style: "margin-top:0" }, "Add requirement"),
      h("form.stack", { "data-testid": "add-requirement", on: { submit: (e) => { e.preventDefault(); mut("POST", "/requirements", formData(e.target), { success: "Requirement added." }); } } },
        h("div.grid",
          h("label", "Title", h("input", { name: "title", required: true })),
          h("label", "Source", h("input", { name: "source", placeholder: "e.g. RFP §3.2" })),
          h("label", "Classification", h("select", { name: "classification" }, ["FUNCTIONAL", "NON_FUNCTIONAL", "CONSTRAINT", "ASSUMPTION", "ACCEPTANCE"].map((o) => h("option", o)))),
          h("label", "Priority", h("select", { name: "priority" }, ["MUST", "SHOULD", "COULD", "WONT"].map((o) => h("option", o)))),
          h("label", "Status", h("select", { name: "status" }, ["DRAFT", "CONFIRMED"].map((o) => h("option", o))))),
        h("label", "Description", h("textarea", { name: "description" })),
        h("label", "Acceptance notes", h("input", { name: "acceptanceNotes" })),
        h("button.primary", { type: "submit" }, "Add requirement"))));
}

// --- Work breakdown --------------------------------------------------------

function tabWork(el, { proposal: p, capabilities: caps }) {
  const editable = caps.canEditWorkBreakdown;
  const milestones = [...p.milestones].sort((a, b) => a.order - b.order);
  const tasksOf = (mid) => p.tasks.filter((t) => t.milestoneId === mid).sort((a, b) => a.order - b.order);
  const title = (id) => p.tasks.find((t) => t.id === id)?.title ?? id;
  const moveMs = (i, d) => {
    const ids = milestones.map((m) => m.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    mut("POST", "/milestones/order", { ids }, { ifMatch: true });
  };
  const moveTask = (mid, i, d) => {
    const ids = tasksOf(mid).map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    mut("POST", `/milestones/${mid}/tasks/order`, { ids }, { ifMatch: true });
  };
  const taskEditor = (t) => h("details", h("summary.small", "Edit"),
    h("form.stack", { on: { submit: (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.mandatory = !!d.mandatory;
      d.dependsOn = d.dependsOn ?? [];
      d.requirementIds = d.requirementIds ?? [];
      mut("PATCH", `/tasks/${t.id}`, d, { ifMatch: true, success: "Task saved." });
    } } },
      h("div.grid",
        h("label", "Title", h("input", { name: "title", value: t.title })),
        h("label", "Milestone", h("select", { name: "milestoneId" }, milestones.map((m) => h("option", { value: m.id, selected: m.id === t.milestoneId ? true : undefined }, m.title)))),
        h("label", "Delivery", h("select", { name: "deliveryType" }, ["INTERNAL", "EXTERNAL", "MIXED"].map((o) => h("option", { selected: t.deliveryType === o ? true : undefined }, o)))),
        h("label.inline", h("input", { type: "checkbox", name: "mandatory", checked: t.mandatory }), "Mandatory scope")),
      h("label", "Scope", h("textarea", { name: "scope" }, t.scope)),
      h("label", "Depends on", h("select", { name: "dependsOn", multiple: true, size: 3 }, p.tasks.filter((x) => x.id !== t.id).map((x) => h("option", { value: x.id, selected: t.dependsOn.includes(x.id) ? true : undefined }, x.title)))),
      h("label", "Delivers requirements", h("select", { name: "requirementIds", multiple: true, size: 3 }, p.requirements.map((r) => h("option", { value: r.id, selected: t.requirementIds.includes(r.id) ? true : undefined }, r.title)))),
      h("div.row", h("button.primary", { type: "submit" }, "Save task"), h("button.danger", { type: "button", on: { click: () => mut("DELETE", `/tasks/${t.id}`, undefined, { ifMatch: true }) } }, "Delete task"))));

  fill(el, 
    milestones.length === 0 && h("p.muted", "No milestones yet."),
    milestones.map((m, mi) => h("div.card", { "data-testid": "milestone" },
      h("div.row", h("h3", { style: "margin:0" }, `${mi + 1}. ${m.title}`), h("span.spacer"),
        editable && [
          h("button.small", { disabled: mi === 0, on: { click: () => moveMs(mi, -1) }, "aria-label": "Move milestone up" }, "↑"),
          h("button.small", { disabled: mi === milestones.length - 1, on: { click: () => moveMs(mi, 1) }, "aria-label": "Move milestone down" }, "↓"),
          h("button.small.danger", { on: { click: () => mut("DELETE", `/milestones/${m.id}`, undefined, { ifMatch: true }) } }, "Delete")]),
      m.description && h("p.small.muted", m.description),
      h("div.table-wrap", h("table", h("thead", h("tr", h("th", "Task"), h("th", "Delivery"), h("th", "Depends on"), h("th", ""))),
        h("tbody", tasksOf(m.id).map((t, ti, arr) => h("tr", { "data-testid": "task-row" },
          h("td", h("strong", t.title), !t.mandatory && h("span.badge.muted", " optional"), h("div.small", t.scope || h("em.muted", "No scope described")), editable && taskEditor(t)),
          h("td", h("span.badge", t.deliveryType)),
          h("td.small", t.dependsOn.map(title).join(", ") || "—"),
          h("td.row", editable && [
            h("button.small", { disabled: ti === 0, on: { click: () => moveTask(m.id, ti, -1) }, "aria-label": "Move task up" }, "↑"),
            h("button.small", { disabled: ti === arr.length - 1, on: { click: () => moveTask(m.id, ti, 1) }, "aria-label": "Move task down" }, "↓")])))))),
      editable && h("form.inline", { "data-testid": "add-task", on: { submit: (e) => { e.preventDefault(); const d = formData(e.target); d.milestoneId = m.id; d.mandatory = !!d.mandatory; mut("POST", "/tasks", d, { success: "Task added." }); } } },
        h("label", "New task", h("input", { name: "title", required: true })),
        h("label", "Scope", h("input", { name: "scope" })),
        h("label", "Delivery", h("select", { name: "deliveryType" }, ["INTERNAL", "EXTERNAL", "MIXED"].map((o) => h("option", o)))),
        h("label.inline", h("input", { type: "checkbox", name: "mandatory", checked: true }), "Mandatory"),
        h("button", { type: "submit" }, "Add task")))),
    editable && h("div.card", h("form.inline", { "data-testid": "add-milestone", on: { submit: (e) => { e.preventDefault(); mut("POST", "/milestones", formData(e.target), { success: "Milestone added." }); } } },
      h("label", "New milestone", h("input", { name: "title", required: true })),
      h("label", "Description", h("input", { name: "description" })),
      h("button.primary", { type: "submit" }, "Add milestone"))));
}

// --- Estimates -------------------------------------------------------------

async function tabEstimates(el, { proposal: p, capabilities: caps }) {
  const tasks = p.tasks.filter((t) => t.deliveryType !== "EXTERNAL");
  if (tasks.length === 0) return fill(el, h("p.muted", "No internally delivered tasks to estimate."));
  const comparisons = await Promise.all(tasks.map((t) => api("GET", `/api/proposals/${p.id}/tasks/${t.id}/estimates`)));
  const anyPending = comparisons.some((c) => c.aiRequests.some((r) => r.status === "PENDING"));
  if (anyPending) app.pollTimer = setInterval(() => render(), 1500);

  fill(el, ...tasks.map((t, i) => {
    const cmp = comparisons[i];
    const lastAi = cmp.aiRequests.at(-1);
    return h("div.card", { "data-testid": "estimate-task" },
      h("div.row", h("h3", { style: "margin:0" }, t.title), h("span.badge", t.deliveryType), !t.mandatory && h("span.badge.muted", "optional"), h("span.spacer"),
        caps.canRequestAiEstimates && h("button", { "data-testid": "request-ai", disabled: lastAi?.status === "PENDING", on: { click: () => mut("POST", `/tasks/${t.id}/ai-estimates`, undefined, { success: "AI estimate requested." }) } }, "Request AI estimate")),
      h("p.small.muted", t.scope),
      cmp.aiRequests.length > 0 && h("div.small", { "data-testid": "ai-status" }, "AI: ", cmp.aiRequests.slice(-3).map((r) =>
        h("span", { style: "margin-right:.75rem" },
          h("span.badge", { class: r.status === "COMPLETED" ? "ok" : r.status === "FAILED" ? "bad" : "warn" }, r.status === "PENDING" ? "Estimating…" : r.status),
          r.error && ` ${r.error.message} (${r.error.code})`))),
      cmp.estimates.length === 0 ? h("p.muted.small", "No estimates yet.") : h("div.table-wrap", h("table", { "data-testid": "estimate-table" },
        h("thead", h("tr", h("th", "Source"), h("th.num", "Min"), h("th.num", "Expected"), h("th.num", "Max"), h("th", "Confidence"), h("th", "Assumptions & rationale"), h("th", "Status"), h("th", "Pricing"))),
        h("tbody", cmp.estimates.map((e) => h("tr", { "data-testid": "estimate-row", style: e.current ? "" : "opacity:.55" },
          h("td", e.source === "AI" ? h("span", h("span.badge", "AI"), h("div.small.muted", `${e.ai.provider} / ${e.ai.model}`)) : userName(e.estimatorUserId), h("div.small.muted", date(e.createdAt))),
          h("td.num", `${e.effortMin} ${e.unit.toLowerCase()}`), h("td.num", h("strong", `${e.effortExpected} ${e.unit.toLowerCase()}`)), h("td.num", `${e.effortMax} ${e.unit.toLowerCase()}`),
          h("td", e.confidence === null ? "—" : `${Math.round(e.confidence * 100)}%`),
          h("td.small", e.assumptions.length > 0 && h("ul", { style: "margin:0;padding-left:1rem" }, e.assumptions.map((a) => h("li", a))), e.rationale),
          h("td", e.current ? (e.stale ? h("span.badge.warn", "Scope changed") : h("span.badge.ok", "Current")) : h("span.badge.muted", "Superseded")),
          h("td", cmp.selectedEstimateId === e.id ? h("span.badge.ok", { "data-testid": "selected-estimate" }, "Selected")
            : caps.canSelectEstimates && e.current && h("button.small", { "data-testid": "select-estimate", on: { click: () => mut("PUT", `/tasks/${t.id}/selected-estimate`, { estimateId: e.id }, { success: "Pricing estimate selected." }) } }, "Use for pricing"))))))),
      cmp.estimates.length > 0 && h("p.small.muted", `Current estimates: ${cmp.summary.currentCount} · expected ${cmp.summary.minExpectedHours}–${cmp.summary.maxExpectedHours} h (mean ${Math.round(cmp.summary.meanExpectedHours * 10) / 10} h)`),
      caps.canSubmitEstimates && estimateForm(t, cmp));
  }));
}

function estimateForm(t, cmp) {
  const mine = cmp.estimates.filter((e) => e.current && e.source === "HUMAN" && e.estimatorUserId === app.me.id);
  return h("details", h("summary", "Submit an estimate"),
    h("form.stack", { "data-testid": "estimate-form", on: { submit: (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.assumptions = (d.assumptions ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (d.confidence !== undefined) d.confidence = d.confidence / 100;
      mut("POST", `/tasks/${t.id}/estimates`, d, { success: "Estimate submitted." });
    } } },
      h("div.grid",
        h("label", "Min", h("input", { name: "effortMin", type: "number", step: "0.5", min: 0, required: true })),
        h("label", "Expected", h("input", { name: "effortExpected", type: "number", step: "0.5", min: 0, required: true })),
        h("label", "Max", h("input", { name: "effortMax", type: "number", step: "0.5", min: 0, required: true })),
        h("label", "Unit", h("select", { name: "unit" }, h("option", "HOURS"), h("option", "DAYS"))),
        h("label", "Confidence %", h("input", { name: "confidence", type: "number", min: 0, max: 100 })),
        mine.length > 0 && h("label", "Corrects", h("select", { name: "supersedesId" }, h("option", { value: "" }, "— new estimate —"), mine.map((e) => h("option", { value: e.id }, `${e.effortExpected} ${e.unit.toLowerCase()} (${date(e.createdAt)})`))))),
      h("label", "Assumptions (one per line)", h("textarea", { name: "assumptions" })),
      h("label", "Rationale", h("textarea", { name: "rationale" })),
      h("button.primary", { type: "submit" }, "Submit estimate")));
}

// --- Staffing --------------------------------------------------------------

function tabStaffing(el, { proposal: p, capabilities: caps }) {
  const members = [...new Set(p.members.map((m) => m.userId))];
  const internalTasks = p.tasks.filter((t) => t.deliveryType !== "EXTERNAL");
  const statusBadge = (s) => h("span.badge", { class: s === "AGREED" || s === "CONFIRMED" ? "ok" : s === "PROPOSED" || s === "PLANNED" ? "warn" : "muted" }, s);
  fill(el, 
    h("div.card", h("h3", { style: "margin-top:0" }, "Task assignments"),
      h("div.table-wrap", h("table", { "data-testid": "assignments" }, h("thead", h("tr", h("th", "Task"), h("th", "Person"), h("th", "Role"), h("th.num", "Allocation"), h("th", "Status"), h("th", ""))),
        h("tbody", internalTasks.flatMap((t) => {
          const rows = p.assignments.filter((a) => a.taskId === t.id);
          if (rows.length === 0) return [h("tr", h("td", t.title), h("td.muted", { colspan: 5 }, t.mandatory ? "Unstaffed — required before approval" : "Unstaffed"))];
          return rows.map((a) => h("tr", h("td", t.title), h("td", userName(a.userId)), h("td", a.assignmentRole), h("td.num", `${a.allocationPercent}%`), h("td", statusBadge(a.status)),
            h("td", caps.canManageStaffing && a.status !== "RELEASED" && h("span.row",
              a.status === "PLANNED" && h("button.small", { on: { click: () => mut("PATCH", `/assignments/${a.id}`, { status: "CONFIRMED" }, { ifMatch: true }) } }, "Confirm"),
              h("button.small", { on: { click: () => mut("PATCH", `/assignments/${a.id}`, { status: "RELEASED" }, { ifMatch: true }) } }, "Release")))));
        })))),
      caps.canManageStaffing && h("form.inline", { "data-testid": "assign-form", on: { submit: (e) => { e.preventDefault(); const d = formData(e.target); const tid = d.taskId; delete d.taskId; mut("POST", `/tasks/${tid}/assignments`, d, { success: "Assigned." }); } } },
        h("label", "Task", h("select", { name: "taskId" }, internalTasks.map((t) => h("option", { value: t.id }, t.title)))),
        h("label", "Person", h("select", { name: "userId" }, members.map((id) => h("option", { value: id }, userName(id))))),
        h("label", "Assignment role", h("input", { name: "assignmentRole", value: "DEVELOPER", required: true })),
        h("label", "Allocation %", h("input", { name: "allocationPercent", type: "number", min: 1, max: 100, value: 100 })),
        h("button", { type: "submit" }, "Assign"))),
    h("div.card", h("h3", { style: "margin-top:0" }, "Project role agreements"),
      h("p.small.muted", `Required roles: ${p.requiredRoles.join(", ") || "none"}. Role agreements are separate from task assignments; the named person must agree.`),
      h("div.table-wrap", h("table", { "data-testid": "role-agreements" }, h("thead", h("tr", h("th", "Role"), h("th", "Person"), h("th", "Responsibilities"), h("th", "Status"), h("th", ""))),
        h("tbody", p.roleAgreements.map((r) => h("tr", { "data-testid": "role-row" }, h("td", r.projectRole), h("td", userName(r.userId)), h("td.small", r.responsibilities),
          h("td", statusBadge(r.status), r.respondedAt && h("div.small.muted", `${userName(r.respondedBy)} · ${date(r.respondedAt)}`)),
          h("td.row",
            r.status === "PROPOSED" && r.userId === app.me.id && caps.editable && [
              h("button.small.primary", { "data-testid": "agree-role", on: { click: () => mut("POST", `/role-agreements/${r.id}/agree`, undefined, { success: "You agreed to the role." }) } }, "Agree"),
              h("button.small", { on: { click: () => mut("POST", `/role-agreements/${r.id}/decline`) } }, "Decline")],
            caps.canManageStaffing && (r.status === "PROPOSED" || r.status === "AGREED") && h("button.small", { on: { click: () => mut("POST", `/role-agreements/${r.id}/revoke`, { reason: "Changed by solution lead" }) } }, "Revoke"))))))),
      caps.editable && caps.permissions.includes("staffing.manage") && h("form.inline", { "data-testid": "role-form", on: { submit: (e) => { e.preventDefault(); mut("POST", "/role-agreements", formData(e.target), { success: "Role proposed." }); } } },
        h("label", "Project role", h("input", { name: "projectRole", value: p.requiredRoles[0] ?? "", required: true })),
        h("label", "Person", h("select", { name: "userId" }, members.map((id) => h("option", { value: id }, userName(id))))),
        h("label", "Responsibilities", h("input", { name: "responsibilities" })),
        h("button", { type: "submit" }, "Propose role"))));
}

// --- Vendors ---------------------------------------------------------------

function tabVendors(el, { proposal: p, capabilities: caps }) {
  const ext = p.tasks.filter((t) => t.deliveryType !== "INTERNAL");
  const vendors = app.users.filter((u) => u.kind === "EXTERNAL");
  if (ext.length === 0) return fill(el, h("p.muted", "No tasks are marked EXTERNAL or MIXED."));
  fill(el, 
    h("div.card", h("h3", { style: "margin-top:0" }, "Vendor access"),
      h("table", h("thead", h("tr", h("th", "Vendor user"), h("th", "Shared tasks"), h("th", "Granted"), h("th", ""))),
        h("tbody", p.vendorGrants.filter((g) => !g.revokedAt).map((g) => h("tr", h("td", userName(g.userId)), h("td.small", g.taskIds.map((id) => p.tasks.find((t) => t.id === id)?.title).join(", ")), h("td.small", date(g.grantedAt)),
          h("td", caps.canManageVendors && h("button.small", { on: { click: () => mut("DELETE", `/vendor-grants/${g.id}`) } }, "Revoke")))))),
      caps.canManageVendors && h("form.inline", { "data-testid": "grant-form", on: { submit: (e) => { e.preventDefault(); mut("POST", "/vendor-grants", formData(e.target), { success: "Access granted." }); } } },
        h("label", "Vendor user", h("select", { name: "userId" }, vendors.map((u) => h("option", { value: u.id }, `${u.displayName}`)))),
        h("label", "Tasks", h("select", { name: "taskIds", multiple: true, size: Math.min(4, ext.length) }, ext.map((t, i) => h("option", { value: t.id, selected: i === 0 ? true : undefined }, t.title)))),
        h("button", { type: "submit" }, "Grant access"))),
    ext.map((t) => {
      const offers = p.vendorOffers.filter((o) => o.taskId === t.id);
      const accepted = offers.find((o) => o.status === "ACCEPTED");
      return h("div.card", { "data-testid": "vendor-task" },
        h("div.row", h("h3", { style: "margin:0" }, t.title), h("span.badge", t.deliveryType), accepted ? h("span.badge.ok", "Committed") : t.mandatory ? h("span.badge.warn", "Commitment needed") : h("span.badge.muted", "optional")),
        offers.length === 0 ? h("p.small.muted", "No vendor offers yet.") : offers.map((o) => {
          const latest = o.revisions.at(-1);
          const vendorName = app.users.find((u) => u.vendorOrganizationId === o.vendorOrganizationId)?.displayName ?? o.vendorOrganizationId;
          return h("div.stack", { style: "border-top:1px solid var(--line);padding-top:.5rem;margin-top:.5rem", "data-testid": "vendor-offer" },
            h("div.row", h("strong", vendorName), h("span.badge", { class: o.status === "ACCEPTED" ? "ok" : o.status === "REJECTED" || o.status === "WITHDRAWN" ? "bad" : "warn", "data-testid": "vendor-offer-status" }, o.status),
              h("span", `Rev ${latest.revision}: `, h("strong", money(latest.priceMinor, latest.currency))), h("span.small.muted", `valid until ${date(latest.validUntil)}`)),
            h("div.small", latest.terms),
            o.acceptedAt && h("div.small.muted", `Accepted revision ${o.acceptedRevision} by ${userName(o.acceptedBy)} on ${date(o.acceptedAt)} — terms are locked.`),
            o.revisions.length > 1 && h("details.small", h("summary", `${o.revisions.length} revisions`), h("ul", o.revisions.map((r) => h("li", `Rev ${r.revision}: ${money(r.priceMinor, r.currency)} · ${r.terms} · ${date(r.submittedAt)}`)))),
            o.reviewNotes.length > 0 && h("ul.small.muted", o.reviewNotes.map((n) => h("li", `${n.action} by ${userName(n.by)}: ${n.note}`))),
            caps.canReviewVendorOffers && o.status === "SUBMITTED" && reviewControls(o));
        }));
    }));
}

function reviewControls(o) {
  const note = h("input", { placeholder: "Note to vendor", "data-testid": "vendor-review-note", style: "flex:1 1 200px" });
  return h("div.row", note,
    h("button.small.primary", { "data-testid": "accept-vendor-offer", on: { click: () => mut("POST", `/vendor-offers/${o.id}/accept`, { note: note.value }, { success: "Vendor offer accepted." }) } }, "Accept"),
    h("button.small", { "data-testid": "request-vendor-revision", on: { click: () => (note.value.trim() ? mut("POST", `/vendor-offers/${o.id}/request-revision`, { note: note.value }, { success: "Revision requested." }) : toast("Tell the vendor what to revise.")) } }, "Request revision"),
    h("button.small.danger", { on: { click: () => mut("POST", `/vendor-offers/${o.id}/reject`, { note: note.value }) } }, "Reject"));
}

// --- Readiness -------------------------------------------------------------

async function tabReadiness(el, view) {
  const { proposal: p, capabilities: caps } = view;
  const history = await api("GET", `/api/proposals/${p.id}/readiness`);
  const latest = history[0];
  const runBtn = caps.canRunReadiness && h("button.primary", { "data-testid": "run-readiness", on: { click: async () => {
    try {
      await api("POST", `/api/proposals/${p.id}/readiness`);
      await render();
    } catch (e) { showError(e); }
  } } }, "Run readiness check");
  const current = latest && latest.proposalContentVersion === p.contentVersion;
  fill(el, 
    h("div.row", runBtn, latest && h("span.small.muted", `Last checked ${date(latest.evaluatedAt)} by ${userName(latest.evaluatedBy)} against content version ${latest.proposalContentVersion}`), latest && !current && h("span.badge.warn", "Proposal changed since")),
    !latest ? h("p.muted", "No readiness check has been run yet.") : h("div", { style: "margin-top:1rem", "data-testid": "readiness-results" },
      h("p", latest.passed ? h("span.badge.ok", { "data-testid": "readiness-result" }, "All rules pass") : h("span.badge.bad", { "data-testid": "readiness-result" }, "Not ready")),
      latest.outcomes.map((o) => h("div.rule", { class: o.passed ? "pass" : "fail", "data-testid": `rule-${o.code}` },
        h("div.row", h("strong", o.passed ? "✓ " : "✗ ", o.title), h("code.small.muted", o.code)),
        !o.passed && h("ul", o.failures.map((f) => h("li", f.message, " ", f.entityType && h("a.small", { href: `#/p/${p.id}/${RULE_TAB[o.code] ?? ENTITY_TAB[f.entityType] ?? "overview"}` }, "Fix"))))))));
}

// --- Offers ----------------------------------------------------------------

async function tabOffers(el, { proposal: p }) {
  const versions = [...p.offerVersions].reverse();
  if (versions.length === 0) return fill(el, h("p.muted", "No offer versions yet. Request commercial approval to create one."));
  fill(el, ...versions.map((v) => {
    const t = v.snapshot.totals;
    const docUrl = `/api/proposals/${p.id}/offer-versions/${v.number}/document`;
    const open = async (download) => {
      try {
        const res = await fetch(docUrl + (download ? "?download=1" : ""), { headers: { authorization: `Bearer ${store.token}` } });
        if (!res.ok) throw new ApiError(res.status, (await res.json()).error);
        const blob = new Blob([await res.text()], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        if (download) {
          const a = h("a", { href: url, download: res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? "offer.html" });
          document.body.append(a);
          a.click();
          a.remove();
        } else window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (e) { showError(e); }
    };
    return h("div.card", { "data-testid": "offer-version" },
      h("div.row", h("h3", { style: "margin:0" }, `Version ${v.number}`), h("span.badge", { class: ["APPROVED", "ISSUED", "ACCEPTED"].includes(v.status) ? "ok" : ["REJECTED", "DECLINED"].includes(v.status) ? "bad" : v.status === "SUPERSEDED" ? "muted" : "warn", "data-testid": "offer-status" }, v.status),
        h("span.spacer"), h("span.total", money(t.totalMinor, t.currency))),
      h("dl.kv.small",
        h("dt", "Created"), h("dd", `${date(v.createdAt)} by ${userName(v.createdBy)}`),
        h("dt", "Valid until"), h("dd", date(v.snapshot.validUntil)),
        v.decision && [h("dt", v.decision.decision === "APPROVED" ? "Approved" : "Rejected"), h("dd", `${date(v.decision.at)} by ${userName(v.decision.by)}${v.decision.comment ? ` — “${v.decision.comment}”` : ""}`)],
        v.issuedAt && [h("dt", "Issued"), h("dd", { "data-testid": "issued-info" }, `${date(v.issuedAt)} by ${userName(v.issuedBy)}`)],
        v.customerResponse && [h("dt", "Customer"), h("dd", `${v.customerResponse.response} ${v.customerResponse.note ? `— ${v.customerResponse.note}` : ""}`)],
        v.document && [h("dt", "Document"), h("dd", h("code.small", v.document.sha256.slice(0, 16) + "…"))],
        h("dt", "Breakdown"), h("dd", `Internal ${money(t.labourMinor, t.currency)} + contingency ${money(t.contingencyMinor, t.currency)} + vendors ${money(t.vendorCostMinor, t.currency)} + markup ${money(t.vendorMarkupMinor, t.currency)}`)),
      h("div.row",
        h("button.small", { "data-testid": "view-document", on: { click: () => open(false) } }, v.document ? "View document" : "Preview"),
        v.document && h("button.small", { "data-testid": "download-document", on: { click: () => open(true) } }, "Download"),
        v.document && h("button.small", { "data-testid": "verify-document", on: { click: async () => {
          try {
            const r = await api("GET", `/api/proposals/${p.id}/offer-versions/${v.number}/verify`);
            toast(r.intact ? "Document integrity verified: stored and regenerated content match the recorded hash." : "Integrity check FAILED.", { info: r.intact });
          } catch (e) { showError(e); }
        } } }, "Verify integrity")),
      ["ISSUED", "ACCEPTED", "DECLINED"].includes(v.status) && h("p.small.muted", "Issued offer versions are immutable."));
  }));
}

// --- Audit -----------------------------------------------------------------

async function tabAudit(el, { proposal: p }) {
  const rows = await api("GET", `/api/proposals/${p.id}/audit`);
  fill(el, h("div.card.table-wrap", h("table", { "data-testid": "audit" },
    h("thead", h("tr", h("th", "When"), h("th", "Who"), h("th", "Action"), h("th", "Entity"), h("th", "Details"))),
    h("tbody", rows.map((a) => h("tr",
      h("td.small", date(a.at)), h("td", userName(a.actorUserId)), h("td", h("code.small", a.action)), h("td.small", `${a.entityType} ${a.entityId}`),
      h("td.small", h("details", h("summary", "Show"), h("pre", { style: "white-space:pre-wrap;max-width:420px" }, JSON.stringify({ before: a.before, after: a.after, metadata: a.metadata }, null, 2))))))))));
}

boot();
