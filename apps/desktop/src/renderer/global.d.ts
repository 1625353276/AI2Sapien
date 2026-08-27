import type {
  AttemptEvaluation,
  AttemptSubmission,
  AttemptSummary,
  ChatGptLoginLaunch,
  ConceptMastery,
  Course,
  CourseCreate,
  CourseDocument,
  DocumentBinary,
  DocumentDetail,
  DocumentImportProgress,
  DocumentImportResult,
  ExplanationAccepted,
  ExplanationFollowUp,
  ExplanationRequest,
  ExplanationUpdate,
  PracticeQuestionReady,
  PracticeRequest,
  PracticeResult,
  PracticeUpdate,
  ProviderId,
  ProviderSettingsSave,
  ProviderSettingsView,
  ProviderStatusView,
  RemediationUpdate,
  RuntimeStatusSnapshot,
} from "@ai2sapien/contracts";

export interface ProviderState {
  settings: ProviderSettingsView;
  statuses: ProviderStatusView[];
  active: ProviderId;
}

interface AI2SapienDesktopApi {
  readRuntimeStatus(): Promise<RuntimeStatusSnapshot>;
  startBrowserLogin(): Promise<ChatGptLoginLaunch>;
  logout(): Promise<void>;
  onRuntimeStatusChanged(listener: (status: RuntimeStatusSnapshot) => void): () => void;
  listCourses(): Promise<Course[]>;
  createCourse(input: CourseCreate): Promise<Course>;
  listDocuments(courseId: string): Promise<CourseDocument[]>;
  importDocuments(courseId: string): Promise<DocumentImportResult>;
  readDocument(documentId: string): Promise<DocumentDetail>;
  readDocumentBinary(documentId: string): Promise<DocumentBinary>;
  onDocumentImportProgress(listener: (progress: DocumentImportProgress) => void): () => void;
  startExplanation(request: ExplanationRequest): Promise<ExplanationAccepted>;
  followUpExplanation(input: ExplanationFollowUp): Promise<ExplanationAccepted>;
  cancelExplanation(runId: string): Promise<void>;
  onExplanationUpdate(listener: (update: ExplanationUpdate) => void): () => void;
  startPractice(request: PracticeRequest): Promise<{ practiceId: string }>;
  startConceptPractice(conceptId: string): Promise<{ practiceId: string }>;
  submitAnswer(input: AttemptSubmission): Promise<AttemptEvaluation>;
  listMastery(courseId: string): Promise<ConceptMastery[]>;
  listConceptAttempts(conceptId: string): Promise<AttemptSummary[]>;
  onPracticeEvent(listener: (update: PracticeUpdate) => void): () => void;
  onPracticeQuestion(listener: (ready: PracticeQuestionReady) => void): () => void;
  onPracticeRemediation(listener: (update: RemediationUpdate) => void): () => void;
  onPracticeResult(listener: (result: PracticeResult) => void): () => void;
  getProviderState(): Promise<ProviderState>;
  saveProviderSettings(input: ProviderSettingsSave): Promise<ProviderState>;
  onProviderStateChanged(listener: (state: ProviderState) => void): () => void;
}

declare global {
  interface Window {
    ai2sapien: AI2SapienDesktopApi;
  }
}

export {};
