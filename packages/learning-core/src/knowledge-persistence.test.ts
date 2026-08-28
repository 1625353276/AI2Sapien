import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeKnowledgePersistence } from "./knowledge-persistence.js";

describe("normalizeKnowledgePersistence", () => {
  it("migrates schemaVersion 1 data safely (no checkpoints yet) to v3 without crashing", () => {
    const legacy = {
      schemaVersion: 1,
      concepts: [{ id: "concept-1", courseId: "course-1", title: "坐标轴", aliases: [], summary: "说明。", sources: [], evidenceRefs: [], createdAt: "", updatedAt: "" }],
      extractions: [{ extractionId: "kex-1", courseId: "course-1" }],
    };
    const normalized = normalizeKnowledgePersistence(legacy);
    assert.equal(normalized.schemaVersion, 3);
    assert.deepEqual(normalized.batchCheckpoints, []);
    assert.equal(normalized.concepts.length, 1);
    assert.equal(normalized.concepts[0]!.title, "坐标轴");
    assert.equal(normalized.extractions.length, 1);
  });

  it("converts a structurally valid schemaVersion 2 single-document checkpoint to v3", () => {
    const current = {
      schemaVersion: 2,
      concepts: [{
        id: "concept-1",
        courseId: "course-1",
        title: "坐标轴",
        aliases: [],
        summary: "说明。",
        sources: [{ documentId: "doc-1", sourceVersion: "v1", pageNumber: 1, sourceLabel: "课程.pdf · 第 1 页", excerpt: "坐标轴", evidence: [{ pageNumber: 1, quote: "坐标轴" }], evidenceRefs: ["坐标轴"] }],
        evidenceRefs: ["坐标轴"],
        createdAt: "",
        updatedAt: "",
      }],
      extractions: [{ extractionId: "kex-2" }],
      batchCheckpoints: [
        {
          courseId: "course-1",
          batchId: "b",
          documentId: "doc-1",
          sourceVersion: "v1",
          sourceLabel: "课程.pdf · 第 1 页",
          displayName: "课程.pdf",
          pageNumbers: [1, 2],
          status: "succeeded",
          concepts: [],
          error: null,
          startedAt: "",
          updatedAt: "",
        },
      ],
    };
    const normalized = normalizeKnowledgePersistence(current);
    assert.equal(normalized.schemaVersion, 3);
    assert.equal(normalized.batchCheckpoints.length, 1);
    const checkpoint = normalized.batchCheckpoints[0]!;
    assert.deepEqual(checkpoint.documents, [{ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" }]);
    assert.deepEqual(checkpoint.pageRefs, [{ documentId: "doc-1", pageNumber: 1 }, { documentId: "doc-1", pageNumber: 2 }]);
    assert.deepEqual(normalized.concepts[0]!.sources[0]!.evidence, [{ documentId: "doc-1", pageNumber: 1, quote: "坐标轴" }]);
  });

  it("passes a schemaVersion 3 database through unchanged, sanitizing checkpoints", () => {
    const current = {
      schemaVersion: 3,
      concepts: [],
      extractions: [{ extractionId: "kex-3" }],
      batchCheckpoints: [
        {
          courseId: "course-1",
          batchId: "b3",
          documents: [{ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" }],
          pageRefs: [{ documentId: "doc-1", pageNumber: 3 }],
          status: "succeeded",
          concepts: [],
          error: null,
          startedAt: "",
          updatedAt: "",
        },
      ],
    };
    const normalized = normalizeKnowledgePersistence(current);
    assert.equal(normalized.schemaVersion, 3);
    assert.equal(normalized.batchCheckpoints.length, 1);
    assert.equal(normalized.batchCheckpoints[0]!.batchId, "b3");
  });

  it("filters malformed checkpoint entries instead of crashing", () => {
    const current = {
      schemaVersion: 3,
      concepts: [],
      extractions: [],
      batchCheckpoints: [
        null,
        "not an object",
        { courseId: "course-1" },
        { courseId: "course-1", batchId: "good", documents: [{ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" }], pageRefs: [{ documentId: "doc-1", pageNumber: 1 }], status: "succeeded", concepts: [], error: null, startedAt: "", updatedAt: "" },
        { courseId: "course-1", batchId: "no-docs", documents: [], pageRefs: [{ documentId: "doc-1", pageNumber: 1 }], status: "succeeded", concepts: [], error: null, startedAt: "", updatedAt: "" },
        { courseId: "course-1", batchId: "bad-status", documents: [{ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" }], pageRefs: [{ documentId: "doc-1", pageNumber: 1 }], status: "unknown", concepts: [], error: null, startedAt: "", updatedAt: "" },
        { courseId: "course-1", batchId: "bad-concepts", documents: [{ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" }], pageRefs: [{ documentId: "doc-1", pageNumber: 1 }], status: "succeeded", concepts: null, error: null, startedAt: "", updatedAt: "" },
      ],
    };
    const normalized = normalizeKnowledgePersistence(current);
    assert.equal(normalized.schemaVersion, 3);
    assert.equal(normalized.batchCheckpoints.length, 1);
    assert.equal(normalized.batchCheckpoints[0]!.batchId, "good");
  });

  it("rejects malformed or unknown structures", () => {
    assert.throws(() => normalizeKnowledgePersistence("not an object"), /结构无效/);
    assert.throws(() => normalizeKnowledgePersistence({ schemaVersion: 4 }), /版本无效/);
    assert.throws(() => normalizeKnowledgePersistence({ schemaVersion: 1, concepts: "nope", extractions: [] }), /结构无效/);
    assert.throws(() => normalizeKnowledgePersistence({ schemaVersion: 2, concepts: [], extractions: [], batchCheckpoints: "nope" }), /结构无效/);
  });
});
