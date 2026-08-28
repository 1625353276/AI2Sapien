import type { KnowledgeConcept } from "@ai2sapien/contracts";

import type { BatchCheckpoint } from "./knowledge-extraction.js";

/**
 * Normalized in-memory shape of the persisted knowledge database. This is the
 * storage contract shared between Learning Core (which owns the checkpoint schema
 * and migration rules) and the desktop store (which owns only the fs I/O).
 */
export interface KnowledgePersistenceData {
  schemaVersion: 2;
  concepts: KnowledgeConcept[];
  extractions: unknown[];
  batchCheckpoints: BatchCheckpoint[];
}

/**
 * Backward-compatible loader for the knowledge database persisted on disk.
 * schemaVersion 1 has no batch checkpoints; it migrates in place by adding an
 * empty checkpoint list, so existing v1 knowledge.json data keeps loading safely.
 * A v2 database returns as-is (when it has the expected arrays).
 */
export function normalizeKnowledgePersistence(value: unknown): KnowledgePersistenceData {
  if (!isRecord(value)) throw new Error("知识库数据库结构无效。");

  if (value.schemaVersion === 1) {
    if (!Array.isArray(value.concepts) || !Array.isArray(value.extractions)) {
      throw new Error("知识库数据库结构无效。");
    }
    return {
      schemaVersion: 2,
      concepts: value.concepts as KnowledgeConcept[],
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
      schemaVersion: 2,
      concepts: value.concepts as KnowledgeConcept[],
      extractions: value.extractions as unknown[],
      batchCheckpoints: value.batchCheckpoints as BatchCheckpoint[],
    };
  }

  throw new Error("知识库数据库版本无效。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
