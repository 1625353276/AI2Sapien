const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

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
  KnowledgeConcept,
  KnowledgeExtractionProgress,
  KnowledgeExtractionResult,
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
  startKnowledgeExtraction(courseId: string): Promise<{ extractionId: string }>;
  listKnowledgeConcepts(courseId: string): Promise<KnowledgeConcept[]>;
  getKnowledgeResult(extractionId: string): Promise<KnowledgeExtractionResult | null>;
  onKnowledgeProgress(listener: (progress: KnowledgeExtractionProgress) => void): () => void;
  onKnowledgeComplete(listener: (result: KnowledgeExtractionResult) => void): () => void;
}

const api: AI2SapienDesktopApi = {
  readRuntimeStatus: () => ipcRenderer.invoke("runtime:read-status"),
  startBrowserLogin: () => ipcRenderer.invoke("auth:start-browser-login"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  onRuntimeStatusChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: RuntimeStatusSnapshot): void => {
      listener(status);
    };
    ipcRenderer.on("runtime:status-changed", handler);
    return () => ipcRenderer.removeListener("runtime:status-changed", handler);
  },
  listCourses: () => ipcRenderer.invoke("library:list-courses"),
  createCourse: (input) => ipcRenderer.invoke("library:create-course", input),
  listDocuments: (courseId) => ipcRenderer.invoke("library:list-documents", courseId),
  importDocuments: (courseId) => ipcRenderer.invoke("library:import-documents", courseId),
  readDocument: (documentId) => ipcRenderer.invoke("library:read-document", documentId),
  readDocumentBinary: (documentId) => ipcRenderer.invoke("library:read-document-binary", documentId),
  onDocumentImportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DocumentImportProgress): void => {
      listener(progress);
    };
    ipcRenderer.on("library:import-progress", handler);
    return () => ipcRenderer.removeListener("library:import-progress", handler);
  },
  startExplanation: (request) => ipcRenderer.invoke("learning:start-explanation", request),
  followUpExplanation: (input) => ipcRenderer.invoke("learning:follow-up", input),
  cancelExplanation: (runId) => ipcRenderer.invoke("learning:cancel-explanation", runId),
  onExplanationUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: ExplanationUpdate): void => {
      listener(update);
    };
    ipcRenderer.on("learning:explanation-update", handler);
    return () => ipcRenderer.removeListener("learning:explanation-update", handler);
  },
  startPractice: (request) => ipcRenderer.invoke("learning:start-practice", request),
  startConceptPractice: (conceptId) => ipcRenderer.invoke("learning:start-concept-practice", conceptId),
  submitAnswer: (input) => ipcRenderer.invoke("learning:submit-answer", input),
  listMastery: (courseId) => ipcRenderer.invoke("learning:list-mastery", courseId),
  listConceptAttempts: (conceptId) => ipcRenderer.invoke("learning:list-concept-attempts", conceptId),
  onPracticeEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: PracticeUpdate): void => {
      listener(update);
    };
    ipcRenderer.on("learning:practice-event", handler);
    return () => ipcRenderer.removeListener("learning:practice-event", handler);
  },
  onPracticeQuestion: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, ready: PracticeQuestionReady): void => {
      listener(ready);
    };
    ipcRenderer.on("learning:practice-question", handler);
    return () => ipcRenderer.removeListener("learning:practice-question", handler);
  },
  onPracticeRemediation: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: RemediationUpdate): void => {
      listener(update);
    };
    ipcRenderer.on("learning:practice-remediation", handler);
    return () => ipcRenderer.removeListener("learning:practice-remediation", handler);
  },
  onPracticeResult: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, result: PracticeResult): void => {
      listener(result);
    };
    ipcRenderer.on("learning:practice-result", handler);
    return () => ipcRenderer.removeListener("learning:practice-result", handler);
  },
  getProviderState: () => ipcRenderer.invoke("provider:get-state"),
  saveProviderSettings: (input) => ipcRenderer.invoke("provider:save-settings", input),
  onProviderStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ProviderState): void => {
      listener(state);
    };
    ipcRenderer.on("provider:state-changed", handler);
    return () => ipcRenderer.removeListener("provider:state-changed", handler);
  },
  startKnowledgeExtraction: (courseId) => ipcRenderer.invoke("knowledge:start-analysis", courseId),
  listKnowledgeConcepts: (courseId) => ipcRenderer.invoke("knowledge:list-concepts", courseId),
  getKnowledgeResult: (extractionId) => ipcRenderer.invoke("knowledge:get-result", extractionId),
  onKnowledgeProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: KnowledgeExtractionProgress): void => {
      listener(progress);
    };
    ipcRenderer.on("knowledge:progress", handler);
    return () => ipcRenderer.removeListener("knowledge:progress", handler);
  },
  onKnowledgeComplete: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, result: KnowledgeExtractionResult): void => {
      listener(result);
    };
    ipcRenderer.on("knowledge:complete", handler);
    return () => ipcRenderer.removeListener("knowledge:complete", handler);
  },
};

contextBridge.exposeInMainWorld("ai2sapien", api);
