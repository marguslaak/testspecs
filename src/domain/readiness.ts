import { isCurrent } from "./estimation.js";
import { calculatePricing } from "./pricing.js";
import { orderedTasks, sorted } from "./proposal.js";
import { activeAssignments } from "./staffing.js";
import type { Proposal, ReadinessCheck, RuleFailure, RuleOutcome, Task } from "./types.js";
import { newId } from "./util.js";
import { acceptedOfferForTask, acceptedRevision } from "./vendor.js";

/**
 * Readiness gate. Each rule has a stable code and returns actionable failures
 * pointing at the entity to fix. Evaluation is pure: it never mutates the proposal.
 */
export interface ReadinessRule {
  code: string;
  title: string;
  evaluate(p: Proposal): RuleFailure[];
}

const needsInternalWork = (t: Task) => t.deliveryType !== "EXTERNAL";
const needsVendor = (t: Task) => t.deliveryType !== "INTERNAL";
const mandatoryTasks = (p: Proposal) => orderedTasks(p).filter((t) => t.mandatory);

export const RULES: ReadinessRule[] = [
  {
    code: "PROPOSAL_DATA_COMPLETE",
    title: "Proposal and customer data is complete",
    evaluate(p) {
      const f: RuleFailure[] = [];
      const self = { entityType: "Proposal", entityId: p.id };
      if (!p.title.trim()) f.push({ message: "Give the proposal a title.", ...self });
      if (!p.customerReference.trim()) f.push({ message: "Enter the customer reference.", ...self });
      if (!p.customerName.trim()) f.push({ message: "Enter the customer name.", ...self });
      if (!/^[A-Z]{3}$/.test(p.currency)) f.push({ message: "Set a valid offer currency.", ...self });
      if (!p.requirements.some((r) => r.status === "CONFIRMED")) f.push({ message: "Confirm at least one customer requirement.", ...self });
      for (const r of sorted(p.requirements).filter((r) => r.status === "DRAFT")) {
        f.push({ message: `Requirement "${r.title}" is still a draft — confirm, defer or reject it.`, entityType: "Requirement", entityId: r.id });
      }
      return f;
    },
  },
  {
    code: "WORK_BREAKDOWN_COMPLETE",
    title: "Work breakdown is complete",
    evaluate(p) {
      const f: RuleFailure[] = [];
      if (p.milestones.length === 0) f.push({ message: "Add at least one milestone.", entityType: "Proposal", entityId: p.id });
      for (const m of sorted(p.milestones)) {
        if (!p.tasks.some((t) => t.milestoneId === m.id)) f.push({ message: `Milestone "${m.title}" has no tasks.`, entityType: "Milestone", entityId: m.id });
      }
      if (p.milestones.length > 0 && mandatoryTasks(p).length === 0) f.push({ message: "Mark at least one task as mandatory scope.", entityType: "Proposal", entityId: p.id });
      for (const t of mandatoryTasks(p)) {
        if (!t.scope.trim()) f.push({ message: `Describe the scope of task "${t.title}".`, entityType: "Task", entityId: t.id });
      }
      return f;
    },
  },
  {
    code: "MANDATORY_TASKS_ESTIMATED",
    title: "Mandatory tasks have developer estimates for their current scope",
    evaluate(p) {
      return mandatoryTasks(p)
        .filter(needsInternalWork)
        .filter((t) => !p.estimates.some((e) => e.taskId === t.id && e.source === "HUMAN" && isCurrent(e) && e.taskRevision === t.revision))
        .map((t) => ({
          message: p.estimates.some((e) => e.taskId === t.id && e.source === "HUMAN" && isCurrent(e))
            ? `Task "${t.title}" changed after it was estimated — re-estimate it.`
            : `Task "${t.title}" needs at least one developer estimate (an AI estimate alone is not sufficient evidence).`,
          entityType: "Task",
          entityId: t.id,
        }));
    },
  },
  {
    code: "PRICING_ESTIMATE_SELECTED",
    title: "Each mandatory task has a pricing estimate selected",
    evaluate(p) {
      return mandatoryTasks(p)
        .filter(needsInternalWork)
        .filter((t) => !p.estimates.some((e) => e.id === t.selectedEstimateId && isCurrent(e)))
        .map((t) => ({ message: `Select which estimate prices task "${t.title}".`, entityType: "Task", entityId: t.id }));
    },
  },
  {
    code: "MANDATORY_TASKS_ASSIGNED",
    title: "Mandatory internal tasks are staffed",
    evaluate(p) {
      return mandatoryTasks(p)
        .filter(needsInternalWork)
        .filter((t) => activeAssignments(p, t.id).length === 0)
        .map((t) => ({ message: `Assign at least one person to task "${t.title}".`, entityType: "Task", entityId: t.id }));
    },
  },
  {
    code: "REQUIRED_ROLES_AGREED",
    title: "Required project roles are agreed",
    evaluate(p) {
      const f: RuleFailure[] = [];
      for (const role of p.requiredRoles) {
        const agreements = p.roleAgreements.filter((r) => r.projectRole === role);
        if (agreements.some((r) => r.status === "AGREED")) continue;
        const pending = agreements.find((r) => r.status === "PROPOSED");
        f.push(
          pending
            ? { message: `Project role ${role} is proposed but not yet agreed by the named person.`, entityType: "RoleAgreement", entityId: pending.id }
            : { message: `Project role ${role} is required — propose someone for it.`, entityType: "Proposal", entityId: p.id },
        );
      }
      return f;
    },
  },
  {
    code: "EXTERNAL_COMMITMENTS_ACCEPTED",
    title: "Externally sourced tasks have accepted vendor commitments",
    evaluate(p) {
      const f: RuleFailure[] = [];
      for (const t of mandatoryTasks(p).filter(needsVendor)) {
        const offer = acceptedOfferForTask(p, t.id);
        const rev = offer && acceptedRevision(offer);
        if (!offer || !rev) {
          f.push({ message: `Task "${t.title}" needs an accepted vendor offer.`, entityType: "Task", entityId: t.id });
        } else if (rev.scopeSnapshot.taskRevision !== t.revision) {
          f.push({ message: `The vendor commitment for "${t.title}" was made against an earlier scope.`, entityType: "VendorOffer", entityId: offer.id });
        } else if (rev.currency !== p.currency) {
          f.push({ message: `The vendor commitment for "${t.title}" is in ${rev.currency}, not ${p.currency}.`, entityType: "VendorOffer", entityId: offer.id });
        }
      }
      return f;
    },
  },
  {
    code: "COMMERCIAL_TOTALS_CALCULABLE",
    title: "Commercial totals can be calculated",
    evaluate(p) {
      return calculatePricing(p).problems;
    },
  },
];

export const RULE_CODES = RULES.map((r) => r.code);

export function evaluateReadiness(p: Proposal, evaluatedBy: string, now: string): ReadinessCheck {
  const outcomes: RuleOutcome[] = RULES.map((rule) => {
    const failures = rule.evaluate(p);
    return { code: rule.code, title: rule.title, passed: failures.length === 0, failures };
  });
  return {
    id: newId("ready"),
    proposalId: p.id,
    proposalContentVersion: p.contentVersion,
    proposalRevision: p.revision,
    passed: outcomes.every((o) => o.passed),
    outcomes,
    evaluatedBy,
    evaluatedAt: now,
  };
}
