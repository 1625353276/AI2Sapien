import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error("Usage: node scripts/library-smoke.mjs <pdf-path>");
}

const workspaceRoot = resolve(".");
const temporaryDirectory = await mkdtemp(join(workspaceRoot, ".ai2sapien-library-smoke-"));
const bundlePath = join(temporaryDirectory, "library-store.mjs");

try {
  await build({
    entryPoints: ["apps/desktop/src/main/library-store.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundlePath,
    external: ["pdfjs-dist", "pdfjs-dist/*"],
  });

  const { LibraryStore } = await import(pathToFileURL(bundlePath).href);
  const store = new LibraryStore(join(temporaryDirectory, "learning-data"));
  await store.initialize();
  const course = await store.createCourse({
    title: "Library smoke test",
    description: "Temporary real-PDF verification",
    defaultLanguage: "zh-CN",
  });
  const imported = await store.importPdfFiles(course.id, [resolve(sourcePath)]);
  if (!imported.imported[0]) throw new Error(imported.failed[0]?.message ?? "PDF import failed");

  const detail = await store.readDocument(imported.imported[0].id);
  const binary = await store.readDocumentBinary(imported.imported[0].id);
  process.stdout.write(`${JSON.stringify({
    courseCount: (await store.listCourses()).length,
    importedCount: imported.imported.length,
    pageCount: detail.pages.length,
    firstPageText: detail.pages[0]?.text.slice(0, 160) ?? "",
    binaryBytes: binary.bytes.byteLength,
  }, null, 2)}\n`);
} finally {
  if (temporaryDirectory.startsWith(workspaceRoot)) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
