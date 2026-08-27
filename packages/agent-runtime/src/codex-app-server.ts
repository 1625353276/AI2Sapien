import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import {
  JsonRpcPeer,
  JsonRpcProtocolError,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./json-rpc.js";

export interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexAppServerOptions {
  command?: string;
  cwd?: string;
  clientInfo?: CodexClientInfo;
  requestTimeoutMs?: number;
}

export interface AccountReadResult {
  account:
    | null
    | {
        type: string;
        email?: string | null;
        planType?: string | null;
        [key: string]: unknown;
      };
  requiresOpenaiAuth: boolean;
}

export interface BrowserLoginResult {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface DeviceCodeLoginResult {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface RateLimitsReadResult {
  rateLimits: unknown;
  rateLimitsByLimitId?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ThreadSummary {
  id: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ThreadStartResult {
  thread: ThreadSummary;
  instructionSources?: string[];
}

export interface TurnStartResult {
  turn: {
    id: string;
    status: string;
    items?: unknown[];
    error?: unknown;
  };
}

export interface TurnInputText {
  type: "text";
  text: string;
}

export interface TurnStartParams {
  threadId: string;
  input: TurnInputText[];
  outputSchema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  personality?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandboxPolicy?: Record<string, unknown>;
}

type NotificationListener = (notification: JsonRpcNotification) => void;
type ServerRequestListener = (request: JsonRpcServerRequest) => void;
type DiagnosticListener = (message: string) => void;

/**
 * Owns one local Codex App Server stdio process and its initialization handshake.
 * Authentication tokens remain owned by Codex and are never exposed here.
 */
export class CodexAppServerClient {
  readonly #options: Required<Pick<CodexAppServerOptions, "command" | "clientInfo">> &
    Omit<CodexAppServerOptions, "command" | "clientInfo">;
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #serverRequestListeners = new Set<ServerRequestListener>();
  readonly #diagnosticListeners = new Set<DiagnosticListener>();

  #process: ChildProcessWithoutNullStreams | null = null;
  #readline: ReadlineInterface | null = null;
  #peer: JsonRpcPeer | null = null;
  #startPromise: Promise<void> | null = null;
  #stopping = false;

  constructor(options: CodexAppServerOptions = {}) {
    this.#options = {
      ...options,
      command: options.command ?? "codex",
      clientInfo: options.clientInfo ?? {
        name: "ai2sapien",
        title: "AI2Sapien",
        version: "0.1.0",
      },
    };
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startInternal();
    return this.#startPromise;
  }

  async #startInternal(): Promise<void> {
    this.#stopping = false;
    const child = spawn(this.#options.command, ["app-server", "--stdio"], {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.#process = child;
    this.#peer = new JsonRpcPeer({
      sendLine: (line) => {
        if (!child.stdin.writable) throw new JsonRpcProtocolError("Codex stdin is not writable");
        child.stdin.write(`${line}\n`);
      },
      ...(this.#options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.#options.requestTimeoutMs }),
    });

    this.#peer.onNotification((notification) => {
      for (const listener of this.#notificationListeners) listener(notification);
    });
    this.#peer.onServerRequest((request) => {
      for (const listener of this.#serverRequestListeners) listener(request);
    });
    this.#peer.onProtocolError((error) => this.#emitDiagnostic(error.message));

    this.#readline = createInterface({ input: child.stdout });
    this.#readline.on("line", (line) => this.#peer?.feedLine(line));
    child.stderr.on("data", (chunk: Buffer) => this.#emitDiagnostic(chunk.toString("utf8").trimEnd()));

    child.once("error", (error) => {
      this.#peer?.close(error);
      this.#emitDiagnostic(`Codex process error: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      const wasStopping = this.#stopping;
      const reason = new Error(
        `Codex App Server exited${code === null ? "" : ` with code ${String(code)}`}${signal ? ` (${signal})` : ""}`,
      );
      this.#peer?.close(reason);
      if (!wasStopping) this.#emitDiagnostic(reason.message);
      this.#process = null;
      this.#peer = null;
      this.#readline = null;
      this.#startPromise = null;
      this.#stopping = false;
    });

    await this.#peer.request("initialize", {
      clientInfo: this.#options.clientInfo,
    });
    this.#peer.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#stopping = true;
    this.#readline?.close();
    this.#peer?.close();
    this.#readline = null;
    this.#peer = null;
    this.#startPromise = null;

    if (!child || child.exitCode !== null) {
      this.#process = null;
      this.#stopping = false;
      return;
    }

    this.#process = null;
    child.kill();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  readAccount(refreshToken = false): Promise<AccountReadResult> {
    return this.#request("account/read", { refreshToken });
  }

  startChatGptLogin(): Promise<BrowserLoginResult> {
    return this.#request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
  }

  startDeviceCodeLogin(): Promise<DeviceCodeLoginResult> {
    return this.#request("account/login/start", { type: "chatgptDeviceCode" });
  }

  async logout(): Promise<void> {
    await this.#request("account/logout");
  }

  readRateLimits(): Promise<RateLimitsReadResult> {
    return this.#request("account/rateLimits/read");
  }

  startThread(params: {
    model?: string;
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    personality?: string;
    serviceName?: string;
  } = {}): Promise<ThreadStartResult> {
    return this.#request("thread/start", params);
  }

  resumeThread(threadId: string): Promise<ThreadStartResult> {
    return this.#request("thread/resume", { threadId });
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.#request("turn/start", params);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId });
  }

  respondToServerRequest(requestId: number | string, result: unknown): void {
    this.#requirePeer().respondResult(requestId, result);
  }

  rejectServerRequest(
    requestId: number | string,
    error: { code: number; message: string; data?: unknown },
  ): void {
    this.#requirePeer().respondError(requestId, error);
  }

  onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  onDiagnostic(listener: DiagnosticListener): () => void {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  #request<TResult>(method: string, params?: unknown): Promise<TResult> {
    return this.#requirePeer().request<TResult>(method, params);
  }

  #requirePeer(): JsonRpcPeer {
    if (!this.#peer) {
      throw new JsonRpcProtocolError("Codex App Server is not started");
    }
    return this.#peer;
  }

  #emitDiagnostic(message: string): void {
    if (message.length === 0) return;
    for (const listener of this.#diagnosticListeners) listener(message);
  }
}
