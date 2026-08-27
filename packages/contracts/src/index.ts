export type Id = string;
export type IsoDateTime = string;

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AsyncAccepted {
  runId: Id;
  status: RunStatus;
  resourceId: Id | null;
}

export interface AuthSession {
  authenticated: boolean;
  authMode: string | null;
  planType: string | null;
  displayName?: string | null;
  email?: string | null;
  updatedAt: IsoDateTime;
}

export interface RateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: IsoDateTime | null;
}

export interface RateLimits {
  limitId: string;
  limitName: string | null;
  planType?: string | null;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  reachedType: string | null;
}

export interface RuntimeIssue {
  code: "CODEX_NOT_INSTALLED" | "CODEX_UNAVAILABLE" | "AUTH_REQUIRED" | "RATE_LIMIT_UNAVAILABLE";
  message: string;
  retryable: boolean;
}

export interface RuntimeStatusSnapshot {
  connected: boolean;
  auth: AuthSession;
  rateLimits: RateLimits[];
  checkedAt: IsoDateTime;
  issue: RuntimeIssue | null;
}

export interface ChatGptLoginLaunch {
  loginId: string;
  flow: "browser";
  authUrl: string;
}

export type RunEventType =
  | "run.status.changed"
  | "agent.message.delta"
  | "artifact.created"
  | "document.processing.progress"
  | "assessment.ready"
  | "evaluation.ready"
  | "approval.required"
  | "approval.resolved"
  | "auth.session.updated"
  | "rate_limit.updated"
  | "run.warning"
  | "run.failed";

export interface RunEvent<TPayload extends object = Record<string, unknown>> {
  eventId: Id;
  runId: Id;
  sequence: number;
  type: RunEventType;
  occurredAt: IsoDateTime;
  payload: TPayload;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionContext {
  documentId: Id;
  sourceVersion: string;
  pageNumber: number;
  selectedText: string;
  prefix: string;
  suffix: string;
  boundingBox?: BoundingBox | null;
}

export type ExplanationMode =
  | "simple"
  | "mechanism"
  | "compare"
  | "visual"
  | "socratic"
  | "example";

export interface ExplanationRequest {
  selection: SelectionContext;
  mode: ExplanationMode;
  language: string;
  includeVisual: boolean;
}
