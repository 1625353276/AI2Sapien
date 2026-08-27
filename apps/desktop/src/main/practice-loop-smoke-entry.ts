import { join } from "node:path";

import type { ModelRuntime, ModelTurnEvent, ModelTurnListener } from "@ai2sapien/model-providers";

import { PracticeController } from "./practice-controller.js";
import { PracticeStore } from "./practice-store.js";

interface SmokeArtifacts {
  questionJson: string;
  verifierJson: string;
  reasoningWrongJson: string;
  reasoningRightJson: string;
  remediationJson: string;
  rootDirectory: string;
}

interface SmokeResult {
  pass: boolean;
  questionStem: string;
  wrongAnswerCorrect: boolean;
  remediationCause: string;
  retestMasteryLevel: number;
  retestEvidenceCount: number;
  phaseLog: string[];
}

interface FakeSession {
  sessionId: string;
  runId: string;
  buffer: string;
}

class FakeModelRuntime implements ModelRuntime {
  readonly listeners = new Set<ModelTurnListener>();
  session: FakeSession | null = null;
  nextId = 1;
  lastRunId = "";
  eventsResolved = false;

  get activeProvider(): "codex" {
    return "codex";
  }

  async configure(): Promise<void> {}

  listStatus(): [] {
    return [];
  }

  onTurnEvent(listener: ModelTurnListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(): Promise<string> {
    const sessionId = `session-${String(this.nextId)}`;
    this.nextId += 1;
    this.session = { sessionId, runId: "", buffer: "" };
    this.eventsResolved = false;
    return sessionId;
  }

  async sendTurn(): Promise<string> {
    const runId = `run-${String(this.nextId)}`;
    this.nextId += 1;
    if (this.session) this.session.runId = runId;
    this.lastRunId = runId;
    this.#emit({ runId, status: "running", delta: "" });
    return runId;
  }

  async interrupt(): Promise<void> {}

  #emit(event: { runId: string; status: ModelTurnEvent["status"]; delta: string; message?: string | null }): void {
    const e: ModelTurnEvent = {
      providerId: "codex",
      sessionId: this.session?.sessionId ?? "",
      runId: event.runId,
      status: event.status,
      delta: event.delta,
      message: event.message ?? null,
    };
    for (const listener of this.listeners) listener(e);
  }

  runTurn(json: string): void {
    this.#emit({
      runId: this.lastRunId,
      status: "running",
      delta: `\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    });
    this.#emit({ runId: this.lastRunId, status: "succeeded", delta: "" });
  }
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch {
        // keep polling
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`${label} timeout`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

async function waitNextRun(runtime: FakeModelRuntime, previousId: string): Promise<void> {
  return waitFor(
    () => runtime.lastRunId.length > 0 && runtime.lastRunId !== previousId,
    "waitNextRun",
  );
}

export async function runPracticeLoopSmoke(artifacts: SmokeArtifacts): Promise<SmokeResult> {
  const store = new PracticeStore(join(artifacts.rootDirectory, "practice"));
  await store.initialize();

  const runtime = new FakeModelRuntime();
  const controller = new PracticeController(runtime as unknown as ModelRuntime, store);

  const questions: Array<{ stem: string; options: unknown[] }> = [];
  controller.onPracticeQuestion((ready) => {
    questions.push({ stem: ready.question.stem, options: ready.question.options });
  });
  const results: Array<{ remediation: { cause: string } | null; mastery: { level: number; evidenceCount: number } }> = [];
  controller.onPracticeResult((result) => {
    results.push({ remediation: result.remediation, mastery: result.mastery });
  });

  const phaseLog: string[] = [];
  controller.onPracticeUpdate((update) => phaseLog.push(update.phase));

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  const selection = {
    documentId: "doc-1",
    sourceVersion: "v1",
    pageNumber: 3,
    selectedText: "坐标轴",
    prefix: "",
    suffix: "",
  };
  const request = {
    courseId: "course-1",
    selection,
    topic: "坐标轴的作用",
    language: "zh-CN",
    isRetest: false,
  };

  const practiceId = await controller.startPractice(request, "来源文本：纵坐标轴表示数值量级…", "课程.pdf · 第 3 页");
  const creatingRun = runtime.lastRunId;
  runtime.runTurn(artifacts.questionJson);
  await waitNextRun(runtime, creatingRun);
  runtime.runTurn(artifacts.verifierJson);
  await waitFor(() => questions.length === 1, "questionReady");

  const submitPromise = controller.submitAnswer({ practiceId, optionId: "A", reasoning: "因为纵轴在上方" });
  await tick();
  const evaluatingRun = runtime.lastRunId;
  runtime.runTurn(artifacts.reasoningWrongJson);
  await waitNextRun(runtime, evaluatingRun);
  runtime.runTurn(artifacts.remediationJson);
  const evaluation = await submitPromise;
  await waitFor(() => results.length === 1, "result");

  const retestId = await controller.startPractice({ ...request, isRetest: true }, "来源文本：纵坐标轴表示数值量级…", "课程.pdf · 第 3 页");
  const retestCreatingRun = runtime.lastRunId;
  runtime.runTurn(artifacts.questionJson);
  await waitNextRun(runtime, retestCreatingRun);
  const retestVerifyingRun = runtime.lastRunId;
  runtime.runTurn(artifacts.verifierJson);
  await waitFor(() => questions.length === 2, "retestReady");

  const retestSubmit = controller.submitAnswer({ practiceId: retestId, optionId: "B", reasoning: "纵轴承载数值，因此是量级尺度。" });
  await tick();
  if (runtime.lastRunId === retestVerifyingRun) throw new Error("evaluating did not start for retest");
  runtime.runTurn(artifacts.reasoningRightJson);
  const retestEvaluation = await retestSubmit;
  await waitFor(() => results.length === 2, "retestResult");

  const result = results[1];
  const wrongResult = results[0];
  if (!result || !wrongResult) throw new Error("missing practice results");

  return {
    pass: evaluation.correct === false
      && evaluation.remediationRequired === true
      && Boolean(retestEvaluation.correct)
      && retestEvaluation.reasoningReview.reasoningCorrect === true
      && result.remediation === null
      && result.mastery.level >= 3
      && wrongResult.remediation !== null,
    questionStem: questions[0]?.stem ?? "",
    wrongAnswerCorrect: evaluation.correct,
    remediationCause: wrongResult.remediation?.cause ?? "",
    retestMasteryLevel: result.mastery.level,
    retestEvidenceCount: result.mastery.evidenceCount,
    phaseLog,
  };
}
