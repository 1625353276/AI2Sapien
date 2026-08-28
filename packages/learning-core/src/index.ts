import type {
  AuthSession,
  ExplanationRequest,
  Id,
  RateLimits,
  RunEvent,
} from "@ai2sapien/contracts";

export * from "./knowledge-extraction.js";
export * from "./knowledge-engine.js";
export * from "./knowledge-persistence.js";

export type LoginFlow = "browser" | "device_code";

export interface BrowserLoginSession {
  loginId: string;
  flow: "browser";
  authUrl: string;
}

export interface DeviceCodeLoginSession {
  loginId: string;
  flow: "device_code";
  verificationUrl: string;
  userCode: string;
}

export type LoginSession = BrowserLoginSession | DeviceCodeLoginSession;

/**
 * Provider-neutral boundary owned by Learning Core.
 * Codex protocol types must not leak through this port.
 */
export interface AgentRuntimePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  readAuthSession(): Promise<AuthSession>;
  startLogin(flow: LoginFlow): Promise<LoginSession>;
  logout(): Promise<void>;
  readRateLimits(): Promise<RateLimits>;
  startExplanation(courseId: Id, request: ExplanationRequest): Promise<{ runId: Id; conversationId: Id }>;
  cancelRun(runId: Id): Promise<void>;
  subscribeRun(runId: Id, listener: (event: RunEvent) => void): () => void;
}

export interface ClockPort {
  now(): Date;
}

export interface IdPort {
  next(prefix: string): Id;
}

export const MASTERY_LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type MasteryLevel = (typeof MASTERY_LEVELS)[number];

export interface MasteryEvidence {
  evidenceId: Id;
  conceptId: Id;
  kind: "recognition" | "explanation" | "application" | "transfer" | "spaced_recall";
  correct: boolean;
  reasoningCorrect: boolean;
  occurredAt: Date;
}

/**
 * Deterministic baseline. AI may label evidence, but it may not directly set mastery.
 */
export * from "./practice-rules.js";

export function deriveMasteryLevel(evidence: readonly MasteryEvidence[]): MasteryLevel {
  const valid = evidence.filter((item) => item.correct && item.reasoningCorrect);

  if (valid.some((item) => item.kind === "spaced_recall")) return 5;
  if (valid.some((item) => item.kind === "transfer")) return 4;
  if (valid.some((item) => item.kind === "application")) return 3;
  if (valid.some((item) => item.kind === "explanation")) return 2;
  if (valid.some((item) => item.kind === "recognition")) return 1;
  return 0;
}
