import {
  CodexAppServerClient,
  mapAccountReadResult,
  mapRateLimitsReadResult,
} from "@ai2sapien/agent-runtime";
import type {
  ChatGptLoginLaunch,
  RuntimeIssue,
  RuntimeStatusSnapshot,
} from "@ai2sapien/contracts";

type InvalidationListener = () => void;

export class RuntimeController {
  readonly #client: CodexAppServerClient;
  readonly #invalidationListeners = new Set<InvalidationListener>();
  #readPromise: Promise<RuntimeStatusSnapshot> | null = null;

  constructor(client = new CodexAppServerClient()) {
    this.#client = client;
    this.#client.onNotification((notification) => {
      if (
        notification.method === "account/updated" ||
        notification.method === "account/login/completed" ||
        notification.method === "account/rateLimits/updated"
      ) {
        this.#emitInvalidated();
      }
    });
  }

  readStatus(): Promise<RuntimeStatusSnapshot> {
    if (this.#readPromise) return this.#readPromise;
    this.#readPromise = this.#readStatusInternal().finally(() => {
      this.#readPromise = null;
    });
    return this.#readPromise;
  }

  async startBrowserLogin(): Promise<ChatGptLoginLaunch> {
    await this.#client.start();
    const login = await this.#client.startChatGptLogin();
    return {
      loginId: login.loginId,
      flow: "browser",
      authUrl: login.authUrl,
    };
  }

  async logout(): Promise<void> {
    await this.#client.start();
    await this.#client.logout();
    this.#emitInvalidated();
  }

  onInvalidated(listener: InvalidationListener): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  stop(): Promise<void> {
    return this.#client.stop();
  }

  async #readStatusInternal(): Promise<RuntimeStatusSnapshot> {
    const checkedAt = new Date();

    try {
      await this.#client.start();
      const accountResult = await this.#client.readAccount(false);
      const auth = mapAccountReadResult(accountResult, checkedAt);

      if (!auth.authenticated) {
        return {
          connected: true,
          auth,
          rateLimits: [],
          checkedAt: checkedAt.toISOString(),
          issue: {
            code: "AUTH_REQUIRED",
            message: "请登录 ChatGPT 后继续。",
            retryable: false,
          },
        };
      }

      try {
        const rateLimits = mapRateLimitsReadResult(await this.#client.readRateLimits());
        return {
          connected: true,
          auth,
          rateLimits,
          checkedAt: checkedAt.toISOString(),
          issue: null,
        };
      } catch {
        return {
          connected: true,
          auth,
          rateLimits: [],
          checkedAt: checkedAt.toISOString(),
          issue: {
            code: "RATE_LIMIT_UNAVAILABLE",
            message: "账户已连接，但暂时无法读取用量。",
            retryable: true,
          },
        };
      }
    } catch (error) {
      return {
        connected: false,
        auth: {
          authenticated: false,
          authMode: null,
          planType: null,
          updatedAt: checkedAt.toISOString(),
        },
        rateLimits: [],
        checkedAt: checkedAt.toISOString(),
        issue: classifyRuntimeIssue(error),
      };
    }
  }

  #emitInvalidated(): void {
    for (const listener of this.#invalidationListeners) listener();
  }
}

function classifyRuntimeIssue(error: unknown): RuntimeIssue {
  const message = error instanceof Error ? error.message : String(error);
  const missingCodex = /ENOENT|not recognized|not found/i.test(message);

  return {
    code: missingCodex ? "CODEX_NOT_INSTALLED" : "CODEX_UNAVAILABLE",
    message: missingCodex
      ? "未检测到 Codex CLI，请先安装并完成本机配置。"
      : "暂时无法连接本机 Codex，请稍后重试。",
    retryable: !missingCodex,
  };
}
