import type { ProviderId, ProviderSettingsSave, ProviderStatusView } from "@ai2sapien/contracts";

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TurnRequest {
  system: string;
  messages: ProviderMessage[];
}

export type ModelTurnStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface ModelTurnEvent {
  providerId: ProviderId;
  sessionId: string;
  runId: string;
  status: ModelTurnStatus;
  delta: string;
  message: string | null;
}

export type ModelTurnListener = (event: ModelTurnEvent) => void;

/**
 * Provider-neutral streaming model runtime.
 * Providers map: codex = ChatGPT login via App Server thread/turn;
 * openai_compatible = any OpenAI-chat-completions endpoint (OpenAI, Ollama, ...);
 * anthropic = Claude Messages API.
 */
export interface ModelProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  status(): ProviderStatusView;
  createSession(system: string): Promise<string>;
  sendTurn(sessionId: string, request: TurnRequest): Promise<string>;
  interrupt(runId: string): Promise<void>;
  events(listener: ModelTurnListener): () => void;
}

export interface ModelRuntime {
  activeProvider: ProviderId;
  configure(settings: ProviderSettingsSave): Promise<void>;
  listStatus(): ProviderStatusView[];
  createSession(system: string): Promise<string>;
  sendTurn(sessionId: string, request: TurnRequest): Promise<string>;
  interrupt(runId: string): Promise<void>;
  onTurnEvent(listener: ModelTurnListener): () => void;
}
