import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAiCompatibleProvider } from "./openai-compatible.js";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function openAiStream(...contents: string[]): string {
  return contents
    .map((content) => `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`)
    .join("") + "data: [DONE]\n\n";
}

const settings = { label: "本地", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "qwen3" };

describe("OpenAiCompatibleProvider", () => {
  it("streams deltas and records history on success", async () => {
    const upstream = streamResponse([openAiStream("你好", "，我是回答。")]);
    const provider = new OpenAiCompatibleProvider(settings, async () => upstream);

    const events: Array<{ status: string; delta: string }> = [];
    provider.events((event) => events.push({ status: event.status, delta: event.delta }));

    const sessionId = await provider.createSession();
    const runId = await provider.sendTurn(sessionId, {
      system: "你是一个助手",
      messages: [{ role: "user", content: "解释一下" }],
    });
    assert.ok(runId.length > 0);
    assert.equal(events[0]!.status, "running");
    const body = events.filter((event) => event.status === "running" && event.delta.length > 0).map((event) => event.delta).join("");
    assert.equal(body, "你好，我是回答。");
    assert.equal(events.at(-1)!.status, "succeeded");
  });

  it("emits failure with a sanitized message when upstream rejects", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "Bad key Bearer sk-abcdefgh123456" } }), { status: 401 });
    const provider = new OpenAiCompatibleProvider(settings, async () => upstream);
    let failed: string | null = null;
    provider.events((event) => { if (event.status === "failed") failed = event.message; });

    const sessionId = await provider.createSession();
    await assert.rejects(() => provider.sendTurn(sessionId, {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    }));
    assert.match(failed ?? "", /401/);
    assert.doesNotMatch(failed ?? "", /sk-abcdefgh123456/);
    assert.match(failed ?? "", /\*\*\*/);
  });

  it("interrupts a running turn and emits interrupted", async () => {
    const provider = new OpenAiCompatibleProvider(settings, async (_url, init) => {
      const encoder = new TextEncoder();
      const payload = openAiStream("x");
      const signal = init?.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload));
          const timer = setInterval(() => {
            if (signal.aborted) {
              clearInterval(timer);
              return;
            }
            try {
              controller.enqueue(encoder.encode(payload));
            } catch {
              clearInterval(timer);
            }
          }, 10);
          void timer;
        },
      });
      return new Response(stream, { status: 200 });
    });
    let firstRunningRunId = "";
    let interrupted = false;
    provider.events((event) => {
      if (event.status === "running" && firstRunningRunId.length === 0) firstRunningRunId = event.runId;
      if (event.status === "interrupted") interrupted = true;
    });

    const sessionId = await provider.createSession();
    const sending = provider.sendTurn(sessionId, {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitFor(() => firstRunningRunId.length > 0);
    await provider.interrupt(firstRunningRunId);
    await sending;
    assert.equal(interrupted, true);
  });
});

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}
