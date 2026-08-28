import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeConcept } from "@ai2sapien/contracts";

import {
  BATCH_OVERLAP_CHARS,
  MAX_BATCH_CHARS,
  MAX_CONCEPTS_PER_BATCH,
  buildBatches,
  normalizeConceptTitle,
  parseMaterialAnalysis,
  rebuildConceptMap,
  type BatchDocument,
  type ConceptOccurrence,
  type MaterialBatch,
  type MaterialDocument,
  type MaterialPage,
} from "./knowledge-extraction.js";

const documents: MaterialDocument[] = [
  { documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" },
  { documentId: "doc-2", sourceVersion: "v2", displayName: "讲义.pdf" },
];

function page(documentId: string, pageNumber: number, text: string, sourceVersion?: string): MaterialPage {
  const version = sourceVersion ?? (documentId === "doc-1" ? "v1" : "v2");
  return { documentId, sourceVersion: version, pageNumber, text };
}

function documentBatch(overrides: { documentId: string; sourceVersion: string; displayName: string }): BatchDocument {
  return {
    documentId: overrides.documentId,
    sourceVersion: overrides.sourceVersion,
    displayName: overrides.displayName,
  };
}

function batch(
  overrides: Partial<MaterialBatch> & { documents: BatchDocument[]; pages: { documentId: string; pageNumber: number; text: string }[] },
): MaterialBatch {
  const pages = overrides.pages;
  const documents = overrides.documents;
  const displayName = documents[0]!.displayName;
  const text = pages.map((entry) => markerText(entry.documentId, displayName, entry.pageNumber) + entry.text).join("\n\n");
  return {
    batchId: overrides.batchId ?? `b-${pages.map((entry) => `${entry.documentId}-${String(entry.pageNumber)}`).join("_")}`,
    documents,
    pages,
    text,
    order: overrides.order ?? 0,
    oversized: overrides.oversized ?? false,
  };
}

function markerText(documentId: string, displayName: string, pageNumber: number): string {
  return `【文档 ${documentId}「${displayName}」· 第 ${String(pageNumber)} 页】\n`;
}

function tenShortDocuments(): MaterialDocument[] {
  return Array.from({ length: 10 }, (_, index) => ({
    documentId: `doc-${String(index + 1)}`,
    sourceVersion: "v1",
    displayName: `课件${String(index + 1)}.pdf`,
  }));
}

describe("buildBatches", () => {
  it("packs 10 short PDFs (one page each) into fewer than 10 course-wide batches", () => {
    const manyDocuments = tenShortDocuments();
    const manyPages = manyDocuments.map((document, index) => page(document.documentId, 1, "概念".repeat(300)));
    const batches = buildBatches(manyDocuments, manyPages);
    assert.ok(batches.length < 10, `expected fewer than 10 batches but got ${batches.length}`);
    assert.ok(batches.length < manyPages.length, "batching must reduce call count");
    for (const item of batches) {
      assert.ok(item.text.length <= MAX_BATCH_CHARS, "every batch must stay within the hard budget");
      assert.ok(item.documents.length > 0, "every batch retains its participating documents");
    }
  });

  it("mixes pages from multiple documents into a shared batch within the exact char bound", () => {
    const mixedPages = [
      page("doc-1", 1, "甲".repeat(600)),
      page("doc-1", 2, "乙".repeat(600)),
      page("doc-2", 1, "丙".repeat(600)),
      page("doc-2", 2, "丁".repeat(600)),
    ];
    const batches = buildBatches(documents, mixedPages);
    assert.equal(batches.length, 1, "small pages from both documents should share one batch");
    assert.ok(batches[0]!.text.length <= MAX_BATCH_CHARS, "a shared batch stays within the hard budget");
    assert.deepEqual(batches[0]!.documents.map((document) => document.documentId).sort(), ["doc-1", "doc-2"]);
    assert.ok(batches[0]!.text.includes("doc-1") && batches[0]!.text.includes("doc-2"), "markers identify both documents");
  });

  it("keeps every page whole (page boundaries) unless the page is oversized", () => {
    const pages = [
      page("doc-1", 1, "一".repeat(900)),
      page("doc-2", 1, "二".repeat(900)),
      page("doc-1", 2, "三".repeat(900)),
    ];
    const batches = buildBatches(documents, pages);
    for (const item of batches) {
      assert.equal(item.oversized, false, "none of these pages is oversized");
      for (const batchPage of item.pages) {
        const original = pages.find((candidate) => candidate.documentId === batchPage.documentId && candidate.pageNumber === batchPage.pageNumber)!;
        assert.equal(batchPage.text, original.text.trim(), "page text must be packed whole, never split");
      }
    }
  });

  it("windows a page whose rendered marker pushes it just over the exact bound", () => {
    const text = "字".repeat(MAX_BATCH_CHARS - 1);
    const batches = buildBatches(documents, [page("doc-1", 3, text)]);
    assert.ok(batches.length > 0);
    for (const item of batches) {
      assert.equal(item.oversized, true, "the page's rendered form exceeds the bound so it is windowed");
      assert.ok(item.text.length <= MAX_BATCH_CHARS, "every windowed batch stays within the exact bound");
    }
  });

  it("windows an oversized single page into bounded overlapping batches referencing that page", () => {
    const longText = "字".repeat(60_000);
    const batches = buildBatches(documents, [page("doc-1", 3, longText)]);
    assert.ok(batches.length > 1, "an oversized page must split into multiple batches");
    for (const item of batches) {
      assert.deepEqual(item.documents.map((document) => document.documentId), ["doc-1"]);
      assert.deepEqual(item.pages.map((batchPage) => [batchPage.documentId, batchPage.pageNumber]), [["doc-1", 3]]);
      assert.equal(item.oversized, true);
      assert.ok(item.text.length <= MAX_BATCH_CHARS, "windowed batches stay within the budget");
    }
    const covered = batches.map((item) => item.pages[0]!.text.length).reduce((sum, length) => sum + length, 0);
    assert.ok(covered > longText.length, "windowed batch text must cover the page (with overlap)");
  });

  it("gives repeated oversized windows distinct deterministic batch ids", () => {
    const repeated = "重复内容".repeat(20_000);
    const first = buildBatches(documents, [page("doc-1", 3, repeated)]);
    const second = buildBatches(documents, [page("doc-1", 3, repeated)]);
    assert.equal(new Set(first.map((item) => item.batchId)).size, first.length);
    assert.deepEqual(first.map((item) => item.batchId), second.map((item) => item.batchId));
  });

  it("ignores pages without extractable text", () => {
    const batches = buildBatches(documents, [page("doc-1", 1, "   "), page("doc-1", 2, "正文")]);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.pages.map((item) => [item.documentId, item.pageNumber]), [["doc-1", 2]]);
  });

  it("is deterministic across runs, and the overlap constant is bounded", () => {
    const pages = Array.from({ length: 40 }, (_, index) => page("doc-1", index + 1, "确定".repeat(700)));
    const first = buildBatches(documents, pages);
    const second = buildBatches(documents, pages);
    assert.deepEqual(first.map((item) => item.batchId), second.map((item) => item.batchId));
    assert.ok(BATCH_OVERLAP_CHARS > 0 && BATCH_OVERLAP_CHARS < MAX_BATCH_CHARS);
  });
});

describe("parseMaterialAnalysis / validateConceptEvidence", () => {
  const single = batch({
    batchId: "b1",
    documents: [documentBatch({ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" })],
    pages: [
      { documentId: "doc-1", pageNumber: 1, text: "坐标轴用于表示数值刻度。" },
      { documentId: "doc-1", pageNumber: 2, text: "图例解释图表中的符号含义。" },
    ],
  });

  it("retains only evidence whose document+page is in the batch and whose quote is present", () => {
    const result = parseMaterialAnalysis(
      `{"concepts":[{"title":"坐标轴","aliases":["y轴"],"summary":"数值量级刻度轴，用于表达尺度。",
        "evidence":[{"documentId":"doc-1","pageNumber":1,"quote":"坐标轴用于表示数值刻度"},{"documentId":"doc-1","pageNumber":99,"quote":"不存在"},{"documentId":"doc-1","pageNumber":1,"quote":"完全不存在的引文"}]}]}`,
      single,
    );
    assert.equal(result.valid, true);
    assert.equal(result.concepts.length, 1);
    assert.deepEqual(result.concepts[0]!.evidence.map((entry) => entry.quote), ["坐标轴用于表示数值刻度"]);
    assert.equal(result.concepts[0]!.evidence[0]!.documentId, "doc-1");
  });

  it("rejects a concept whose only evidence is on a wrong page", () => {
    const result = parseMaterialAnalysis(
      `{"concepts":[{"title":"幽灵概念","aliases":[],"summary":"这个概念的说明文字。","evidence":[{"documentId":"doc-1","pageNumber":99,"quote":"坐标轴"}]}]}`,
      single,
    );
    assert.equal(result.valid, false);
    assert.equal(result.concepts.length, 0);
    assert.ok(result.errors.some((error) => error.includes("证据")));
  });

  it("rejects a concept whose only evidence is on the right page of the wrong document", () => {
    const result = parseMaterialAnalysis(
      `{"concepts":[{"title":"串文档概念","aliases":[],"summary":"这个概念的说明文字。","evidence":[{"documentId":"doc-2","pageNumber":2,"quote":"图例解释图表中的符号含义"}]}]}`,
      single,
    );
    assert.equal(result.valid, false);
    assert.equal(result.concepts.length, 0);
  });

  it("rejects a concept whose quote does not appear in the claimed page", () => {
    const result = parseMaterialAnalysis(
      `{"concepts":[{"title":"伪造概念","aliases":[],"summary":"这个概念的说明文字。","evidence":[{"documentId":"doc-1","pageNumber":2,"quote":"完全不存在的引文内容"}]}]}`,
      single,
    );
    assert.equal(result.valid, false);
    assert.equal(result.concepts.length, 0);
  });

  it("accepts a well-formed concept spread across multiple pages of one document", () => {
    const result = parseMaterialAnalysis(
      `{"concepts":[{"title":"坐标轴","aliases":["Y 轴"],"summary":"承载数值量级的刻度轴。","evidence":[{"documentId":"doc-1","pageNumber":1,"quote":"坐标轴用于表示数值刻度"},{"documentId":"doc-1","pageNumber":2,"quote":"图例解释图表中的符号含义"}]}]}`,
      single,
    );
    assert.equal(result.concepts.length, 1);
    assert.equal(result.concepts[0]!.evidence.length, 2);
  });

  it("accepts evidence that combines pages across multiple documents of a shared batch", () => {
    const shared = buildBatches(documents, [
      page("doc-1", 1, "甲特征：数据可视化基础。" ),
      page("doc-2", 1, "乙特征：信息设计原则。" ),
    ]);
    assert.equal(shared.length, 1);
    const result = parseMaterialAnalysis(
      `{"concepts":[{"title":"可视化","aliases":[],"summary":"将数据编码为图形以传达含义。","evidence":[{"documentId":"doc-1","pageNumber":1,"quote":"甲特征：数据可视化基础"},{"documentId":"doc-2","pageNumber":1,"quote":"乙特征：信息设计原则"}]}]}`,
      shared[0]!,
    );
    assert.equal(result.valid, true);
    assert.equal(result.concepts[0]!.evidence.length, 2);
  });

  it("returns no concepts for malformed output and caps the concept count", () => {
    assert.equal(parseMaterialAnalysis("这不是 JSON", single).valid, false);
    assert.equal(parseMaterialAnalysis("```json\n{broken\n```", single).concepts.length, 0);
    const many = Array.from({ length: MAX_CONCEPTS_PER_BATCH + 10 }, (_, index) => ({
      title: `概念${String(index)}`,
      aliases: [],
      summary: "含义与机制说明。",
      evidence: [{ documentId: "doc-1", pageNumber: 1, quote: "坐标轴" }],
    }));
    const { concepts } = parseMaterialAnalysis(`{"concepts":${JSON.stringify(many)}}`, single);
    assert.ok(concepts.length <= MAX_CONCEPTS_PER_BATCH);
  });
});

describe("normalizeConceptTitle", () => {
  it("collapses case, whitespace, and trailing punctuation", () => {
    assert.equal(normalizeConceptTitle("  Y轴 。"), normalizeConceptTitle("y轴"));
    assert.equal(normalizeConceptTitle("坐标轴"), normalizeConceptTitle(" 坐标轴\n"));
  });
});

describe("rebuildConceptMap", () => {
  const clockNow = () => "2026-08-28T00:00:00.000Z";
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${String((idCounter += 1))}`;

  it("merges duplicate titles while preserving every document/page/quote source", () => {
    const occurrences: ConceptOccurrence[] = [
      {
        draft: {
          title: "坐标轴",
          aliases: ["坐标轴"],
          summary: "第一种解释较短。",
          evidence: [{ documentId: "doc-1", pageNumber: 1, quote: "坐标轴用于表示数值刻度" }],
        },
        batchId: "b1",
        documents: [documentBatch({ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" })],
      },
      {
        draft: {
          title: " 坐标轴 ",
          aliases: ["轴系"],
          summary: "第二种解释，更长的一种说明方式以覆盖更多机制。",
          evidence: [{ documentId: "doc-2", pageNumber: 2, quote: "图例解释图表中的符号含义" }],
        },
        batchId: "b2",
        documents: [documentBatch({ documentId: "doc-2", sourceVersion: "v2", displayName: "讲义.pdf" })],
      },
    ];
    const merged = rebuildConceptMap("course-1", occurrences, [], nextId, clockNow);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.title, "坐标轴");
    assert.deepEqual(merged[0]!.sources.map((source) => source.sourceLabel), ["课程.pdf · 第 1 页", "讲义.pdf · 第 2 页"]);
    assert.deepEqual(merged[0]!.sources.map((source) => source.documentId), ["doc-1", "doc-2"]);
    assert.ok(merged[0]!.aliases.length >= 2);
    assert.ok(merged[0]!.evidenceRefs.length >= 2);
    assert.equal(merged[0]!.sources[0]!.evidence?.length, 1);
    assert.equal(merged[0]!.sources[0]!.evidence![0]!.documentId, "doc-1");
    assert.equal(merged[0]!.sources[0]!.evidence![0]!.quote, "坐标轴用于表示数值刻度");
  });

  it("resolves sources per evidence entry inside a multi-document batch", () => {
    const occurrences: ConceptOccurrence[] = [
      {
        draft: {
          title: "可视化",
          aliases: [],
          summary: "将数据编码为图形以传达信息，是一套设计原则。",
          evidence: [
            { documentId: "doc-1", pageNumber: 1, quote: "甲特征：数据可视化基础" },
            { documentId: "doc-2", pageNumber: 3, quote: "乙特征：信息设计原则" },
          ],
        },
        batchId: "b-shared",
        documents: [
          documentBatch({ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" }),
          documentBatch({ documentId: "doc-2", sourceVersion: "v2", displayName: "讲义.pdf" }),
        ],
      },
    ];
    const merged = rebuildConceptMap("course-1", occurrences, [], nextId, clockNow);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.sources.length, 2);
    assert.deepEqual(
      merged[0]!.sources.map((source) => [source.documentId, source.pageNumber]),
      [["doc-1", 1], ["doc-2", 3]],
    );
    assert.deepEqual(merged[0]!.sources.map((source) => source.sourceVersion), ["v1", "v2"]);
    assert.deepEqual(merged[0]!.sources.map((source) => source.sourceLabel), ["课程.pdf · 第 1 页", "讲义.pdf · 第 3 页"]);
  });

  it("reuses stable ids for unchanged normalized titles", () => {
    const existing: KnowledgeConcept[] = [
      {
        id: "concept-fixed",
        courseId: "course-1",
        title: "坐标轴",
        aliases: ["旧别称"],
        summary: "旧解释",
        sources: [{ documentId: "doc-0", sourceVersion: "v0", pageNumber: 5, sourceLabel: "旧.pdf · 第 5 页", excerpt: "旧来源", evidenceRefs: ["旧依据"] }],
        evidenceRefs: ["旧依据"],
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    const occurrences: ConceptOccurrence[] = [
      {
        draft: {
          title: "坐标轴",
          aliases: ["新别称"],
          summary: "新解释更完整一些。",
          evidence: [{ documentId: "doc-1", pageNumber: 3, quote: "坐标轴用于表示数值刻度" }],
        },
        batchId: "b1",
        documents: [documentBatch({ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" })],
      },
    ];
    const merged = rebuildConceptMap("course-1", occurrences, existing, nextId, clockNow);
    assert.equal(merged[0]!.id, "concept-fixed");
    assert.deepEqual(merged[0]!.sources.map((source) => source.documentId), ["doc-1"]);
    assert.ok(merged[0]!.evidenceRefs.includes("坐标轴用于表示数值刻度"));
    assert.ok(!merged[0]!.sources.some((source) => source.documentId === "doc-0"), "removed-document source must be dropped");
  });

  it("drops concepts that no longer have any validated occurrence", () => {
    const existing: KnowledgeConcept[] = [
      {
        id: "concept-gone",
        courseId: "course-1",
        title: "已删除概念",
        aliases: [],
        summary: "只存在于已删除文档。",
        sources: [{ documentId: "doc-2", sourceVersion: "v2", pageNumber: 1, sourceLabel: "讲义.pdf · 第 1 页", excerpt: "旧", evidenceRefs: ["旧"] }],
        evidenceRefs: ["旧"],
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    const occurrences: ConceptOccurrence[] = [
      {
        draft: {
          title: "仍在概念",
          aliases: [],
          summary: "仍然存在的概念的说明。",
          evidence: [{ documentId: "doc-1", pageNumber: 1, quote: "坐标轴用于表示数值刻度" }],
        },
        batchId: "b1",
        documents: [documentBatch({ documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" })],
      },
    ];
    const merged = rebuildConceptMap("course-1", occurrences, existing, nextId, clockNow);
    assert.deepEqual(merged.map((concept) => concept.title), ["仍在概念"]);
  });
});
