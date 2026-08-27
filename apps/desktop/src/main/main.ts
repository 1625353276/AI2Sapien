import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { ChatGptLoginLaunch, RuntimeStatusSnapshot } from "@ai2sapien/contracts";

import { RuntimeController } from "./runtime-controller.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const runtime = new RuntimeController();

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

function registerIpc(): void {
  ipcMain.handle("runtime:read-status", () => runtime.readStatus());
  ipcMain.handle("auth:start-browser-login", async (): Promise<ChatGptLoginLaunch> => {
    const launch = await runtime.startBrowserLogin();
    const url = new URL(launch.authUrl);
    if (url.protocol !== "https:") throw new Error("Codex returned an unsafe authentication URL");
    await shell.openExternal(url.toString());
    return launch;
  });
  ipcMain.handle("auth:logout", () => runtime.logout());
}

async function publishRuntimeStatus(): Promise<void> {
  const status: RuntimeStatusSnapshot = await runtime.readStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("runtime:status-changed", status);
  }
}

registerIpc();
runtime.onInvalidated(() => {
  void publishRuntimeStatus();
});

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void runtime.stop();
});
