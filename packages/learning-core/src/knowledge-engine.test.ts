import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeConcept, KnowledgeExtractionResult } from "@ai2sapien/contracts";

import { buildBatches, type BatchCheckpoint, type MaterialBatch } from "./knowledge-extraction.js";
import {
  ExtractionCancelledError,
  KnowledgeExtractionEngine,
  MAX_CONCURRENT_BATCHES,
  collectTurnReply,
  summarizeKnowledgeAnalysisState,
  type KnowledgeExtractionStorePort,
  type MaterialAnalystPort,
  type ModelStreamEvent,
} from "./knowledge-engine.js";

const DATE = "2026-08-28T00:00:00.000Z";
const clock = { now: () => new Date(DATE) };
let idCounter = 0;
const idPort = { next: (prefix: string) => `${prefix}-${String((idCounter += 1))}` };

const documents = [
  { documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" },
  { documentId: "doc-2", sourceVersion: "v1", displayName: "讲义.pdf" },
];

function tokenPage(documentId: string, pageNumber: number, token: string, sourceVersion = "v1") {
  return { documentId, sourceVersion, pageNumber, text: token.repeat(4_000) };
}

function phrasePage(documentId: string, pageNumber: number, phrase: string, sourceVersion = "v1") {
  return { documentId, sourceVersion, pageNumber, text: `${phrase}。补充说明文字，确保本页有一定内容。` };
}

function longPage(documentId: string, pageNumber: number, phrase: string, sourceVersion = "v1") {
  return { documentId, sourceVersion, pageNumber, text: phrase.repeat(6_000) };
}

function conceptReply(title: string, documentId: string, pageNumber: number, quote: string): string {
  return JSON.stringify({
    concepts: [
      { title, aliases: [title], summary: "关于这个概念的一条足够长的含义与机制说明文字。", evidence: [{ documentId, pageNumber, quote }] },
    ],
  });
}

function pageRefs(batch: MaterialBatch): { documentId: string; pageNumber: number }[] {
  return batch.pages.map((entry) => ({ documentId: entry.documentId, pageNumber: entry.pageNumber }));
}

function repliesForBatches(runtime: FakeModelRuntime, batches: readonly MaterialBatch[]): void {
  for (const item of batches) {
    const token = `特征${String(item.pages[0]!.pageNumber)}`;
    runtime.replies.push(conceptReply(token, item.pages[0]!.documentId, item.pages[0]!.pageNumber, token));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeModelRuntime implements MaterialAnalystPort {
  readonly listeners = new Set<(event: ModelStreamEvent) => void>();
  readonly replies: string[] = [];
  readonly failMessages: string[] = [];
  sessionCount = 0;
  turns = 0;
  active = 0;
  maxActive = 0;
  turnDelayMs = 0;
  completions = Infinity;
  #gate: (() => void) | null = null;
  #gatePromise: Promise<void> | null = null;

  onTurnEvent(listener: (event: ModelStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(_system: string): Promise<string> {
    const sessionId = `session-${String(this.sessionCount)}`;
    this.sessionCount += 1;
    return sessionId;
  }

  hold(): void {
    this.#gatePromise = new Promise((resolve) => {
      this.#gate = resolve;
    });
  }

  async sendTurn(
    sessionId: string,
    _request: { system: string; messages: Array<{ role: string; content: string }> },
  ): Promise<string> {
    this.turns += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const failure = this.failMessages.shift() ?? null;
    const reply = this.replies.shift() ?? "";
    const runId = `run-${String(this.turns)}`;
    try {
      this.#emit({ sessionId, runId, status: "running", delta: reply, message: null });
      if (this.turnDelayMs > 0) await delay(this.turnDelayMs);
      // Deterministically allow only the first `completions` turns to finish; later
      // turns wait on the gate so a test can cancel while some are still in flight.
      if (this.#gatePromise && this.turns > this.completions) await this.#gatePromise;
      if (failure !== null) {
        this.#emit({ sessionId, runId, status: "failed", delta: "", message: failure });
      } else {
        this.#emit({ sessionId, runId, status: "succeeded", delta: "", message: null });
      }
      return runId;
    } finally {
      this.active -= 1;
    }
  }

  #emit(event: ModelStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class MemoryStore implements KnowledgeExtractionStorePort {
  readonly concepts = new Map<string, KnowledgeConcept[]>();
  readonly results = new Map<string, KnowledgeExtractionResult>();
  readonly checkpoints = new Map<string, BatchCheckpoint[]>();
  readonly saveCount = { checkpoints: 0, prune: 0, concepts: 0 };

  async listConcepts(courseId: string): Promise<KnowledgeConcept[]> {
    return structuredClone(this.concepts.get(courseId) ?? []);
  }

  async saveConcepts(courseId: string, concepts: KnowledgeConcept[]): Promise<void> {
    this.saveCount.concepts += 1;
    this.concepts.set(courseId, structuredClone(concepts));
  }

  async saveResult(result: KnowledgeExtractionResult): Promise<void> {
    this.results.set(result.extractionId, structuredClone(result));
  }

  async getResult(extractionId: string): Promise<KnowledgeExtractionResult | null> {
    return structuredClone(this.results.get(extractionId) ?? null);
  }

  async listBatchCheckpoints(courseId: string): Promise<BatchCheckpoint[]> {
    return structuredClone(this.checkpoints.get(courseId) ?? []);
  }

  async saveBatchCheckpoint(checkpoint: BatchCheckpoint): Promise<void> {
    this.saveCount.checkpoints += 1;
    const list = this.checkpoints.get(checkpoint.courseId) ?? [];
    const index = list.findIndex((candidate) => candidate.batchId === checkpoint.batchId);
    if (index >= 0) list[index] = structuredClone(checkpoint);
    else list.push(structuredClone(checkpoint));
    this.checkpoints.set(checkpoint.courseId, list);
  }

  async pruneBatchCheckpoints(courseId: string, retainedBatchIds: string[]): Promise<void> {
    this.saveCount.prune += 1;
    const retained = new Set(retainedBatchIds);
    this.checkpoints.set(
      courseId,
      (this.checkpoints.get(courseId) ?? []).filter((checkpoint) => retained.has(checkpoint.batchId)),
    );
  }

  seedCheckpoint(checkpoint: BatchCheckpoint): void {
    const list = this.checkpoints.get(checkpoint.courseId) ?? [];
    const index = list.findIndex((candidate) => candidate.batchId === checkpoint.batchId);
    if (index >= 0) list[index] = structuredClone(checkpoint);
    else list.push(structuredClone(checkpoint));
    this.checkpoints.set(checkpoint.courseId, list);
  }
}

describe("KnowledgeExtractionEngine", () => {
  it("analyzes page batches with independent sessions and checkpoint every settled batch", async () => {
    const runtime = new FakeModelRuntime();
    const pages = Array.from({ length: 8 }, (_, index) => tokenPage("doc-1", index + 1, `特征${String(index + 1)}`, "v1"));
    const expectedBatches = buildBatches(documents, pages);
    repliesForBatches(runtime, expectedBatches);

    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    const phases: string[] = [];
    engine.onProgress((progress) => phases.push(progress.phase));

    const result = await engine.run({ courseId: "course-1", documents, pages }, "kex-1");

    assert.equal(result.chunkCount, expectedBatches.length);
    assert.equal(result.analyzedChunkCount, expectedBatches.length);
    assert.equal(result.failedChunkCount, 0);
    assert.equal(result.concepts.length, expectedBatches.length);
    assert.equal(runtime.turns, expectedBatches.length, "one model turn per batch");
    assert.equal(runtime.sessionCount, expectedBatches.length, "an independent session is created per batch");
    assert.equal(store.checkpoints.get("course-1")?.length, expectedBatches.length, "a checkpoint is persisted per settled batch");
    assert.equal(store.saveCount.checkpoints, expectedBatches.length);
    assert.ok((store.checkpoints.get("course-1") ?? []).every((candidate) => candidate.status === "succeeded"));
    assert.ok(phases.includes("chunking"));
    assert.ok(phases.includes("merging"));
    assert.ok(phases.includes("succeeded"));
    assert.ok(result.reusedBatchCount === 0);
    assert.deepEqual(store.results.get("kex-1")?.concepts.length, result.concepts.length);
  });

  it("uses bounded concurrency: never more than 3 and more than 1 when work allows", async () => {
    const runtime = new FakeModelRuntime();
    runtime.turnDelayMs = 10;
    const pages = Array.from({ length: 8 }, (_, index) => tokenPage("doc-1", index + 1, `特征${String(index + 1)}`, "v1"));
    const batches = buildBatches(documents, pages);
    repliesForBatches(runtime, batches);

    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    const result = await engine.run({ courseId: "course-1", documents, pages }, "kex-2");

    assert.equal(result.failedChunkCount, 0);
    assert.ok(runtime.maxActive >= 2, `expected >1 concurrent turn but saw ${runtime.maxActive}`);
    assert.ok(runtime.maxActive <= MAX_CONCURRENT_BATCHES, `expected at most ${MAX_CONCURRENT_BATCHES} concurrent turns but saw ${runtime.maxActive}`);
  });

  it("resumes by reusing completed batches and skipping model calls", async () => {
    const pages = Array.from({ length: 8 }, (_, index) => tokenPage("doc-1", index + 1, `特征${String(index + 1)}`, "v1"));
    const batches = buildBatches(documents, pages);
    const firstRuntime = new FakeModelRuntime();
    repliesForBatches(firstRuntime, batches);
    const store = new MemoryStore();
    const first = new KnowledgeExtractionEngine(firstRuntime, store, clock, idPort).run({ courseId: "course-1", documents, pages }, "kex-3");
    await assert.doesNotReject(first);

    const secondRuntime = new FakeModelRuntime();
    const second = new KnowledgeExtractionEngine(secondRuntime, store, clock, idPort).run({ courseId: "course-1", documents, pages }, "kex-4");
    const result = await second;

    assert.equal(secondRuntime.turns, 0, "no model calls on a fully-reused course");
    assert.equal(result.reusedBatchCount, batches.length);
    assert.equal(result.analyzedChunkCount, batches.length);
    assert.equal(result.failedChunkCount, 0);
    assert.equal(result.chunkCount, batches.length);
    assert.equal(result.concepts.length, batches.length);
    assert.equal(store.checkpoints.get("course-1")?.length, batches.length);
    assert.ok((store.checkpoints.get("course-1") ?? []).every((candidate) => candidate.documents.length > 0 && candidate.pageRefs.length > 0));
  });

  it("reanalyzes a cached batch when its persisted evidence no longer validates", async () => {
    const pages = [phrasePage("doc-1", 1, "甲特征", "v1")];
    const batch = buildBatches([documents[0]!], pages)[0]!;
    const store = new MemoryStore();
    store.seedCheckpoint({
      courseId: "course-1",
      batchId: batch.batchId,
      documents: batch.documents,
      pageRefs: pageRefs(batch),
      status: "succeeded",
      concepts: [{ title: "伪造缓存", aliases: [], summary: "这是一条长度足够的缓存说明。", evidence: [{ documentId: "doc-1", pageNumber: 99, quote: "不存在" }] }],
      error: null,
      startedAt: DATE,
      updatedAt: DATE,
    });
    const runtime = new FakeModelRuntime();
    runtime.replies.push(conceptReply("概念甲", "doc-1", 1, "甲特征"));

    const result = await new KnowledgeExtractionEngine(runtime, store, clock, idPort).run(
      { courseId: "course-1", documents: [documents[0]!], pages },
      "kex-invalid-cache",
    );

    assert.equal(runtime.turns, 1);
    assert.equal(result.reusedBatchCount, 0);
    assert.deepEqual(result.concepts.map((concept) => concept.title), ["概念甲"]);
  });

  it("reanalyzes a cached batch when its persisted document/page metadata does not match", async () => {
    const pages = [phrasePage("doc-1", 1, "甲特征", "v1")];
    const batch = buildBatches([documents[0]!], pages)[0]!;
    const store = new MemoryStore();
    store.seedCheckpoint({
      courseId: "course-1",
      batchId: batch.batchId,
      documents: batch.documents,
      pageRefs: [{ documentId: "doc-1", pageNumber: 2 }],
      status: "succeeded",
      concepts: [{ title: "缓存概念", aliases: [], summary: "这是一条长度足够的缓存说明。", evidence: [{ documentId: "doc-1", pageNumber: 1, quote: "甲特征" }] }],
      error: null,
      startedAt: DATE,
      updatedAt: DATE,
    });
    const runtime = new FakeModelRuntime();
    runtime.replies.push(conceptReply("概念甲", "doc-1", 1, "甲特征"));

    const result = await new KnowledgeExtractionEngine(runtime, store, clock, idPort).run(
      { courseId: "course-1", documents: [documents[0]!], pages },
      "kex-invalid-metadata",
    );

    assert.equal(runtime.turns, 1);
    assert.equal(result.reusedBatchCount, 0);
    assert.deepEqual(result.concepts.map((concept) => concept.title), ["概念甲"]);
  });

  it("reuses unchanged course bundles but reanalyzes the batch containing a changed document", async () => {
    const runOneDocs = [
      { documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" },
      { documentId: "doc-2", sourceVersion: "v1", displayName: "讲义.pdf" },
    ];
    const runOnePages = [longPage("doc-1", 1, "甲特征", "v1"), longPage("doc-2", 1, "乙特征", "v1")];
    const firstRuntime = new FakeModelRuntime();
    firstRuntime.replies.push(conceptReply("概念甲", "doc-1", 1, "甲特征"), conceptReply("概念乙", "doc-2", 1, "乙特征"));
    const store = new MemoryStore();
    await new KnowledgeExtractionEngine(firstRuntime, store, clock, idPort).run({ courseId: "course-1", documents: runOneDocs, pages: runOnePages }, "kex-5");

    const runTwoDocs = [
      { documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" },
      { documentId: "doc-2", sourceVersion: "v2", displayName: "讲义.pdf" },
    ];
    const runTwoPages = [longPage("doc-1", 1, "甲特征", "v1"), longPage("doc-2", 1, "乙特征", "v2")];
    const secondRuntime = new FakeModelRuntime();
    secondRuntime.replies.push(conceptReply("概念乙", "doc-2", 1, "乙特征"));
    const result = await new KnowledgeExtractionEngine(secondRuntime, store, clock, idPort).run({ courseId: "course-1", documents: runTwoDocs, pages: runTwoPages }, "kex-6");

    assert.equal(secondRuntime.turns, 1, "only the batch containing the changed document is reanalyzed");
    assert.equal(result.reusedBatchCount, 1);
    assert.equal(result.failedChunkCount, 0);
    assert.deepEqual(result.concepts.map((concept) => concept.title).sort(), ["概念乙", "概念甲"].sort());
    assert.ok(result.concepts.every((concept) => concept.sources.length === 1));
    assert.equal(store.checkpoints.get("course-1")?.length, 2, "stale checkpoints from the old document version are pruned");
    assert.ok((store.checkpoints.get("course-1") ?? []).every((checkpoint) => checkpoint.documents.every((document) => document.sourceVersion === "v1" || document.sourceVersion === "v2")));
  });

  it("removes evidence belonging to a document no longer present and prunes its checkpoints", async () => {
    const bothPages = [longPage("doc-1", 1, "甲特征", "v1"), longPage("doc-2", 1, "乙特征", "v1")];
    const firstRuntime = new FakeModelRuntime();
    firstRuntime.replies.push(conceptReply("概念甲", "doc-1", 1, "甲特征"), conceptReply("概念乙", "doc-2", 1, "乙特征"));
    const store = new MemoryStore();
    await new KnowledgeExtractionEngine(firstRuntime, store, clock, idPort).run({ courseId: "course-1", documents, pages: bothPages }, "kex-7");

    const remainingPages = [longPage("doc-1", 1, "甲特征", "v1")];
    const secondRuntime = new FakeModelRuntime();
    const result = await new KnowledgeExtractionEngine(secondRuntime, store, clock, idPort).run({ courseId: "course-1", documents: [documents[0]!], pages: remainingPages }, "kex-8");

    assert.equal(secondRuntime.turns, 0, "the retained document's bundle is reused verbatim");
    assert.equal(result.reusedBatchCount, 1);
    assert.ok(result.concepts.every((concept) => concept.sources.every((source) => source.documentId === "doc-1")));
    assert.equal(
      store.checkpoints.get("course-1")?.every((checkpoint) => checkpoint.documents.length === 1 && checkpoint.documents[0]!.documentId === "doc-1"),
      true,
    );
  });

  it("checkpoints a malformed batch as failed and keeps partial valid results", async () => {
    const runtime = new FakeModelRuntime();
    runtime.replies.push("not json");
    const pages = [phrasePage("doc-1", 1, "甲特征", "v1")];
    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    const result = await engine.run({ courseId: "course-1", documents: [documents[0]!], pages }, "kex-9");

    assert.equal(result.failedChunkCount, 1);
    assert.equal(result.analyzedChunkCount, 0);
    assert.deepEqual(result.concepts, []);
    const checkpoint = store.checkpoints.get("course-1")?.[0];
    assert.equal(checkpoint?.status, "failed");
    assert.ok(checkpoint?.error);
  });

  it("marks a batch retryable when every proposed concept has unsupported evidence", async () => {
    const runtime = new FakeModelRuntime();
    runtime.replies.push(
      JSON.stringify({ concepts: [{ title: "伪造概念", aliases: [], summary: "这条概念的说明文字。", evidence: [{ documentId: "doc-1", pageNumber: 99, quote: "不存在" }] }] }),
    );
    const pages = [phrasePage("doc-1", 1, "甲特征", "v1")];
    const store = new MemoryStore();
    const result = await new KnowledgeExtractionEngine(runtime, store, clock, idPort).run({ courseId: "course-1", documents: [documents[0]!], pages }, "kex-10");

    assert.equal(result.failedChunkCount, 1);
    assert.equal(result.analyzedChunkCount, 0);
    assert.deepEqual(result.concepts, []);
    assert.equal(store.checkpoints.get("course-1")?.[0]?.status, "failed");
  });

  it("supports cancellation: completed batches persist, in-flight batches are left pending", async () => {
    const runtime = new FakeModelRuntime();
    runtime.completions = 1;
    runtime.hold();
    const pages = Array.from({ length: 8 }, (_, index) => tokenPage("doc-1", index + 1, `特征${String(index + 1)}`, "v1"));
    const batches = buildBatches(documents, pages);
    repliesForBatches(runtime, batches);

    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    const cancellator = new AbortController();
    const runPromise = engine.run({ courseId: "course-1", documents, pages }, "kex-11", cancellator.signal);

    await delay(30);
    cancellator.abort();

    await assert.rejects(runPromise, ExtractionCancelledError);
    assert.equal(store.checkpoints.get("course-1")?.length, 1, "only the settled batch is checkpointed");
    assert.equal(store.saveCount.checkpoints, 1);
    assert.ok((store.checkpoints.get("course-1") ?? []).every((candidate) => candidate.status === "succeeded"));
    assert.equal(store.concepts.get("course-1")?.length, 1, "partial valid concepts are persisted");
  });
});

describe("summarizeKnowledgeAnalysisState", () => {
  it("reports validated saved, pending, and retryable failed batches honestly", () => {
    const pages = [
      tokenPage("doc-1", 1, "特征1", "v1"),
      tokenPage("doc-1", 2, "特征2", "v1"),
      tokenPage("doc-1", 3, "特征3", "v1"),
      tokenPage("doc-1", 4, "特征4", "v1"),
    ];
    const batches = buildBatches([documents[0]!], pages);
    assert.equal(batches.length, 2);
    const checkpoints: BatchCheckpoint[] = [
      {
        courseId: "course-1",
        batchId: batches[0]!.batchId,
        documents: batches[0]!.documents,
        pageRefs: pageRefs(batches[0]!),
        status: "succeeded",
        concepts: [{ title: "概念甲", aliases: [], summary: "这是一条长度足够的概念说明。", evidence: [{ documentId: "doc-1", pageNumber: 1, quote: "特征1" }] }],
        error: null,
        startedAt: DATE,
        updatedAt: DATE,
      },
      {
        courseId: "course-1",
        batchId: batches[1]!.batchId,
        documents: batches[1]!.documents,
        pageRefs: pageRefs(batches[1]!),
        status: "failed",
        concepts: [],
        error: "模型响应无效",
        startedAt: DATE,
        updatedAt: DATE,
      },
    ];

    const state = summarizeKnowledgeAnalysisState("course-1", batches, checkpoints);
    assert.equal(state.totalBatchCount, 2);
    assert.equal(state.completedBatchCount, 1);
    assert.equal(state.pendingBatchCount, 1);
    assert.equal(state.failedBatchCount, 1);
    assert.equal(state.canResume, true);
  });
});

describe("collectTurnReply", () => {
  it("ignores streamed events from a different concurrent session", async () => {
    const listeners = new Set<(event: ModelStreamEvent) => void>();
    const runtime: MaterialAnalystPort = {
      createSession: async () => "session-owned",
      onTurnEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async sendTurn(sessionId) {
        for (const listener of listeners) {
          listener({ sessionId: "session-foreign", runId: "run-foreign", status: "running", delta: "foreign", message: null });
          listener({ sessionId: "session-foreign", runId: "run-foreign", status: "succeeded", delta: "", message: null });
          listener({ sessionId, runId: "run-owned", status: "running", delta: "owned", message: null });
          listener({ sessionId, runId: "run-owned", status: "succeeded", delta: "", message: null });
        }
        return "run-owned";
      },
    };

    assert.equal(await collectTurnReply(runtime, "session-owned", "system", "prompt", 100), "owned");
  });

  it("propagates a provider turn failure", async () => {
    const runtime = new FakeModelRuntime();
    runtime.failMessages.push("模型中断");
    await assert.rejects(
      collectTurnReply(runtime, "session-0", "system", "prompt", 100),
      /模型中断/,
    );
  });
});
