import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AttemptEvaluation,
  AttemptSummary,
  ConceptMastery,
  Course,
  CourseDocument,
  DocumentDetail,
  DocumentImportProgress,
  DocumentPage,
  ExplanationMode,
  ExplanationUpdate,
  KnowledgeAnalysisState,
  KnowledgeConcept,
  KnowledgeExtractionPhase,
  KnowledgeExtractionProgress,
  KnowledgeExtractionResult,
  PracticePhase,
  ProviderId,
  ProviderSettingsView,
  ProviderStatusView,
  Question,
  RateLimits,
  RateWindow,
  RemediationUnit,
  RuntimeStatusSnapshot,
} from "@ai2sapien/contracts";

type View = "home" | "library" | "map" | "practice";
type ReaderMode = "text" | "split" | "original";

interface SelectedSource {
  page: DocumentPage;
  text: string;
}

interface TutorState {
  runId: string;
  conversationId: string;
  sourceLabel: string;
  sourceText: string;
  answer: string;
  status: ExplanationUpdate["status"];
  message: string | null;
}

interface PracticeState {
  practiceId: string;
  courseId: string;
  topic: string;
  isRetest: boolean;
  phase: PracticePhase;
  phaseMessage: string | null;
  question: Question | null;
  selectedOptionId: string;
  reasoning: string;
  evaluation: AttemptEvaluation | null;
  remediationText: string;
  remediationStatus: "idle" | "running" | "done" | "failed";
  remediationUnit: RemediationUnit | null;
  mastery: ConceptMastery | null;
  failure: string | null;
}

interface ProviderUiState {
  settings: ProviderSettingsView;
  statuses: ProviderStatusView[];
  active: ProviderId;
}

const navigation = [
  { id: "home", label: "学习台", icon: "home", enabled: true },
  { id: "library", label: "资料库", icon: "library", enabled: true },
  { id: "map", label: "知识地图", icon: "map", enabled: true },
  { id: "practice", label: "练习与补救", icon: "practice", enabled: true },
  { id: "review", label: "复习队列", icon: "review", enabled: false },
] as const;

export function App() {
  const [view, setView] = useState<View>("home");
  const [status, setStatus] = useState<RuntimeStatusSnapshot | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [runtimeAction, setRuntimeAction] = useState<"login" | "logout" | "refresh" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<CourseDocument[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [documentDetail, setDocumentDetail] = useState<DocumentDetail | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [readerMode, setReaderMode] = useState<ReaderMode>("original");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [creatingCourse, setCreatingCourse] = useState(false);
  const [courseTitle, setCourseTitle] = useState("AI UX & Data Visualisation Design Principles");
  const [importProgress, setImportProgress] = useState<DocumentImportProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null);
  const [explanationMode, setExplanationMode] = useState<ExplanationMode>("mechanism");
  const [tutor, setTutor] = useState<TutorState | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [topicInput, setTopicInput] = useState("");
  const [practice, setPractice] = useState<PracticeState | null>(null);
  const [masteryByCourse, setMasteryByCourse] = useState<Record<string, ConceptMastery[]>>({});
  const [providerState, setProviderState] = useState<ProviderUiState | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState(() => ({
    activeProvider: "codex" as ProviderId,
    label: "OpenAI 兼容",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    anthropicApiKey: "",
    anthropicModel: "claude-3-5-sonnet-latest",
  }));
  const [savingProvider, setSavingProvider] = useState(false);
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [conceptAttempts, setConceptAttempts] = useState<AttemptSummary[]>([]);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const practiceCourseRef = useRef<string | null>(null);
  const startingPractice = practice?.phase === "creating" || practice?.phase === "verifying";
  const [conceptsByCourse, setConceptsByCourse] = useState<Record<string, KnowledgeConcept[]>>({});
  const [resultsByCourse, setResultsByCourse] = useState<Record<string, KnowledgeExtractionResult | undefined>>({});
  const [progressByCourse, setProgressByCourse] = useState<Record<string, KnowledgeExtractionProgress | undefined>>({});
  const [analyzingCourseIds, setAnalyzingCourseIds] = useState<string[]>([]);
  const [knowledgeLoadingCourseIds, setKnowledgeLoadingCourseIds] = useState<string[]>([]);
  const [pausingCourseIds, setPausingCourseIds] = useState<string[]>([]);
  const [analysisStateByCourse, setAnalysisStateByCourse] = useState<Record<string, KnowledgeAnalysisState | undefined>>({});
  const [targetPage, setTargetPage] = useState<{ documentId: string; pageNumber: number } | null>(null);

  const refreshMastery = useCallback(async (courseId: string) => {
    try {
      const next = await window.ai2sapien.listMastery(courseId);
      setMasteryByCourse((current) => ({ ...current, [courseId]: next }));
    } catch {
      // keep previous data
    }
  }, []);

  const refreshConceptAttempts = useCallback(async (conceptId: string | null) => {
    if (!conceptId) {
      setConceptAttempts([]);
      return;
    }
    try {
      setConceptAttempts(await window.ai2sapien.listConceptAttempts(conceptId));
    } catch {
      setConceptAttempts([]);
    }
  }, []);

  const refreshKnowledgeConcepts = useCallback(async (courseId: string) => {
    setKnowledgeLoadingCourseIds((current) => current.includes(courseId) ? current : [...current, courseId]);
    try {
      const next = await window.ai2sapien.listKnowledgeConcepts(courseId);
      setConceptsByCourse((current) => ({ ...current, [courseId]: next }));
    } catch {
      setConceptsByCourse((current) => ({ ...current, [courseId]: [] }));
    } finally {
      setKnowledgeLoadingCourseIds((current) => current.filter((id) => id !== courseId));
    }
  }, []);

  const refreshKnowledgeAnalysisState = useCallback(async (courseId: string, hasDocuments: boolean) => {
    if (!hasDocuments) {
      setAnalysisStateByCourse((current) => ({
        ...current,
        [courseId]: undefined,
      }));
      return;
    }
    try {
      const next = await window.ai2sapien.getKnowledgeAnalysisState(courseId);
      setAnalysisStateByCourse((current) => ({ ...current, [courseId]: next }));
    } catch {
      // keep previous
    }
  }, []);

  const pauseCourse = useCallback(async (courseId: string) => {
    if (!courseId || !analyzingCourseIds.includes(courseId)) return;
    if (pausingCourseIds.includes(courseId)) return;
    setPausingCourseIds((current) => (current.includes(courseId) ? current : [...current, courseId]));
    try {
      await window.ai2sapien.cancelKnowledgeExtraction(courseId);
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setPausingCourseIds((current) => current.filter((id) => id !== courseId));
    }
  }, [analyzingCourseIds, pausingCourseIds]);

  const analyzeCourse = useCallback(async (courseId: string) => {
    if (!courseId || analyzingCourseIds.includes(courseId)) return;
    setAnalyzingCourseIds((current) => (current.includes(courseId) ? current : [...current, courseId]));
    setResultsByCourse((current) => ({ ...current, [courseId]: undefined }));
    setProgressByCourse((current) => ({
      ...current,
      [courseId]: {
        courseId,
        extractionId: "",
        phase: "queued",
        current: 0,
        total: 0,
        message: null,
        occurredAt: new Date().toISOString(),
      },
    }));
    try {
      await window.ai2sapien.startKnowledgeExtraction(courseId);
    } catch (error) {
      setAnalyzingCourseIds((current) => current.filter((id) => id !== courseId));
      setNotice(friendlyError(error));
    }
  }, [analyzingCourseIds]);

  const openSourceInLibrary = useCallback((documentId: string, pageNumber: number) => {
    setTargetPage({ documentId, pageNumber });
    setSelectedDocumentId(documentId);
    setReaderMode("original");
    setSelectedSource(null);
    setView("library");
  }, []);

  useEffect(() => {
    practiceCourseRef.current = practice?.courseId ?? null;
  }, [practice]);

  useEffect(() => {
    void refreshConceptAttempts(selectedConceptId);
  }, [refreshConceptAttempts, selectedConceptId]);

  const refreshRuntime = useCallback(async (kind: "initial" | "refresh" = "refresh") => {
    if (kind === "refresh") setRuntimeAction("refresh");
    try {
      setStatus(await window.ai2sapien.readRuntimeStatus());
      setNotice(null);
    } catch {
      setNotice("无法读取本机运行状态，请稍后再试。");
    } finally {
      setLoadingStatus(false);
      setRuntimeAction(null);
    }
  }, []);

  const refreshCourses = useCallback(async () => {
    const nextCourses = await window.ai2sapien.listCourses();
    setCourses(nextCourses);
    setSelectedCourseId((current) => current ?? nextCourses[0]?.id ?? null);
    setLibraryLoading(false);
    const nextMastery: Record<string, ConceptMastery[]> = {};
    await Promise.all(nextCourses.map(async (course) => {
      try {
        nextMastery[course.id] = await window.ai2sapien.listMastery(course.id);
      } catch {
        nextMastery[course.id] = [];
      }
    }));
    setMasteryByCourse(nextMastery);
    return nextCourses;
  }, []);

  const refreshDocuments = useCallback(async (courseId: string) => {
    const nextDocuments = await window.ai2sapien.listDocuments(courseId);
    setDocuments(nextDocuments);
    setSelectedDocumentId((current) => {
      if (current && nextDocuments.some((document) => document.id === current)) return current;
      return nextDocuments[0]?.id ?? null;
    });
    return nextDocuments;
  }, []);

  useEffect(() => {
    void refreshRuntime("initial");
    void refreshCourses().catch((error: unknown) => {
      setLibraryLoading(false);
      setNotice(friendlyError(error));
    });
    const removeRuntimeListener = window.ai2sapien.onRuntimeStatusChanged((nextStatus) => {
      setStatus(nextStatus);
      setLoadingStatus(false);
    });
    const removeProgressListener = window.ai2sapien.onDocumentImportProgress(setImportProgress);
    const removeExplanationListener = window.ai2sapien.onExplanationUpdate((update) => {
      setTutor((current) => current?.runId === update.runId
        ? { ...current, answer: current.answer + update.delta, status: update.status, message: update.message }
        : current);
    });
    const removePracticeEvent = window.ai2sapien.onPracticeEvent((update) => {
      setPractice((current) => current?.practiceId === update.practiceId
        ? { ...current, phase: update.phase, phaseMessage: update.message }
        : current);
    });
    const removePracticeQuestion = window.ai2sapien.onPracticeQuestion((ready) => {
      setPractice((current) => current?.practiceId === ready.practiceId
        ? {
          ...current,
          question: ready.question,
          phase: "ready",
          phaseMessage: null,
          selectedOptionId: "",
          reasoning: "",
          evaluation: null,
          remediationText: "",
          remediationStatus: "idle",
          remediationUnit: null,
          failure: null,
        }
        : current);
    });
    const removePracticeRemediation = window.ai2sapien.onPracticeRemediation((update) => {
      setPractice((current) => current?.practiceId === update.practiceId
        ? {
          ...current,
          remediationText: current.remediationText + update.delta,
          remediationStatus: update.status === "failed" ? "failed" : current.remediationStatus === "idle" ? "running" : current.remediationStatus,
        }
        : current);
    });
    const removePracticeResult = window.ai2sapien.onPracticeResult((result) => {
      setPractice((current) => current?.practiceId === result.practiceId
        ? {
          ...current,
          evaluation: result.evaluation ?? current.evaluation,
          remediationUnit: result.remediation ?? current.remediationUnit,
          mastery: result.mastery,
          phase: "completed",
          phaseMessage: null,
          remediationStatus: result.remediation ? "done" : current.remediationStatus,
        }
        : current);
      const courseId = practiceCourseRef.current;
      if (courseId) void refreshMastery(courseId);
    });
    const removeProviderState = window.ai2sapien.onProviderStateChanged((state) => {
      setProviderState(state);
    });
    return () => {
      removeRuntimeListener();
      removeProgressListener();
      removeExplanationListener();
      removePracticeEvent();
      removePracticeQuestion();
      removePracticeRemediation();
      removePracticeResult();
      removeProviderState();
    };
  }, [refreshCourses, refreshMastery, refreshRuntime]);

  useEffect(() => {
    const removeKnowledgeProgress = window.ai2sapien.onKnowledgeProgress((progress) => {
      setProgressByCourse((current) => ({ ...current, [progress.courseId]: progress }));
      if (progress.phase === "failed" || progress.phase === "cancelled") {
        setAnalyzingCourseIds((current) => current.filter((id) => id !== progress.courseId));
        if (progress.phase === "cancelled") {
          void refreshKnowledgeAnalysisState(progress.courseId, true);
          void refreshKnowledgeConcepts(progress.courseId);
        } else {
          void refreshKnowledgeAnalysisState(progress.courseId, true);
          setNotice(progress.message ?? "课程资料分析失败，请重试。");
        }
      }
    });
    const removeKnowledgeComplete = window.ai2sapien.onKnowledgeComplete((result) => {
      setResultsByCourse((current) => ({ ...current, [result.courseId]: result }));
      setProgressByCourse((current) => ({ ...current, [result.courseId]: undefined }));
      setConceptsByCourse((current) => ({ ...current, [result.courseId]: result.concepts }));
      setKnowledgeLoadingCourseIds((current) => current.filter((id) => id !== result.courseId));
      setAnalyzingCourseIds((current) => current.filter((id) => id !== result.courseId));
      void refreshKnowledgeAnalysisState(result.courseId, true);
    });
    return () => {
      removeKnowledgeProgress();
      removeKnowledgeComplete();
    };
  }, [refreshKnowledgeAnalysisState, refreshKnowledgeConcepts]);

  useEffect(() => {
    void window.ai2sapien.getProviderState().then((state) => {
      setProviderState(state);
      setProviderDraft({
        activeProvider: state.active as ProviderId,
        label: state.settings.openaiCompatible.label,
        baseUrl: state.settings.openaiCompatible.baseUrl,
        apiKey: "",
        model: state.settings.openaiCompatible.model,
        anthropicApiKey: "",
        anthropicModel: state.settings.anthropic.model,
      });
    }).catch((error: unknown) => setNotice(friendlyError(error)));
  }, []);

  useEffect(() => {
    if (!selectedCourseId) {
      setDocuments([]);
      return;
    }
    void (async () => {
      try {
        const nextDocuments = await refreshDocuments(selectedCourseId);
        void refreshKnowledgeConcepts(selectedCourseId);
        void refreshKnowledgeAnalysisState(selectedCourseId, nextDocuments.length > 0);
      } catch (error: unknown) {
        setNotice(friendlyError(error));
      }
    })();
  }, [refreshDocuments, refreshKnowledgeAnalysisState, refreshKnowledgeConcepts, selectedCourseId]);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setSelectedSource(null);
    setTutor(null);
    if (!selectedDocumentId) {
      setDocumentDetail(null);
      setDocumentUrl(null);
      return;
    }
    setDocumentLoading(true);
    Promise.all([
      window.ai2sapien.readDocument(selectedDocumentId),
      window.ai2sapien.readDocumentBinary(selectedDocumentId),
    ]).then(([detail, binary]) => {
      if (cancelled) return;
      const copiedBytes = new Uint8Array(binary.bytes).slice();
      objectUrl = URL.createObjectURL(new Blob([copiedBytes.buffer], { type: binary.mediaType }));
      setDocumentDetail(detail);
      setDocumentUrl(objectUrl);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(friendlyError(error));
    }).finally(() => {
      if (!cancelled) setDocumentLoading(false);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedDocumentId]);

  const login = async () => {
    setRuntimeAction("login");
    try {
      await window.ai2sapien.startBrowserLogin();
      setNotice("已在浏览器打开 ChatGPT 登录页，完成后这里会自动更新。");
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setRuntimeAction(null);
    }
  };

  const logout = async () => {
    setRuntimeAction("logout");
    try {
      await window.ai2sapien.logout();
      await refreshRuntime("initial");
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setRuntimeAction(null);
    }
  };

  const createCourse = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const course = await window.ai2sapien.createCourse({
        title: courseTitle,
        description: "Week 1–3 学习资料与自适应练习",
        defaultLanguage: "zh-CN",
      });
      await refreshCourses();
      setSelectedCourseId(course.id);
      setCreatingCourse(false);
      setView("library");
      setNotice("课程已创建，现在可以导入 PDF 资料。");
    } catch (error) {
      setNotice(friendlyError(error));
    }
  };

  const importDocuments = async () => {
    if (!selectedCourseId) return;
    setImporting(true);
    setImportProgress(null);
    try {
      const result = await window.ai2sapien.importDocuments(selectedCourseId);
      const nextDocuments = await refreshDocuments(selectedCourseId);
      void refreshKnowledgeAnalysisState(selectedCourseId, nextDocuments.length > 0);
      await refreshCourses();
      if (result.imported.length > 0) {
        setResultsByCourse((current) => ({ ...current, [selectedCourseId]: undefined }));
      }
      if (result.imported[0]) setSelectedDocumentId(result.imported[0].id);
      if (result.imported.length > 0) {
        setNotice(`成功导入 ${String(result.imported.length)} 份 PDF${result.failed.length > 0 ? `，${String(result.failed.length)} 份失败` : ""}。`);
      } else if (result.failed.length > 0) {
        setNotice(result.failed.map((failure) => `${failure.fileName}：${failure.message}`).join("；"));
      } else if (nextDocuments.length === 0) {
        setNotice("未选择文件。");
      }
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const captureSelection = (page: DocumentPage, container: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
    if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return;
    const text = selection.toString().trim();
    if (text.length === 0) return;
    setSelectedSource({ page, text: text.slice(0, 4_000) });
  };

  const explainSelection = async () => {
    if (!selectedSource || !documentDetail) return;
    setTutor(null);
    try {
      const launch = await window.ai2sapien.startExplanation({
        selection: {
          documentId: selectedSource.page.documentId,
          sourceVersion: selectedSource.page.sourceVersion,
          pageNumber: selectedSource.page.pageNumber,
          selectedText: selectedSource.text,
          prefix: "",
          suffix: "",
        },
        mode: explanationMode,
        language: "zh-CN",
        includeVisual: explanationMode === "visual" || explanationMode === "mechanism",
      });
      setTutor({
        runId: launch.runId,
        conversationId: launch.conversationId,
        sourceLabel: `${documentDetail.document.displayName} · 第 ${String(selectedSource.page.pageNumber)} 页`,
        sourceText: selectedSource.text,
        answer: "",
        status: "running",
        message: null,
      });
    } catch (error) {
      setNotice(friendlyError(error));
    }
  };

  const submitFollowUp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tutor || followUp.trim().length === 0) return;
    try {
      const launch = await window.ai2sapien.followUpExplanation({
        conversationId: tutor.conversationId,
        message: followUp,
        language: "zh-CN",
      });
      setTutor({ ...tutor, runId: launch.runId, answer: "", status: "running", message: null });
      setFollowUp("");
    } catch (error) {
      setNotice(friendlyError(error));
    }
  };

  const beginPractice = async (isRetest = false) => {
    if (!selectedSource || !selectedCourseId) return;
    setPractice({
      practiceId: "",
      courseId: selectedCourseId,
      topic: topicInput,
      isRetest,
      phase: isRetest ? "creating" : "creating",
      phaseMessage: null,
      question: null,
      selectedOptionId: "",
      reasoning: "",
      evaluation: null,
      remediationText: "",
      remediationStatus: "idle",
      remediationUnit: null,
      mastery: null,
      failure: null,
    });
    try {
      const launch = await window.ai2sapien.startPractice({
        courseId: selectedCourseId,
        selection: {
          documentId: selectedSource.page.documentId,
          sourceVersion: selectedSource.page.sourceVersion,
          pageNumber: selectedSource.page.pageNumber,
          selectedText: selectedSource.text,
          prefix: "",
          suffix: "",
        },
        topic: topicInput || selectedSource.text.slice(0, 50),
        language: "zh-CN",
        isRetest,
      });
      setPractice((current) => (current?.courseId === selectedCourseId && current?.practiceId === "" && current?.topic === (topicInput || selectedSource.text.slice(0, 50))
        ? { ...current, practiceId: launch.practiceId }
        : current));
    } catch (error) {
      setPractice(null);
      setNotice(friendlyError(error));
    }
  };

  const submitPracticeAnswer = async () => {
    if (!practice?.question || !practice.selectedOptionId) return;
    const previous = practice;
    setPractice({ ...practice, phase: "evaluating", phaseMessage: null });
    try {
      await window.ai2sapien.submitAnswer({
        practiceId: practice.practiceId,
        optionId: practice.selectedOptionId,
        reasoning: practice.reasoning,
      });
    } catch (error) {
      setPractice({ ...previous, phase: "failed", failure: friendlyError(error) });
    }
  };

  const closePractice = () => {
    setPractice(null);
    setTopicInput("");
    void refreshConceptAttempts(selectedConceptId);
  };

  const beginConceptPractice = async (concept: ConceptMastery) => {
    if (!concept.source) {
      setNotice("该概念缺少来源上下文，请回到资料库重新划选文本。");
      return;
    }
    setPracticeBusy(true);
    setPractice({
      practiceId: "",
      courseId: selectedCourseId ?? "",
      topic: concept.topic,
      isRetest: concept.evidenceCount > 0,
      phase: "creating",
      phaseMessage: null,
      question: null,
      selectedOptionId: "",
      reasoning: "",
      evaluation: null,
      remediationText: "",
      remediationStatus: "idle",
      remediationUnit: null,
      mastery: null,
      failure: null,
    });
    try {
      const launch = await window.ai2sapien.startConceptPractice(concept.conceptId);
      setPractice((current) => (current && current.practiceId.length === 0 && current.courseId === (selectedCourseId ?? "")
        ? { ...current, practiceId: launch.practiceId }
        : current));
    } catch (error) {
      setPractice(null);
      setNotice(friendlyError(error));
    } finally {
      setPracticeBusy(false);
    }
  };

  const saveProviderSettings = async () => {
    setSavingProvider(true);
    try {
      const next = await window.ai2sapien.saveProviderSettings({
        activeProvider: providerDraft.activeProvider,
        openaiCompatible: {
          label: providerDraft.label,
          baseUrl: providerDraft.baseUrl,
          apiKey: providerDraft.apiKey,
          model: providerDraft.model,
        },
        anthropic: {
          apiKey: providerDraft.anthropicApiKey,
          model: providerDraft.anthropicModel,
        },
      });
      setProviderState(next);
      setProviderModalOpen(false);
      setNotice("模型提供者设置已保存。留空的 API Key 保持不变。");
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setSavingProvider(false);
    }
  };

  const selectedCourse = courses.find((course) => course.id === selectedCourseId) ?? null;
  const selectedConcept = (masteryByCourse[selectedCourseId ?? ""] ?? [])
    .find((concept) => concept.conceptId === selectedConceptId) ?? null;
  const selectedConcepts = conceptsByCourse[selectedCourseId ?? ""] ?? [];
  const selectedResult = resultsByCourse[selectedCourseId ?? ""] ?? null;
  const selectedProgress = progressByCourse[selectedCourseId ?? ""] ?? null;
  const selectedAnalysisState = analysisStateByCourse[selectedCourseId ?? ""] ?? null;
  const selectedPausing = selectedCourseId ? pausingCourseIds.includes(selectedCourseId) : false;
  const analyzing = selectedCourseId ? analyzingCourseIds.includes(selectedCourseId) : false;
  const knowledgeLoading = selectedCourseId ? knowledgeLoadingCourseIds.includes(selectedCourseId) : false;
  const analyzeDisabled = !selectedCourseId || (selectedCourse?.documentCount ?? 0) === 0 || analyzing;
  const appliedPage = targetPage && targetPage.documentId === selectedDocumentId ? targetPage.pageNumber : null;
  const displayDocumentUrl = documentUrl ? (appliedPage ? `${documentUrl}#page=${appliedPage}` : documentUrl) : null;
  const authenticated = status?.auth.authenticated ?? false;
  const plan = formatPlan(status?.auth.planType);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark" aria-hidden="true"><span>AI</span><i>2</i></div><div><strong>AI2Sapien</strong><small>人工智人</small></div></div>
        <nav aria-label="主要导航">
          <p className="nav-eyebrow">学习空间</p>
          {navigation.map((item) => (
            <button className={`nav-item ${view === item.id ? "active" : ""}`} disabled={!item.enabled} key={item.id} onClick={() => item.enabled && setView(item.id)} type="button">
              <NavIcon name={item.icon} /><span>{item.label}</span>{!item.enabled && <small>开发中</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note"><span className="note-orbit" aria-hidden="true" /><p>本地优先</p><small>原始 PDF 与学习记录默认留在这台电脑</small></div>
      </aside>

      <main className={view === "library" ? "library-main" : undefined}>
        <header className="topbar">
          <div><p className="eyebrow">{view === "home" ? "LEARNING WORKSPACE" : view === "library" ? "SOURCE-BASED LIBRARY" : view === "map" ? "KNOWLEDGE MAP" : "PRACTICE & REMEDIAL"}</p><h1>{view === "home" ? "开始今天的理解之旅。" : view === "practice" ? selectedCourse?.title ?? "练习与补救" : view === "map" ? selectedCourse?.title ?? "知识地图" : selectedCourse?.title ?? "资料库"}</h1></div>
          <div className="topbar-actions"><div className={`connection-pill ${authenticated ? "online" : "offline"}`}><span />{loadingStatus ? "正在连接" : authenticated ? `${plan} 已连接` : "尚未登录"}</div><button className="provider-button" type="button" onClick={() => setProviderModalOpen(true)}>模型 · {providerName(providerState?.active)}</button></div>
        </header>
        {notice && <div className="notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>×</button></div>}

        {view === "home" ? (
          <HomeView action={runtimeAction} courses={courses} loading={loadingStatus || libraryLoading} masteryByCourse={masteryByCourse} onCreateCourse={() => setCreatingCourse(true)} onLogin={() => void login()} onLogout={() => void logout()} onOpenCourse={(courseId) => { setSelectedCourseId(courseId); setView("library"); }} onRefresh={() => void refreshRuntime()} status={status} />
        ) : view === "practice" ? (
          <PracticeView attempts={conceptAttempts} busy={practiceBusy || startingPractice} concepts={masteryByCourse[selectedCourseId ?? ""] ?? []} courseId={selectedCourseId} practice={practice} selectedConcept={selectedConcept} setPractice={setPractice} onClosePractice={closePractice} onGoHome={() => setView("home")} onRetest={() => void (selectedConcept && beginConceptPractice(selectedConcept))} onSelectConcept={(concept) => { setSelectedConceptId(concept.conceptId); void beginConceptPractice(concept); }} onSubmitAnswer={() => void submitPracticeAnswer()} />
        ) : view === "map" ? (
          <MapView analyzeDisabled={analyzeDisabled} analyzing={analyzing} concepts={selectedConcepts} courses={courses} knowledgeLoading={knowledgeLoading} onCreateCourse={() => setCreatingCourse(true)} onOpenSource={openSourceInLibrary} onGoHome={() => setView("home")} onPause={() => void pauseCourse(selectedCourseId ?? "")} onSelectCourse={setSelectedCourseId} pausing={selectedPausing} progress={selectedProgress} result={selectedResult} selectedCourse={selectedCourse} selectedCourseId={selectedCourseId} analysisState={selectedAnalysisState} onAnalyze={() => void analyzeCourse(selectedCourseId ?? "")} />
        ) : (
          <LibraryView courses={courses} detail={documentDetail} documentLoading={documentLoading} documentUrl={displayDocumentUrl} documents={documents} importing={importing} importProgress={importProgress} mode={readerMode} onCaptureSelection={captureSelection} onCreateCourse={() => setCreatingCourse(true)} onImport={() => void importDocuments()} onModeChange={setReaderMode} onPause={() => void pauseCourse(selectedCourseId ?? "")} onSelectCourse={setSelectedCourseId} onSelectDocument={(documentId) => { setTargetPage(null); setSelectedDocumentId(documentId); }} selectedCourseId={selectedCourseId} selectedDocumentId={selectedDocumentId} selectedSource={selectedSource} onExplain={() => void explainSelection()} explanationMode={explanationMode} onExplanationModeChange={setExplanationMode} analyzing={analyzing} analyzeDisabled={analyzeDisabled} analysisResult={selectedResult} analysisProgress={selectedProgress} analysisState={selectedAnalysisState} pausing={selectedPausing} onAnalyze={() => void analyzeCourse(selectedCourseId ?? "")} />
        )}
      </main>

      {creatingCourse && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCreatingCourse(false)}>
          <form className="course-modal" onSubmit={(event) => void createCourse(event)} onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">NEW COURSE</p><h2>创建学习课程</h2><p>课程资料、来源页和后续学习记录都会按课程隔离保存。</p>
            <label>课程名称<input autoFocus maxLength={200} onChange={(event) => setCourseTitle(event.target.value)} value={courseTitle} /></label>
            <div className="modal-actions"><button type="button" onClick={() => setCreatingCourse(false)}>取消</button><button className="primary-button" type="submit">创建课程</button></div>
          </form>
        </div>
      )}
      {providerModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setProviderModalOpen(false)}>
          <div className="provider-modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">MODEL PROVIDERS</p><h2>AI 模型提供者</h2><p>划词解释、出题、验题与补救都会使用当前激活的提供者；账户与用量卡片始终对应 Codex 的 ChatGPT 登录状态。</p>
            <div className="provider-choices">
              {(["codex", "openai_compatible", "anthropic"] as const).map((id) => {
                const status = providerState?.statuses.find((item) => item.id === id);
                const active = providerDraft.activeProvider === id;
                return <label className={active ? "active" : ""} key={id}>
                  <input name="provider" type="radio" checked={active} onChange={() => setProviderDraft((current) => ({ ...current, activeProvider: id }))} />
                  <span className="provider-name">{providerName(id)}</span>
                  <span className="provider-detail">{status?.detail ?? ""}</span>
                  <span className={"provider-dot" + (active ? " checked" : "")} />
                </label>;
              })}
            </div>
            {providerDraft.activeProvider === "openai_compatible" && <div className="provider-fields">
              <label>显示名称<input maxLength={60} onChange={(event) => setProviderDraft({ ...providerDraft, label: event.target.value })} value={providerDraft.label} /></label>
              <label>Base URL（OpenAI API / Ollama / 其他兼容服务）<input maxLength={300} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} value={providerDraft.baseUrl} placeholder="https://api.openai.com/v1 或 http://127.0.0.1:11434/v1" /></label>
              <label>模型名<input maxLength={120} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })} value={providerDraft.model} placeholder="gpt-4o-mini / qwen3 / deepseek …" /></label>
              <label>API Key（本地服务可留空；留空保存 = 保持不变）<input type="password" maxLength={300} autoComplete="off" onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} value={providerDraft.apiKey} placeholder={providerState?.settings.openaiCompatible.apiKeySet === true ? "已配置（留空保持不变）" : "sk-…" } /></label>
            </div>}
            {providerDraft.activeProvider === "anthropic" && <div className="provider-fields">
              <label>API Key（留空保存 = 保持不变）<input type="password" maxLength={300} autoComplete="off" onChange={(event) => setProviderDraft({ ...providerDraft, anthropicApiKey: event.target.value })} value={providerDraft.anthropicApiKey} placeholder={providerState?.settings.anthropic.apiKeySet === true ? "已配置（留空保持不变）" : "sk-ant-…" } /></label>
              <label>模型名<input maxLength={120} onChange={(event) => setProviderDraft({ ...providerDraft, anthropicModel: event.target.value })} value={providerDraft.anthropicModel} /></label>
            </div>}
            <div className="modal-actions"><button type="button" onClick={() => setProviderModalOpen(false)}>取消</button><button className="primary-button" disabled={savingProvider} type="button" onClick={() => void saveProviderSettings()}>{savingProvider ? "正在保存…" : "保存并启用"}</button></div>
          </div>
        </div>
      )}
      {tutor && <TutorPanel followUp={followUp} practice={practice} startingPractice={startingPractice} topicInput={topicInput} onBeginPractice={() => void beginPractice()} onRetest={() => void beginPractice(true)} onClosePractice={closePractice} onPracticeQuestionChange={setPractice} onTopicInputChange={setTopicInput} onSubmitPracticeAnswer={() => void submitPracticeAnswer()} onCancel={() => void window.ai2sapien.cancelExplanation(tutor.runId)} onClose={() => setTutor(null)} onFollowUpChange={setFollowUp} onSubmitFollowUp={submitFollowUp} tutor={tutor} />}
    </div>
  );
}

function PracticeView({ courseId, concepts, attempts, practice, busy, selectedConcept, setPractice, onSelectConcept, onRetest, onSubmitAnswer, onClosePractice, onGoHome }: { courseId: string | null; concepts: ConceptMastery[]; attempts: AttemptSummary[]; practice: PracticeState | null; busy: boolean; selectedConcept: ConceptMastery | null; setPractice: React.Dispatch<React.SetStateAction<PracticeState | null>>; onSelectConcept: (concept: ConceptMastery) => void; onRetest: () => void; onSubmitAnswer: () => void; onClosePractice: () => void; onGoHome: () => void }) {
  return <section className="practice-workspace">
    <aside className="practice-rail">
      <div className="rail-section">
        <div className="rail-heading"><span>概念</span><small>{String(concepts.length)}</small></div>
        <div className="concept-list">
          {concepts.length === 0 && <p className="empty-practice-note">还没有概念。先在资料库划选文本、完成一次解释与练习，概念会自动出现在这里。</p>}
          {concepts.map((concept) => <button className={practice ? "disabled" : ""} disabled={busy && !practice} key={concept.conceptId} onClick={() => onSelectConcept(concept)} type="button">
            <span className="concept-lv">Lv.{String(concept.level)}</span>
            <span className="concept-meta"><strong>{concept.topic}</strong><small>{String(concept.evidenceCount)} 次练习{concept.source ? ` · ${concept.source.sourceLabel}` : ""}</small></span>
          </button>)}
        </div>
      </div>
    </aside>
    <div className="practice-stage">
      {!courseId ? <EmptyReader title="先选择一门课程" text="课程用于组织概念、练习与补救记录。" action="回到学习台" onAction={onGoHome} /> : practice ? (
        <div className="practice-card">
          <div className="practice-heading"><span>练习{practice.isRetest ? " · 复测" : ""}</span>{practice.phase !== "completed" && practice.phase !== "ready" && <span className="phase-badge">{practice.phaseMessage ?? phaseLabel(practice.phase)}</span>}</div>
          {practice.phase === "failed" && practice.failure && <div className="tutor-error">{practice.failure}</div>}
          {practice.question && (practice.phase === "ready" || practice.phase === "evaluating") && <>
            <p className="question-stem">{practice.question.stem}</p>
            <div className="quiz-options">{practice.question.options.map((option) => <label className={practice.selectedOptionId === option.id ? "selected" : ""} key={option.id}><input disabled={practice.phase === "evaluating"} name="quiz-option" type="radio" checked={practice.selectedOptionId === option.id} onChange={() => setPractice((current) => current ? { ...current, selectedOptionId: option.id } : current)} /><span className="option-label">{option.label}</span><span>{option.text}</span></label>)}</div>
            <label className="reasoning-field">你为什么这样选？<textarea disabled={practice.phase === "evaluating"} maxLength={1500} placeholder="说明推理路径，AI 将独立评审对错。" value={practice.reasoning} onChange={(event) => setPractice((current) => current ? { ...current, reasoning: event.target.value } : current)} /></label>
            {practice.phase === "evaluating" ? <p className="phase-line"><span className="spinner-mini" />{practice.phaseMessage ?? "正在评审推理…"}</p> : <button className="practice-submit" disabled={!practice.selectedOptionId} type="button" onClick={onSubmitAnswer}>提交作答 →</button>}
          </>}
          {practice.phase === "remediating" && <><ResultBanner practice={practice} /><div className="remediation-box" aria-live="polite">{practice.remediationText ? <p>{practice.remediationText}</p> : <div className="thinking"><span /><p>正在分析错误来源…</p></div>}</div></>}
          {practice.phase === "completed" && <><ResultBanner practice={practice} /><div className="practice-actions">{practice.remediationUnit ? <button className="practice-submit" type="button" onClick={onRetest}>再来一道（复测）→</button> : <button className="practice-submit" type="button" onClick={onClosePractice}>完成 ✓</button>}<button className="practice-dismiss" type="button" onClick={onClosePractice}>收起练习</button></div></>}
          {practice.question === null && practice.phase !== "failed" && <div className="thinking"><span /><p>{practice.phaseMessage ?? phaseLabel(practice.phase)}…</p></div>}
        </div>
      ) : (
        <div className="concept-detail">
          {selectedConcept ? <>
            <div className="detail-head"><p className="eyebrow">CONCEPT</p><h3>{selectedConcept.topic}</h3><span className={`mastery-badge lv-${String(selectedConcept.level)}`}>掌握度 Lv.{String(selectedConcept.level)}</span></div>
            <p className="detail-source">来源：{selectedConcept.source?.sourceLabel ?? "（无来源记录）"}</p>
            {selectedConcept.source && <p className="detail-source">原文：…{selectedConcept.source.selectedText.slice(0, 140)}{selectedConcept.source.selectedText.length > 140 ? "…" : ""}</p>}
            <button className="practice-submit" disabled={busy} type="button" onClick={() => onSelectConcept(selectedConcept)}>{selectedConcept.evidenceCount > 0 ? "再来一道（复测）→" : "开始练习 →"}</button>
            <div className="attempt-history"><p className="eyebrow">ATTEMPT HISTORY</p>
              {attempts.length === 0 ? <p className="empty-history">还没有作答记录。练习后会在这里看到答题、评审与补救摘要。</p> : attempts.map((attempt) => <div className={"attempt-row" + (attempt.correct && attempt.reasoningCorrect ? " passed" : " needs-work")} key={attempt.attemptId}>
                <span>{attempt.isRetest ? "复测" : "首次"}</span>
                <strong>{attempt.correct && attempt.reasoningCorrect ? "通过 ✓" : attempt.correct ? "结论对，推理不足" : "未通过"}</strong>
                <small>{formatClock(attempt.occurredAt)} · {formatDate(attempt.occurredAt)}</small>
                {attempt.remediationCause && <p>补救：{attempt.remediationCause}</p>}
              </div>)}
            </div>
          </> : <EmptyReader title="选择一个概念" text="点左侧概念开始练习：系统会用该概念的原来源内容重新出题，并记录掌握度。" action="回学习台" onAction={onGoHome} />}
        </div>
      )}
    </div>
  </section>;
}

function HomeView({ status, loading, action, courses, masteryByCourse, onRefresh, onLogin, onLogout, onCreateCourse, onOpenCourse }: { status: RuntimeStatusSnapshot | null; loading: boolean; action: "login" | "logout" | "refresh" | null; courses: Course[]; masteryByCourse: Record<string, ConceptMastery[]>; onRefresh: () => void; onLogin: () => void; onLogout: () => void; onCreateCourse: () => void; onOpenCourse: (courseId: string) => void }) {
  return <><section className="hero-grid"><article className="hero-card"><div className="hero-copy"><p className="eyebrow">FROM SOURCE TO UNDERSTANDING</p><h2>把课程资料，<br /><em>蒸馏</em>成真正理解。</h2><p className="hero-description">导入课程的全部 PDF，AI 自动分析整门课程，生成带来源页码的知识地图；对其中不熟悉的概念，再就地划选原文做解释与练习。</p><div className="hero-actions"><button className="primary-button" type="button" onClick={onCreateCourse}>{courses.length === 0 ? "创建第一门课程" : "新建课程"}<span>→</span></button><span className="ready-tag">PDF 学习已开放</span></div></div><KnowledgeOrbit /></article><RuntimeCard status={status} loading={loading} action={action} onRefresh={onRefresh} onLogin={onLogin} onLogout={onLogout} /></section><section className="section-block"><div className="section-heading"><div><p className="eyebrow">YOUR COURSES</p><h2>本地课程</h2></div><span>{String(courses.length)} 门课程</span></div>{courses.length === 0 ? <button className="empty-course" type="button" onClick={onCreateCourse}><strong>还没有课程</strong><span>创建课程后导入 Week 1–3 PDF →</span></button> : <div className="course-grid">{courses.map((course) => <button className="course-card" key={course.id} onClick={() => onOpenCourse(course.id)} type="button"><span>{String(course.documentCount).padStart(2, "0")}</span><strong>{course.title}</strong><small>{String(course.documentCount)} 份资料 · 更新于 {formatDate(course.updatedAt)}</small>{renderCourseMastery(masteryByCourse[course.id])}</button>)}</div>}</section></>;
}

function LibraryView({ courses, documents, selectedCourseId, selectedDocumentId, detail, documentUrl, documentLoading, importing, importProgress, mode, selectedSource, explanationMode, analyzing, analyzeDisabled, analysisResult, analysisProgress, analysisState, pausing, onPause, onSelectCourse, onSelectDocument, onCreateCourse, onImport, onModeChange, onCaptureSelection, onExplain, onExplanationModeChange, onAnalyze }: { courses: Course[]; documents: CourseDocument[]; selectedCourseId: string | null; selectedDocumentId: string | null; detail: DocumentDetail | null; documentUrl: string | null; documentLoading: boolean; importing: boolean; importProgress: DocumentImportProgress | null; mode: ReaderMode; selectedSource: SelectedSource | null; explanationMode: ExplanationMode; analyzing: boolean; analyzeDisabled: boolean; analysisResult: KnowledgeExtractionResult | null; analysisProgress: KnowledgeExtractionProgress | null; analysisState: KnowledgeAnalysisState | null; pausing: boolean; onPause: () => void; onSelectCourse: (courseId: string) => void; onSelectDocument: (documentId: string) => void; onCreateCourse: () => void; onImport: () => void; onModeChange: (mode: ReaderMode) => void; onCaptureSelection: (page: DocumentPage, container: HTMLElement) => void; onExplain: () => void; onExplanationModeChange: (mode: ExplanationMode) => void; onAnalyze: () => void }) {
  return <section className="library-workspace"><aside className="library-rail"><div className="rail-section"><div className="rail-heading"><span>课程</span><button type="button" onClick={onCreateCourse}>＋</button></div><select value={selectedCourseId ?? ""} onChange={(event) => onSelectCourse(event.target.value)}>{courses.length === 0 && <option value="">请先创建课程</option>}{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></div><div className="rail-section document-section"><div className="rail-heading"><span>PDF 资料</span><small>{String(documents.length)}</small></div><div className="document-list">{documents.map((document) => <button className={selectedDocumentId === document.id ? "active" : ""} key={document.id} onClick={() => onSelectDocument(document.id)} type="button"><DocumentIcon /><span><strong>{document.displayName}</strong><small>{document.pageCount ? `${String(document.pageCount)} 页` : "处理中"} · {formatBytes(document.sizeBytes)}</small></span></button>)}</div></div><button className="import-button" disabled={!selectedCourseId || importing} onClick={onImport} type="button">{importing ? `${importProgress?.phase === "parsing" ? "解析" : "导入"} ${String(importProgress?.current ?? 0)}/${String(importProgress?.total ?? 0)}` : "＋ 导入 PDF"}</button><AnalysisPanel compact analyzing={analyzing} disabled={analyzeDisabled} progress={analysisProgress} result={analysisResult} state={analysisState} conceptCount={documents.length} onAnalyze={onAnalyze} onPause={onPause} pausing={pausing} /></aside><div className="reader-shell">{!selectedCourseId ? <EmptyReader title="先创建一门课程" text="课程用于组织资料、知识点、题目和学习记录。" action="创建课程" onAction={onCreateCourse} /> : documents.length === 0 ? <EmptyReader title="导入第一份 PDF" text="可一次选择多份 Week 1–3 课件，系统会逐页提取文本并保留原始视觉页面。" action="选择 PDF" onAction={onImport} /> : documentLoading || !detail ? <div className="reader-loading"><span /><p>正在读取资料与来源页…</p></div> : <><div className="reader-toolbar"><div><p className="eyebrow">SOURCE DOCUMENT</p><h2>{detail.document.displayName}</h2><small>SHA-256 来源版本 {detail.document.sourceVersion.slice(0, 12)} · {String(detail.document.pageCount ?? 0)} 页</small></div><div className="reader-tabs"><button className={mode === "text" ? "active" : ""} onClick={() => onModeChange("text")} type="button">可选文本</button><button className={mode === "split" ? "active" : ""} onClick={() => onModeChange("split")} type="button">对照</button><button className={mode === "original" ? "active" : ""} onClick={() => onModeChange("original")} type="button">原始 PDF</button></div></div><div className={`reader-content mode-${mode}`}>{mode !== "original" && <div className="text-pages"><div className="reader-hint"><span>划选文字</span>后可按来源向 AI 提问，回答不会直接接触你的文件路径。</div>{detail.pages.map((page) => <article className="text-page" key={page.pageNumber} onMouseUp={(event) => onCaptureSelection(page, event.currentTarget)}><header><span>PAGE {String(page.pageNumber).padStart(2, "0")}</span><small>{String(page.text.length)} 字符</small></header>{page.text ? <p>{page.text}</p> : <div className="page-warning">本页没有提取到文本，请在右侧查看原始页面。</div>}{selectedSource?.page.pageNumber === page.pageNumber && <div className="selection-card"><p>“{selectedSource.text.slice(0, 120)}{selectedSource.text.length > 120 ? "…" : ""}”</p><select value={explanationMode} onChange={(event) => onExplanationModeChange(event.target.value as ExplanationMode)}><option value="mechanism">解释原理与为什么</option><option value="simple">简单解释</option><option value="compare">对比易混概念</option><option value="example">举例解释</option><option value="visual">视觉化解释</option><option value="socratic">引导式解释</option></select><button type="button" onClick={onExplain}>让 AI 解释 →</button></div>}</article>)}</div>}{mode !== "text" && documentUrl && <iframe className="pdf-frame" src={documentUrl} title={`${detail.document.displayName} 原始 PDF`} />}</div></>}</div></section>;
}

function TutorPanel({ tutor, followUp, practice, startingPractice, topicInput, onFollowUpChange, onSubmitFollowUp, onBeginPractice, onRetest, onPracticeQuestionChange, onTopicInputChange, onSubmitPracticeAnswer, onClosePractice, onCancel, onClose }: { tutor: TutorState; followUp: string; practice: PracticeState | null; startingPractice: boolean; topicInput: string; onFollowUpChange: (value: string) => void; onSubmitFollowUp: (event: React.FormEvent) => void; onBeginPractice: () => void; onRetest: () => void; onPracticeQuestionChange: (setter: (current: PracticeState | null) => PracticeState | null) => void; onTopicInputChange: (value: string) => void; onSubmitPracticeAnswer: () => void; onClosePractice: () => void; onCancel: () => void; onClose: () => void }) {
  const running = tutor.status === "running";
  return <aside className="tutor-panel"><header><div><p className="eyebrow">SOURCE-GROUNDED TUTOR</p><h2>概念解释</h2></div><button type="button" onClick={onClose}>×</button></header><div className="source-card"><span>来源</span><strong>{tutor.sourceLabel}</strong><p>“{tutor.sourceText.slice(0, 220)}{tutor.sourceText.length > 220 ? "…" : ""}”</p></div><div className="tutor-answer" aria-live="polite">{tutor.answer ? <p>{tutor.answer}</p> : <div className="thinking"><span /><p>正在分析概念、机制和常见误解…</p></div>}{tutor.message && <div className="tutor-error">{tutor.message}</div>}</div><div className="tutor-footer">{running ? <button className="cancel-run" type="button" onClick={onCancel}>停止生成</button> : <form className="follow-up" onSubmit={onSubmitFollowUp}><label htmlFor="follow-up">继续追问</label><textarea id="follow-up" maxLength={4000} placeholder="例如：为什么这里不能使用饼图？换一个例子解释。" value={followUp} onChange={(event) => onFollowUpChange(event.target.value)} /><button disabled={!followUp.trim()} type="submit">发送追问 →</button></form>}{!running && <PracticeSection practice={practice} startingPractice={startingPractice} topicInput={topicInput} onTopicInputChange={onTopicInputChange} onPracticeQuestionChange={onPracticeQuestionChange} onBeginPractice={onBeginPractice} onRetest={onRetest} onSubmitPracticeAnswer={onSubmitPracticeAnswer} onClosePractice={onClosePractice} />}</div></aside>;
}

function PracticeSection({ practice, startingPractice, topicInput, onTopicInputChange, onPracticeQuestionChange, onBeginPractice, onRetest, onSubmitPracticeAnswer, onClosePractice }: { practice: PracticeState | null; startingPractice: boolean; topicInput: string; onTopicInputChange: (value: string) => void; onPracticeQuestionChange: (setter: (current: PracticeState | null) => PracticeState | null) => void; onBeginPractice: () => void; onRetest: () => void; onSubmitPracticeAnswer: () => void; onClosePractice: () => void }) {
  if (!practice) {
    return <div className="practice-block"><div className="practice-heading"><span>练习</span><small>SUMMATIVE CHECK</small></div><p className="practice-description">把这段话变成一道单选题：自动独立验题、作答后评审推理，答错则补救。</p><label className="topic-field">概念主题<input maxLength={120} placeholder="例如：坐标轴的作用" value={topicInput} onChange={(event) => onTopicInputChange(event.target.value)} /></label><button className="practice-start" disabled={startingPractice} type="button" onClick={onBeginPractice}>生成一道小题 →</button></div>;
  }

  const phase = practice.phase;
  const running = phase === "creating" || phase === "verifying" || phase === "evaluating" || phase === "remediating";

  return <div className="practice-block active">
    <div className="practice-heading"><span>练习{practice.isRetest ? " · 复测" : ""}</span>{running && <span className="phase-badge">{practice.phaseMessage ?? phaseLabel(phase)}</span>}</div>
    {phase === "failed" && practice.failure && <div className="tutor-error">{practice.failure}</div>}
    {running && !practice.question && <div className="thinking"><span /><p>{practice.phaseMessage ?? phaseLabel(phase)}…</p></div>}
    {practice.question && (phase === "ready" || phase === "evaluating") && <>
      <div className="question-card"><p className="question-stem">{practice.question.stem}</p><div className="quiz-options">{practice.question.options.map((option) => <label className={practice.selectedOptionId === option.id ? "selected" : ""} key={option.id}><input disabled={phase === "evaluating"} name="quiz-option" type="radio" checked={practice.selectedOptionId === option.id} onChange={() => onPracticeQuestionChange((current) => current ? { ...current, selectedOptionId: option.id } : current)} /><span className="option-label">{option.label}</span><span>{option.text}</span></label>)}</div><label className="reasoning-field">你为什么这样选？<textarea maxLength={1500} disabled={phase === "evaluating"} placeholder="说明推理路径，AI 将独立评审对错。" value={practice.reasoning} onChange={(event) => onPracticeQuestionChange((current) => current ? { ...current, reasoning: event.target.value } : current)} /></label>{phase === "evaluating" ? <p className="phase-line"><span className="spinner-mini" />{practice.phaseMessage ?? "正在评审推理…"}</p> : <button className="practice-submit" disabled={!practice.selectedOptionId} type="button" onClick={onSubmitPracticeAnswer}>提交作答 →</button>}</div>
    </>}
    {phase === "remediating" && <><ResultBanner practice={practice} /><div className="remediation-box" aria-live="polite">{practice.remediationText ? <p>{practice.remediationText}</p> : <div className="thinking"><span /><p>正在分析错误来源…</p></div>}</div></>}
    {phase === "completed" && <ResultBanner practice={practice} />}
    {phase === "completed" && (<div className="practice-actions">{practice.remediationUnit ? <button className="practice-submit" type="button" onClick={onRetest}>再来一道（复测）→</button> : <button className="practice-submit" type="button" onClick={onClosePractice}>完成 ✓</button>} <button className="practice-dismiss" type="button" onClick={onClosePractice}>收起练习</button></div>)}
    {phase === "failed" && <button className="practice-start" type="button" onClick={onBeginPractice}>重试生成 →</button>}
  </div>;
}

function ResultBanner({ practice }: { practice: PracticeState }) {
  const evaluation = practice.evaluation;
  if (!evaluation) return null;
  const reasoningBroken = !evaluation.reasoningReview.reasoningCorrect;
  const passed = evaluation.correct && !reasoningBroken;
  return <div className={`result-banner ${passed ? "passed" : "needs-work"}`}>
    <strong>{passed ? "分析正确 · 理解达成 ✓" : evaluation.correct ? "结论正确，但推理站不住脚" : "回答错误"}</strong>
    {!passed && <p>评审意见：{evaluation.reasoningReview.reason || "需要重新审视推理过程。"}</p>}
    <span>概念掌握度 <b>Lv.{practice.mastery?.level ?? 0}</b> · 已通过证据 {String(practice.mastery?.evidenceCount ?? 0)} 次</span>
  </div>;
}

function phaseLabel(phase: PracticePhase): string {
  switch (phase) {
    case "creating": return "正在出题";
    case "verifying": return "正在独立验题";
    case "evaluating": return "正在评审推理";
    case "remediating": return "正在生成补救";
    case "ready": return "题目已就绪";
    case "completed": return "已完成";
    case "failed": return "失败";
  }
}

function renderCourseMastery(concepts: ConceptMastery[] | undefined): React.ReactNode {
  if (!concepts || concepts.length === 0) return null;
  const mastered = concepts.filter((concept) => concept.level >= 3).length;
  return <span className="course-mastery">已练习 {String(concepts.length)} 个概念 · 已掌握 {String(mastered)}</span>;
}

function providerName(id: ProviderId | string | undefined): string {
  switch (id) {
    case "codex": return "Codex";
    case "openai_compatible": return "OpenAI 兼容";
    case "anthropic": return "Claude";
    default: return "Codex";
  }
}

function EmptyReader({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) { return <div className="empty-reader"><div className="empty-reader-icon"><DocumentIcon /></div><h2>{title}</h2><p>{text}</p><button className="primary-button" type="button" onClick={onAction}>{action} <span>→</span></button></div>; }

function RuntimeCard({ status, loading, action, onRefresh, onLogin, onLogout }: { status: RuntimeStatusSnapshot | null; loading: boolean; action: "login" | "logout" | "refresh" | null; onRefresh: () => void; onLogin: () => void; onLogout: () => void }) {
  const primaryLimit = useMemo(() => choosePrimaryLimit(status?.rateLimits ?? []), [status]);
  const authenticated = status?.auth.authenticated ?? false;
  return <article className="runtime-card"><div className="runtime-header"><div><p className="eyebrow">CODEX CONNECTION</p><h2>AI 运行状态</h2></div><button className={`icon-button ${action === "refresh" ? "spinning" : ""}`} onClick={onRefresh} type="button" aria-label="刷新状态" disabled={action !== null}><RefreshIcon /></button></div>{loading ? <div className="runtime-loading"><span /><p>正在读取本机状态…</p></div> : authenticated && status ? <><div className="account-row"><div className="account-avatar">AI</div><div><strong>ChatGPT {formatPlan(status.auth.planType)}</strong><small>{maskEmail(status.auth.email) ?? "由 Codex 安全管理登录"}</small></div><span className="verified">已连接</span></div>{primaryLimit ? <UsageMeter limit={primaryLimit} /> : <p className="muted-panel">{status.issue?.message ?? "当前没有可显示的用量窗口。"}</p>}<div className="runtime-footer"><span>更新于 {formatClock(status.checkedAt)}</span><button className="text-button" type="button" onClick={onLogout} disabled={action !== null}>{action === "logout" ? "正在退出…" : "退出账户"}</button></div></> : <div className="login-state"><div className="login-glyph" aria-hidden="true">↗</div><h3>{status?.connected ? "连接你的 ChatGPT" : "Codex 暂时不可用"}</h3><p>{status?.issue?.message ?? "登录后即可使用来源解释。"}</p><button className="secondary-button" type="button" onClick={onLogin} disabled={!status?.connected || action !== null}>{action === "login" ? "正在打开…" : "使用 ChatGPT 登录"}</button></div>}</article>;
}

function UsageMeter({ limit }: { limit: RateLimits }) { const window = limit.primary ?? limit.secondary; if (!window) return null; const remaining = Math.max(0, Math.round(100 - window.usedPercent)); return <div className="usage-panel"><div className="usage-label"><span>当前用量窗口</span><strong>{remaining}% <small>可用</small></strong></div><div className="meter" aria-label={`剩余 ${remaining}%`}><span style={{ width: `${String(remaining)}%` }} /></div><div className="usage-meta"><span>{describeWindow(window)}</span><span>{formatReset(window)}</span></div></div>; }
function KnowledgeOrbit() { return <div className="knowledge-orbit" aria-label="资料经过分析、知识地图和针对性练习形成理解的示意图"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><span className="orbit-node node-a">资料</span><span className="orbit-node node-b">分析</span><span className="orbit-node node-c">地图</span><span className="orbit-node node-d">练习</span><div className="orbit-core"><strong>理解</strong><small>MASTERY</small></div></div>; }
function DocumentIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></svg>; }
function NavIcon({ name }: { name: string }) { const paths: Record<string, React.ReactNode> = { home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11h13V9M9 20v-6h6v6"/></>, library: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z"/><path d="M7 16h12M9 8h6"/></>, map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></>, practice: <><path d="M5 3h14v18H5z"/><path d="m8 9 2 2 4-4M8 16h8"/></>, review: <><path d="M12 5a7 7 0 1 1-6.2 3.75"/><path d="M3 4v5h5M12 8v5l3 2"/></> }; return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2.05 4.95"/></svg>; }
function choosePrimaryLimit(limits: RateLimits[]): RateLimits | null { return limits.find((item) => item.limitId === "codex") ?? limits[0] ?? null; }
function formatPlan(plan: string | null | undefined): string { return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "账户"; }
function maskEmail(email: string | null | undefined): string | null { if (!email) return null; const [name, domain] = email.split("@"); if (!name || !domain) return email; const visible = name.slice(0, Math.min(2, name.length)); return `${visible}${"•".repeat(Math.max(3, Math.min(6, name.length - visible.length)))}@${domain}`; }
function formatClock(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)); }
function formatBytes(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${String(Math.ceil(bytes / 1024))} KB`; }
function describeWindow(window: RateWindow): string { if (!window.windowDurationMins) return "Codex 用量"; const hours = window.windowDurationMins / 60; return Number.isInteger(hours) ? `${String(hours)} 小时窗口` : `${String(window.windowDurationMins)} 分钟窗口`; }
function formatReset(window: RateWindow): string { if (!window.resetsAt) return "重置时间未知"; return `${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(window.resetsAt))} 重置`; }

function MapView({ courses, selectedCourseId, selectedCourse, concepts, result, progress, analyzing, analyzeDisabled, knowledgeLoading, analysisState, pausing, onPause, onSelectCourse, onAnalyze, onOpenSource, onGoHome, onCreateCourse }: { courses: Course[]; selectedCourseId: string | null; selectedCourse: Course | null; concepts: KnowledgeConcept[]; result: KnowledgeExtractionResult | null; progress: KnowledgeExtractionProgress | null; analyzing: boolean; analyzeDisabled: boolean; knowledgeLoading: boolean; analysisState: KnowledgeAnalysisState | null; pausing: boolean; onPause: () => void; onSelectCourse: (courseId: string) => void; onAnalyze: () => void; onOpenSource: (documentId: string, pageNumber: number) => void; onGoHome: () => void; onCreateCourse: () => void }) {
  return <section className="map-workspace">
    <aside className="map-rail">
      <div className="rail-section">
        <div className="rail-heading"><span>课程</span><button type="button" onClick={onCreateCourse}>＋</button></div>
        <select value={selectedCourseId ?? ""} onChange={(event) => onSelectCourse(event.target.value)}>{courses.length === 0 && <option value="">请先创建课程</option>}{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select>
      </div>
      <div className="rail-section map-rail-section">
        <div className="rail-heading"><span>知识地图</span><small>{String(concepts.length)}</small></div>
        <p className="map-rail-note">{analyzing ? "正在分析整门课程…" : concepts.length === 0 ? "尚未生成概念" : "点击概念来源可跳到 PDF 所在页"}</p>
      </div>
    </aside>
    <div className="map-stage">
      {!selectedCourse ? <EmptyReader title="先选择一门课程" text="知识地图针对单门课程生成。请在资料库导入 PDF 并选择课程。" action="回到学习台" onAction={onGoHome} /> : <>
        <AnalysisPanel analyzing={analyzing} progress={progress} result={result} state={analysisState} conceptCount={concepts.length} disabled={analyzeDisabled} onAnalyze={onAnalyze} onPause={onPause} pausing={pausing} />
        {concepts.length > 0 ? <div className="concept-grid">{concepts.map((concept) => <ConceptCard concept={concept} key={concept.id} onOpenSource={onOpenSource} />)}</div> : knowledgeLoading ? <div className="map-waiting"><div className="thinking"><span /><p>正在读取本地知识地图……</p></div></div> : analyzing ? <div className="map-waiting"><div className="thinking"><span /><p>正在从课程资料中提取概念……</p></div></div> : <div className="map-empty"><div className="empty-reader-icon"><MapIcon /></div><h2>还没有知识概念</h2><p>导入课程 PDF 后，点击「分析全部资料」即可从整门课程中提取概念、别名、摘要与来源页码。分析之前，这里不会展示任何知识点。</p></div>}
      </>}
    </div>
  </section>;
}

function ConceptCard({ concept, onOpenSource }: { concept: KnowledgeConcept; onOpenSource: (documentId: string, pageNumber: number) => void }) {
  return <article className="concept-card">
    <header><h3>{concept.title}</h3><span className="concept-sources-count">{String(concept.sources.length)} 处来源</span></header>
    <p className="concept-summary">{concept.summary}</p>
    {concept.aliases.length > 0 && <div className="concept-aliases"><span>别名</span>{concept.aliases.map((alias) => <code key={alias}>{alias}</code>)}</div>}
    <div className="concept-sources"><span className="sources-label">来源证据</span>{concept.sources.map((source, index) => <button className="source-chip" type="button" key={`${String(source.documentId)}-${String(source.pageNumber)}-${String(index)}`} onClick={() => onOpenSource(source.documentId, source.pageNumber)}><span>{source.sourceLabel}</span><small>{source.excerpt ? `“${source.excerpt.slice(0, 56)}${source.excerpt.length > 56 ? "…" : ""}”` : `第 ${String(source.pageNumber)} 页`}</small></button>)}</div>
  </article>;
}

function AnalysisPanel({ analyzing, progress, result, state, conceptCount, disabled, onAnalyze, onPause, pausing, compact }: { analyzing: boolean; progress: KnowledgeExtractionProgress | null; result: KnowledgeExtractionResult | null; state: KnowledgeAnalysisState | null; conceptCount: number; disabled: boolean; onAnalyze: () => void; onPause: () => void; pausing: boolean; compact?: boolean }) {
  const failed = progress?.phase === "failed";
  const cancelled = progress?.phase === "cancelled";
  const resume = state?.canResume === true;
  if (compact) {
    if (analyzing) {
      const phase = progress?.phase ?? "queued";
      const current = progress?.current ?? 0;
      const total = progress?.total ?? 0;
      return <div className="analysis-mini active" role="status"><span className="spinner-mini" /><span>{extractionPhaseLabel(phase)}{total > 0 ? ` ${String(current)}/${String(total)} 个批次` : ""}</span><button className="analysis-retry" disabled={pausing} onClick={onPause} type="button">{pausing ? "暂停中…" : "暂停"}</button></div>;
    }
    if (failed) {
      return <div className="analysis-mini failed" role="alert"><span className="analysis-dot failed" /><span title={progress.message ?? undefined}>分析失败</span><button className="analysis-retry" disabled={disabled} onClick={onAnalyze} type="button">重试</button></div>;
    }
    if (cancelled) {
      return <div className="analysis-mini paused" role="status"><span className="analysis-dot cancelled" /><span>分析已暂停{state ? ` · 已保存 ${String(state.completedBatchCount)}/${String(state.totalBatchCount)} 个批次` : " · 正在读取断点"}</span><button className="analysis-retry" disabled={disabled} onClick={onAnalyze} type="button">{resume ? "继续分析" : "重新分析"}</button></div>;
    }
    if (result) {
      const reused = (result.reusedBatchCount ?? 0) > 0;
      return <div className="analysis-mini done" role="status"><span className="analysis-dot succeeded" /><span>已生成 {String(result.concepts.length)} 个概念{reused ? ` · 复用 ${String(result.reusedBatchCount)} 个批次` : ""}{result.failedChunkCount > 0 ? ` · 失败 ${String(result.failedChunkCount)} 个` : ""}</span><button className="analysis-retry" disabled={disabled} onClick={onAnalyze} type="button">{result.failedChunkCount > 0 ? "继续分析" : "重新分析"}</button></div>;
    }
    if (resume && state) {
      return <div className="analysis-mini ready"><span className="analysis-dot queued" /><span className="analysis-resume-note">{resumeMessageText(state)}</span><button className="analyze-button" disabled={disabled} onClick={onAnalyze} type="button">继续分析</button></div>;
    }
    return <button className="analyze-button" disabled={disabled} onClick={onAnalyze} type="button">分析全部资料</button>;
  }
  if (analyzing) {
    const phase = progress?.phase ?? "queued";
    const current = progress?.current ?? 0;
    const total = progress?.total ?? 0;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    return <div className="analysis-panel active" role="status">
      <div className="analysis-row"><span className={"analysis-dot " + phase} /><strong>正在分析全部资料…</strong><span className="phase-badge">{extractionPhaseLabel(phase)}</span></div>
      <p className="analysis-message">{progress?.message ?? (phase === "chunking" ? "正在切分资料…" : phase === "merging" ? "正在合并概念…" : "")}</p>
      {phase === "analyzing" && total > 0 && <div className="analysis-meter"><span style={{ width: `${String(percent)}%` }} /></div>}
      <div className="analysis-meta"><span>{String(current)}/{String(total || 0)} 个批次</span><span>{String(percent)}%</span></div>
      <button className="analyze-button secondary" disabled={pausing} onClick={onPause} type="button">{pausing ? "正在暂停…" : "暂停"}</button>
    </div>;
  }
  if (failed) {
    return <div className="analysis-panel failed" role="alert">
      <div className="analysis-row"><span className="analysis-dot failed" /><strong>分析未完成</strong><span className="phase-badge">失败</span></div>
      <p className="analysis-message">{progress.message ?? "模型没有返回可用的结构化结果，请检查模型连接后重试。"}</p>
      <button className="analyze-button secondary" disabled={disabled} onClick={onAnalyze} type="button">{resume ? "继续分析 →" : "重新分析 →"}</button>
    </div>;
  }
  if (cancelled) {
    return <div className="analysis-panel paused" role="status">
      <div className="analysis-row"><span className="analysis-dot cancelled" /><strong>分析已暂停</strong><span className="phase-badge">{state ? `已保存 ${String(state.completedBatchCount)}/${String(state.totalBatchCount)} 个批次` : "正在读取断点"}</span></div>
      <p className="analysis-message">{progress.message ?? "已完成的部分会保留，点击继续分析可从断点接着进行。"}</p>
      {resume && state && <p className="analysis-message">{resumeMessageText(state)}</p>}
      <button className="analyze-button secondary" disabled={disabled} onClick={onAnalyze} type="button">{resume ? "继续分析 →" : "重新分析全部资料 →"}</button>
    </div>;
  }
  if (result) {
    return <div className="analysis-panel done" role="status">
      <div className="analysis-row"><span className="analysis-dot succeeded" /><strong>分析完成</strong><span className="phase-badge">{String(result.concepts.length)} 个概念</span></div>
      <p className="analysis-message">{resultMessageText(result)}</p>
      <button className="analyze-button secondary" disabled={disabled} onClick={onAnalyze} type="button">{result.failedChunkCount > 0 ? "继续分析（重试失败批次）→" : "重新分析全部资料 →"}</button>
    </div>;
  }
  if (resume && state) {
    return <div className="analysis-panel">
      <p className="analysis-lead">{resumeMessageText(state)}。</p>
      <button className="analyze-button" disabled={disabled} onClick={onAnalyze} type="button">继续分析 →</button>
      {conceptCount > 0 && <span className="analysis-hint">已生成 {String(conceptCount)} 个概念，继续分析将补齐剩余批次</span>}
    </div>;
  }
  return <div className="analysis-panel">
    <p className="analysis-lead">把整门课程的 PDF 交给 AI，提取一篇带来源页码证据的知识地图。解释与练习仍可随时使用。</p>
    <button className="analyze-button" disabled={disabled} onClick={onAnalyze} type="button">分析全部资料 →</button>
    {conceptCount > 0 && <span className="analysis-hint">已生成 {String(conceptCount)} 个概念，可重新分析</span>}
  </div>;
}

function MapIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>; }

function resumeMessageText(state: KnowledgeAnalysisState): string {
  const saved = `${String(state.completedBatchCount)}/${String(state.totalBatchCount)}`;
  const base = `已保存 ${saved} 个批次，剩余 ${String(state.pendingBatchCount)} 个`;
  if (state.failedBatchCount > 0) {
    return `${base}，其中 ${String(state.failedBatchCount)} 个失败批次将在点击继续后重试`;
  }
  return base;
}

function resultMessageText(result: KnowledgeExtractionResult): string {
  const parts = [`已分析 ${String(result.analyzedChunkCount)}/${String(result.chunkCount)} 个批次。`];
  if ((result.reusedBatchCount ?? 0) > 0) parts.push(`复用了 ${String(result.reusedBatchCount)} 个已保存批次。`);
  if (result.failedChunkCount > 0) parts.push(`其中 ${String(result.failedChunkCount)} 个批次未通过校验，可点击继续分析重试。`);
  else parts.push("全部批次均已通过校验。");
  return parts.join("");
}

function extractionPhaseLabel(phase: KnowledgeExtractionPhase | null | undefined): string {
  switch (phase) {
    case "queued": return "排队";
    case "chunking": return "切分资料";
    case "analyzing": return "分析";
    case "merging": return "合并概念";
    case "succeeded": return "完成";
    case "failed": return "失败";
    case "cancelled": return "取消";
    default: return "准备中";
  }
}

function friendlyError(error: unknown): string { const raw = error instanceof Error ? error.message : String(error); return raw.replace(/^Error invoking remote method '[^']+': Error: /, ""); }
