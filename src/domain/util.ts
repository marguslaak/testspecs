import { randomUUID } from "node:crypto";
import { validation } from "./errors.js";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

// ---------------------------------------------------------------------------
// Input validation helpers. Every failure carries a stable code and the field name.
// ---------------------------------------------------------------------------

type Input = Record<string, unknown>;

export function asObject(value: unknown, name = "body"): Input {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validation("INVALID_BODY", `${name} must be a JSON object.`);
  }
  return value as Input;
}

export function reqString(input: Input, field: string, opts: { max?: number; allowEmpty?: boolean } = {}): string {
  const v = input[field];
  if (typeof v !== "string") throw validation("FIELD_REQUIRED", `${field} is required and must be a string.`, { field });
  const trimmed = v.trim();
  if (!opts.allowEmpty && trimmed.length === 0) throw validation("FIELD_REQUIRED", `${field} must not be empty.`, { field });
  if (trimmed.length > (opts.max ?? 10_000)) throw validation("FIELD_TOO_LONG", `${field} is too long.`, { field });
  return trimmed;
}

export function optString(input: Input, field: string, fallback = "", max = 10_000): string {
  const v = input[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") throw validation("FIELD_INVALID", `${field} must be a string.`, { field });
  if (v.length > max) throw validation("FIELD_TOO_LONG", `${field} is too long.`, { field });
  return v.trim();
}

export function optEnum<T extends string>(input: Input, field: string, allowed: readonly T[], fallback: T): T {
  const v = input[field];
  if (v === undefined || v === null) return fallback;
  return reqEnumValue(v, field, allowed);
}

export function reqEnum<T extends string>(input: Input, field: string, allowed: readonly T[]): T {
  const v = input[field];
  if (v === undefined || v === null) throw validation("FIELD_REQUIRED", `${field} is required.`, { field });
  return reqEnumValue(v, field, allowed);
}

function reqEnumValue<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw validation("FIELD_INVALID", `${field} must be one of ${allowed.join(", ")}.`, { field, allowed });
  }
  return v as T;
}

export function optBool(input: Input, field: string, fallback: boolean): boolean {
  const v = input[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw validation("FIELD_INVALID", `${field} must be a boolean.`, { field });
  return v;
}

export function reqNumber(input: Input, field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const v = input[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw validation("FIELD_REQUIRED", `${field} is required and must be a number.`, { field });
  }
  return checkNumber(v, field, opts);
}

export function optNumber(
  input: Input,
  field: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const v = input[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) throw validation("FIELD_INVALID", `${field} must be a number.`, { field });
  return checkNumber(v, field, opts);
}

function checkNumber(v: number, field: string, opts: { min?: number; max?: number; integer?: boolean }): number {
  if (opts.integer && !Number.isInteger(v)) throw validation("FIELD_INVALID", `${field} must be an integer.`, { field });
  if (opts.min !== undefined && v < opts.min) throw validation("FIELD_OUT_OF_RANGE", `${field} must be at least ${opts.min}.`, { field });
  if (opts.max !== undefined && v > opts.max) throw validation("FIELD_OUT_OF_RANGE", `${field} must be at most ${opts.max}.`, { field });
  return v;
}

export function optStringArray(input: Input, field: string, fallback: string[] = []): string[] {
  const v = input[field];
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw validation("FIELD_INVALID", `${field} must be an array of strings.`, { field });
  }
  return (v as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function has(input: Input, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
}

export const CURRENCY_RE = /^[A-Z]{3}$/;

export function reqCurrency(input: Input, field: string): string {
  const v = reqString(input, field, { max: 3 }).toUpperCase();
  if (!CURRENCY_RE.test(v)) throw validation("FIELD_INVALID", `${field} must be an ISO 4217 currency code.`, { field });
  return v;
}

export function reqIsoDate(input: Input, field: string): string {
  const v = reqString(input, field, { max: 40 });
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw validation("FIELD_INVALID", `${field} must be an ISO 8601 date.`, { field });
  return d.toISOString();
}

/** Validates that `ids` is a permutation of `existing`. */
export function assertPermutation(ids: string[], existing: string[], what: string) {
  const a = [...ids].sort();
  const b = [...existing].sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i]) || new Set(ids).size !== ids.length) {
    throw validation("ORDER_MISMATCH", `The new ${what} order must list every existing ${what} exactly once.`);
  }
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
