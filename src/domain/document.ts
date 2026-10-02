import { createHash } from "node:crypto";
import type { OfferSnapshot } from "./types.js";

/**
 * Renders the customer-facing offer document. Rendering is a pure function of
 * the frozen snapshot and the version number, so a stored document can always
 * be regenerated and checked byte-for-byte against its integrity hash.
 */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${major}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

const date = (iso: string) => iso.slice(0, 10);

export function renderOfferDocument(snapshot: OfferSnapshot, versionNumber: number): string {
  const s = snapshot;
  const cur = s.proposal.currency;
  const money = (m: number) => formatMoney(m, cur);
  const milestoneSections = s.milestones
    .map((m) => {
      const lines = s.lines.filter((l) => l.milestoneId === m.id);
      const rows = lines
        .map(
          (l) =>
            `<tr><td>${esc(l.title)}${l.optional ? " <em>(optional)</em>" : ""}<div class="scope">${esc(l.scope)}</div></td>` +
            `<td class="num">${l.effortHours ? `${l.effortHours} h` : "—"}</td><td class="num">${money(l.totalMinor)}</td></tr>`,
        )
        .join("");
      return `<section><h3>${esc(m.title)}</h3>${m.description ? `<p>${esc(m.description)}</p>` : ""}<table><thead><tr><th>Deliverable</th><th>Effort</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    })
    .join("");
  const reqs = s.requirements.map((r) => `<li><strong>${esc(r.title)}</strong> (${r.priority})${r.description ? ` — ${esc(r.description)}` : ""}</li>`).join("");
  const assumptions = s.assumptions.map((a) => `<li>${esc(a)}</li>`).join("");
  const t = s.totals;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(s.proposal.title)} — Offer v${versionNumber}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#222}table{width:100%;border-collapse:collapse;margin:.5rem 0 1rem}th,td{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}.num{text-align:right;white-space:nowrap}.scope{color:#555;font-size:.9em}.totals td{border:none}.grand td{font-weight:bold;border-top:2px solid #222}</style>
</head><body>
<header><p>Red Function</p><h1>${esc(s.proposal.title)}</h1>
<p>Offer version ${versionNumber} · Customer: ${esc(s.proposal.customerName)} (${esc(s.proposal.customerReference)})</p>
<p>Offer date ${date(s.generatedAt)} · Valid until ${date(s.validUntil)}</p></header>
${s.proposal.description ? `<section><h2>Summary</h2><p>${esc(s.proposal.description)}</p></section>` : ""}
<section><h2>Requirements in scope</h2><ul>${reqs}</ul></section>
<section><h2>Scope and milestones</h2>${milestoneSections}</section>
<section><h2>Price</h2><table class="totals"><tbody>
<tr><td>Delivery services</td><td class="num">${money(t.labourMinor + t.contingencyMinor)}</td></tr>
<tr><td>Partner-delivered scope</td><td class="num">${money(t.vendorCostMinor + t.vendorMarkupMinor)}</td></tr>
<tr class="grand"><td>Total (excl. optional items)</td><td class="num">${money(t.totalMinor)}</td></tr>
${t.optionalTotalMinor ? `<tr><td>Optional items</td><td class="num">${money(t.optionalTotalMinor)}</td></tr>` : ""}
</tbody></table></section>
${assumptions ? `<section><h2>Assumptions</h2><ul>${assumptions}</ul></section>` : ""}
<section><h2>Commercial terms</h2><p>${esc(s.commercial.paymentTerms)}</p>${s.commercial.terms ? `<p>${esc(s.commercial.terms)}</p>` : ""}
<p>This offer is valid until ${date(s.validUntil)}.</p></section>
</body></html>
`;
}

export const sha256 = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
