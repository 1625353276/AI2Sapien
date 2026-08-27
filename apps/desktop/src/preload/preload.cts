const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

import type {
  ChatGptLoginLaunch,
  RuntimeStatusSnapshot,
} from "@ai2sapien/contracts";

interface AI2SapienDesktopApi {
  readRuntimeStatus(): Promise<RuntimeStatusSnapshot>;
  startBrowserLogin(): Promise<ChatGptLoginLaunch>;
  logout(): Promise<void>;
  onRuntimeStatusChanged(listener: (status: RuntimeStatusSnapshot) => void): () => void;
}

const api: AI2SapienDesktopApi = {
  readRuntimeStatus: () => ipcRenderer.invoke("runtime:read-status"),
  startBrowserLogin: () => ipcRenderer.invoke("auth:start-browser-login"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  onRuntimeStatusChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: RuntimeStatusSnapshot): void => {
      listener(status);
    };
    ipcRenderer.on("runtime:status-changed", handler);
    return () => ipcRenderer.removeListener("runtime:status-changed", handler);
  },
};

contextBridge.exposeInMainWorld("ai2sapien", api);
