import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CodexAppServerClient } from "@ai2sapien/agent-runtime";
import type {
  AttemptSubmission,
  ChatGptLoginLaunch,
  CourseCreate,
  ExplanationFollowUp,
  ExplanationRequest,
  PracticeRequest,
  ProviderSettingsSave,
  RuntimeStatusSnapshot,
} from "@ai2sapien/contracts";
import { CodexProvider, ModelRuntimeImpl } from "@ai2sapien/model-providers";

import { LibraryStore } from "./library-store.js";
import { PracticeController } from "./practice-controller.js";
import { PracticeStore } from "./practice-store.js";
import { ProviderSettingsStore } from "./provider-settings.js";
import { RuntimeController } from "./runtime-controller.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const client = new CodexAppServerClient();
let runtime: RuntimeController | null = null;
let modelRuntime: ModelRuntimeImpl | null = null;
let providers: ProviderSettingsStore | null = null;
let library: LibraryStore | null = null;
let practiceStore: PracticeStore | null = null;
let practice: PracticeController | null = null;

function rendererDevelopmentUrl(): string | null {
  const argument = process.argv.find((item) => item.startsWith("--dev-server-url="));
  return argument?.slice("--dev-server-url=".length) ?? null;
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: "#f2efe8",
    title: "AI2Sapien · 人工智人",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());

  const developmentUrl = rendererDevelopmentUrl();
  if (developmentUrl) {
    await window.loadURL(developmentUrl);
  } else {
    await window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }

  return window;
}

function currentProviderState() {
  const settings = requireProviders().view();
  return {
    settings,
    statuses: requireModelRuntime().listStatus(),
    active: requireModelRuntime().activeProvider,
  };
}

function registerIpc(): void {
  ipcMain.handle("runtime:read-status", () => requireRuntime().readStatus());
  ipcMain.handle("auth:start-browser-login", async (): Promise<ChatGptLoginLaunch> => {
    const launch = await requireRuntime().startBrowserLogin();
    const url = new URL(launch.authUrl);
    if (url.protocol !== "https:") throw new Error("Codex returned an unsafe authentication URL");
    await shell.openExternal(url.toString());
    return launch;
  });
  ipcMain.handle("auth:logout", () => requireRuntime().logout());
  ipcMain.handle("library:list-courses", () => requireLibrary().listCourses());
  ipcMain.handle("library:create-course", (_event, input: CourseCreate) => requireLibrary().createCourse(input));
  ipcMain.handle("library:list-documents", (_event, courseId: string) => requireLibrary().listDocuments(courseId));
  ipcMain.handle("library:read-document", (_event, documentId: string) => requireLibrary().readDocument(documentId));
  ipcMain.handle("library:read-document-binary", (_event, documentId: string) => requireLibrary().readDocumentBinary(documentId));
  ipcMain.handle("library:import-documents", async (event, courseId: string) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "导入 PDF 课程资料",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF 课程资料", extensions: ["pdf"] }],
    };
    const selection = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || selection.filePaths.length === 0) return { imported: [], failed: [] };
    return requireLibrary().importPdfFiles(courseId, selection.filePaths, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("library:import-progress", progress);
    });
  });
  ipcMain.handle("learning:start-explanation", async (_event, request: ExplanationRequest) => {
    const selection = request.selection;
    const detail = await requireLibrary().readDocument(selection.documentId);
    const page = await requireLibrary().readPage(selection.documentId, selection.pageNumber);
    if (page.sourceVersion !== selection.sourceVersion) throw new Error("资料版本已经变化，请重新选择文本。");
    const selectedText = selection.selectedText.trim();
    if (selectedText.length === 0 || selectedText.length > 4_000) {
      throw new Error("请选择 1–4000 个字符进行解释。");
    }
    const selectionIndex = page.text.indexOf(selectedText);
    if (selectionIndex < 0) throw new Error("所选文本不属于当前来源页面，请重新选择。");
    const safeRequest: ExplanationRequest = {
      ...request,
      selection: {
        ...selection,
        selectedText,
        prefix: page.text.slice(Math.max(0, selectionIndex - 1_000), selectionIndex),
        suffix: page.text.slice(selectionIndex + selectedText.length, selectionIndex + selectedText.length + 1_000),
      },
    };
    const sourceLabel = `${detail.document.displayName} · 第 ${String(page.pageNumber)} 页`;
    return requireRuntime().startExplanation(safeRequest, page.text, sourceLabel);
  });
  ipcMain.handle("learning:follow-up", (_event, input: ExplanationFollowUp) => requireRuntime().followUpExplanation(input));
  ipcMain.handle("learning:cancel-explanation", (_event, runId: string) => requireRuntime().cancelExplanation(runId));
  ipcMain.handle("learning:start-practice", async (_event, request: PracticeRequest) => {
    const selection = request.selection;
    const detail = await requireLibrary().readDocument(selection.documentId);
    const page = await requireLibrary().readPage(selection.documentId, selection.pageNumber);
    if (page.sourceVersion !== selection.sourceVersion) throw new Error("资料版本已经变化，请重新选择文本。");
    const selectedText = selection.selectedText.trim();
    if (selectedText.length === 0 || selectedText.length > 4_000) {
      throw new Error("请选择 1–4000 个字符的划线内容进行练习。");
    }
    const selectionIndex = page.text.indexOf(selectedText);
    if (selectionIndex < 0) throw new Error("所选文本不属于当前来源页面，请重新选择。");
    const topic = request.topic.trim();
    if (topic.length === 0 || topic.length > 120) {
      throw new Error("主题必须为 1–120 个字符。");
    }
    const sourceLabel = `${detail.document.displayName} · 第 ${String(page.pageNumber)} 页`;
    const practiceId = await requirePractice().startPractice(
      {
        ...request,
        topic,
        selection: {
          ...selection,
          selectedText,
          prefix: page.text.slice(Math.max(0, selectionIndex - 1_000), selectionIndex),
          suffix: page.text.slice(selectionIndex + selectedText.length, selectionIndex + selectedText.length + 1_000),
        },
      },
      page.text,
      sourceLabel,
    );
    return { practiceId };
  });
  ipcMain.handle("learning:submit-answer", (_event, input: AttemptSubmission) => requirePractice().submitAnswer(input));
  ipcMain.handle("learning:list-mastery", (_event, courseId: string) => requirePracticeStore().listConceptMastery(courseId));
  ipcMain.handle("provider:get-state", () => currentProviderState());
  ipcMain.handle("provider:save-settings", async (_event, input: ProviderSettingsSave) => {
    const saved = await requireProviders().save(input);
    await requireModelRuntime().configure(saved);
    const next = currentProviderState();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("provider:state-changed", next);
    }
    return next;
  });
}

async function publishRuntimeStatus(): Promise<void> {
  const status: RuntimeStatusSnapshot = await requireRuntime().readStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("runtime:status-changed", status);
  }
}

function forwardEvent(channel: string): (payload: unknown) => void {
  return (payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const learningDataRoot = join(userData, "learning-data");

  library = new LibraryStore(learningDataRoot);
  await library.initialize();
  practiceStore = new PracticeStore(learningDataRoot);
  await practiceStore.initialize();
  providers = new ProviderSettingsStore(userData);
  const settings = await providers.load();
  modelRuntime = new ModelRuntimeImpl(new CodexProvider(client), settings);
  runtime = new RuntimeController(client, modelRuntime);
  practice = new PracticeController(modelRuntime, practiceStore);

  runtime.onInvalidated(() => {
    void publishRuntimeStatus();
  });
  runtime.onExplanationUpdate(forwardEvent("learning:explanation-update"));
  practice.onPracticeUpdate(forwardEvent("learning:practice-event"));
  practice.onPracticeQuestion(forwardEvent("learning:practice-question"));
  practice.onRemediationUpdate(forwardEvent("learning:practice-remediation"));
  practice.onPracticeResult(forwardEvent("learning:practice-result"));

  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void client.stop();
});

function requireLibrary(): LibraryStore {
  if (!library) throw new Error("本地资料库尚未初始化。");
  return library;
}

function requirePracticeStore(): PracticeStore {
  if (!practiceStore) throw new Error("练习数据库尚未初始化。");
  return practiceStore;
}

function requirePractice(): PracticeController {
  if (!practice) throw new Error("练习引擎尚未初始化。");
  return practice;
}

function requireRuntime(): RuntimeController {
  if (!runtime) throw new Error("运行时尚未初始化。");
  return runtime;
}

function requireModelRuntime(): ModelRuntimeImpl {
  if (!modelRuntime) throw new Error("模型运行时尚未初始化。");
  return modelRuntime;
}

function requireProviders(): ProviderSettingsStore {
  if (!providers) throw new Error("提供者配置尚未初始化。");
  return providers;
}
