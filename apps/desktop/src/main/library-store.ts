import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type {
  Course,
  CourseCreate,
  CourseDocument,
  DocumentBinary,
  DocumentDetail,
  DocumentImportProgress,
  DocumentImportResult,
  DocumentPage,
} from "@ai2sapien/contracts";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

interface StoredCourse extends Omit<Course, "documentCount"> {}

interface StoredDocument extends CourseDocument {
  storageName: string;
}

interface LearningDatabase {
  schemaVersion: 1;
  courses: StoredCourse[];
  documents: StoredDocument[];
  pages: DocumentPage[];
}

const EMPTY_DATABASE: LearningDatabase = {
  schemaVersion: 1,
  courses: [],
  documents: [],
  pages: [],
};

export type ImportProgressListener = (progress: DocumentImportProgress) => void;

export class LibraryStore {
  readonly #rootDirectory: string;
  readonly #databasePath: string;
  readonly #originalsDirectory: string;
  #database: LearningDatabase = structuredClone(EMPTY_DATABASE);
  #initialized: Promise<void> | null = null;

  constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
    this.#databasePath = join(rootDirectory, "library.json");
    this.#originalsDirectory = join(rootDirectory, "originals");
  }

  initialize(): Promise<void> {
    if (!this.#initialized) this.#initialized = this.#initializeInternal();
    return this.#initialized;
  }

  async listCourses(): Promise<Course[]> {
    await this.initialize();
    return this.#database.courses
      .map((course) => this.#toCourse(course))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createCourse(input: CourseCreate): Promise<Course> {
    await this.initialize();
    const title = input.title.trim();
    const description = input.description.trim();
    const defaultLanguage = input.defaultLanguage.trim() || "zh-CN";

    if (title.length === 0 || title.length > 200) {
      throw new Error("课程名称必须为 1–200 个字符。");
    }
    if (description.length > 2_000) {
      throw new Error("课程说明不能超过 2000 个字符。");
    }

    const now = new Date().toISOString();
    const course: StoredCourse = {
      id: randomUUID(),
      title,
      description,
      defaultLanguage,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#database.courses.push(course);
    await this.#persist();
    return this.#toCourse(course);
  }

  async listDocuments(courseId: string): Promise<CourseDocument[]> {
    await this.initialize();
    this.#requireCourse(courseId);
    return this.#database.documents
      .filter((document) => document.courseId === courseId)
      .map(stripStorageName)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async importPdfFiles(
    courseId: string,
    sourcePaths: readonly string[],
    onProgress?: ImportProgressListener,
  ): Promise<DocumentImportResult> {
    await this.initialize();
    const course = this.#requireCourse(courseId);
    const result: DocumentImportResult = { imported: [], failed: [] };
    const total = sourcePaths.length;

    for (const [index, sourcePath] of sourcePaths.entries()) {
      const fileName = basename(sourcePath);
      const current = index + 1;

      try {
        if (extname(sourcePath).toLowerCase() !== ".pdf") {
          throw new Error("当前切片只支持 PDF 文件。");
        }
        const sourceStat = await stat(sourcePath);
        if (!sourceStat.isFile()) throw new Error("选择的路径不是文件。");
        if (sourceStat.size === 0) throw new Error("PDF 文件为空。");

        onProgress?.({ courseId, current, total, fileName, phase: "copying" });
        const id = randomUUID();
        const storageName = `${id}.pdf`;
        const destinationPath = join(this.#originalsDirectory, storageName);
        await copyFile(sourcePath, destinationPath);

        onProgress?.({ courseId, current, total, fileName, phase: "parsing" });
        const bytes = await readFile(destinationPath);
        const parsed = await parsePdf(bytes, id);
        const createdAt = new Date().toISOString();
        const warnings = parsed.pages.every((page) => page.text.length === 0)
          ? ["未能提取文本；仍可查看原始 PDF，后续可使用 OCR。"]
          : [];
        const document: StoredDocument = {
          id,
          courseId,
          displayName: fileName,
          mediaType: "application/pdf",
          sourceVersion: createHash("sha256").update(bytes).digest("hex"),
          status: "ready",
          pageCount: parsed.pageCount,
          sizeBytes: sourceStat.size,
          warnings,
          createdAt,
          storageName,
        };

        for (const page of parsed.pages) page.sourceVersion = document.sourceVersion;
        this.#database.documents.push(document);
        this.#database.pages.push(...parsed.pages);
        course.version += 1;
        course.updatedAt = createdAt;
        await this.#persist();
        result.imported.push(stripStorageName(document));
        onProgress?.({ courseId, current, total, fileName, phase: "complete" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ fileName, message });
        onProgress?.({ courseId, current, total, fileName, phase: "failed" });
      }
    }

    return result;
  }

  async readDocument(documentId: string): Promise<DocumentDetail> {
    await this.initialize();
    const document = this.#requireDocument(documentId);
    return {
      document: stripStorageName(document),
      pages: this.#database.pages
        .filter((page) => page.documentId === documentId)
        .sort((left, right) => left.pageNumber - right.pageNumber),
    };
  }

  async readDocumentBinary(documentId: string): Promise<DocumentBinary> {
    await this.initialize();
    const document = this.#requireDocument(documentId);
    const bytes = await readFile(join(this.#originalsDirectory, document.storageName));
    return {
      documentId,
      fileName: document.displayName,
      mediaType: document.mediaType,
      bytes: new Uint8Array(bytes),
    };
  }

  async readPage(documentId: string, pageNumber: number): Promise<DocumentPage> {
    await this.initialize();
    this.#requireDocument(documentId);
    const page = this.#database.pages.find(
      (candidate) => candidate.documentId === documentId && candidate.pageNumber === pageNumber,
    );
    if (!page) throw new Error("没有找到对应的来源页面。");
    return page;
  }

  async #initializeInternal(): Promise<void> {
    await mkdir(this.#originalsDirectory, { recursive: true });
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

  #requireCourse(courseId: string): StoredCourse {
    const course = this.#database.courses.find((candidate) => candidate.id === courseId);
    if (!course) throw new Error("课程不存在或已经被删除。");
    return course;
  }

  #requireDocument(documentId: string): StoredDocument {
    const document = this.#database.documents.find((candidate) => candidate.id === documentId);
    if (!document) throw new Error("资料不存在或已经被删除。");
    return document;
  }

  #toCourse(course: StoredCourse): Course {
    return {
      ...course,
      documentCount: this.#database.documents.filter((document) => document.courseId === course.id).length,
    };
  }
}

async function parsePdf(bytes: Uint8Array, documentId: string): Promise<{ pageCount: number; pages: DocumentPage[] }> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const pages: DocumentPage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const fragments: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        fragments.push(item.str);
        if (item.hasEOL) fragments.push("\n");
      }
      const text = fragments.join(" ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      pages.push({
        documentId,
        sourceVersion: "pending",
        pageNumber,
        text,
        warnings: text.length === 0 ? ["本页没有可提取文本，可能需要 OCR。"] : [],
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return { pageCount: pdf.numPages, pages };
}

function stripStorageName(document: StoredDocument): CourseDocument {
  const { storageName: _storageName, ...publicDocument } = document;
  return publicDocument;
}

function validateDatabase(value: unknown): LearningDatabase {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("本地学习数据库版本无效。");
  if (!Array.isArray(value.courses) || !Array.isArray(value.documents) || !Array.isArray(value.pages)) {
    throw new Error("本地学习数据库结构无效。");
  }
  return value as unknown as LearningDatabase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
