/**
 * Domain errors carry a stable machine-readable code, a human-readable message
 * and the HTTP status the API layer should map them to.
 */
export type ErrorKind =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE";

const STATUS: Record<ErrorKind, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
};

export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[kind];
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export const validation = (code: string, message: string, details?: unknown) =>
  new DomainError("VALIDATION", code, message, details);
export const forbidden = (message = "You are not allowed to perform this action.", code = "FORBIDDEN") =>
  new DomainError("FORBIDDEN", code, message);
export const notFound = (entity: string, id: string) =>
  new DomainError("NOT_FOUND", `${entity.toUpperCase()}_NOT_FOUND`, `${entity} ${id} was not found.`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError("CONFLICT", code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new DomainError("UNPROCESSABLE", code, message, details);
