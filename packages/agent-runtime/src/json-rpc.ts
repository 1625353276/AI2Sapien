export type JsonRpcId = number | string;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface JsonRpcServerRequest<TParams = unknown> extends JsonRpcNotification<TParams> {
  id: JsonRpcId;
}

export interface JsonRpcPeerOptions {
  sendLine(line: string): void;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timeout: NodeJS.Timeout;
}

type NotificationListener = (notification: JsonRpcNotification) => void;
type ServerRequestListener = (request: JsonRpcServerRequest) => void;
type ProtocolErrorListener = (error: Error, line?: string) => void;

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = "JsonRpcRemoteError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class JsonRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonRpcProtocolError";
  }
}

export class JsonRpcRequestTimeoutError extends Error {
  readonly method: string;

  constructor(method: string, timeoutMs: number) {
    super(`JSON-RPC request '${method}' timed out after ${timeoutMs} ms`);
    this.name = "JsonRpcRequestTimeoutError";
    this.method = method;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function isErrorObject(value: unknown): value is JsonRpcErrorObject {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string"
  );
}

/**
 * Bidirectional JSON-RPC peer for Codex App Server's newline-delimited stdio.
 * The App Server omits the usual `jsonrpc: "2.0"` field on the wire.
 */
export class JsonRpcPeer {
  readonly #sendLine: (line: string) => void;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #serverRequestListeners = new Set<ServerRequestListener>();
  readonly #protocolErrorListeners = new Set<ProtocolErrorListener>();
  #nextRequestId = 1;
  #closed = false;

  constructor(options: JsonRpcPeerOptions) {
    this.#sendLine = options.sendLine;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  request<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (this.#closed) {
      return Promise.reject(new JsonRpcProtocolError("JSON-RPC peer is closed"));
    }

    const id = this.#nextRequestId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new JsonRpcRequestTimeoutError(method, this.#requestTimeoutMs));
      }, this.#requestTimeoutMs);

      this.#pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      });

      try {
        this.#send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const message: Record<string, unknown> = { method };
    if (params !== undefined) message.params = params;
    this.#send(message);
  }

  respondResult(id: JsonRpcId, result: unknown): void {
    this.#send({ id, result });
  }

  respondError(id: JsonRpcId, error: JsonRpcErrorObject): void {
    this.#send({ id, error });
  }

  feedLine(line: string): void {
    if (this.#closed || line.trim().length === 0) return;

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.#emitProtocolError(
        new JsonRpcProtocolError(
          `Invalid JSON received: ${error instanceof Error ? error.message : String(error)}`,
        ),
        line,
      );
      return;
    }

    if (!isRecord(message)) {
      this.#emitProtocolError(new JsonRpcProtocolError("JSON-RPC message must be an object"), line);
      return;
    }

    const method = message.method;
    const id = message.id;

    if (typeof method === "string" && isId(id)) {
      const request: JsonRpcServerRequest = { id, method };
      if ("params" in message) request.params = message.params;
      for (const listener of this.#serverRequestListeners) listener(request);
      return;
    }

    if (typeof method === "string" && id === undefined) {
      const notification: JsonRpcNotification = { method };
      if ("params" in message) notification.params = message.params;
      for (const listener of this.#notificationListeners) listener(notification);
      return;
    }

    if (isId(id)) {
      const pending = this.#pending.get(id);
      if (!pending) {
        this.#emitProtocolError(
          new JsonRpcProtocolError(`Received response for unknown request id '${String(id)}'`),
          line,
        );
        return;
      }

      clearTimeout(pending.timeout);
      this.#pending.delete(id);

      if (isErrorObject(message.error)) {
        pending.reject(new JsonRpcRemoteError(message.error));
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new JsonRpcProtocolError("JSON-RPC response has neither result nor error"));
      }
      return;
    }

    this.#emitProtocolError(new JsonRpcProtocolError("Unrecognized JSON-RPC message"), line);
  }

  onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  onProtocolError(listener: ProtocolErrorListener): () => void {
    this.#protocolErrorListeners.add(listener);
    return () => this.#protocolErrorListeners.delete(listener);
  }

  close(reason: Error = new JsonRpcProtocolError("JSON-RPC peer closed")): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed) throw new JsonRpcProtocolError("JSON-RPC peer is closed");
    this.#sendLine(JSON.stringify(message));
  }

  #emitProtocolError(error: Error, line?: string): void {
    for (const listener of this.#protocolErrorListeners) listener(error, line);
  }
}
