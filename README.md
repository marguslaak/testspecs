# Offer Management Platform

Red Function's environment for preparing customer offers. It covers requirements, the milestone and task breakdown, AI and developer estimates, staffing and project roles, external vendor commitments, a readiness gate, commercial approval and issuing versioned customer offers.

The architecture is in the Architentic space **redfunction/offer-management-platform**. This repository implements specs 2 and 4–11 from that space.

## Running it

Requires Node.js ≥ 22.13 (uses the built-in `node:sqlite`).

```bash
npm install
npm start            # http://localhost:3000 (workspace) and /portal (vendor portal)
npm test             # unit + API integration tests (vitest)
npm run test:e2e     # browser end-to-end tests (Playwright, Chromium)
npm run typecheck
```

Outside `NODE_ENV=production`, a **development identity provider** is enabled. The sign-in screen offers demo identities, one for each role:

| Identity | Roles |
|---|---|
| Anna Account | Account Manager |
| Sam Lead | Solution Lead, Developer |
| Dana Developer | Developer |
| Carl Approver | Commercial Approver |
| Vera Vendor (Acme Design OÜ) | External Vendor |
| Otto Othervendor (Globex Partners) | External Vendor |

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/offers.db` | SQLite file (`:memory:` for ephemeral) |
| `AUTH_TOKEN_SECRET` | dev secret when dev login is on | HS256 secret shared with the identity provider (required in production) |
| `AUTH_TOKEN_ISSUER` | `https://idp.redfunction.dev` | Expected `iss` claim |
| `DEV_LOGIN` | on unless `NODE_ENV=production` | `1`/`0` forces the development identity provider on or off |
| `AI_ESTIMATION_PROVIDER` | `anthropic` if `ANTHROPIC_API_KEY` is set, else `heuristic` | AI estimation engine |
| `AI_ESTIMATION_MODEL` | `claude-opus-5-5` | Model for the Claude provider |

## Architecture

```
src/domain/   pure domain model and commands (no I/O)
  types.ts        aggregate and value types
  lifecycle.ts    explicit state machine (transition table)
  workflow.ts     lifecycle commands, approval, issuance, allowed actions
  proposal.ts     proposal, members, requirements, milestones, tasks
  estimation.ts   human/AI estimates, superseding, comparison
  staffing.ts     task assignments and role agreements
  vendor.ts       vendor access grants, vendor offers, vendor projection
  readiness.ts    readiness rules
  pricing.ts      commercial calculation and offer snapshot
  document.ts     deterministic offer document rendering + SHA-256
  authz.ts        role × proposal/task-context authorization
src/infra/    SQLite store and repositories, token verification, AI providers
src/app/      application service (transactions, audit, async AI runner), bootstrap
src/http/     JSON API and static file server
web/          internal workspace (index.html, app.js) and vendor portal (portal.html, portal.js)
test/         vitest unit and API integration tests
e2e/          Playwright end-to-end scenarios
```

How the code maps to the architecture:

| Architecture element | Implementation |
|---|---|
| Proposal (business object) | `Proposal` aggregate, stored as one JSON document with optimistic `revision` |
| Customer Requirement, Milestone, Task | `domain/proposal.ts` |
| Estimate / AI Estimate / Developer Estimate | `Estimate` with `source: HUMAN \| AI`, `domain/estimation.ts` |
| AI Estimation Service / Engine | `AiEstimationRunner` (async queue) and `EstimationProvider` (`HeuristicEstimationProvider`, `ClaudeEstimationProvider`) |
| Task Assignment, Role Agreement | `domain/staffing.ts` |
| Vendor Offer, External Vendor Portal, Vendor Submission Service | `domain/vendor.ts`, `/api/portal/*`, `web/portal.*` |
| Offer Readiness Check, Validate Offer Readiness | `domain/readiness.ts`, `readiness_checks` table |
| Workflow & Approval Service, Approval Workflow Service | `domain/lifecycle.ts`, `domain/workflow.ts` |
| Customer Offer, Offer Generation / Offer Document Service | `OfferVersion` and snapshot (`pricing.ts`), `document.ts`, `documents` table |
| Identity & Access Service | delegated; `infra/identity.ts` verifies its tokens, and `users` holds identity references only |
| User / Internal User / External User | `users` table (`kind INTERNAL \| EXTERNAL`, IdP issuer + subject) |
| Offer Management Workspace | `web/index.html`, `web/app.js` |

### Key design decisions

- **Explicit lifecycle.** State is never written directly. `TRANSITIONS` lists each command's allowed source states and permission. Anything else is rejected with `INVALID_TRANSITION`, along with the allowed source states. Content can only be edited in the working phases (`DRAFT` … `VENDOR_COMMITMENTS`). From `READY_FOR_APPROVAL` onwards, writes fail with `PROPOSAL_LOCKED`.
- **Two version counters.** `revision` is incremented on every write and drives optimistic concurrency: the API requires `If-Match: <revision>` for edits of existing data, and every save is a compare-and-swap. `contentVersion` increases only on material changes. Readiness checks and offer versions record it.
- **Readiness gate.** There are eight rules, each with a stable code. Every failure points at the entity to fix. A dry check (`POST /readiness`) records its result without touching the proposal. `requestApproval` re-evaluates the rules against the current content version and refuses with `READINESS_FAILED` if any rule fails.
- **Offers are reproducible.** `requestApproval` freezes a self-contained snapshot into a numbered `OfferVersion`: scope, selected estimates, rates, vendor commitments, assumptions, terms, validity and totals. Approval renders the document deterministically from that snapshot and stores it with a SHA-256 hash. `GET …/offer-versions/:n/verify` regenerates the document and compares it with the stored hash. Issued versions never change, and a later revision always creates a new version that needs re-approval.
- **Evidence is immutable.** Estimates are never edited; a correction creates a new estimate that supersedes the old one. Accepted vendor offer revisions are locked. The audit log and the documents table are append-only, and SQLite triggers reject `UPDATE` and `DELETE` on them.
- **Authorization = role × context.** An internal user acts on a proposal only through a membership role that they also hold in the identity provider. Commercial Approvers may review any proposal, but not approve a version they requested themselves. External vendors get no proposal permissions at all. They act only through `VendorAccessGrant`s scoped to tasks, and only ever receive the vendor projection, which excludes estimates, margins, other tasks and other vendors.
- **Money** is held as integer minor units (cents).

### Proposal states

```
DRAFT → REQUIREMENTS_READY → ESTIMATION → STAFFING → VENDOR_COMMITMENTS → READY_FOR_APPROVAL → APPROVED → ISSUED → ACCEPTED | REJECTED
          (returnToPhase: back to any earlier working phase)        rejectOffer ↩    reopenForRevision ↩ (from READY_FOR_APPROVAL/APPROVED/ISSUED)
any non-terminal state → CANCELLED
```

`GET /api/proposals/:id` returns the caller's `capabilities.actions`, which the UI uses to show only the actions the caller can take.

## API overview

All responses are JSON. Errors have the shape `{ "error": { "code", "message", "details?" } }`. Mutations return `{ revision, result }` and an `ETag` header.

| | |
|---|---|
| `GET/POST /api/proposals`, `GET/PATCH /api/proposals/:id`, `PATCH …/commercial` | proposals |
| `POST/DELETE …/members[/:userId/:role]` | team (`?releaseCommitments=true`) |
| `POST …/requirements`, `PATCH/DELETE …/requirements/:rid`, `POST …/requirements/order` | requirements |
| `POST …/milestones`, `PATCH/DELETE …/milestones/:mid`, `POST …/milestones/order`, `POST …/milestones/:mid/tasks/order` | milestones |
| `POST …/tasks`, `PATCH/DELETE …/tasks/:tid` | tasks |
| `GET/POST …/tasks/:tid/estimates`, `POST …/tasks/:tid/ai-estimates`, `PUT …/tasks/:tid/selected-estimate` | estimation |
| `POST …/tasks/:tid/assignments`, `PATCH …/assignments/:aid` | assignments |
| `POST …/role-agreements`, `POST …/role-agreements/:rid/{agree,decline,revoke}` | role agreements |
| `POST/DELETE …/vendor-grants[/:gid]`, `POST …/vendor-offers/:vid/{accept,reject,request-revision}` | vendor management |
| `GET/POST …/readiness` | readiness history / dry check |
| `POST …/commands/:command` | lifecycle commands (`If-Match` required) |
| `GET …/offer-versions`, `GET …/offer-versions/:n/document[?download=1]`, `GET …/offer-versions/:n/verify` | offers |
| `GET …/audit` | audit trail |
| `GET /api/portal/proposals[/:id]`, `POST /api/portal/proposals/:id/tasks/:tid/offers`, `POST …/offers/:vid/withdraw` | vendor portal |

## Not in scope here

- **Production identity provider integration.** Tokens are HS256 JWTs. To use OIDC (JWKS / RS256), implement the `TokenVerifier` interface.
- **Persistence.** SQLite runs in a single process. The repository layer is the seam for moving to PostgreSQL.
- **Document format.** Offer documents are self-contained HTML. PDF rendering would plug in next to `renderOfferDocument`.
