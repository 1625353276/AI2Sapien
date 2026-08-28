import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Id,
  IsoDateTime,
  KnowledgeConcept,
  KnowledgeExtractionResult,
} from "@ai2sapien/contracts";
import {
  normalizeKnowledgePersistence,
  type BatchCheckpoint,
  type KnowledgeExtractionStorePort,
} from "@ai2sapien/learning-core";

interface KnowledgeDatabase {
  schemaVersion: 3;
  concepts: KnowledgeConcept[];
  extractions: StoredExtraction[];
  batchCheckpoints: BatchCheckpoint[];
}

interface StoredExtraction extends KnowledgeExtractionResult {
  _syncedAt: IsoDateTime;
}

const EMPTY_DATABASE: KnowledgeDatabase = {
  schemaVersion: 3,
  concepts: [],
  extractions: [],
  batchCheckpoints: [],
};

export class KnowledgeStore implements KnowledgeExtractionStorePort {
  readonly #rootDirectory: string;
  readonly #databasePath: string;
  #database: KnowledgeDatabase = structuredClone(EMPTY_DATABASE);
  #initialized: Promise<void> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
    this.#databasePath = join(rootDirectory, "knowledge.json");
  }

  initialize(): Promise<void> {
    if (!this.#initialized) this.#initialized = this.#initializeInternal();
    return this.#initialized;
  }

  async listConcepts(courseId: string): Promise<KnowledgeConcept[]> {
    await this.initialize();
    return this.#database.concepts
      .filter((concept) => concept.courseId === courseId)
      .map((concept) => structuredClone(concept));
  }

  async saveConcepts(courseId: string, concepts: KnowledgeConcept[]): Promise<void> {
    await this.initialize();
    this.#database.concepts = this.#database.concepts.filter((concept) => concept.courseId !== courseId);
    this.#database.concepts.push(...concepts.map((concept) => structuredClone(concept)));
    await this.#persist();
  }

  async saveResult(result: KnowledgeExtractionResult): Promise<void> {
    await this.initialize();
    const index = this.#database.extractions.findIndex(
      (extraction) => extraction.extractionId === result.extractionId,
    );
    const stored: StoredExtraction = { ...result, _syncedAt: new Date().toISOString() };
    if (index >= 0) this.#database.extractions[index] = stored;
    else this.#database.extractions.push(stored);
    await this.#persist();
  }

  async getResult(extractionId: string): Promise<KnowledgeExtractionResult | null> {
    await this.initialize();
    const stored = this.#database.extractions.find((extraction) => extraction.extractionId === extractionId);
    return stored ? stripSyncMeta(stored) : null;
  }

  async listBatchCheckpoints(courseId: Id): Promise<BatchCheckpoint[]> {
    await this.initialize();
    return this.#database.batchCheckpoints
      .filter((checkpoint) => checkpoint.courseId === courseId)
      .map((checkpoint) => structuredClone(checkpoint));
  }

  async saveBatchCheckpoint(checkpoint: BatchCheckpoint): Promise<void> {
    await this.initialize();
    const index = this.#database.batchCheckpoints.findIndex(
      (candidate) => candidate.courseId === checkpoint.courseId && candidate.batchId === checkpoint.batchId,
    );
    const stored = structuredClone(checkpoint);
    if (index >= 0) this.#database.batchCheckpoints[index] = stored;
    else this.#database.batchCheckpoints.push(stored);
    await this.#persist();
  }

  async pruneBatchCheckpoints(courseId: Id, retainedBatchIds: string[]): Promise<void> {
    await this.initialize();
    const retained = new Set(retainedBatchIds);
    const before = this.#database.batchCheckpoints.length;
    this.#database.batchCheckpoints = this.#database.batchCheckpoints.filter(
      (checkpoint) => checkpoint.courseId !== courseId || retained.has(checkpoint.batchId),
    );
    if (this.#database.batchCheckpoints.length !== before) await this.#persist();
  }

  async listExtractions(courseId: Id): Promise<KnowledgeExtractionResult[]> {
    await this.initialize();
    return this.#database.extractions
      .filter((extraction) => extraction.courseId === courseId)
      .map(stripSyncMeta)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async #initializeInternal(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#databasePath, "utf8")) as unknown;
      const normalized = normalizeKnowledgePersistence(parsed);
      this.#database = {
        schemaVersion: 3,
        concepts: normalized.concepts.map((concept) => structuredClone(concept)),
        extractions: normalized.extractions as StoredExtraction[],
        batchCheckpoints: normalized.batchCheckpoints.map((checkpoint) => structuredClone(checkpoint)),
      };
    } catch (error) {
      const code = isNodeError(error) ? error.code : null;
      if (code !== "ENOENT") throw error;
      this.#database = structuredClone(EMPTY_DATABASE);
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      await mkdir(this.#rootDirectory, { recursive: true });
      const temporaryPath = `${this.#databasePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.#database, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.#databasePath);
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

function stripSyncMeta(extraction: StoredExtraction): KnowledgeExtractionResult {
  const { _syncedAt: _syncedAt, ...publicResult } = extraction;
  return publicResult;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
