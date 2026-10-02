/**
 * Domain model for the Offer Management Platform.
 *
 * The Proposal is the aggregate root: requirements, milestones, tasks, estimates,
 * AI estimate requests, assignments, role agreements, vendor access grants,
 * vendor offers and customer offer versions all live inside it and are saved
 * atomically with optimistic concurrency (`revision`).
 *
 * Readiness checks, audit records, users and generated documents are stored
 * separately so that recording them never changes the proposal itself.
 */

export type Iso = string;
/** Money is always held as integer minor units (e.g. cents) to avoid float drift. */
export type MinorUnits = number;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const USER_KINDS = ["INTERNAL", "EXTERNAL"] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** Minimum role set from the architecture (business roles). */
export const ROLES = [
  "ACCOUNT_MANAGER",
  "SOLUTION_LEAD",
  "DEVELOPER",
  "COMMERCIAL_APPROVER",
  "EXTERNAL_VENDOR",
] as const;
export type Role = (typeof ROLES)[number];

export const INTERNAL_PROPOSAL_ROLES = ["ACCOUNT_MANAGER", "SOLUTION_LEAD", "DEVELOPER", "COMMERCIAL_APPROVER"] as const;
export type ProposalRole = (typeof INTERNAL_PROPOSAL_ROLES)[number];

/**
 * A user is an identity reference to the Identity & Access Service. No passwords
 * or authentication secrets are stored here — only the IdP subject and the
 * claims we synchronise on login.
 */
export interface User {
  id: string;
  idpIssuer: string;
  idpSubject: string;
  kind: UserKind;
  displayName: string;
  email: string;
  /** Global roles granted by the identity provider. */
  roles: Role[];
  /** Set for EXTERNAL users: the vendor organisation they act for. */
  vendorOrganizationId: string | null;
  createdAt: Iso;
  lastSeenAt: Iso;
}

export interface VendorOrganization {
  id: string;
  name: string;
  createdAt: Iso;
}

/** Who performed an action. `system` is used for asynchronous jobs (AI estimation). */
export interface Actor {
  userId: string;
  kind: UserKind | "SYSTEM";
  roles: Role[];
  vendorOrganizationId: string | null;
  displayName: string;
}

export const SYSTEM_ACTOR: Actor = {
  userId: "system",
  kind: "SYSTEM",
  roles: [],
  vendorOrganizationId: null,
  displayName: "System",
};

export interface RecordMeta {
  createdAt: Iso;
  createdBy: string;
  updatedAt: Iso;
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const PROPOSAL_STATES = [
  "DRAFT",
  "REQUIREMENTS_READY",
  "ESTIMATION",
  "STAFFING",
  "VENDOR_COMMITMENTS",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "ISSUED",
  "ACCEPTED",
  "REJECTED",
  "CANCELLED",
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export interface StateChange {
  from: ProposalState;
  to: ProposalState;
  command: string;
  at: Iso;
  by: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Requirements and work breakdown
// ---------------------------------------------------------------------------

export const REQUIREMENT_PRIORITIES = ["MUST", "SHOULD", "COULD", "WONT"] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

export const REQUIREMENT_CLASSIFICATIONS = [
  "FUNCTIONAL",
  "NON_FUNCTIONAL",
  "CONSTRAINT",
  "ASSUMPTION",
  "ACCEPTANCE",
] as const;
export type RequirementClassification = (typeof REQUIREMENT_CLASSIFICATIONS)[number];

export const REQUIREMENT_STATUSES = ["DRAFT", "CONFIRMED", "DEFERRED", "REJECTED"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface Requirement extends RecordMeta {
  id: string;
  title: string;
  description: string;
  source: string;
  priority: RequirementPriority;
  classification: RequirementClassification;
  acceptanceNotes: string;
  status: RequirementStatus;
  order: number;
}

export interface Milestone extends RecordMeta {
  id: string;
  title: string;
  description: string;
  order: number;
}

export const DELIVERY_TYPES = ["INTERNAL", "EXTERNAL", "MIXED"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export interface Task extends RecordMeta {
  id: string;
  milestoneId: string;
  title: string;
  description: string;
  scope: string;
  deliveryType: DeliveryType;
  mandatory: boolean;
  /** Task ids this task depends on (must finish first). */
  dependsOn: string[];
  /** Requirement ids this task delivers (traceability). */
  requirementIds: string[];
  order: number;
  /** Incremented on every edit of the task; estimates record which revision they were made against. */
  revision: number;
  /** The estimate used for pricing this task (INTERNAL / MIXED). */
  selectedEstimateId: string | null;
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export const EFFORT_UNITS = ["HOURS", "DAYS"] as const;
export type EffortUnit = (typeof EFFORT_UNITS)[number];
export const HOURS_PER_DAY = 8;

export interface Estimate {
  id: string;
  taskId: string;
  source: "HUMAN" | "AI";
  /** Set for HUMAN estimates. */
  estimatorUserId: string | null;
  /** Set for AI estimates. */
  ai: { provider: string; model: string; requestId: string } | null;
  /** Task revision the estimate was made against. */
  taskRevision: number;
  effortMin: number;
  effortExpected: number;
  effortMax: number;
  unit: EffortUnit;
  assumptions: string[];
  rationale: string;
  /** 0..1 */
  confidence: number | null;
  createdAt: Iso;
  /** Estimate this one corrects. */
  supersedesId: string | null;
  supersededById: string | null;
  supersededAt: Iso | null;
}

export type AiRequestStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface AiEstimateRequest {
  id: string;
  taskId: string;
  taskRevision: number;
  status: AiRequestStatus;
  requestedBy: string;
  requestedAt: Iso;
  completedAt: Iso | null;
  estimateId: string | null;
  error: { code: string; message: string } | null;
}

// ---------------------------------------------------------------------------
// Staffing
// ---------------------------------------------------------------------------

export const ASSIGNMENT_STATUSES = ["PLANNED", "CONFIRMED", "RELEASED"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface TaskAssignment extends RecordMeta {
  id: string;
  taskId: string;
  userId: string;
  assignmentRole: string;
  /** Percent of the person's capacity, 1..100. */
  allocationPercent: number;
  status: AssignmentStatus;
}

export type RoleAgreementStatus = "PROPOSED" | "AGREED" | "DECLINED" | "REVOKED";

export interface RoleAgreement {
  id: string;
  userId: string;
  projectRole: string;
  responsibilities: string;
  status: RoleAgreementStatus;
  proposedBy: string;
  proposedAt: Iso;
  respondedBy: string | null;
  respondedAt: Iso | null;
  revokedBy: string | null;
  revokedAt: Iso | null;
  revokeReason: string | null;
}

export interface ProposalMember {
  userId: string;
  role: ProposalRole;
  addedBy: string;
  addedAt: Iso;
}

// ---------------------------------------------------------------------------
// Vendor collaboration
// ---------------------------------------------------------------------------

export interface VendorAccessGrant {
  id: string;
  userId: string;
  vendorOrganizationId: string;
  taskIds: string[];
  grantedBy: string;
  grantedAt: Iso;
  revokedBy: string | null;
  revokedAt: Iso | null;
}

export interface VendorOfferRevision {
  revision: number;
  priceMinor: MinorUnits;
  currency: string;
  terms: string;
  validUntil: Iso;
  /** The task scope the vendor bound themselves to when submitting. */
  scopeSnapshot: { title: string; scope: string; taskRevision: number };
  bindingConfirmed: true;
  submittedBy: string;
  submittedAt: Iso;
}

export type VendorOfferStatus = "SUBMITTED" | "REVISION_REQUESTED" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";

export interface VendorOffer {
  id: string;
  taskId: string;
  vendorOrganizationId: string;
  status: VendorOfferStatus;
  revisions: VendorOfferRevision[];
  /** Feedback from internal reviewers (revision request / rejection reasons). */
  reviewNotes: { at: Iso; by: string; action: "REVISION_REQUESTED" | "REJECTED" | "ACCEPTED"; note: string }[];
  acceptedRevision: number | null;
  acceptedAt: Iso | null;
  acceptedBy: string | null;
  createdAt: Iso;
}

// ---------------------------------------------------------------------------
// Commercial
// ---------------------------------------------------------------------------

export interface CommercialSettings {
  /** Default internal rate per hour in minor units. */
  hourlyRateMinor: MinorUnits;
  /** Rate overrides by assignment role, minor units per hour. */
  roleRatesMinor: Record<string, MinorUnits>;
  contingencyPercent: number;
  vendorMarkupPercent: number;
  validityDays: number;
  paymentTerms: string;
  terms: string;
  assumptions: string[];
}

export type OfferVersionStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "ISSUED"
  | "SUPERSEDED"
  | "ACCEPTED"
  | "DECLINED";

export interface OfferLine {
  taskId: string;
  milestoneId: string;
  title: string;
  scope: string;
  deliveryType: DeliveryType;
  optional: boolean;
  /** Internal effort in hours from the selected estimate (0 for EXTERNAL). */
  effortHours: number;
  hourlyRateMinor: MinorUnits;
  labourMinor: MinorUnits;
  estimateId: string | null;
  vendorOfferId: string | null;
  vendorCostMinor: MinorUnits;
  vendorPriceMinor: MinorUnits;
  totalMinor: MinorUnits;
}

export interface OfferTotals {
  currency: string;
  labourMinor: MinorUnits;
  vendorCostMinor: MinorUnits;
  vendorMarkupMinor: MinorUnits;
  contingencyMinor: MinorUnits;
  totalMinor: MinorUnits;
  optionalTotalMinor: MinorUnits;
}

/** Frozen, self-contained copy of everything the customer offer is based on. */
export interface OfferSnapshot {
  proposal: {
    id: string;
    title: string;
    customerReference: string;
    customerName: string;
    description: string;
    currency: string;
    contentVersion: number;
  };
  requirements: Pick<Requirement, "id" | "title" | "description" | "priority" | "classification" | "acceptanceNotes">[];
  milestones: { id: string; title: string; description: string; order: number }[];
  lines: OfferLine[];
  vendorCommitments: {
    vendorOfferId: string;
    taskId: string;
    vendorOrganizationId: string;
    vendorOrganizationName: string;
    revision: number;
    priceMinor: MinorUnits;
    currency: string;
    terms: string;
    acceptedAt: Iso;
    acceptedBy: string;
  }[];
  commercial: CommercialSettings;
  assumptions: string[];
  totals: OfferTotals;
  validUntil: Iso;
  generatedAt: Iso;
}

export interface OfferDocumentRef {
  ref: string;
  sha256: string;
  format: "text/html";
  generatedAt: Iso;
}

export interface OfferVersion {
  id: string;
  number: number;
  status: OfferVersionStatus;
  proposalContentVersion: number;
  readinessCheckId: string;
  snapshot: OfferSnapshot;
  createdAt: Iso;
  createdBy: string;
  decision: { decision: "APPROVED" | "REJECTED"; by: string; at: Iso; comment: string } | null;
  document: OfferDocumentRef | null;
  issuedAt: Iso | null;
  issuedBy: string | null;
  customerResponse: { response: "ACCEPTED" | "DECLINED"; recordedBy: string; at: Iso; note: string } | null;
  supersededAt: Iso | null;
}

// ---------------------------------------------------------------------------
// Proposal aggregate
// ---------------------------------------------------------------------------

export interface Proposal {
  id: string;
  /** Optimistic concurrency revision — incremented on every write. */
  revision: number;
  /** Incremented on every material content change (what readiness and offers are evaluated against). */
  contentVersion: number;
  state: ProposalState;
  /** Working state the proposal returns to if approval is rejected. */
  approvalReturnState: ProposalState | null;
  title: string;
  customerReference: string;
  customerName: string;
  description: string;
  currency: string;
  ownerId: string;
  members: ProposalMember[];
  /** Project roles that must be agreed before the offer is ready. */
  requiredRoles: string[];
  commercial: CommercialSettings;
  requirements: Requirement[];
  milestones: Milestone[];
  tasks: Task[];
  estimates: Estimate[];
  aiRequests: AiEstimateRequest[];
  assignments: TaskAssignment[];
  roleAgreements: RoleAgreement[];
  vendorGrants: VendorAccessGrant[];
  vendorOffers: VendorOffer[];
  offerVersions: OfferVersion[];
  history: StateChange[];
  createdAt: Iso;
  createdBy: string;
  updatedAt: Iso;
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface RuleFailure {
  message: string;
  entityType?: string;
  entityId?: string;
}

export interface RuleOutcome {
  code: string;
  title: string;
  passed: boolean;
  failures: RuleFailure[];
}

export interface ReadinessCheck {
  id: string;
  proposalId: string;
  proposalContentVersion: number;
  proposalRevision: number;
  passed: boolean;
  outcomes: RuleOutcome[];
  evaluatedBy: string;
  evaluatedAt: Iso;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  actorUserId: string;
  actorKind: Actor["kind"];
  action: string;
  entityType: string;
  entityId: string;
  proposalId: string | null;
  at: Iso;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
}

/** An audit entry produced by a domain command, completed by the application layer. */
export type AuditEvent = Omit<AuditRecord, "id" | "actorUserId" | "actorKind" | "at" | "proposalId"> & {
  proposalId?: string | null;
};
