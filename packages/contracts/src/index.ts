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

export interface CourseCreate {
  title: string;
  description: string;
  defaultLanguage: string;
}

export interface Course {
  id: Id;
  title: string;
  description: string;
  defaultLanguage: string;
  version: number;
  documentCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type DocumentStatus = "uploaded" | "processing" | "ready" | "failed";

export interface CourseDocument {
  id: Id;
  courseId: Id;
  displayName: string;
  mediaType: string;
  sourceVersion: string;
  status: DocumentStatus;
  pageCount: number | null;
  sizeBytes: number;
  warnings: string[];
  createdAt: IsoDateTime;
}

export interface DocumentPage {
  documentId: Id;
  sourceVersion: string;
  pageNumber: number;
  text: string;
  warnings: string[];
}

export interface DocumentDetail {
  document: CourseDocument;
  pages: DocumentPage[];
}

export interface DocumentBinary {
  documentId: Id;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface DocumentImportFailure {
  fileName: string;
  message: string;
}

export interface DocumentImportResult {
  imported: CourseDocument[];
  failed: DocumentImportFailure[];
}

export interface DocumentImportProgress {
  courseId: Id;
  current: number;
  total: number;
  fileName: string;
  phase: "copying" | "parsing" | "complete" | "failed";
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

export interface ExplanationAccepted {
  runId: Id;
  status: RunStatus;
  resourceId: Id | null;
  conversationId: Id;
}

export interface ExplanationUpdate {
  runId: Id;
  conversationId: Id;
  status: "running" | "succeeded" | "failed" | "cancelled";
  delta: string;
  message: string | null;
}

export interface ExplanationFollowUp {
  conversationId: Id;
  message: string;
  language: string;
}

export interface QuestionOption {
  id: Id;
  label: "A" | "B" | "C" | "D";
  text: string;
}

export type QuestionKind = "single_choice";

export interface QuestionVerification {
  verified: boolean;
  checks: {
    sourceSupport: boolean;
    singleBestAnswer: boolean;
    noAnswerLeak: boolean;
    completeStem: boolean;
  };
  notes: string;
  verifiedAt: IsoDateTime;
}

export interface Question {
  id: Id;
  courseId: Id;
  conceptId: Id;
  kind: QuestionKind;
  stem: string;
  options: QuestionOption[];
  correctOptionId: Id;
  rationale: string;
  evidenceRefs: string[];
  verification: QuestionVerification;
  createdAt: IsoDateTime;
}

export interface PracticeRequest {
  courseId: Id;
  selection: SelectionContext;
  topic: string;
  language: string;
  isRetest: boolean;
}

export type PracticePhase =
  | "creating"
  | "verifying"
  | "ready"
  | "evaluating"
  | "remediating"
  | "completed"
  | "failed";

export interface PracticeUpdate {
  practiceId: Id;
  phase: PracticePhase;
  message: string | null;
}

export interface PracticeQuestionReady {
  practiceId: Id;
  question: Question;
  isRetest: boolean;
}

export interface AttemptSubmission {
  practiceId: Id;
  optionId: Id;
  reasoning: string;
}

export interface ReasoningReview {
  reasoningCorrect: boolean;
  reason: string;
}

export interface AttemptEvaluation {
  attemptId: Id;
  practiceId: Id;
  questionId: Id;
  correct: boolean;
  correctOptionId: Id;
  reasoningReview: ReasoningReview;
  remediationRequired: boolean;
  occurredAt: IsoDateTime;
}

export interface RemediationUpdate {
  practiceId: Id;
  status: "running" | "succeeded" | "failed";
  delta: string;
  message: string | null;
}

export interface RemediationUnit {
  cause: string;
  howToNotice: string;
  explanation: string;
}

export type MasteryLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ConceptSource {
  documentId: Id;
  sourceVersion: string;
  pageNumber: number;
  selectedText: string;
  sourceLabel: string;
}

export interface ConceptMastery {
  conceptId: Id;
  topic: string;
  level: MasteryLevel;
  evidenceCount: number;
  lastAttemptAt: IsoDateTime | null;
  source: ConceptSource | null;
}

export interface AttemptSummary {
  attemptId: Id;
  correct: boolean;
  reasoningCorrect: boolean;
  isRetest: boolean;
  occurredAt: IsoDateTime;
  remediationCause: string | null;
}

export interface PracticeResult {
  practiceId: Id;
  evaluation: AttemptEvaluation | null;
  remediation: RemediationUnit | null;
  mastery: ConceptMastery;
}

export type ProviderId = "codex" | "openai_compatible" | "anthropic";

export interface OpenAiCompatibleSettings {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AnthropicSettings {
  apiKey: string;
  model: string;
}

export interface ProviderSettingsSave {
  activeProvider: ProviderId;
  openaiCompatible: OpenAiCompatibleSettings;
  anthropic: AnthropicSettings;
}

export interface ProviderSettingsView {
  activeProvider: ProviderId;
  openaiCompatible: {
    label: string;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
  anthropic: {
    model: string;
    apiKeySet: boolean;
  };
}

export interface ProviderStatusView {
  id: ProviderId;
  displayName: string;
  available: boolean;
  configured: boolean;
  detail: string | null;
}

/**
 * A single validated quote of course material supporting a concept. `documentId`
 * and `pageNumber` identify the concrete source page and `quote` is a short
 * excerpt that was verified to exist in that page's extracted text. The analyst
 * may propose many evidence entries, but only those that pass schema + document +
 * page + quote validation survive.
 */
export interface ConceptEvidence {
  documentId: Id;
  pageNumber: number;
  quote: string;
}

export interface KnowledgeConceptSource {
  documentId: Id;
  sourceVersion: string;
  pageNumber: number;
  sourceLabel: string;
  excerpt: string;
  /** Validated evidence (page + quote). Absent only for legacy v1 persisted concepts. */
  evidence?: ConceptEvidence[];
  evidenceRefs: string[];
}

export interface KnowledgeConcept {
  id: Id;
  courseId: Id;
  title: string;
  aliases: string[];
  summary: string;
  sources: KnowledgeConceptSource[];
  evidenceRefs: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type KnowledgeExtractionPhase =
  | "queued"
  | "chunking"
  | "analyzing"
  | "merging"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface KnowledgeExtractionProgress {
  courseId: Id;
  extractionId: Id;
  phase: KnowledgeExtractionPhase;
  current: number;
  total: number;
  message: string | null;
  occurredAt: IsoDateTime;
}

export interface KnowledgeAnalysisState {
  courseId: Id;
  totalBatchCount: number;
  completedBatchCount: number;
  pendingBatchCount: number;
  failedBatchCount: number;
  canResume: boolean;
  updatedAt: IsoDateTime | null;
}

export interface KnowledgeExtractionResult {
  extractionId: Id;
  courseId: Id;
  concepts: KnowledgeConcept[];
  /** Total number of page batches for the course in this run. */
  chunkCount: number;
  /** Batches whose concepts contributed this run (reused + newly analyzed successfully). */
  analyzedChunkCount: number;
  /** Batches that settled as failed this run. */
  failedChunkCount: number;
  /** Batches reused verbatim from a prior completed checkpoint. */
  reusedBatchCount?: number;
  startedAt: IsoDateTime;
  completedAt: IsoDateTime;
}
