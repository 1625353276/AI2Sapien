import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeConcept, KnowledgeExtractionResult } from "@ai2sapien/contracts";

import {
  MAX_CHUNK_CHARS,
  splitSourceIntoChunks,
  normalizeConceptTitle,
  parseMaterialAnalysis,
  mergeMaterialConcepts,
  type MaterialDocument,
  type MaterialPage,
  type SourceChunk,
} from "./knowledge-extraction.js";
import {
  KnowledgeExtractionEngine,
  collectTurnReply,
  type KnowledgeExtractionStorePort,
  type MaterialAnalystPort,
  type ModelStreamEvent,
} from "./knowledge-engine.js";

const documents: MaterialDocument[] = [
  { documentId: "doc-1", sourceVersion: "v1", displayName: "课程.pdf" },
  { documentId: "doc-2", sourceVersion: "v2", displayName: "讲义.pdf" },
];

function page(documentId: string, pageNumber: number, text: string): MaterialPage {
  const version = documentId === "doc-1" ? "v1" : "v2";
  return { documentId, sourceVersion: version, pageNumber, text };
}

/**
 * In-memory fake of a provider-neutral ModelRuntime with no network calls.
 * It replays queued replies for each turn and settles the terminal event that
 * `collectTurnReply` waits on.
 */
class FakeModelRuntime implements MaterialAnalystPort {
  readonly listeners = new Set<(event: ModelStreamEvent) => void>();
  readonly replies: string[] = [];
  readonly failMessages: string[] = [];
  sessionCount = 0;
  readSystem: string[] = [];

  onTurnEvent(listener: (event: ModelStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(system: string): Promise<string> {
    this.readSystem.push(system);
    const sessionId = `session-${String(this.sessionCount)}`;
    this.sessionCount += 1;
    return sessionId;
  }

  async sendTurn(
    sessionId: string,
    _request: { system: string; messages: Array<{ role: string; content: string }> },
  ): Promise<string> {
    const runId = `run-${String(this.sessionCount)}-${String(this.listeners.size)}`;
    const reply = this.replies.shift() ?? "";
    const failure = this.failMessages.shift() ?? null;
    this.#emit({ sessionId, runId, status: "running", delta: reply, message: null });
    if (failure !== null) {
      this.#emit({ sessionId, runId, status: "failed", delta: "", message: failure });
    } else {
      this.#emit({ sessionId, runId, status: "succeeded", delta: "", message: null });
    }
    return runId;
  }

  async interrupt(): Promise<void> {}

  #emit(event: ModelStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class MemoryStore implements KnowledgeExtractionStorePort {
  concepts = new Map<string, KnowledgeConcept[]>();
  results = new Map<string, KnowledgeExtractionResult>();

  async listConcepts(courseId: string): Promise<KnowledgeConcept[]> {
    return structuredClone(this.concepts.get(courseId) ?? []);
  }

  async saveConcepts(courseId: string, concepts: KnowledgeConcept[]): Promise<void> {
    this.concepts.set(courseId, structuredClone(concepts));
  }

  async saveResult(result: KnowledgeExtractionResult): Promise<void> {
    this.results.set(result.extractionId, structuredClone(result));
  }

  async getResult(extractionId: string): Promise<KnowledgeExtractionResult | null> {
    return structuredClone(this.results.get(extractionId) ?? null);
  }
}

const clock = { now: () => new Date("2026-08-28T00:00:00Z") };
let idCounter = 0;
const idPort = { next: (prefix: string) => `${prefix}-${String((idCounter += 1))}` };

describe("splitSourceIntoChunks", () => {
  it("keeps a short page as a single bounded chunk", () => {
    const chunks = splitSourceIntoChunks(documents, [page("doc-1", 1, "短文本")]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, "短文本");
    assert.equal(chunks[0]!.sourceLabel, "课程.pdf · 第 1 页");
    assert.ok(chunks[0]!.text.length <= MAX_CHUNK_CHARS);
  });

  it("windows oversized pages into overlapping bounded chunks", () => {
    const longText = Array.from({ length: 600 }, (_, index) => `词${String(index).padStart(3, "0")}`).join(" ");
    const chunks = splitSourceIntoChunks(documents, [page("doc-1", 2, longText)]);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= MAX_CHUNK_CHARS, "chunk must stay within budget");
      assert.equal(chunk.documentId, "doc-1");
      assert.equal(chunk.sourceVersion, "v1");
      assert.equal(chunk.pageNumber, 2);
    }
  });

  it("labels chunks from the owning document and orders them deterministically", () => {
    const chunks = splitSourceIntoChunks(documents, [
      page("doc-2", 1, "第二份材料"),
      page("doc-1", 1, "第一份材料"),
    ]);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.sourceLabel, "课程.pdf · 第 1 页");
    assert.equal(chunks[1]!.sourceLabel, "讲义.pdf · 第 1 页");
    assert.equal(chunks[0]!.order, 0);
    assert.equal(chunks[1]!.order, 1);
  });

  it("skips pages with no extractable text", () => {
    const chunks = splitSourceIntoChunks(documents, [page("doc-1", 1, "  "), page("doc-1", 2, "正文")]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.pageNumber, 2);
  });
});

describe("parseMaterialAnalysis", () => {
  it("accepts a well-formed concepts payload", () => {
    const { concepts, errors } = parseMaterialAnalysis(
      "分析如下：\n```json\n{\"concepts\":[{\"title\":\"纵坐标轴\",\"aliases\":[\"Y 轴\"],\"summary\":\"承载数值量级，表达尺度。\",\"evidenceRefs\":[\"第 3 页 第 2 段\"]}]}\n```\n",
    );
    assert.equal(errors.length, 0);
    assert.equal(parseMaterialAnalysis("not json").valid, false);
    assert.equal(concepts.length, 1);
    assert.equal(concepts[0]!.title, "纵坐标轴");
    assert.deepEqual(concepts[0]!.aliases, ["Y 轴"]);
  });

  it("returns no concepts for malformed or non-JSON output", () => {
    assert.equal(parseMaterialAnalysis("这不是 JSON").concepts.length, 0);
    assert.equal(parseMaterialAnalysis("```json\n{broken\n```").concepts.length, 0);
    assert.equal(parseMaterialAnalysis("```json\n{\"foo\":1}\n```").concepts.length, 0);
  });

  it("ignores invalid entries and caps output at the per-chunk limit", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      title: `概念${String(index)}`,
      aliases: [],
      summary: "含义与机制说明",
      evidenceRefs: ["依据"],
    })).concat([{ title: "", aliases: [], summary: "空的标题", evidenceRefs: [] }]);
    const { concepts, errors } = parseMaterialAnalysis(`{"concepts":${JSON.stringify(many)}}`);
    assert.ok(concepts.length <= 20);
    assert.ok(errors.length > 0);
  });
});

describe("normalizeConceptTitle", () => {
  it("collapses case, whitespace, and trailing punctuation", () => {
    assert.equal(normalizeConceptTitle("  Y轴 。"), normalizeConceptTitle("y轴"));
    assert.equal(normalizeConceptTitle("坐标轴"), normalizeConceptTitle(" 坐标轴\n"));
  });
});

describe("mergeMaterialConcepts", () => {
  it("collapses duplicate titles while retaining every source excerpt", () => {
    const chunkA: SourceChunk = {
      chunkId: "c1", documentId: "doc-1", sourceVersion: "v1", pageNumber: 1, sourceLabel: "课程.pdf · 第 1 页", text: "来源甲", order: 0,
    };
    const chunkB: SourceChunk = {
      chunkId: "c2", documentId: "doc-2", sourceVersion: "v2", pageNumber: 2, sourceLabel: "讲义.pdf · 第 2 页", text: "来源乙", order: 1,
    };
    const existing: KnowledgeConcept[] = [];
    const merged = mergeMaterialConcepts("course-1", [
      { draft: { title: "坐标轴", aliases: ["坐标轴"], summary: "第一种解释，相对较短的说明。", evidenceRefs: ["来源甲依据"], sourceChunkId: "c1" }, chunk: chunkA },
      { draft: { title: " 坐标轴 ", aliases: ["轴系"], summary: "第二种解释，更长的一种说明方式以覆盖更多机制。", evidenceRefs: ["来源乙依据"], sourceChunkId: "c2" }, chunk: chunkB },
    ], existing, idPort.next, () => clock.now().toISOString());

    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.title, "坐标轴");
    assert.deepEqual(merged[0]!.sources.map((source) => source.sourceLabel), ["课程.pdf · 第 1 页", "讲义.pdf · 第 2 页"]);
    assert.ok(merged[0]!.aliases.length >= 2);
    assert.ok(merged[0]!.evidenceRefs.length >= 2);
    assert.deepEqual(merged[0]!.sources[0]!.evidenceRefs, ["来源甲依据"]);
    assert.deepEqual(merged[0]!.sources[1]!.evidenceRefs, ["来源乙依据"]);
  });

  it("merges onto existing concepts so a re-run keeps prior sources", () => {
    const chunkA: SourceChunk = {
      chunkId: "c1", documentId: "doc-1", sourceVersion: "v1", pageNumber: 3, sourceLabel: "课程.pdf · 第 3 页", text: "历史来源", order: 0,
    };
    const existing: KnowledgeConcept[] = [
      {
        id: "concept-old", courseId: "course-1", title: "坐标轴", aliases: ["旧别称"], summary: "旧解释", sources: [
          { documentId: "doc-0", sourceVersion: "v0", pageNumber: 5, sourceLabel: "旧.pdf · 第 5 页", excerpt: "旧来源", evidenceRefs: ["旧依据"] },
        ], evidenceRefs: ["旧依据"], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    const merged = mergeMaterialConcepts("course-1", [
      { draft: { title: "坐标轴", aliases: ["新别称"], summary: "新解释更完整一些。", evidenceRefs: ["新依据"], sourceChunkId: "c1" }, chunk: chunkA },
    ], existing, idPort.next, () => clock.now().toISOString());

    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.id, "concept-old");
    assert.equal(merged[0]!.sources.length, 2);
    assert.ok(merged[0]!.evidenceRefs.includes("旧依据"));
    assert.ok(merged[0]!.evidenceRefs.includes("新依据"));
  });
});

describe("collectTurnReply", () => {
  it("reassembles a streamed reply and settles on the terminal event", async () => {
    const runtime = new FakeModelRuntime();
    runtime.replies.push("{\"concepts\":[{\"title\":\"坐标轴\",\"summary\":\"含义与机制说明\",\"aliases\":[],\"evidenceRefs\":[\"第 1 段\"]}]}");
    const text = await collectTurnReply(runtime, "session-0", "系统指令", "请分析。");
    assert.ok(text.includes("坐标轴"));
  });

  it("ignores events from another model session", async () => {
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
    const text = await collectTurnReply(runtime, "session-owned", "系统指令", "请分析。");
    assert.equal(text, "owned");
  });

  it("rejects when the run fails", async () => {
    const runtime = new FakeModelRuntime();
    runtime.replies.push("");
    runtime.failMessages.push("模型中断");
    await assert.rejects(
      collectTurnReply(runtime, "session-0", "系统指令", "请分析。", 50),
      /模型中断/,
      "expected interruption to propagate",
    );
  });
});

describe("KnowledgeExtractionEngine", () => {
  it("runs a chunked extraction with a fake runtime and persists merged concepts", async () => {
    const runtime = new FakeModelRuntime();
    runtime.replies.push(
      "{\"concepts\":[{\"title\":\"坐标轴\",\"aliases\":[\"Y 轴\"],\"summary\":\"数值量级尺度。\",\"evidenceRefs\":[\"第 3 页 第 1 段\"]}]}",
      "{\"concepts\":[{\"title\":\"坐标轴\",\"aliases\":[\"轴系\"],\"summary\":\"承载量级的数值刻度轴。\",\"evidenceRefs\":[\"第 4 页 第 2 段\"]},{\"title\":\"图例\",\"aliases\":[],\"summary\":\"说明图表中符号含义的辅助元素。\",\"evidenceRefs\":[\"第 4 页 第 3 段\"]}]}",
    );

    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    const phases: string[] = [];
    engine.onProgress((progress) => phases.push(progress.phase));

    const pages = [
      page("doc-1", 3, "坐标轴概念相关文本，足够长以便切分……".repeat(80)),
      page("doc-1", 4, "坐标轴与图例的进一步说明。".repeat(90)),
    ];
    const result = await engine.run({ courseId: "course-1", documents, pages }, "kex-1");

    assert.equal(result.chunkCount > 0, true);
    assert.equal(result.analyzedChunkCount > 0, true);
    assert.equal(result.failedChunkCount, 0);
    assert.ok(result.concepts.length >= 1);
    assert.equal(result.concepts[0]!.courseId, "course-1");
    assert.ok(phases.includes("analyzing"));
    assert.ok(phases.includes("merging"));
    assert.ok(phases.includes("succeeded"));
    assert.equal(store.results.get("kex-1")?.concepts.length, result.concepts.length);

    const persisted = await store.listConcepts("course-1");
    const merged = persisted.find((concept) => normalizeConceptTitle(concept.title) === "坐标轴");
    assert.ok(merged, "schema concept should exist");
    assert.ok((merged!.sources.length ?? 0) >= 1);
    assert.ok(runtime.readSystem.length === 1);
    assert.ok(runtime.readSystem[0]!.length > 0);
  });

  it("continues past a failed chunk and reports a partial result", async () => {
    const runtime = new FakeModelRuntime();
    runtime.failMessages.push("网络错误");
    runtime.replies.push(
      "{\"concepts\":[]}",
      "{\"concepts\":[{\"title\":\"图例\",\"aliases\":[],\"summary\":\"说明图表中符号含义的辅助元素。\",\"evidenceRefs\":[\"第 1 段\"]}]}",
    );
    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    const pages = [
      page("doc-1", 1, "第一段材料说明。"),
      page("doc-1", 2, "第二段材料包含图例的定义。"),
    ];
    const result = await engine.run({ courseId: "course-1", documents, pages }, "kex-2");
    assert.equal(result.failedChunkCount, 1);
    assert.equal(result.analyzedChunkCount, 1);
    assert.equal(result.concepts.length, 1);
  });

  it("fails the extraction when no chunk produces a structurally valid response", async () => {
    const runtime = new FakeModelRuntime();
    runtime.replies.push("not json");
    const store = new MemoryStore();
    const engine = new KnowledgeExtractionEngine(runtime, store, clock, idPort);
    await assert.rejects(
      engine.run({ courseId: "course-1", documents, pages: [page("doc-1", 1, "材料说明。")] }, "kex-3"),
      /所有资料片段/,
    );
    assert.equal(store.results.has("kex-3"), false);
  });
});
