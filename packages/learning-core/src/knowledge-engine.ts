import type {
  Id,
  IsoDateTime,
  KnowledgeConcept,
  KnowledgeExtractionProgress,
  KnowledgeExtractionResult,
} from "@ai2sapien/contracts";

import type { ClockPort, IdPort } from "./index.js";
import {
  materialAnalystInstructions,
  materialAnalystPrompt,
  mergeMaterialConcepts,
  parseMaterialAnalysis,
  splitSourceIntoChunks,
  type MaterialConceptDraft,
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
  listConcepts(courseId: string): Promise<KnowledgeConcept[]>;
  saveConcepts(courseId: string, concepts: KnowledgeConcept[]): Promise<void>;
  saveResult(result: KnowledgeExtractionResult): Promise<void>;
  getResult(extractionId: string): Promise<KnowledgeExtractionResult | null>;
}

export interface KnowledgeExtractionInput {
  courseId: string;
  documents: MaterialDocument[];
  pages: MaterialPage[];
}

export type KnowledgeProgressListener = (progress: KnowledgeExtractionProgress) => void;

const TURN_TIMEOUT_MS = 300_000;
const MAX_CHUNKS_PER_SESSION = 8;

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

  async run(input: KnowledgeExtractionInput, extractionId: Id): Promise<KnowledgeExtractionResult> {
    const courseId = input.courseId;
    const startedAt = this.#clock.now().toISOString();

    this.#emitProgress(courseId, extractionId, "queued", 0, 0, null);
    this.#emitProgress(courseId, extractionId, "chunking", 0, 0, null);
    const chunks = splitSourceIntoChunks(input.documents, input.pages);
    this.#emitProgress(courseId, extractionId, "analyzing", 0, chunks.length, null);

    if (chunks.length === 0) {
      throw new Error("课程资料中没有可用于知识提取的嵌入文本。");
    }

    const system = materialAnalystInstructions();
    let sessionId: string | null = null;
    let chunksInSession = 0;

    const drafts: MaterialConceptDraft[] = [];
    let analyzedChunkCount = 0;
    let failedChunkCount = 0;

    for (const [index, chunk] of chunks.entries()) {
      this.#emitProgress(courseId, extractionId, "analyzing", index + 1, chunks.length, chunk.sourceLabel);
      try {
        if (sessionId === null || chunksInSession >= MAX_CHUNKS_PER_SESSION) {
          sessionId = await this.#port.createSession(system);
          chunksInSession = 0;
        }
        const reply = await collectTurnReply(this.#port, sessionId, system, materialAnalystPrompt(chunk));
        const parsed = parseMaterialAnalysis(reply);
        if (!parsed.valid) throw new Error(parsed.errors.join("；"));
        for (const draft of parsed.concepts) drafts.push({ ...draft, sourceChunkId: chunk.chunkId });
        analyzedChunkCount += 1;
        chunksInSession += 1;
      } catch {
        failedChunkCount += 1;
        sessionId = null;
        chunksInSession = 0;
      }
    }

    if (analyzedChunkCount === 0) {
      throw new Error("所有资料片段均未能通过模型分析与结构校验。");
    }

    this.#emitProgress(courseId, extractionId, "merging", chunks.length, chunks.length, null);
    const existing = await this.#store.listConcepts(courseId);
    const chunkByIndex = new Map(chunks.map((chunk, index) => [chunk.chunkId, index]));
    const inputs = drafts.map((draft) => {
      const chunkIndex = chunkByIndex.get(draft.sourceChunkId) ?? 0;
      return { draft, chunk: chunks[chunkIndex]! };
    });
    const concepts = mergeMaterialConcepts(
      courseId,
      inputs,
      existing,
      (prefix) => this.#ids.next(prefix),
      () => this.#clock.now().toISOString(),
    );
    await this.#store.saveConcepts(courseId, concepts);

    const result: KnowledgeExtractionResult = {
      extractionId,
      courseId,
      concepts,
      chunkCount: chunks.length,
      analyzedChunkCount,
      failedChunkCount,
      startedAt,
      completedAt: this.#clock.now().toISOString(),
    };
    await this.#store.saveResult(result);

    this.#emitProgress(courseId, extractionId, "succeeded", chunks.length, chunks.length, null);
    return result;
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

/**
 * Collect a full, non-streamed reply for a single turn. Buffers the streaming
 * deltas for the run and settles on the terminal event. Correct for both the
 * Codex provider (runId known before stream) and OpenAI-compatible provider
 * (events precede the resolved runId).
 */
export function collectTurnReply(
  port: MaterialAnalystPort,
  sessionId: string,
  system: string,
  prompt: string,
  timeoutMs: number = TURN_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let runId: string | null = null;
    let buffer = "";
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new Error("材料分析超时。"));
    }, timeoutMs);

    unsubscribe = port.onTurnEvent((event) => {
      if (settled) return;
      if (event.sessionId !== sessionId) return;
      if (runId !== null && event.runId !== runId) return;

      if (event.status === "running" && event.delta.length > 0) {
        buffer += event.delta;
        return;
      }
      if (event.status === "succeeded") {
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(buffer);
        return;
      }
      if (event.status === "failed" || event.status === "interrupted") {
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        reject(new Error(event.message ?? "材料分析被中断。"));
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
        reject(error);
      });
  });
}
