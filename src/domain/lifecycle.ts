import { conflict } from "./errors.js";
import type { Permission } from "./authz.js";
import type { ProposalState } from "./types.js";

/**
 * The proposal lifecycle as an explicit transition table. State is never set
 * directly; each command names the states it may be issued from and the state
 * it produces. Anything not listed here is an invalid transition.
 */

/** States in which proposal content (scope, estimates, staffing, vendor work) may change. */
export const WORKING_STATES: readonly ProposalState[] = [
  "DRAFT",
  "REQUIREMENTS_READY",
  "ESTIMATION",
  "STAFFING",
  "VENDOR_COMMITMENTS",
];

/** Working states from which estimation-phase work (estimates, assignments, vendor offers) is allowed. */
export const ESTIMATION_STATES: readonly ProposalState[] = ["ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS"];

export const TERMINAL_STATES: readonly ProposalState[] = ["ACCEPTED", "REJECTED", "CANCELLED"];

export type LifecycleCommand =
  | "markRequirementsReady"
  | "startEstimation"
  | "startStaffing"
  | "startVendorCommitments"
  | "returnToPhase"
  | "requestApproval"
  | "approveOffer"
  | "rejectOffer"
  | "issueOffer"
  | "recordCustomerAcceptance"
  | "recordCustomerRejection"
  | "reopenForRevision"
  | "cancel";

export interface TransitionRule {
  from: readonly ProposalState[];
  /** Target state; `null` means it is computed by the command (returnToPhase, rejectOffer, reopenForRevision). */
  to: ProposalState | null;
  permission: Permission;
  label: string;
}

export const TRANSITIONS: Record<LifecycleCommand, TransitionRule> = {
  markRequirementsReady: { from: ["DRAFT"], to: "REQUIREMENTS_READY", permission: "lifecycle.advance", label: "Mark requirements ready" },
  startEstimation: { from: ["REQUIREMENTS_READY"], to: "ESTIMATION", permission: "lifecycle.advance", label: "Work breakdown complete — start estimation" },
  startStaffing: { from: ["ESTIMATION"], to: "STAFFING", permission: "lifecycle.advance", label: "Start staffing" },
  startVendorCommitments: { from: ["STAFFING"], to: "VENDOR_COMMITMENTS", permission: "lifecycle.advance", label: "Start vendor commitments" },
  returnToPhase: {
    from: ["REQUIREMENTS_READY", "ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS"],
    to: null,
    permission: "lifecycle.advance",
    label: "Return to an earlier phase",
  },
  requestApproval: {
    from: ["ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS"],
    to: "READY_FOR_APPROVAL",
    permission: "lifecycle.advance",
    label: "Request commercial approval",
  },
  approveOffer: { from: ["READY_FOR_APPROVAL"], to: "APPROVED", permission: "offer.decide", label: "Approve offer" },
  rejectOffer: { from: ["READY_FOR_APPROVAL"], to: null, permission: "offer.decide", label: "Reject offer (return for revision)" },
  issueOffer: { from: ["APPROVED"], to: "ISSUED", permission: "offer.issue", label: "Issue offer to customer" },
  recordCustomerAcceptance: { from: ["ISSUED"], to: "ACCEPTED", permission: "offer.issue", label: "Record customer acceptance" },
  recordCustomerRejection: { from: ["ISSUED"], to: "REJECTED", permission: "offer.issue", label: "Record customer rejection" },
  reopenForRevision: {
    from: ["READY_FOR_APPROVAL", "APPROVED", "ISSUED"],
    to: null,
    permission: "lifecycle.advance",
    label: "Reopen for revision (new offer version)",
  },
  cancel: {
    from: ["DRAFT", "REQUIREMENTS_READY", "ESTIMATION", "STAFFING", "VENDOR_COMMITMENTS", "READY_FOR_APPROVAL", "APPROVED", "ISSUED"],
    to: "CANCELLED",
    permission: "proposal.cancel",
    label: "Cancel proposal",
  },
};

export const LIFECYCLE_COMMANDS = Object.keys(TRANSITIONS) as LifecycleCommand[];

const PHASE_ORDER: readonly ProposalState[] = WORKING_STATES;

export function isWorkingState(s: ProposalState) {
  return WORKING_STATES.includes(s);
}

export function earlierPhases(s: ProposalState): ProposalState[] {
  const idx = PHASE_ORDER.indexOf(s);
  return idx <= 0 ? [] : PHASE_ORDER.slice(0, idx) as ProposalState[];
}

export function assertTransition(command: LifecycleCommand, from: ProposalState): TransitionRule {
  const rule = TRANSITIONS[command];
  if (!rule) throw conflict("UNKNOWN_COMMAND", `Unknown lifecycle command ${command}.`);
  if (!rule.from.includes(from)) {
    throw conflict(
      "INVALID_TRANSITION",
      `Cannot ${rule.label.toLowerCase()} while the proposal is ${from}.`,
      { command, from, allowedFrom: rule.from },
    );
  }
  return rule;
}

export function assertEditable(state: ProposalState, what = "Proposal content") {
  if (!isWorkingState(state)) {
    throw conflict(
      "PROPOSAL_LOCKED",
      `${what} cannot be changed while the proposal is ${state}. Reopen the proposal for revision first.`,
      { state },
    );
  }
}

export function assertEstimationPhase(state: ProposalState, what: string) {
  assertEditable(state, what);
  if (!ESTIMATION_STATES.includes(state)) {
    throw conflict("PHASE_NOT_STARTED", `${what} is possible once the proposal has reached estimation (currently ${state}).`, { state });
  }
}
