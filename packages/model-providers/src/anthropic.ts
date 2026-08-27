import { randomUUID } from "node:crypto";

import type { AnthropicSettings, ProviderStatusView } from "@ai2sapien/contracts";

import { SseParser } from "./sse.js";
import type { ModelProvider, ModelTurnEvent, ModelTurnListener, ProviderMessage, TurnRequest } from "./types.js";

interface ActiveRun {
  runId: string;
  sessionId: string;
  controller: AbortController;
}

const STREAM_TIMEOUT_MS = 180_000;
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly displayName = "Anthropic (Claude)";
  readonly #settings: AnthropicSettings;
  readonly #sessions = new Map<string, ProviderMessage[]>();
  readonly #runs = new Map<string, ActiveRun>();
  readonly #listeners = new Set<ModelTurnListener>();
  readonly #fetch: typeof fetch;

  constructor(settings: AnthropicSettings, fetchImpl: typeof fetch = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;
  }

  status(): ProviderStatusView {
    const apiKey = this.#settings.apiKey.trim();
    const model = this.#settings.model.trim();
    return {
      id: this.id,
      displayName: this.displayName,
      available: apiKey.length > 0 && model.length > 0,
      configured: apiKey.length > 0 && model.length > 0,
      detail: apiKey.length > 0 ? "已配置 API Key" : "需要 Anthropic API Key",
    };
  }

  async createSession(): Promise<string> {
    const sessionId = randomUUID();
    this.#sessions.set(sessionId, []);
    return sessionId;
  }

  async sendTurn(sessionId: string, request: TurnRequest): Promise<string> {
    const history = this.#sessions.get(sessionId);
    if (!history) throw new Error("会话不存在或已经被切换。");

    const userMessage = request.messages.length > 0
      ? request.messages[request.messages.length - 1]!
      : { role: "user" as const, content: "" };
    if (userMessage.content.trim().length === 0) throw new Error("请求内容不能为空。");
    if (userMessage.role !== "user") throw new Error("每次发言必须以用户消息开始。");

    const runId = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    this.#runs.set(runId, { runId, sessionId, controller });

    const payload = {
      model: this.#settings.model.trim(),
      system: request.system,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: 4_096,
      stream: true,
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.#settings.apiKey.trim(),
      "anthropic-version": ANTHROPIC_VERSION,
    };

    this.#emit({ providerId: this.id, sessionId, runId, status: "running", delta: "", message: null });

    let received = "";
    try {
      const response = await this.#fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readAnthropicError(response));

      const parser = new SseParser();
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          for (const chunk of parser.push(decoder.decode(value, { stream: true }))) {
            const delta = extractAnthropicDelta(chunk);
            if (delta) {
              received += delta;
              this.#emit({ providerId: this.id, sessionId, runId, status: "running", delta, message: null });
            }
          }
        }
      } else {
        throw new Error("上游未返回可读流。");
      }

      if (controller.signal.aborted) {
        const abortError = new Error("The operation was aborted.");
        abortError.name = "AbortError";
        throw abortError;
      }

      history.push(userMessage);
      if (received.length > 0) history.push({ role: "assistant", content: received });
      this.#runs.delete(runId);
      this.#emit({ providerId: this.id, sessionId, runId, status: "succeeded", delta: "", message: null });
      return runId;
    } catch (error) {
      this.#runs.delete(runId);
      const interrupted = error instanceof Error && (error.name === "AbortError" || controller.signal.aborted);
      this.#emit({
        providerId: this.id,
        sessionId,
        runId,
        status: interrupted ? "interrupted" : "failed",
        delta: "",
        message: interrupted ? null : sanitizeError(error),
      });
      if (!interrupted) throw error;
      return runId;
    } finally {
      clearTimeout(timeout);
    }
  }

  async interrupt(runId: string): Promise<void> {
    const active = this.#runs.get(runId);
    if (!active) throw new Error("没有找到可中断的生成。");
    active.controller.abort();
  }

  events(listener: ModelTurnListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: ModelTurnEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function extractAnthropicDelta(chunk: { event: string | null; data: string }): string | null {
  if (!chunk.event || !chunk.event.includes("delta") || chunk.data.length === 0) return null;
  const payload = JSON.parse(chunk.data) as unknown;
  if (!isRecord(payload)) return null;
  const delta = isRecord(payload.delta) ? payload.delta : {};
  const text = delta.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

async function readAnthropicError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const message = typeof parsed.message === "string" ? parsed.message : (parsed.error_message ?? null);
      const error = isRecord(parsed.error) ? parsed.error : {};
      if (typeof message === "string") detail = message.slice(0, 500);
      else if (typeof error.message === "string") detail = error.message.slice(0, 500);
    }
  } catch {
    detail = "";
  }
  return `上游返回 ${String(response.status)}：${detail || response.statusText || "未知错误"}`;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
