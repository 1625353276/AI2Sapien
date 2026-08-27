import type { ChatGptLoginLaunch, RuntimeStatusSnapshot } from "@ai2sapien/contracts";

interface AI2SapienDesktopApi {
  readRuntimeStatus(): Promise<RuntimeStatusSnapshot>;
  startBrowserLogin(): Promise<ChatGptLoginLaunch>;
  logout(): Promise<void>;
  onRuntimeStatusChanged(listener: (status: RuntimeStatusSnapshot) => void): () => void;
}

declare global {
  interface Window {
    ai2sapien: AI2SapienDesktopApi;
  }
}

export {};
