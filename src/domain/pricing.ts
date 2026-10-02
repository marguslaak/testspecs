import type { CommandContext } from "./context.js";
import { isCurrent, toHours } from "./estimation.js";
import { orderedTasks, sorted } from "./proposal.js";
import { activeAssignments } from "./staffing.js";
import type { OfferLine, OfferSnapshot, OfferTotals, Proposal, RuleFailure } from "./types.js";
import { acceptedOfferForTask, acceptedRevision } from "./vendor.js";

const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);

/**
 * Hourly rate for a task: the allocation-weighted average of role rates for its
 * active assignments, falling back to the proposal's default rate.
 */
function rateForTask(p: Proposal, taskId: string): number {
  const assignments = activeAssignments(p, taskId);
  let weight = 0;
  let sum = 0;
  for (const a of assignments) {
    const rate = p.commercial.roleRatesMinor[a.assignmentRole];
    if (rate === undefined) continue;
    weight += a.allocationPercent;
    sum += rate * a.allocationPercent;
  }
  return weight > 0 ? Math.round(sum / weight) : p.commercial.hourlyRateMinor;
}

export interface PricingResult {
  lines: (OfferLine & { priced: boolean })[];
  totals: OfferTotals;
  problems: RuleFailure[];
}

/**
 * Calculates the commercial offer from the selected estimates, rates and
 * accepted vendor commitments. Problems are returned rather than thrown so the
 * readiness gate can report them.
 */
export function calculatePricing(p: Proposal): PricingResult {
  const problems: RuleFailure[] = [];
  const c = p.commercial;
  if (!(c.hourlyRateMinor > 0)) problems.push({ message: "Set a default hourly rate greater than zero.", entityType: "Proposal", entityId: p.id });
  if (!(c.validityDays > 0)) problems.push({ message: "Set an offer validity period.", entityType: "Proposal", entityId: p.id });

  const lines: PricingResult["lines"] = [];
  for (const t of orderedTasks(p)) {
    let priced = true;
    let effortHours = 0;
    let labourMinor = 0;
    let estimateId: string | null = null;
    const hourlyRateMinor = t.deliveryType === "EXTERNAL" ? 0 : rateForTask(p, t.id);
    if (t.deliveryType !== "EXTERNAL") {
      const est = p.estimates.find((e) => e.id === t.selectedEstimateId && isCurrent(e));
      if (est) {
        estimateId = est.id;
        effortHours = toHours(est.effortExpected, est.unit);
        labourMinor = Math.round(effortHours * hourlyRateMinor);
      } else priced = false;
    }
    let vendorOfferId: string | null = null;
    let vendorCostMinor = 0;
    if (t.deliveryType !== "INTERNAL") {
      const offer = acceptedOfferForTask(p, t.id);
      const rev = offer && acceptedRevision(offer);
      if (offer && rev) {
        vendorOfferId = offer.id;
        vendorCostMinor = rev.priceMinor;
        if (rev.currency !== p.currency) {
          problems.push({ message: `Vendor commitment for "${t.title}" is in ${rev.currency}, not ${p.currency}.`, entityType: "VendorOffer", entityId: offer.id });
        }
      } else priced = false;
    }
    const vendorPriceMinor = vendorCostMinor + pct(vendorCostMinor, c.vendorMarkupPercent);
    lines.push({
      taskId: t.id,
      milestoneId: t.milestoneId,
      title: t.title,
      scope: t.scope,
      deliveryType: t.deliveryType,
      optional: !t.mandatory,
      effortHours,
      hourlyRateMinor,
      labourMinor,
      estimateId,
      vendorOfferId,
      vendorCostMinor,
      vendorPriceMinor,
      totalMinor: labourMinor + vendorPriceMinor,
      priced,
    });
  }

  const mandatory = lines.filter((l) => !l.optional);
  const labourMinor = mandatory.reduce((s, l) => s + l.labourMinor, 0);
  const vendorCostMinor = mandatory.reduce((s, l) => s + l.vendorCostMinor, 0);
  const vendorMarkupMinor = mandatory.reduce((s, l) => s + (l.vendorPriceMinor - l.vendorCostMinor), 0);
  const contingencyMinor = pct(labourMinor, c.contingencyPercent);
  const totals: OfferTotals = {
    currency: p.currency,
    labourMinor,
    vendorCostMinor,
    vendorMarkupMinor,
    contingencyMinor,
    totalMinor: labourMinor + contingencyMinor + vendorCostMinor + vendorMarkupMinor,
    optionalTotalMinor: lines.filter((l) => l.optional && l.priced).reduce((s, l) => s + l.totalMinor, 0),
  };
  if (mandatory.length > 0 && mandatory.every((l) => l.priced) && !(totals.totalMinor > 0)) {
    problems.push({ message: "The offer total must be greater than zero.", entityType: "Proposal", entityId: p.id });
  }
  return { lines, totals, problems };
}

/** Freezes the proposal into a self-contained offer snapshot. */
export function buildSnapshot(p: Proposal, ctx: Pick<CommandContext, "now" | "lookups">): OfferSnapshot {
  const { lines, totals } = calculatePricing(p);
  const validUntil = new Date(new Date(ctx.now).getTime() + p.commercial.validityDays * 86_400_000).toISOString();
  const requirementAssumptions = p.requirements
    .filter((r) => r.classification === "ASSUMPTION" && r.status === "CONFIRMED")
    .map((r) => r.title);
  const vendorCommitments = p.vendorOffers
    .filter((o) => o.status === "ACCEPTED")
    .map((o) => {
      const rev = acceptedRevision(o)!;
      return {
        vendorOfferId: o.id,
        taskId: o.taskId,
        vendorOrganizationId: o.vendorOrganizationId,
        vendorOrganizationName: ctx.lookups.getVendorOrganization(o.vendorOrganizationId)?.name ?? o.vendorOrganizationId,
        revision: rev.revision,
        priceMinor: rev.priceMinor,
        currency: rev.currency,
        terms: rev.terms,
        acceptedAt: o.acceptedAt!,
        acceptedBy: o.acceptedBy!,
      };
    });
  return {
    proposal: {
      id: p.id,
      title: p.title,
      customerReference: p.customerReference,
      customerName: p.customerName,
      description: p.description,
      currency: p.currency,
      contentVersion: p.contentVersion,
    },
    requirements: sorted(p.requirements)
      .filter((r) => r.status === "CONFIRMED")
      .map(({ id, title, description, priority, classification, acceptanceNotes }) => ({ id, title, description, priority, classification, acceptanceNotes })),
    milestones: sorted(p.milestones).map(({ id, title, description, order }) => ({ id, title, description, order })),
    lines: lines.map(({ priced: _priced, ...l }) => l),
    vendorCommitments,
    commercial: structuredClone(p.commercial),
    assumptions: [...p.commercial.assumptions, ...requirementAssumptions],
    totals,
    validUntil,
    generatedAt: ctx.now,
  };
}
