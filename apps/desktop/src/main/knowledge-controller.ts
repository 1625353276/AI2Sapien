import { randomUUID } from "node:crypto";

import type {
  Id,
  KnowledgeAnalysisState,
  KnowledgeConcept,
  KnowledgeExtractionProgress,
  KnowledgeExtractionResult,
} from "@ai2sapien/contracts";
import {
  ExtractionCancelledError,
  KnowledgeExtractionEngine,
  buildBatches,
  summarizeKnowledgeAnalysisState,
  type KnowledgeExtractionStorePort,
  type MaterialAnalystPort,
  type MaterialDocument,
  type MaterialPage,
} from "@ai2sapien/learning-core";
import type { ModelRuntime } from "@ai2sapien/model-providers";

import type { LibraryStore } from "./library-store.js";
import type { KnowledgeStore } from "./knowledge-store.js";

type ProgressListener = (progress: KnowledgeExtractionProgress) => void;
type CompleteListener = (result: KnowledgeExtractionResult) => void;

export class KnowledgeController {
  readonly #modelRuntime: ModelRuntime;
  readonly #library: LibraryStore;
  readonly #store: KnowledgeExtractionStorePort;
  readonly #progressListeners = new Set<ProgressListener>();
  readonly #completeListeners = new Set<CompleteListener>();
  readonly #activeCourses = new Set<Id>();
  readonly #cancellators = new Map<Id, AbortController>();

  constructor(modelRuntime: ModelRuntime, library: LibraryStore, store: KnowledgeExtractionStorePort) {
    this.#modelRuntime = modelRuntime;
    this.#library = library;
    this.#store = store;
  }

  onKnowledgeProgress(listener: ProgressListener): () => void {
    this.#progressListeners.add(listener);
    return () => this.#progressListeners.delete(listener);
  }

  onKnowledgeComplete(listener: CompleteListener): () => void {
    this.#completeListeners.add(listener);
    return () => this.#completeListeners.delete(listener);
  }

  async startExtraction(courseId: Id): Promise<{ extractionId: Id }> {
    if (this.#activeCourses.has(courseId)) {
      throw new Error("该课程的知识提取正在进行中。");
    }
    const material = await this.#readMaterial(courseId);
    const extractionId = randomUUID();
    this.#activeCourses.add(courseId);
    const cancellator = new AbortController();
    this.#cancellators.set(courseId, cancellator);

    const port: MaterialAnalystPort = this.#modelRuntime;
    const engine = new KnowledgeExtractionEngine(port, this.#store, { now: () => new Date() }, {
      next: (prefix: string) => `${prefix}-${randomUUID()}`,
    });
    engine.onProgress((progress) => this.#emitProgress(progress));
    engine
      .run(material, extractionId, cancellator.signal)
      .then((result) => this.#emitComplete(result))
      .catch((error: unknown) => {
        if (error instanceof ExtractionCancelledError) {
          this.#emitProgress({
            courseId,
            extractionId,
            phase: "cancelled",
            current: 0,
            total: 0,
            message: "知识提取已取消，已完成的部分会保留并可在下次开始时继续。",
            occurredAt: new Date().toISOString(),
          });
        } else {
          this.#emitProgress({
            courseId,
            extractionId,
            phase: "failed",
            current: 0,
            total: 0,
            message: error instanceof Error ? error.message : String(error),
            occurredAt: new Date().toISOString(),
          });
        }
      })
      .finally(() => {
        this.#activeCourses.delete(courseId);
        this.#cancellators.delete(courseId);
      });

    return { extractionId };
  }

  cancelExtraction(courseId: Id): void {
    if (!this.#activeCourses.has(courseId)) {
      throw new Error("该课程当前没有进行中的知识提取。");
    }
    this.#cancellators.get(courseId)?.abort();
  }

  listConcepts(courseId: Id): Promise<KnowledgeConcept[]> {
    return this.#store.listConcepts(courseId);
  }

  getResult(extractionId: Id): Promise<KnowledgeExtractionResult | null> {
    return this.#store.getResult(extractionId);
  }

  async getAnalysisState(courseId: Id): Promise<KnowledgeAnalysisState> {
    const material = await this.#readMaterial(courseId);
    const batches = buildBatches(material.documents, material.pages);
    const checkpoints = await this.#store.listBatchCheckpoints(courseId);
    return summarizeKnowledgeAnalysisState(courseId, batches, checkpoints);
  }

  async #readMaterial(courseId: Id): Promise<{ courseId: Id; documents: MaterialDocument[]; pages: MaterialPage[] }> {
    const documents = await this.#library.listDocuments(courseId);
    if (documents.length === 0) {
      throw new Error("该课程还没有可分析的资料，请先导入 PDF。");
    }

    const materialDocuments: MaterialDocument[] = [];
    const pages: MaterialPage[] = [];
    for (const document of documents) {
      const detail = await this.#library.readDocument(document.id);
      materialDocuments.push({
        documentId: document.id,
        sourceVersion: document.sourceVersion,
        displayName: document.displayName,
      });
      for (const page of detail.pages) {
        pages.push({
          documentId: page.documentId,
          sourceVersion: page.sourceVersion,
          pageNumber: page.pageNumber,
          text: page.text,
        });
      }
    }

    return { courseId, documents: materialDocuments, pages };
  }

  #emitProgress(progress: KnowledgeExtractionProgress): void {
    for (const listener of this.#progressListeners) listener(progress);
  }

  #emitComplete(result: KnowledgeExtractionResult): void {
    for (const listener of this.#completeListeners) listener(result);
  }
}
