import { randomUUID } from "node:crypto";

import type {
  Id,
  KnowledgeConcept,
  KnowledgeExtractionProgress,
  KnowledgeExtractionResult,
} from "@ai2sapien/contracts";
import {
  KnowledgeExtractionEngine,
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

    const port: MaterialAnalystPort = this.#modelRuntime;
    const engine = new KnowledgeExtractionEngine(port, this.#store, { now: () => new Date() }, {
      next: (prefix: string) => `${prefix}-${randomUUID()}`,
    });
    engine.onProgress((progress) => this.#emitProgress(progress));
    engine
      .run(material, extractionId)
      .then((result) => this.#emitComplete(result))
      .catch((error: unknown) => {
        this.#emitProgress({
          courseId,
          extractionId,
          phase: "failed",
          current: 0,
          total: 0,
          message: error instanceof Error ? error.message : String(error),
          occurredAt: new Date().toISOString(),
        });
      })
      .finally(() => {
        this.#activeCourses.delete(courseId);
      });

    return { extractionId };
  }

  listConcepts(courseId: Id): Promise<KnowledgeConcept[]> {
    return this.#store.listConcepts(courseId);
  }

  getResult(extractionId: Id): Promise<KnowledgeExtractionResult | null> {
    return this.#store.getResult(extractionId);
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
