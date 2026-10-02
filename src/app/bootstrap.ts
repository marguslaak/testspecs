import { ClaudeEstimationProvider, type EstimationProvider, HeuristicEstimationProvider } from "../infra/ai.js";
import { Database } from "../infra/db.js";
import { HmacTokenVerifier, type IdentityClaims } from "../infra/identity.js";
import { buildServer } from "../http/server.js";
import { OfferService } from "./service.js";
import type { Clock } from "../domain/util.js";

/** Demo directory served by the development identity provider. */
export const DEMO_IDENTITIES: Omit<IdentityClaims, "issuer">[] = [
  { subject: "anna.am", displayName: "Anna Account", email: "anna@redfunction.ee", kind: "INTERNAL", roles: ["ACCOUNT_MANAGER"], vendorOrganizationId: null, vendorOrganizationName: null },
  { subject: "sam.lead", displayName: "Sam Lead", email: "sam@redfunction.ee", kind: "INTERNAL", roles: ["SOLUTION_LEAD", "DEVELOPER"], vendorOrganizationId: null, vendorOrganizationName: null },
  { subject: "dana.dev", displayName: "Dana Developer", email: "dana@redfunction.ee", kind: "INTERNAL", roles: ["DEVELOPER"], vendorOrganizationId: null, vendorOrganizationName: null },
  { subject: "carl.approver", displayName: "Carl Approver", email: "carl@redfunction.ee", kind: "INTERNAL", roles: ["COMMERCIAL_APPROVER"], vendorOrganizationId: null, vendorOrganizationName: null },
  { subject: "vera.vendor", displayName: "Vera Vendor", email: "vera@acme-design.example", kind: "EXTERNAL", roles: ["EXTERNAL_VENDOR"], vendorOrganizationId: "vorg_acme", vendorOrganizationName: "Acme Design OÜ" },
  { subject: "otto.other", displayName: "Otto Othervendor", email: "otto@globex.example", kind: "EXTERNAL", roles: ["EXTERNAL_VENDOR"], vendorOrganizationId: "vorg_globex", vendorOrganizationName: "Globex Partners" },
];

export interface AppConfig {
  dbPath: string;
  tokenSecret: string;
  tokenIssuer: string;
  devLogin: boolean;
  estimationProvider: EstimationProvider;
  clock?: Clock;
}

export function configFromEnv(env = process.env): AppConfig {
  const devLogin = env.DEV_LOGIN === "1" || (env.NODE_ENV !== "production" && env.DEV_LOGIN !== "0");
  const secret = env.AUTH_TOKEN_SECRET ?? (devLogin ? "dev-only-secret-change-me" : "");
  if (!secret) throw new Error("AUTH_TOKEN_SECRET must be set when the development login is disabled.");
  const provider = env.AI_ESTIMATION_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "heuristic");
  return {
    dbPath: env.DATABASE_PATH ?? "data/offers.db",
    tokenSecret: secret,
    tokenIssuer: env.AUTH_TOKEN_ISSUER ?? "https://idp.redfunction.dev",
    devLogin,
    estimationProvider: provider === "anthropic" ? new ClaudeEstimationProvider(env.AI_ESTIMATION_MODEL || undefined) : new HeuristicEstimationProvider(),
  };
}

export function createApp(config: AppConfig) {
  const store = new Database(config.dbPath);
  const service = new OfferService(store, { estimationProvider: config.estimationProvider, clock: config.clock });
  const verifier = new HmacTokenVerifier(config.tokenSecret, config.tokenIssuer);
  if (config.devLogin) {
    // Simulates directory sync so the demo users can be picked for teams before their first login.
    for (const id of DEMO_IDENTITIES) service.syncIdentity({ ...id, issuer: config.tokenIssuer });
  }
  const server = buildServer({
    service,
    verifier,
    devLogin: config.devLogin ? { identities: DEMO_IDENTITIES, sign: (c) => verifier.sign(c) } : undefined,
  });
  service.resumePendingAiRequests();
  return { store, service, verifier, server };
}

