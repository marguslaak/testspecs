import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { ROLES, type Role, USER_KINDS, type UserKind } from "../domain/types.js";

/**
 * Authentication is delegated to the Identity & Access Service. This module only
 * verifies tokens it issues and extracts identity claims; no passwords or
 * credentials are stored by the offer domain.
 *
 * `HmacTokenVerifier` verifies HS256 JWTs signed with a shared secret. A
 * production deployment would plug in an OIDC verifier (JWKS, RS256) behind
 * the same `TokenVerifier` interface.
 */
export interface IdentityClaims {
  issuer: string;
  subject: string;
  kind: UserKind;
  displayName: string;
  email: string;
  roles: Role[];
  vendorOrganizationId: string | null;
  vendorOrganizationName: string | null;
}

export interface TokenVerifier {
  verify(token: string): IdentityClaims;
}

const unauthenticated = (message: string) => new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED", message);

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export class HmacTokenVerifier implements TokenVerifier {
  constructor(
    private readonly secret: string,
    private readonly issuer: string,
    private readonly audience = "offer-management",
  ) {}

  /** Issues a token. Used by the development identity provider and tests only. */
  sign(claims: Omit<IdentityClaims, "issuer">, ttlSeconds = 8 * 3600): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: this.issuer,
        aud: this.audience,
        sub: claims.subject,
        iat: now,
        exp: now + ttlSeconds,
        name: claims.displayName,
        email: claims.email,
        kind: claims.kind,
        roles: claims.roles,
        vendor_org: claims.vendorOrganizationId,
        vendor_org_name: claims.vendorOrganizationName,
      }),
    );
    const sig = createHmac("sha256", this.secret).update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
  }

  verify(token: string): IdentityClaims {
    const parts = token.split(".");
    if (parts.length !== 3) throw unauthenticated("Malformed token.");
    const [h, p, s] = parts;
    const expected = createHmac("sha256", this.secret).update(`${h}.${p}`).digest();
    const given = Buffer.from(s, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthenticated("Invalid token signature.");
    let header: Record<string, unknown>;
    let c: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      c = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      throw unauthenticated("Malformed token.");
    }
    if (header.alg !== "HS256") throw unauthenticated("Unsupported token algorithm.");
    if (c.iss !== this.issuer || c.aud !== this.audience) throw unauthenticated("Token was not issued for this application.");
    if (typeof c.exp !== "number" || c.exp * 1000 < Date.now()) throw unauthenticated("Token has expired.");
    if (typeof c.sub !== "string" || !c.sub) throw unauthenticated("Token has no subject.");
    const kind = USER_KINDS.includes(c.kind as UserKind) ? (c.kind as UserKind) : null;
    if (!kind) throw unauthenticated("Token has no valid user kind.");
    const roles = Array.isArray(c.roles) ? (c.roles.filter((r) => ROLES.includes(r as Role)) as Role[]) : [];
    // Role claims are constrained by user kind: externals can only ever be vendors.
    const allowed = kind === "EXTERNAL" ? roles.filter((r) => r === "EXTERNAL_VENDOR") : roles.filter((r) => r !== "EXTERNAL_VENDOR");
    return {
      issuer: c.iss as string,
      subject: c.sub,
      kind,
      displayName: typeof c.name === "string" && c.name ? c.name : c.sub,
      email: typeof c.email === "string" ? c.email : "",
      roles: allowed,
      vendorOrganizationId: kind === "EXTERNAL" && typeof c.vendor_org === "string" ? c.vendor_org : null,
      vendorOrganizationName: typeof c.vendor_org_name === "string" ? c.vendor_org_name : null,
    };
  }
}
