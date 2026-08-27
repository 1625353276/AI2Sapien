import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AnthropicSettings,
  OpenAiCompatibleSettings,
  ProviderSettingsSave,
  ProviderSettingsView,
} from "@ai2sapien/contracts";
import { DEFAULT_PROVIDER_SETTINGS } from "@ai2sapien/model-providers";

interface StoredSettings {
  schemaVersion: 1;
  settings: ProviderSettingsSave;
}

export class ProviderSettingsStore {
  readonly #rootDirectory: string;
  readonly #path: string;
  #settings: ProviderSettingsSave | null = null;

  constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
    this.#path = join(rootDirectory, "provider-settings.json");
  }

  async load(): Promise<ProviderSettingsSave> {
    if (this.#settings) return this.#settings;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as unknown;
      const stored = validateStored(parsed);
      this.#settings = stored;
    } catch (error) {
      const code = isNodeError(error) ? error.code : null;
      if (code !== "ENOENT") throw error;
      this.#settings = structuredClone(DEFAULT_PROVIDER_SETTINGS);
      await this.#persist();
    }
    return this.#settings;
  }

  async save(input: ProviderSettingsSave): Promise<ProviderSettingsSave> {
    const stored = await this.load();
    const saved: ProviderSettingsSave = {
      activeProvider: input.activeProvider,
      openaiCompatible: {
        label: sanitizeText(input.openaiCompatible.label, 60) || "OpenAI 兼容",
        baseUrl: normalizeBaseUrl(input.openaiCompatible.baseUrl),
        apiKey: mergeKey(stored.openaiCompatible.apiKey, input.openaiCompatible.apiKey),
        model: sanitizeText(input.openaiCompatible.model, 120) || "gpt-4o-mini",
      },
      anthropic: {
        apiKey: mergeKey(stored.anthropic.apiKey, input.anthropic.apiKey),
        model: sanitizeText(input.anthropic.model, 120) || "claude-3-5-sonnet-latest",
      },
    };
    if (saved.openaiCompatible.baseUrl.length === 0) {
      throw new Error("OpenAI 兼容服务的地址不能为空。");
    }
    this.#settings = saved;
    await this.#persist();
    return saved;
  }

  view(): ProviderSettingsView {
    const settings = this.#settings ?? DEFAULT_PROVIDER_SETTINGS;
    return {
      activeProvider: settings.activeProvider,
      openaiCompatible: {
        label: settings.openaiCompatible.label,
        baseUrl: settings.openaiCompatible.baseUrl,
        model: settings.openaiCompatible.model,
        apiKeySet: settings.openaiCompatible.apiKey.length > 0,
      },
      anthropic: {
        model: settings.anthropic.model,
        apiKeySet: settings.anthropic.apiKey.length > 0,
      },
    };
  }

  async #persist(): Promise<void> {
    const payload: StoredSettings = { schemaVersion: 1, settings: this.#settings ?? structuredClone(DEFAULT_PROVIDER_SETTINGS) };
    const temporaryPath = `${this.#path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#path);
  }
}

function validateStored(value: unknown): ProviderSettingsSave {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.settings)) {
    throw new Error("提供者配置版本无效。");
  }
  const settings = value.settings;
  return {
    activeProvider: settings.activeProvider === "openai_compatible" || settings.activeProvider === "anthropic"
      ? settings.activeProvider
      : "codex",
    openaiCompatible: readOpenAi(settings.openaiCompatible),
    anthropic: readAnthropic(settings.anthropic),
  } satisfies ProviderSettingsSave;
}

function readOpenAi(value: unknown): OpenAiCompatibleSettings {
  const record = isRecord(value) ? value : {};
  return {
    label: typeof record.label === "string" ? record.label.slice(0, 60) : "OpenAI 兼容",
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    model: typeof record.model === "string" ? record.model.slice(0, 120) : "",
  };
}

function readAnthropic(value: unknown): AnthropicSettings {
  const record = isRecord(value) ? value : {};
  return {
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    model: typeof record.model === "string" ? record.model.slice(0, 120) : "",
  };
}

function sanitizeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    return "";
  }
  return trimmed;
}

function mergeKey(stored: string, incoming: string): string {
  const candidate = incoming.trim();
  return candidate.length > 0 ? candidate : stored;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
