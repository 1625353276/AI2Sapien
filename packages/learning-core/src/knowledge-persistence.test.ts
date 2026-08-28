import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeKnowledgePersistence } from "./knowledge-persistence.js";

describe("normalizeKnowledgePersistence", () => {
  it("migrates schemaVersion 1 data safely (no checkpoints yet) without crashing", () => {
    const legacy = {
      schemaVersion: 1,
      concepts: [{ id: "concept-1", courseId: "course-1", title: "坐标轴", aliases: [], summary: "说明。", sources: [], evidenceRefs: [], createdAt: "", updatedAt: "" }],
      extractions: [{ extractionId: "kex-1", courseId: "course-1" }],
    };
    const normalized = normalizeKnowledgePersistence(legacy);
    assert.equal(normalized.schemaVersion, 2);
    assert.deepEqual(normalized.batchCheckpoints, []);
    assert.equal(normalized.concepts.length, 1);
    assert.equal(normalized.concepts[0]!.title, "坐标轴");
    assert.equal(normalized.extractions.length, 1);
  });

  it("passes a schemaVersion 2 database through unchanged", () => {
    const current = {
      schemaVersion: 2,
      concepts: [],
      extractions: [{ extractionId: "kex-2" }],
      batchCheckpoints: [
        { courseId: "course-1", batchId: "b", documentId: "d", sourceVersion: "v1", sourceLabel: "第 1 页", displayName: "d", pageNumbers: [1], status: "succeeded", concepts: [], error: null, startedAt: "", updatedAt: "" },
      ],
    };
    const normalized = normalizeKnowledgePersistence(current);
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.batchCheckpoints.length, 1);
  });

  it("rejects malformed or unknown structures", () => {
    assert.throws(() => normalizeKnowledgePersistence("not an object"), /结构无效/);
    assert.throws(() => normalizeKnowledgePersistence({ schemaVersion: 3 }), /版本无效/);
    assert.throws(() => normalizeKnowledgePersistence({ schemaVersion: 1, concepts: "nope", extractions: [] }), /结构无效/);
  });
});
