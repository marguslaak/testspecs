// Shared helpers for the internal workspace and the vendor portal.

const TOKEN_KEY = "omp.token";

export const store = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(v) {
    try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  },
};

export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = error?.code ?? "ERROR";
    this.details = error?.details;
  }
}

export async function api(method, path, body, { ifMatch } = {}) {
  const headers = {};
  if (store.token) headers.authorization = `Bearer ${store.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (ifMatch !== undefined) headers["if-match"] = `"${ifMatch}"`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

/** Minimal DOM builder: h("div.card#id", {attrs, on: {click}}, ...children). Text is always escaped. */
export function h(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || "div");
  for (const part of rest) {
    if (part.startsWith(".")) el.classList.add(part.slice(1));
    else if (part.startsWith("#")) el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className += ` ${v}`;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

/** Replaces an element's children, flattening arrays and skipping null/false like h(). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function toast(message, { info = false, code } = {}) {
  let box = document.getElementById("toast");
  if (!box) document.body.append((box = h("div#toast", { role: "status", "aria-live": "polite" })));
  const msg = h("div.msg", { class: info ? "info" : "", "data-testid": info ? "toast-info" : "toast-error" }, message, code ? h("code", code) : null);
  box.append(msg);
  setTimeout(() => msg.remove(), info ? 2500 : 7000);
}

export function showError(err) {
  if (err instanceof ApiError) {
    const failures = err.details?.failures ?? err.details?.readiness?.outcomes?.filter((o) => !o.passed).flatMap((o) => o.failures) ?? [];
    const extra = failures.length ? ` ${failures.map((f) => f.message).join(" ")}` : "";
    toast(err.message + extra, { code: err.code });
  } else {
    console.error(err);
    toast("Something went wrong.");
  }
}

export const money = (minor, currency) => {
  if (minor === null || minor === undefined) return "—";
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100).toLocaleString("en").replace(/,/g, " ")}.${String(abs % 100).padStart(2, "0")} ${currency ?? ""}`.trim();
};

export const date = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");

/** Reads a form into an object; numeric inputs become numbers, checkboxes booleans, empty strings are dropped. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "number") { if (el.value !== "") out[el.name] = Number(el.value); }
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else if (el.value !== "") out[el.name] = el.value;
  }
  return out;
}

export async function devLoginPicker(container, { filter, onLogin }) {
  let identities = [];
  try { identities = await api("GET", "/api/dev/identities"); } catch { /* dev login disabled */ }
  const select = h("select", { "data-testid": "identity-picker", "aria-label": "Sign in as" },
    h("option", { value: "" }, "Sign in as…"),
    identities.filter(filter).map((i) => h("option", { value: i.subject }, `${i.displayName} — ${i.roles.join(", ")}${i.vendorOrganizationName ? ` (${i.vendorOrganizationName})` : ""}`)));
  select.addEventListener("change", async () => {
    if (!select.value) return;
    try {
      const { token } = await api("POST", "/api/dev/login", { subject: select.value });
      store.token = token;
      onLogin();
    } catch (e) { showError(e); }
  });
  container.replaceChildren(identities.length ? select : h("span.muted.small", "Sign in through your identity provider."));
}
