import type {
  AuthSession,
  RateLimits,
  RateWindow,
} from "@ai2sapien/contracts";

import type {
  AccountReadResult,
  RateLimitsReadResult,
} from "./codex-app-server.js";

interface RawRateWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RawRateLimit {
  limitId?: unknown;
  limitName?: unknown;
  planType?: unknown;
  primary?: unknown;
  secondary?: unknown;
  rateLimitReachedType?: unknown;
  reachedType?: unknown;
}

export function mapAccountReadResult(
  result: AccountReadResult,
  now: Date = new Date(),
): AuthSession {
  const account = result.account;

  return {
    authenticated: account !== null,
    authMode: account?.type ?? null,
    planType: readOptionalString(account?.planType),
    email: readOptionalString(account?.email),
    updatedAt: now.toISOString(),
  };
}

export function mapRateLimitsReadResult(result: RateLimitsReadResult): RateLimits[] {
  const multiBucket = isRecord(result.rateLimitsByLimitId)
    ? Object.values(result.rateLimitsByLimitId)
    : [];
  const candidates = multiBucket.length > 0 ? multiBucket : [result.rateLimits];
  const mapped = candidates
    .filter(isRecord)
    .map((item, index) => mapRateLimit(item, index));

  return mapped.filter(
    (item, index) => mapped.findIndex((candidate) => candidate.limitId === item.limitId) === index,
  );
}

function mapRateLimit(raw: RawRateLimit, index: number): RateLimits {
  return {
    limitId: readOptionalString(raw.limitId) ?? `codex-${String(index + 1)}`,
    limitName: readOptionalString(raw.limitName),
    planType: readOptionalString(raw.planType),
    primary: mapRateWindow(raw.primary),
    secondary: mapRateWindow(raw.secondary),
    reachedType:
      readOptionalString(raw.rateLimitReachedType) ?? readOptionalString(raw.reachedType),
  };
}

function mapRateWindow(value: unknown): RateWindow | null {
  if (!isRecord(value)) return null;
  const raw = value as RawRateWindow;
  const usedPercent = readNumber(raw.usedPercent);
  if (usedPercent === null) return null;

  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowDurationMins: readNumber(raw.windowDurationMins),
    resetsAt: mapResetTime(raw.resetsAt),
  };
}

function mapResetTime(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
