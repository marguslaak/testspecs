import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { OfferService } from "../app/service.js";
import { DomainError, validation } from "../domain/errors.js";
import type { LifecycleCommand } from "../domain/lifecycle.js";
import type { Actor } from "../domain/types.js";
import type { IdentityClaims, TokenVerifier } from "../infra/identity.js";
import { type RequestContext, Router } from "./router.js";

export interface ServerOptions {
  service: OfferService;
  verifier: TokenVerifier;
  /** Development identity provider: issues tokens for the demo directory. Never enable in production. */
  devLogin?: { identities: Omit<IdentityClaims, "issuer">[]; sign(claims: Omit<IdentityClaims, "issuer">): string };
  webRoot?: string;
}

const MAX_BODY = 1_000_000;
const RAW = Symbol("raw-response");
/** A handler result with an explicit status code. */
class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
const defaultWebRoot = fileURLToPath(new URL("../../web/", import.meta.url));

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON with Content-Type: application/json.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw validation("INVALID_JSON", "Request body is not valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(payload);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function buildServer(opts: ServerOptions): Server {
  const { service, verifier } = opts;
  const webRoot = opts.webRoot ?? defaultWebRoot;
  const r = new Router();

  const authenticate = (ctx: RequestContext): Actor => {
    const header = ctx.req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) throw new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED", "Sign in to continue.");
    const claims = verifier.verify(m[1].trim());
    return service.actorFor(service.syncIdentity(claims));
  };

  /** If-Match carries the proposal revision the client last saw. Required for edits of existing data. */
  const ifMatch = (ctx: RequestContext, required: boolean): number | undefined => {
    const raw = ctx.req.headers["if-match"];
    if (raw === undefined) {
      if (required) throw validation("IF_MATCH_REQUIRED", "Send the proposal revision you are editing in the If-Match header.");
      return undefined;
    }
    const n = Number(String(raw).replace(/^W\//, "").replace(/"/g, ""));
    if (!Number.isInteger(n) || n < 1) throw validation("IF_MATCH_INVALID", "If-Match must be a proposal revision number.");
    return n;
  };

  type Cmd = (actor: Actor, ctx: RequestContext) => { proposal: { revision: number }; result: unknown };
  /** Wraps a mutation: returns the new revision both in the body and as an ETag. */
  const mutation =
    (fn: Cmd, status = 200) =>
    (ctx: RequestContext) => {
      const actor = authenticate(ctx);
      const { proposal, result } = fn(actor, ctx);
      ctx.res.setHeader("etag", `"${proposal.revision}"`);
      return new Reply(status, { revision: proposal.revision, result: result ?? null });
    };

  const c = service.commands;
  const run = <T>(actor: Actor, ctx: RequestContext, required: boolean, fn: Parameters<OfferService["mutate"]>[3]) =>
    service.mutate(actor, ctx.params.id, ifMatch(ctx, required), fn) as { proposal: { revision: number }; result: T };

  // --- health & identity ----------------------------------------------------
  r.get("/api/health", () => ({ ok: true }));
  if (opts.devLogin) {
    const dev = opts.devLogin;
    r.get("/api/dev/identities", () =>
      dev.identities.map((i) => ({ subject: i.subject, displayName: i.displayName, kind: i.kind, roles: i.roles, vendorOrganizationName: i.vendorOrganizationName })),
    );
    r.post("/api/dev/login", (ctx) => {
      const subject = (ctx.body as Record<string, unknown>)?.subject;
      const identity = dev.identities.find((i) => i.subject === subject);
      if (!identity) throw validation("UNKNOWN_IDENTITY", "No such demo identity.");
      return { token: dev.sign(identity) };
    });
  }
  r.get("/api/me", (ctx) => {
    const actor = authenticate(ctx);
    const u = service.users.get(actor.userId)!;
    return { id: u.id, kind: u.kind, displayName: u.displayName, email: u.email, roles: u.roles, vendorOrganizationId: u.vendorOrganizationId };
  });
  r.get("/api/users", (ctx) => service.listUsers(authenticate(ctx)));
  r.get("/api/vendor-organizations", (ctx) => service.listVendorOrganizations(authenticate(ctx)));

  // --- proposals ------------------------------------------------------------
  r.get("/api/proposals", (ctx) => service.listProposals(authenticate(ctx)));
  r.post("/api/proposals", (ctx) => {
    const p = service.create(authenticate(ctx), ctx.body);
    ctx.res.setHeader("etag", `"${p.revision}"`);
    return new Reply(201, { revision: p.revision, result: { id: p.id } });
  });
  r.get("/api/proposals/:id", (ctx) => {
    const view = service.getProposal(authenticate(ctx), ctx.params.id);
    ctx.res.setHeader("etag", `"${view.proposal.revision}"`);
    return view;
  });
  r.patch("/api/proposals/:id", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.updateDetails(p, ctx.body, k))));
  r.patch("/api/proposals/:id/commercial", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.updateCommercial(p, ctx.body, k))));
  r.post("/api/proposals/:id/members", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.addMember(p, ctx.body, k)), 201));
  r.delete(
    "/api/proposals/:id/members/:userId/:role",
    mutation((a, ctx) =>
      run(a, ctx, true, (p, k) => c.removeMember(p, ctx.params.userId, ctx.params.role, ctx.query.get("releaseCommitments") === "true", k)),
    ),
  );

  // requirements
  r.post("/api/proposals/:id/requirements", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.addRequirement(p, ctx.body, k)), 201));
  r.post("/api/proposals/:id/requirements/order", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.reorderRequirements(p, ctx.body, k))));
  r.patch("/api/proposals/:id/requirements/:rid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.updateRequirement(p, ctx.params.rid, ctx.body, k))));
  r.delete("/api/proposals/:id/requirements/:rid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.deleteRequirement(p, ctx.params.rid, k))));

  // milestones & tasks
  r.post("/api/proposals/:id/milestones", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.addMilestone(p, ctx.body, k)), 201));
  r.post("/api/proposals/:id/milestones/order", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.reorderMilestones(p, ctx.body, k))));
  r.patch("/api/proposals/:id/milestones/:mid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.updateMilestone(p, ctx.params.mid, ctx.body, k))));
  r.delete("/api/proposals/:id/milestones/:mid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.deleteMilestone(p, ctx.params.mid, k))));
  r.post("/api/proposals/:id/milestones/:mid/tasks/order", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.reorderTasks(p, ctx.params.mid, ctx.body, k))));
  r.post("/api/proposals/:id/tasks", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.addTask(p, ctx.body, k)), 201));
  r.patch("/api/proposals/:id/tasks/:tid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.updateTask(p, ctx.params.tid, ctx.body, k))));
  r.delete("/api/proposals/:id/tasks/:tid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.deleteTask(p, ctx.params.tid, k))));

  // estimation
  r.get("/api/proposals/:id/tasks/:tid/estimates", (ctx) => service.estimates(authenticate(ctx), ctx.params.id, ctx.params.tid));
  r.post("/api/proposals/:id/tasks/:tid/estimates", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.submitEstimate(p, ctx.params.tid, ctx.body, k)), 201));
  r.post("/api/proposals/:id/tasks/:tid/ai-estimates", mutation((a, ctx) => service.requestAiEstimate(a, ctx.params.id, ctx.params.tid), 202));
  r.put("/api/proposals/:id/tasks/:tid/selected-estimate", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.selectEstimate(p, ctx.params.tid, ctx.body, k))));

  // staffing
  r.post("/api/proposals/:id/tasks/:tid/assignments", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.assign(p, ctx.params.tid, ctx.body, k)), 201));
  r.patch("/api/proposals/:id/assignments/:aid", mutation((a, ctx) => run(a, ctx, true, (p, k) => c.updateAssignment(p, ctx.params.aid, ctx.body, k))));
  r.post("/api/proposals/:id/role-agreements", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.proposeRole(p, ctx.body, k)), 201));
  r.post("/api/proposals/:id/role-agreements/:rid/agree", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.respondToRole(p, ctx.params.rid, "AGREED", k))));
  r.post("/api/proposals/:id/role-agreements/:rid/decline", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.respondToRole(p, ctx.params.rid, "DECLINED", k))));
  r.post("/api/proposals/:id/role-agreements/:rid/revoke", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.revokeRole(p, ctx.params.rid, ctx.body, k))));

  // vendors (internal side)
  r.post("/api/proposals/:id/vendor-grants", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.grantVendorAccess(p, ctx.body, k)), 201));
  r.delete("/api/proposals/:id/vendor-grants/:gid", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.revokeVendorAccess(p, ctx.params.gid, k))));
  r.post("/api/proposals/:id/vendor-offers/:vid/accept", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.acceptVendorOffer(p, ctx.params.vid, ctx.body, k))));
  r.post("/api/proposals/:id/vendor-offers/:vid/reject", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.reviewVendorOffer(p, ctx.params.vid, "REJECTED", ctx.body, k))));
  r.post(
    "/api/proposals/:id/vendor-offers/:vid/request-revision",
    mutation((a, ctx) => run(a, ctx, false, (p, k) => c.reviewVendorOffer(p, ctx.params.vid, "REVISION_REQUESTED", ctx.body, k))),
  );

  // readiness, lifecycle, offers, audit
  r.get("/api/proposals/:id/readiness", (ctx) => service.readinessHistory(authenticate(ctx), ctx.params.id));
  r.post("/api/proposals/:id/readiness", (ctx) => service.runReadinessCheck(authenticate(ctx), ctx.params.id));
  r.post(
    "/api/proposals/:id/commands/:command",
    mutation((a, ctx) => service.lifecycle(a, ctx.params.id, ifMatch(ctx, true), ctx.params.command as LifecycleCommand, ctx.body)),
  );
  r.get("/api/proposals/:id/offer-versions", (ctx) => service.offerVersions(authenticate(ctx), ctx.params.id));
  r.get("/api/proposals/:id/offer-versions/:n/document", (ctx) => {
    const doc = service.offerDocument(authenticate(ctx), ctx.params.id, Number(ctx.params.n));
    const disposition = ctx.query.get("download") === "1" ? "attachment" : "inline";
    ctx.res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `${disposition}; filename="${doc.filename}"`,
      "x-content-sha256": doc.sha256,
      "x-offer-document": doc.final ? "final" : "preview",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "cache-control": "no-store",
    });
    ctx.res.end(doc.content);
    return RAW;
  });
  r.get("/api/proposals/:id/offer-versions/:n/verify", (ctx) => service.verifyOfferDocument(authenticate(ctx), ctx.params.id, Number(ctx.params.n)));
  r.get("/api/proposals/:id/audit", (ctx) => service.auditTrail(authenticate(ctx), ctx.params.id));

  // --- vendor portal --------------------------------------------------------
  r.get("/api/portal/proposals", (ctx) => {
    const actor = authenticate(ctx);
    if (actor.kind !== "EXTERNAL") throw new DomainError("FORBIDDEN", "NOT_VENDOR", "The vendor portal is for external vendor users.");
    return service.listProposals(actor);
  });
  r.get("/api/portal/proposals/:id", (ctx) => service.vendorView(authenticate(ctx), ctx.params.id));
  r.post("/api/portal/proposals/:id/tasks/:tid/offers", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.submitVendorOffer(p, ctx.params.tid, ctx.body, k)), 201));
  r.post("/api/portal/proposals/:id/offers/:vid/withdraw", mutation((a, ctx) => run(a, ctx, false, (p, k) => c.withdrawVendorOffer(p, ctx.params.vid, k))));

  // --- static UI --------------------------------------------------------------
  const serveStatic = async (res: ServerResponse, path: string) => {
    const file = path === "/" ? "index.html" : path === "/portal" || path === "/portal/" ? "portal.html" : path.replace(/^\/+/, "");
    const full = normalize(join(webRoot, file));
    if (!full.startsWith(normalize(webRoot))) return false;
    try {
      const content = await readFile(full);
      res.writeHead(200, {
        "content-type": MIME[extname(full)] ?? "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (method === "GET" && (await serveStatic(res, url.pathname))) return;
        throw new HttpError(404, "NOT_FOUND", "Not found.");
      }
      const match = r.match(method, url.pathname);
      if (match === null) throw new HttpError(404, "ROUTE_NOT_FOUND", `No route for ${method} ${url.pathname}.`);
      if (match === "METHOD_NOT_ALLOWED") throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not supported here.`);
      const body = await readBody(req);
      const out = await match.handler({ req, res, params: match.params, query: url.searchParams, body });
      if (out === RAW) return;
      if (out instanceof Reply) sendJson(res, out.status, out.body);
      else sendJson(res, 200, out);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof DomainError) return sendJson(res, err.status, { error: err.toJSON() });
      if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      console.error(err);
      sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
    }
  });
}

