import { api, ApiError, date, devLoginPicker, fill, formData, h, money, showError, store, toast } from "./common.js";

// External Vendor Portal: shows only the task scope shared with the vendor's
// organisation and that organisation's own offers.

const root = document.getElementById("app");
let me = null;

const header = () => h("header.top", h("h1", h("a", { href: "#/" }, "Vendor Portal")), h("span.spacer"),
  me && h("span.small", { "data-testid": "current-user" }, me.displayName),
  me && h("button", { on: { click: () => { store.token = null; me = null; renderLogin(); } } }, "Sign out"));

function renderLogin() {
  const picker = h("div");
  fill(root, h("header.top", h("h1", "Vendor Portal")), h("main", h("div.card.stack", h("h2", "Sign in"),
    h("p.muted", "Review the scope shared with your organisation and submit binding offers."), picker)));
  devLoginPicker(picker, { filter: (i) => i.kind === "EXTERNAL", onLogin: boot });
}

async function boot() {
  if (!store.token) return renderLogin();
  try {
    me = await api("GET", "/api/me");
    if (me.kind !== "EXTERNAL") { location.href = "/"; return; }
  } catch {
    store.token = null;
    return renderLogin();
  }
  render();
}

window.addEventListener("hashchange", () => render());

async function render() {
  const [, page, id] = (location.hash.replace(/^#/, "") || "/").split("/");
  try {
    if (page === "p" && id) await renderProposal(id);
    else await renderList();
  } catch (e) {
    showError(e);
    if (e instanceof ApiError && e.status === 403) location.hash = "#/";
  }
}

async function renderList() {
  const list = await api("GET", "/api/portal/proposals");
  fill(root, header(), h("main", h("h2", "Requests for offers"),
    list.length === 0 ? h("p.muted", "Nothing has been shared with you yet.") :
      h("div.grid", list.map((p) => h("a.card", { href: `#/p/${p.id}`, style: "text-decoration:none;color:inherit", "data-testid": "portal-proposal" },
        h("strong", p.title), h("div.small.muted", `${p.sharedTasks} task(s) shared with you`))))));
}

async function renderProposal(id) {
  const v = await api("GET", `/api/portal/proposals/${id}`);
  fill(root, header(), h("main",
    h("a", { href: "#/" }, "← All requests"),
    h("h2", v.title),
    !v.acceptingOffers && h("p.badge.warn", "This request is not accepting offers at the moment."),
    v.tasks.map((t) => {
      const offer = v.offers.filter((o) => o.taskId === t.id).find((o) => ["SUBMITTED", "REVISION_REQUESTED", "ACCEPTED"].includes(o.status));
      const history = v.offers.filter((o) => o.taskId === t.id);
      return h("div.card", { "data-testid": "portal-task" },
        h("div.row", h("h3", { style: "margin:0" }, t.title), h("span.badge", t.deliveryType), h("span.small.muted", t.milestone)),
        t.description && h("p", t.description),
        h("div", h("strong.small", "Scope"), h("p", { "data-testid": "portal-scope" }, t.scope || "—")),
        history.map((o) => h("div.stack", { style: "border-top:1px solid var(--line);padding-top:.5rem", "data-testid": "portal-offer" },
          h("div.row", h("strong", "Your offer"), h("span.badge", { class: o.status === "ACCEPTED" ? "ok" : o.status === "REVISION_REQUESTED" ? "warn" : o.status === "SUBMITTED" ? "" : "bad", "data-testid": "portal-offer-status" }, o.status)),
          h("ul.small", o.revisions.map((r) => h("li", `Revision ${r.revision}: ${money(r.priceMinor, r.currency)} — ${r.terms || "no terms"} — valid until ${date(r.validUntil)} (submitted ${date(r.submittedAt)})`))),
          o.reviewNotes.length > 0 && h("ul.small.muted", o.reviewNotes.map((n) => h("li", { "data-testid": "portal-review-note" }, `${n.action.replace("_", " ").toLowerCase()}: ${n.note}`))),
          o.status === "ACCEPTED" && h("p.small", `Accepted on ${date(o.acceptedAt)}. Revision ${o.acceptedRevision} is now binding and cannot be changed.`),
          ["SUBMITTED", "REVISION_REQUESTED"].includes(o.status) && h("button.small.danger", { on: { click: () => act(() => api("POST", `/api/portal/proposals/${id}/offers/${o.id}/withdraw`), "Offer withdrawn.") } }, "Withdraw"))),
        v.acceptingOffers && offer?.status !== "ACCEPTED" && offerForm(id, t, v.currency, offer));
    })));
}

function offerForm(proposalId, t, currency, open) {
  const validDefault = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  return h("details", { open: open?.status === "REVISION_REQUESTED" ? true : undefined },
    h("summary", open ? "Submit a revised offer" : "Submit an offer"),
    h("form.stack", { "data-testid": "portal-offer-form", on: { submit: (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const body = {
        priceMinor: Math.round((d.price ?? 0) * 100),
        currency: d.currency,
        terms: d.terms ?? "",
        validUntil: new Date(`${d.validUntil}T23:59:59Z`).toISOString(),
        confirmBinding: !!d.confirmBinding,
      };
      act(() => api("POST", `/api/portal/proposals/${proposalId}/tasks/${t.id}/offers`, body), "Offer submitted.");
    } } },
      h("div.grid",
        h("label", "Price", h("input", { name: "price", type: "number", min: 0.01, step: "0.01", required: true, "data-testid": "portal-price" })),
        h("label", "Currency", h("input", { name: "currency", value: currency, maxlength: 3, required: true })),
        h("label", "Valid until", h("input", { name: "validUntil", type: "date", value: validDefault, required: true }))),
      h("label", "Terms", h("textarea", { name: "terms", "data-testid": "portal-terms" })),
      h("label.inline", h("input", { type: "checkbox", name: "confirmBinding", "data-testid": "portal-confirm" }),
        "I confirm this offer is binding for the scope shown above and the stated terms."),
      h("button.primary", { type: "submit" }, "Submit binding offer")));
}

async function act(fn, success) {
  try {
    await fn();
    toast(success, { info: true });
    await render();
  } catch (e) { showError(e); }
}

boot();
