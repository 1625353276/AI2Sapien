import { CodexAppServerClient } from "@ai2sapien/agent-runtime";
import type { ProviderStatusView } from "@ai2sapien/contracts";

import type { ModelProvider, ModelTurnEvent, ModelTurnListener, TurnRequest } from "./types.js";

interface ActiveRun {
  runId: string;
  threadId: string;
}

export class CodexProvider implements ModelProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex (ChatGPT 登录)";
  readonly #client: CodexAppServerClient;
  readonly #listeners = new Set<ModelTurnListener>();
  readonly #activeRuns = new Map<string, ActiveRun>();
  #started = false;

  constructor(client: CodexAppServerClient) {
    this.#client = client;
    this.#client.onNotification((notification) => {
      this.#handleNotification(notification.method, notification.params);
    });
  }

  status(): ProviderStatusView {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      configured: true,
      detail: "登录状态见 AI 运行状态卡片。",
    };
  }

  async createSession(system: string): Promise<string> {
    await this.#start();
    const thread = await this.#client.startThread({
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "AI2Sapien Model",
      baseInstructions: system,
      ephemeral: false,
    });
    return thread.thread.id;
  }

  async sendTurn(sessionId: string, request: TurnRequest): Promise<string> {
    await this.#start();
    const messages = request.messages;
    const text = messages.length > 0 ? messages[messages.length - 1]!.content : "";
    const result = await this.#client.startTurn({
      threadId: sessionId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const active: ActiveRun = { runId: result.turn.id, threadId: sessionId };
    this.#activeRuns.set(active.runId, active);
    this.#emit({
      providerId: this.id,
      sessionId,
      runId: active.runId,
      status: "running",
      delta: "",
      message: null,
    });
    return active.runId;
  }

  async interrupt(runId: string): Promise<void> {
    const active = this.#activeRuns.get(runId);
    if (!active) throw new Error("没有找到可中断的生成。");
    await this.#client.interruptTurn(active.threadId, runId);
  }

  events(listener: ModelTurnListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #start(): Promise<void> {
    if (this.#started) return;
    await this.#client.start();
    this.#started = true;
  }

  #handleNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    const runId = typeof params.turnId === "string"
      ? params.turnId
      : isRecord(params.turn) && typeof params.turn.id === "string"
        ? params.turn.id
        : null;
    if (!runId) return;
    const active = this.#activeRuns.get(runId);
    if (!active) return;

    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.#emit({
        providerId: this.id,
        sessionId: active.threadId,
        runId,
        status: "running",
        delta: params.delta,
        message: null,
      });
      return;
    }

    if (method !== "turn/completed" || !isRecord(params.turn)) return;
    const remoteStatus = params.turn.status;
    const error = isRecord(params.turn.error) && typeof params.turn.error.message === "string"
      ? params.turn.error.message
      : null;
    const status: ModelTurnEvent["status"] = remoteStatus === "completed"
      ? "succeeded"
      : remoteStatus === "interrupted"
        ? "interrupted"
        : "failed";
    this.#activeRuns.delete(runId);
    this.#emit({
      providerId: this.id,
      sessionId: active.threadId,
      runId,
      status,
      delta: "",
      message: error,
    });
  }

  #emit(event: ModelTurnEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
