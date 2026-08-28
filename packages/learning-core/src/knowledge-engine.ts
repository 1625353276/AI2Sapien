import type {
  Id,
  KnowledgeAnalysisState,
  KnowledgeConcept,
  KnowledgeExtractionProgress,
  KnowledgeExtractionResult,
} from "@ai2sapien/contracts";

import type { ClockPort, IdPort } from "./index.js";
import {
  batchLabel,
  buildBatches,
  collectPageRefs,
  materialAnalystInstructions,
  materialAnalystPrompt,
  parseMaterialAnalysis,
  rebuildConceptMap,
  validateConceptEvidence,
  validateMaterialConcept,
  type BatchCheckpoint,
  type BatchDocument,
  type ConceptOccurrence,
  type MaterialBatch,
  type MaterialDocument,
  type MaterialPage,
} from "./knowledge-extraction.js";

/**
 * Provider-neutral stream event. This is a structural subset of the events the
 * real {@link import("@ai2sapien/model-providers").ModelRuntime} emits, so a live
 * ModelRuntime satisfies the port without leaking Codex protocol types here.
 */
export interface ModelStreamEvent {
  sessionId: string;
  runId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  delta: string;
  message: string | null;
}

/**
 * Provider-neutral model port owned by Learning Core. Codex/tenant protocol
 * types must never cross this boundary.
 */
export interface MaterialAnalystPort {
  createSession(system: string): Promise<string>;
  sendTurn(
    sessionId: string,
    request: { system: string; messages: Array<{ role: string; content: string }> },
  ): Promise<string>;
  onTurnEvent(listener: (event: ModelStreamEvent) => void): () => void;
}

export interface KnowledgeExtractionStorePort {
  listConcepts(courseId: Id): Promise<KnowledgeConcept[]>;
  saveConcepts(courseId: Id, concepts: KnowledgeConcept[]): Promise<void>;
  saveResult(result: KnowledgeExtractionResult): Promise<void>;
  getResult(extractionId: Id): Promise<KnowledgeExtractionResult | null>;
  listBatchCheckpoints(courseId: Id): Promise<BatchCheckpoint[]>;
  saveBatchCheckpoint(checkpoint: BatchCheckpoint): Promise<void>;
  pruneBatchCheckpoints(courseId: Id, retainedBatchIds: string[]): Promise<void>;
}

export interface KnowledgeExtractionInput {
  courseId: string;
  documents: MaterialDocument[];
  pages: MaterialPage[];
}

export type KnowledgeProgressListener = (progress: KnowledgeExtractionProgress) => void;

export const MAX_CONCURRENT_BATCHES = 3;
export const BATCH_TURN_TIMEOUT_MS = 300_000;

export class ExtractionCancelledError extends Error {
  constructor() {
    super("知识提取已取消。");
    this.name = "ExtractionCancelledError";
  }
}

export class KnowledgeExtractionEngine {
  readonly #port: MaterialAnalystPort;
  readonly #store: KnowledgeExtractionStorePort;
  readonly #clock: ClockPort;
  readonly #ids: IdPort;
  readonly #progressListeners = new Set<KnowledgeProgressListener>();

  constructor(port: MaterialAnalystPort, store: KnowledgeExtractionStorePort, clock: ClockPort, ids: IdPort) {
    this.#port = port;
    this.#store = store;
    this.#clock = clock;
    this.#ids = ids;
  }

  onProgress(listener: KnowledgeProgressListener): () => void {
    this.#progressListeners.add(listener);
    return () => this.#progressListeners.delete(listener);
  }

  /**
   * Analyze the whole course. Completed batches are reused from persisted
   * checkpoints; only pending batches (failed, never settled, or belonging to a
   * changed document) are sent to the model, with at most {@link MAX_CONCURRENT_BATCHES}
   * requests in flight. Every settled batch is checkpointed immediately.
   */
  async run(
    input: KnowledgeExtractionInput,
    extractionId: Id,
    signal?: AbortSignal,
  ): Promise<KnowledgeExtractionResult> {
    const courseId = input.courseId;
    const startedAt = this.#clock.now().toISOString();

    this.#emitProgress(courseId, extractionId, "queued", 0, 0, null);
    this.#emitProgress(courseId, extractionId, "chunking", 0, 0, null);

    const batches = buildBatches(input.documents, input.pages);
    const total = batches.length;
    this.#emitProgress(courseId, extractionId, "analyzing", 0, total, null);

    if (total === 0) {
      throw new Error("课程资料中没有可用于知识提取的嵌入文本。");
    }

    await this.#store.pruneBatchCheckpoints(courseId, batches.map((batch) => batch.batchId));

    const checkpoints = await this.#store.listBatchCheckpoints(courseId);
    const batchById = new Map(batches.map((batch) => [batch.batchId, batch]));
    const reusableByBatch = new Map<string, BatchCheckpoint>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.status !== "succeeded") continue;
      const batch = batchById.get(checkpoint.batchId);
      if (!batch) continue;
      const validatedConcepts = validateCheckpointConcepts(checkpoint, batch);
      if (!validatedConcepts) continue;
      const reusableCheckpoint = { ...checkpoint, concepts: validatedConcepts };
      const current = reusableByBatch.get(checkpoint.batchId);
      if (!current || checkpoint.updatedAt > current.updatedAt) reusableByBatch.set(checkpoint.batchId, reusableCheckpoint);
    }

    const pending: MaterialBatch[] = [];
    let reusedCount = 0;
    for (const batch of batches) {
      if (reusableByBatch.has(batch.batchId)) {
        reusedCount += 1;
      } else {
        pending.push(batch);
      }
    }

    const system = materialAnalystInstructions();
    let settledCount = reusedCount;
    let failedCount = 0;

    this.#emitProgress(courseId, extractionId, "analyzing", settledCount, total, reusedCount > 0 ? "正在复用已完成的资料批次。" : null);

    let nextIndex = 0;
    const work = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) throw new ExtractionCancelledError();
        const position = nextIndex;
        nextIndex += 1;
        if (position >= pending.length) return;

        const batch = pending[position]!;
        try {
          const sessionId = await this.#port.createSession(system);
          const reply = await collectTurnReply(
            this.#port,
            sessionId,
            system,
            materialAnalystPrompt(batch),
            BATCH_TURN_TIMEOUT_MS,
            signal,
          );
          const parsed = parseMaterialAnalysis(reply, batch);
          if (!parsed.valid) throw new Error(parsed.errors.join("；"));
          await this.#store.saveBatchCheckpoint(checkpointFor(batch, input.courseId, "succeeded", parsed.concepts, null, this.#clock));
        } catch (error) {
          if (signal?.aborted) throw new ExtractionCancelledError();
          failedCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          await this.#store.saveBatchCheckpoint(checkpointFor(batch, input.courseId, "failed", [], message, this.#clock));
        }
        settledCount += 1;
        this.#emitProgress(courseId, extractionId, "analyzing", settledCount, total, batchLabel(batch));
      }
    };

    const workerCount = Math.min(MAX_CONCURRENT_BATCHES, pending.length);
    const workers = Array.from({ length: workerCount }, () => work());
    const workerResults = await Promise.allSettled(workers);
    const rejected = workerResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected.some((result) => result.reason instanceof ExtractionCancelledError)) {
      await this.#persistPartialMap(batches, input.courseId);
      throw new ExtractionCancelledError();
    }
    if (rejected.length > 0) {
      throw rejected[0]!.reason;
    }

    this.#emitProgress(courseId, extractionId, "merging", total, total, null);
    const concepts = await this.#persistConceptMap(batches, input.courseId);

    const result: KnowledgeExtractionResult = {
      extractionId,
      courseId,
      concepts,
      chunkCount: total,
      analyzedChunkCount: total - failedCount,
      failedChunkCount: failedCount,
      reusedBatchCount: reusedCount,
      startedAt,
      completedAt: this.#clock.now().toISOString(),
    };
    await this.#store.saveResult(result);

    this.#emitProgress(courseId, extractionId, "succeeded", total, total, null);
    return result;
  }

  async #persistPartialMap(batches: readonly MaterialBatch[], courseId: Id): Promise<void> {
    await this.#persistConceptMap(batches, courseId);
  }

  async #persistConceptMap(batches: readonly MaterialBatch[], courseId: Id): Promise<KnowledgeConcept[]> {
    const occurrences = await this.#collectOccurrences(batches, courseId);
    const existing = await this.#store.listConcepts(courseId);
    const concepts = rebuildConceptMap(
      courseId,
      occurrences,
      existing,
      (prefix) => this.#ids.next(prefix),
      () => this.#clock.now().toISOString(),
    );
    await this.#store.saveConcepts(courseId, concepts);
    return concepts;
  }

  async #collectOccurrences(batches: readonly MaterialBatch[], courseId: Id): Promise<ConceptOccurrence[]> {
    const checkpoints = await this.#store.listBatchCheckpoints(courseId);
    const byBatchId = new Map<string, BatchCheckpoint>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.status !== "succeeded") continue;
      const current = byBatchId.get(checkpoint.batchId);
      if (!current || checkpoint.updatedAt > current.updatedAt) byBatchId.set(checkpoint.batchId, checkpoint);
    }

    const occurrences: ConceptOccurrence[] = [];
    for (const batch of batches) {
      const checkpoint = byBatchId.get(batch.batchId);
      if (!checkpoint) continue;
      const validatedConcepts = validateCheckpointConcepts(checkpoint, batch);
      if (!validatedConcepts) continue;
      for (const draft of validatedConcepts) {
        occurrences.push({
          draft,
          batchId: batch.batchId,
          documents: batch.documents.map((document) => ({ ...document })),
        });
      }
    }
    return occurrences;
  }

  #emitProgress(
    courseId: string,
    extractionId: string,
    phase: KnowledgeExtractionProgress["phase"],
    current: number,
    total: number,
    message: string | null,
  ): void {
    const progress: KnowledgeExtractionProgress = {
      courseId,
      extractionId,
      phase,
      current,
      total,
      message,
      occurredAt: this.#clock.now().toISOString(),
    };
    for (const listener of this.#progressListeners) listener(progress);
  }
}

export function summarizeKnowledgeAnalysisState(
  courseId: Id,
  batches: readonly MaterialBatch[],
  checkpoints: readonly BatchCheckpoint[],
): KnowledgeAnalysisState {
  const batchById = new Map(batches.map((batch) => [batch.batchId, batch]));
  const latestByBatch = new Map<string, BatchCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.courseId !== courseId || !batchById.has(checkpoint.batchId)) continue;
    const current = latestByBatch.get(checkpoint.batchId);
    if (!current || checkpoint.updatedAt > current.updatedAt) latestByBatch.set(checkpoint.batchId, checkpoint);
  }

  let completedBatchCount = 0;
  let failedBatchCount = 0;
  let updatedAt: string | null = null;
  for (const [batchId, checkpoint] of latestByBatch) {
    const batch = batchById.get(batchId)!;
    if (checkpoint.status === "succeeded" && validateCheckpointConcepts(checkpoint, batch)) {
      completedBatchCount += 1;
    } else if (checkpoint.status === "failed") {
      failedBatchCount += 1;
    }
    if (!updatedAt || checkpoint.updatedAt > updatedAt) updatedAt = checkpoint.updatedAt;
  }

  const pendingBatchCount = Math.max(0, batches.length - completedBatchCount);
  return {
    courseId,
    totalBatchCount: batches.length,
    completedBatchCount,
    pendingBatchCount,
    failedBatchCount,
    canResume: pendingBatchCount > 0 && (completedBatchCount > 0 || failedBatchCount > 0),
    updatedAt,
  };
}

function validateCheckpointConcepts(
  checkpoint: BatchCheckpoint,
  batch: MaterialBatch,
): BatchCheckpoint["concepts"] | null {
  if (!checkpointMatchesBatch(checkpoint, batch)) return null;
  if (!Array.isArray(checkpoint.concepts)) return null;

  const concepts: BatchCheckpoint["concepts"] = [];
  for (const stored of checkpoint.concepts) {
    const structural = validateMaterialConcept(stored);
    if (!structural) return null;
    const supported = validateConceptEvidence(structural, batch);
    if (!supported) return null;
    concepts.push(supported);
  }
  return concepts;
}

function checkpointMatchesBatch(checkpoint: BatchCheckpoint, batch: MaterialBatch): boolean {
  if (checkpoint.documents.length !== batch.documents.length) return false;
  if (checkpoint.pageRefs.length !== collectPageRefs(batch).length) return false;

  const checkpointDocuments = [...checkpoint.documents].sort((left, right) => left.documentId.localeCompare(right.documentId));
  const batchDocuments = [...batch.documents].sort((left, right) => left.documentId.localeCompare(right.documentId));
  for (let index = 0; index < batchDocuments.length; index += 1) {
    const stored = checkpointDocuments[index]!;
    const current = batchDocuments[index]!;
    if (
      stored.documentId !== current.documentId ||
      stored.sourceVersion !== current.sourceVersion ||
      stored.displayName !== current.displayName
    ) return false;
  }

  const checkpointRefs = [...checkpoint.pageRefs].sort(comparePageRefs);
  const batchRefs = collectPageRefs(batch).sort(comparePageRefs);
  return checkpointRefs.every((stored, index) => {
    const current = batchRefs[index]!;
    return stored.documentId === current.documentId && stored.pageNumber === current.pageNumber;
  });
}

function comparePageRefs(
  left: { documentId: string; pageNumber: number },
  right: { documentId: string; pageNumber: number },
): number {
  return left.documentId.localeCompare(right.documentId) || left.pageNumber - right.pageNumber;
}

function checkpointFor(
  batch: MaterialBatch,
  courseId: Id,
  status: "succeeded" | "failed",
  concepts: BatchCheckpoint["concepts"],
  error: string | null,
  clock: ClockPort,
): BatchCheckpoint {
  const now = clock.now().toISOString();
  return {
    courseId,
    batchId: batch.batchId,
    documents: cloneDocuments(batch.documents),
    pageRefs: collectPageRefs(batch),
    status,
    concepts,
    error,
    startedAt: now,
    updatedAt: now,
  };
}

function cloneDocuments(documents: readonly BatchDocument[]): BatchDocument[] {
  return documents.map((document) => ({ ...document }));
}

/**
 * Collect a full, non-streamed reply for a single turn. Buffers the streaming
 * deltas for the run and settles on the terminal event. Correct for both the
 * Codex provider (runId known before stream) and OpenAI-compatible provider
 * (events precede the resolved runId). An optional abort signal rejects the
 * promise immediately and causes the run to stop.
 */
export function collectTurnReply(
  port: MaterialAnalystPort,
  sessionId: string,
  system: string,
  prompt: string,
  timeoutMs: number = BATCH_TURN_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let runId: string | null = null;
    let buffer = "";
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      reject(error);
    };

    const timeout = setTimeout(() => fail(new Error("材料分析超时。")), timeoutMs);

    const onAbort = (): void => fail(new ExtractionCancelledError());
    if (abortSignal) {
      if (abortSignal.aborted) {
        fail(new ExtractionCancelledError());
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    unsubscribe = port.onTurnEvent((event) => {
      if (settled) return;
      if (event.sessionId !== sessionId) return;
      if (runId !== null && event.runId !== runId) return;

      if (event.status === "running" && event.delta.length > 0) {
        buffer += event.delta;
        return;
      }
      if (event.status === "succeeded") {
        clearTimeout(timeout);
        unsubscribe?.();
        if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
        settled = true;
        resolve(buffer);
        return;
      }
      if (event.status === "failed" || event.status === "interrupted") {
        fail(new Error(event.message ?? "材料分析被中断。"));
      }
    });

    void port
      .sendTurn(sessionId, { system, messages: [{ role: "user", content: prompt }] })
      .then((assignedRunId: string) => {
        runId = assignedRunId;
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      });
  });
}
