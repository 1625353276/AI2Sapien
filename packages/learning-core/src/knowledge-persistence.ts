import type { KnowledgeConcept } from "@ai2sapien/contracts";

import type { BatchCheckpoint, BatchDocument, BatchPageRef } from "./knowledge-extraction.js";

/**
 * Normalized in-memory shape of the persisted knowledge database. This is the
 * storage contract shared between Learning Core (which owns the checkpoint schema
 * and migration rules) and the desktop store (which owns only the fs I/O).
 *
 * Schema v3 moved batch checkpoints from a single-document shape to a
 * multi-document shape: a checkpoint records all participating documents (with
 * sourceVersion/displayName) plus the page references they cover, and never
 * persists page text.
 */
export interface KnowledgePersistenceData {
  schemaVersion: 3;
  concepts: KnowledgeConcept[];
  extractions: unknown[];
  batchCheckpoints: BatchCheckpoint[];
}

/**
 * Backward-compatible loader for the knowledge database persisted on disk.
 *
 * - schemaVersion 1 has no batch checkpoints: it migrates in place by adding an
 *   empty checkpoint list, so existing v1 knowledge.json data keeps loading.
 * - schemaVersion 2 has single-document batch checkpoints: structurally valid
 *   entries are converted to the v3 multi-document shape. They are intentionally
 *   NOT reusable (new batch ids differ), but the conversion keeps the database
 *   safe to open. Malformed entries are dropped rather than crashing the app.
 * - schemaVersion 3 is normalized in place; malformed or unsafe checkpoints are
 *   filtered out.
 */
export function normalizeKnowledgePersistence(value: unknown): KnowledgePersistenceData {
  if (!isRecord(value)) throw new Error("知识库数据库结构无效。");

  if (value.schemaVersion === 1) {
    if (!Array.isArray(value.concepts) || !Array.isArray(value.extractions)) {
      throw new Error("知识库数据库结构无效。");
    }
    return {
      schemaVersion: 3,
      concepts: normalizeConcepts(value.concepts),
      extractions: value.extractions as unknown[],
      batchCheckpoints: [],
    };
  }

  if (value.schemaVersion === 2) {
    if (
      !Array.isArray(value.concepts) ||
      !Array.isArray(value.extractions) ||
      !Array.isArray(value.batchCheckpoints)
    ) {
      throw new Error("知识库数据库结构无效。");
    }
    return {
      schemaVersion: 3,
      concepts: normalizeConcepts(value.concepts),
      extractions: value.extractions as unknown[],
      batchCheckpoints: (value.batchCheckpoints as unknown[]).map(sanitizeCheckpointV2).filter(isCheckpoint),
    };
  }

  if (value.schemaVersion === 3) {
    if (
      !Array.isArray(value.concepts) ||
      !Array.isArray(value.extractions) ||
      !Array.isArray(value.batchCheckpoints)
    ) {
      throw new Error("知识库数据库结构无效。");
    }
    return {
      schemaVersion: 3,
      concepts: normalizeConcepts(value.concepts),
      extractions: value.extractions as unknown[],
      batchCheckpoints: (value.batchCheckpoints as unknown[]).map(sanitizeCheckpointV3).filter(isCheckpoint),
    };
  }

  throw new Error("知识库数据库版本无效。");
}

/**
 * Convert a schema v2 (single-document) checkpoint to the v3 shape. Returns null
 * when the entry is not a structurally valid single-document checkpoint so the
 * app never crashes on malformed stored data.
 */
function sanitizeCheckpointV2(value: unknown): BatchCheckpoint | null {
  if (!isRecord(value)) return null;
  const courseId = readString(value.courseId);
  const batchId = readString(value.batchId);
  const documentId = readString(value.documentId);
  const sourceVersion = readString(value.sourceVersion);
  const displayName = readString(value.displayName);
  if (!courseId || !batchId || !documentId || !sourceVersion || !displayName) return null;
  if (value.status !== "succeeded" && value.status !== "failed") return null;

  const pageNumbers = readPositiveIntegers(value.pageNumbers);
  if (pageNumbers.length === 0) return null;
  if (!Array.isArray(value.concepts)) return null;

  return {
    courseId,
    batchId,
    documents: [{ documentId, sourceVersion, displayName }],
    pageRefs: pageNumbers.map((pageNumber) => ({ documentId, pageNumber })),
    status: value.status,
    concepts: readConcepts(value.concepts),
    error: typeof value.error === "string" ? value.error : null,
    startedAt: readString(value.startedAt) ?? "",
    updatedAt: readString(value.updatedAt) ?? "",
  };
}

/**
 * Sanitize a schema v3 checkpoint. Returns null when the entry is malformed or
 * unsafe (missing ids, no participating documents, or no page references) so the
 * app never crashes on corrupted stored data.
 */
function sanitizeCheckpointV3(value: unknown): BatchCheckpoint | null {
  if (!isRecord(value)) return null;
  const courseId = readString(value.courseId);
  const batchId = readString(value.batchId);
  if (!courseId || !batchId) return null;
  if (value.status !== "succeeded" && value.status !== "failed") return null;

  const documents = Array.isArray(value.documents) ? value.documents.map(sanitizeBatchDocument).filter(isDocument) : [];
  if (documents.length === 0) return null;

  const pageRefs = Array.isArray(value.pageRefs) ? value.pageRefs.map(sanitizePageRef).filter(isPageRef) : [];
  if (pageRefs.length === 0) return null;
  if (!Array.isArray(value.concepts)) return null;

  return {
    courseId,
    batchId,
    documents,
    pageRefs,
    status: value.status,
    concepts: readConcepts(value.concepts),
    error: typeof value.error === "string" ? value.error : null,
    startedAt: readString(value.startedAt) ?? "",
    updatedAt: readString(value.updatedAt) ?? "",
  };
}

function sanitizeBatchDocument(value: unknown): BatchDocument | null {
  if (!isRecord(value)) return null;
  const documentId = readString(value.documentId);
  const sourceVersion = readString(value.sourceVersion);
  const displayName = readString(value.displayName);
  if (!documentId || !sourceVersion || !displayName) return null;
  return { documentId, sourceVersion, displayName };
}

function sanitizePageRef(value: unknown): BatchPageRef | null {
  if (!isRecord(value)) return null;
  const documentId = readString(value.documentId);
  const pageNumber = value.pageNumber;
  if (!documentId || typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) return null;
  return { documentId, pageNumber };
}

function readConcepts(value: unknown): BatchCheckpoint["concepts"] {
  if (!Array.isArray(value)) return [];
  return value as BatchCheckpoint["concepts"];
}

/**
 * Evidence stored before schema v3 identified its page but inherited the
 * document from the enclosing source. Materialize that documentId while loading
 * so old knowledge maps remain compatible with the stricter v3 contract.
 */
function normalizeConcepts(value: unknown[]): KnowledgeConcept[] {
  return value.map((concept) => {
    if (!isRecord(concept) || !Array.isArray(concept.sources)) return concept as KnowledgeConcept;
    const sources = concept.sources.map((source) => {
      if (!isRecord(source) || !Array.isArray(source.evidence)) return source;
      const sourceDocumentId = readString(source.documentId);
      if (!sourceDocumentId) return source;
      const evidence = source.evidence.map((entry) => {
        if (!isRecord(entry)) return entry;
        return { ...entry, documentId: readString(entry.documentId) ?? sourceDocumentId };
      });
      return { ...source, evidence };
    });
    return { ...concept, sources } as KnowledgeConcept;
  });
}

function readPositiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const result: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 1) {
      result.push(item);
      continue;
    }
    if (typeof item === "string" && /^\d+$/.test(item)) result.push(Number(item));
  }
  return result;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckpoint(value: BatchCheckpoint | null): value is BatchCheckpoint {
  return value !== null;
}

function isDocument(value: BatchDocument | null): value is BatchDocument {
  return value !== null;
}

function isPageRef(value: BatchPageRef | null): value is BatchPageRef {
  return value !== null;
}
