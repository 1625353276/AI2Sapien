import { randomUUID } from "node:crypto";

import type { OpenAiCompatibleSettings, ProviderStatusView } from "@ai2sapien/contracts";

import { SseParser } from "./sse.js";
import type { ModelProvider, ModelTurnEvent, ModelTurnListener, ProviderMessage, TurnRequest } from "./types.js";

interface ActiveRun {
  runId: string;
  sessionId: string;
  controller: AbortController;
}

const STREAM_TIMEOUT_MS = 180_000;

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = "openai_compatible" as const;
  readonly displayName: string;
  readonly #settings: OpenAiCompatibleSettings;
  readonly #sessions = new Map<string, ProviderMessage[]>();
  readonly #runs = new Map<string, ActiveRun>();
  readonly #listeners = new Set<ModelTurnListener>();

  constructor(settings: OpenAiCompatibleSettings, fetchImpl: typeof fetch = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;
    this.displayName = settings.label.trim() || "OpenAI 兼容模型";
  }

  readonly #fetch: typeof fetch;

  status(): ProviderStatusView {
    const baseUrl = this.#settings.baseUrl.trim();
    const model = this.#settings.model.trim();
    const label = this.#settings.label.trim() || "OpenAI 兼容模型";
    return {
      id: this.id,
      displayName: label,
      available: baseUrl.length > 0 && model.length > 0,
      configured: baseUrl.length > 0 && model.length > 0,
      detail: this.#settings.apiKey.length > 0
        ? `${baseUrl || "(未配置地址)"} · 已配置 API Key`
        : `${baseUrl || "(未配置地址)"} · 本地免鉴权模式`,
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

    const baseUrl = this.#settings.baseUrl.trim().replace(/\/$/, "");
    const payload = {
      model: this.#settings.model.trim(),
      stream: true,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const apiKey = this.#settings.apiKey.trim();
    if (apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

    this.#emit({ providerId: this.id, sessionId, runId, status: "running", delta: "", message: null });

    let received = "";
    try {
      const response = await this.#fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readApiError(response));

      const parser = new SseParser();
      let done = false;
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          const chunks = parser.push(decoder.decode(value, { stream: true }));
          for (const chunk of chunks) {
            if (chunk.data === "[DONE]") {
              done = true;
              break;
            }
            const delta = extractOpenAiDelta(chunk.data);
            if (delta) {
              received += delta;
              this.#emit({ providerId: this.id, sessionId, runId, status: "running", delta, message: null });
            }
          }
          if (done) break;
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

function extractOpenAiDelta(raw: string): string | null {
  if (raw.length === 0) return null;
  const payload = JSON.parse(raw) as unknown;
  if (!isRecord(payload)) return null;
  if (Array.isArray(payload.choices) && payload.choices[0]) {
    const choice = payload.choices[0] as Record<string, unknown>;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const content = delta.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  }
  return null;
}

async function readApiError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const message = isRecord(parsed.error) ? parsed.error.message : parsed.message;
      if (typeof message === "string") detail = message.slice(0, 500);
    }
  } catch {
    detail = "";
  }
  return `上游返回 ${String(response.status)}：${detail || response.statusText || "未知错误"}`;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500).replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer ***");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
