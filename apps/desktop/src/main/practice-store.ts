import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AttemptSummary,
  ConceptMastery,
  ConceptSource,
  Id,
  IsoDateTime,
  MasteryLevel,
  Question,
  SelectionContext,
} from "@ai2sapien/contracts";
import { asMasteryEvidence, deriveMasteryLevel } from "@ai2sapien/learning-core";

interface StoredConcept {
  id: Id;
  courseId: Id;
  topic: string;
  firstSourceRef: string;
  createdAt: IsoDateTime;
  source: StoredConceptSource | null;
}

interface StoredConceptSource extends ConceptSource {
  pageText: string;
}

export interface AttemptRecord {
  attemptId: Id;
  practiceId: Id;
  questionId: Id;
  courseId: Id;
  conceptId: Id;
  chosenOptionId: Id;
  correct: boolean;
  reasoningCorrect: boolean;
  reason: string;
  isRetest: boolean;
  occurredAt: IsoDateTime;
  remediationCause: string | null;
  remediationHowToNotice: string | null;
  remediationExplanation: string | null;
}

interface PracticeDatabase {
  schemaVersion: 1;
  concepts: StoredConcept[];
  questions: Question[];
  attempts: AttemptRecord[];
}

const EMPTY_DATABASE: PracticeDatabase = {
  schemaVersion: 1,
  concepts: [],
  questions: [],
  attempts: [],
};

export class PracticeStore {
  readonly #rootDirectory: string;
  readonly #databasePath: string;
  #database: PracticeDatabase = structuredClone(EMPTY_DATABASE);
  #initialized: Promise<void> | null = null;

  constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
    this.#databasePath = join(rootDirectory, "practice.json");
  }

  initialize(): Promise<void> {
    if (!this.#initialized) this.#initialized = this.#initializeInternal();
    return this.#initialized;
  }

  recordConcept(
    courseId: string,
    topic: string,
    source: {
      sourceLabel: string;
      selection: SelectionContext;
      pageText: string;
    },
  ): Promise<{ conceptId: string; isNew: boolean }> {
    return this.recordConceptInternal(courseId, topic, {
      sourceLabel: source.sourceLabel,
      documentId: source.selection.documentId,
      sourceVersion: source.selection.sourceVersion,
      pageNumber: source.selection.pageNumber,
      selectedText: source.selection.selectedText,
      pageText: source.pageText,
    });
  }

  private async recordConceptInternal(
    courseId: string,
    topic: string,
    source: Omit<StoredConceptSource, "sourceLabel"> & { sourceLabel: string },
  ): Promise<{ conceptId: string; isNew: boolean }> {
    await this.initialize();
    const normalizedTopic = normalizeTopic(topic);
    const existing = this.#database.concepts.find(
      (concept) => concept.courseId === courseId && normalizeTopic(concept.topic) === normalizedTopic,
    );
    if (existing) {
      const merged: StoredConceptSource = {
        documentId: source.documentId,
        sourceVersion: source.sourceVersion,
        pageNumber: source.pageNumber,
        selectedText: source.selectedText,
        sourceLabel: source.sourceLabel,
        pageText: source.pageText.slice(0, 16_000),
      };
      existing.source = merged;
      existing.firstSourceRef = source.sourceLabel;
      await this.#persist();
      return { conceptId: existing.id, isNew: false };
    }

    const concept: StoredConcept = {
      id: randomUUID(),
      courseId,
      topic: topic.trim(),
      firstSourceRef: source.sourceLabel,
      createdAt: new Date().toISOString(),
      source: {
        documentId: source.documentId,
        sourceVersion: source.sourceVersion,
        pageNumber: source.pageNumber,
        selectedText: source.selectedText,
        sourceLabel: source.sourceLabel,
        pageText: source.pageText.slice(0, 16_000),
      },
    };
    this.#database.concepts.push(concept);
    await this.#persist();
    return { conceptId: concept.id, isNew: true };
  }

  async recordQuestion(question: Question): Promise<void> {
    await this.initialize();
    const index = this.#database.questions.findIndex((candidate) => candidate.id === question.id);
    if (index >= 0) this.#database.questions[index] = question;
    else this.#database.questions.push(question);
    await this.#persist();
  }

  async recordAttempt(attempt: AttemptRecord): Promise<void> {
    await this.initialize();
    const index = this.#database.attempts.findIndex((candidate) => candidate.attemptId === attempt.attemptId);
    if (index >= 0) this.#database.attempts[index] = attempt;
    else this.#database.attempts.push(attempt);
    await this.#persist();
  }

  async listQuestions(conceptId: string): Promise<Question[]> {
    await this.initialize();
    return this.#database.questions
      .filter((question) => question.conceptId === conceptId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listQuestion(questionId: string): Promise<Question | null> {
    await this.initialize();
    return this.#database.questions.find((question) => question.id === questionId) ?? null;
  }

  async listAttempts(courseId: string): Promise<AttemptRecord[]> {
    await this.initialize();
    return this.#database.attempts
      .filter((attempt) => attempt.courseId === courseId)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  async listConceptAttempts(conceptId: string): Promise<AttemptSummary[]> {
    await this.initialize();
    return this.#database.attempts
      .filter((attempt) => attempt.conceptId === conceptId)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .map((attempt) => ({
        attemptId: attempt.attemptId,
        correct: attempt.correct,
        reasoningCorrect: attempt.reasoningCorrect,
        isRetest: attempt.isRetest,
        occurredAt: attempt.occurredAt,
        remediationCause: attempt.remediationCause,
      }));
  }

  async listConceptMastery(courseId: string): Promise<ConceptMastery[]> {
    await this.initialize();
    return this.#database.concepts
      .filter((concept) => concept.courseId === courseId)
      .map((concept) => this.#conceptMastery(concept))
      .sort((left, right) => (right.lastAttemptAt ?? "").localeCompare(left.lastAttemptAt ?? ""));
  }

  async conceptMastery(courseId: string, conceptId: string): Promise<ConceptMastery> {
    await this.initialize();
    const concept = this.#database.concepts.find(
      (candidate) => candidate.id === conceptId && candidate.courseId === courseId,
    );
    if (!concept) throw new Error("概念不存在。");
    return this.#conceptMastery(concept);
  }

  async getConceptContext(conceptId: string): Promise<{ courseId: string; topic: string; source: StoredConceptSource | null }> {
    await this.initialize();
    const concept = this.#database.concepts.find((candidate) => candidate.id === conceptId);
    if (!concept) throw new Error("概念不存在。");
    return {
      courseId: concept.courseId,
      topic: concept.topic,
      source: concept.source,
    };
  }

  #conceptMastery(concept: StoredConcept): ConceptMastery {
    const attempts = this.#database.attempts
      .filter((attempt) => attempt.conceptId === concept.id && attempt.courseId === concept.courseId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const evidence = attempts.map((attempt) =>
      asMasteryEvidence({
        evidenceId: attempt.attemptId,
        conceptId: concept.id,
        isRetest: attempt.isRetest,
        correct: attempt.correct,
        reasoningCorrect: attempt.reasoningCorrect,
        occurredAt: attempt.occurredAt,
      }),
    );
    const level: MasteryLevel = deriveMasteryLevel(evidence);
    return {
      conceptId: concept.id,
      topic: concept.topic,
      level,
      evidenceCount: attempts.length,
      lastAttemptAt: attempts.length > 0 ? attempts.at(-1)?.occurredAt ?? null : null,
      source: concept.source
        ? {
          documentId: concept.source.documentId,
          sourceVersion: concept.source.sourceVersion,
          pageNumber: concept.source.pageNumber,
          selectedText: concept.source.selectedText,
          sourceLabel: concept.source.sourceLabel,
        }
        : null,
    };
  }

  async #initializeInternal(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#databasePath, "utf8")) as unknown;
      this.#database = validateDatabase(parsed);
    } catch (error) {
      const code = isNodeError(error) ? error.code : null;
      if (code !== "ENOENT") throw error;
      this.#database = structuredClone(EMPTY_DATABASE);
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true });
    const temporaryPath = `${this.#databasePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.#database, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#databasePath);
  }
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function validateDatabase(value: unknown): PracticeDatabase {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("练习数据库版本无效。");
  if (!Array.isArray(value.concepts) || !Array.isArray(value.questions) || !Array.isArray(value.attempts)) {
    throw new Error("练习数据库结构无效。");
  }
  return value as unknown as PracticeDatabase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
