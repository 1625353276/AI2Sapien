import type {
  ProviderId,
  ProviderSettingsSave,
  ProviderStatusView,
} from "@ai2sapien/contracts";

import { AnthropicProvider } from "./anthropic.js";
import { CodexProvider } from "./codex-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider, ModelRuntime, ModelTurnEvent, ModelTurnListener, TurnRequest } from "./types.js";

const DEFAULT_OPENAI = {
  label: "OpenAI 兼容",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
} as const;

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettingsSave = {
  activeProvider: "codex",
  openaiCompatible: { ...DEFAULT_OPENAI },
  anthropic: { apiKey: "", model: "claude-3-5-sonnet-latest" },
};

export class ModelRuntimeImpl implements ModelRuntime {
  readonly #codex: CodexProvider;
  #openAi: OpenAiCompatibleProvider;
  #anthropic: AnthropicProvider;
  #activeProvider: ProviderId;
  readonly #listeners = new Set<ModelTurnListener>();

  constructor(codex: CodexProvider, settings: ProviderSettingsSave = DEFAULT_PROVIDER_SETTINGS) {
    this.#codex = codex;
    this.#openAi = new OpenAiCompatibleProvider(settings.openaiCompatible);
    this.#anthropic = new AnthropicProvider(settings.anthropic);
    this.#activeProvider = settings.activeProvider;
    this.#subscribe(this.#codex);
  }

  get activeProvider(): ProviderId {
    return this.#activeProvider;
  }

  configure(settings: ProviderSettingsSave): Promise<void> {
    this.#openAi = new OpenAiCompatibleProvider(settings.openaiCompatible);
    this.#anthropic = new AnthropicProvider(settings.anthropic);
    this.#activeProvider = settings.activeProvider;
    this.#subscribe(this.#openAi);
    this.#subscribe(this.#anthropic);
    return Promise.resolve();
  }

  listStatus(): ProviderStatusView[] {
    return [
      this.#codex.status(),
      this.#openAi.status(),
      this.#anthropic.status(),
    ];
  }

  activeProviderView(): ProviderStatusView {
    const current = this.#current();
    return current.status();
  }

  createSession(system: string): Promise<string> {
    return this.#current().createSession(system);
  }

  sendTurn(sessionId: string, request: TurnRequest): Promise<string> {
    return this.#current().sendTurn(sessionId, request);
  }

  interrupt(runId: string): Promise<void> {
    return this.#current().interrupt(runId);
  }

  onTurnEvent(listener: ModelTurnListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #current(): ModelProvider {
    switch (this.#activeProvider) {
      case "codex":
        return this.#codex;
      case "openai_compatible":
        return this.#openAi;
      case "anthropic":
        return this.#anthropic;
    }
  }

  #subscribe(provider: ModelProvider): void {
    provider.events((event) => {
      const guarded: ModelTurnEvent = {
        ...event,
        message: event.message ? event.message.slice(0, 500) : null,
        delta: event.delta.slice(0, 20_000),
      };
      for (const listener of this.#listeners) listener(guarded);
    });
  }
}

export function rebuildOpenAiProvider(settings: ProviderSettingsSave["openaiCompatible"]): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider(settings);
}

export function rebuildAnthropicProvider(settings: ProviderSettingsSave["anthropic"]): AnthropicProvider {
  return new AnthropicProvider(settings);
}
