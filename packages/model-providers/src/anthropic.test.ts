import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AnthropicProvider } from "./anthropic.js";

const settings = { apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest" };

function anthropicStream(...texts: string[]): string {
  return texts
    .map((text) => `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${text}"}}\n\n`)
    .join("") + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
}

describe("AnthropicProvider", () => {
  it("streams text deltas and succeeds", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(anthropicStream("claude", " 回复")));
        controller.close();
      },
    });
    const provider = new AnthropicProvider(settings, async () => new Response(stream, { status: 200 }));

    const deltas: string[] = [];
    let succeeded = false;
    provider.events((event) => {
      if (event.delta) deltas.push(event.delta);
      if (event.status === "succeeded") succeeded = true;
    });

    const sessionId = await provider.createSession();
    await provider.sendTurn(sessionId, { system: "s", messages: [{ role: "user", content: "hi" }] });
    assert.equal(deltas.join(""), "claude 回复");
    assert.equal(succeeded, true);
  });

  it("fails cleanly on bad api key without leaking the key", async () => {
    const provider = new AnthropicProvider(settings, async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }));
    let failed: string | null = null;
    provider.events((event) => { if (event.status === "failed") failed = event.message; });

    const sessionId = await provider.createSession();
    await assert.rejects(() => provider.sendTurn(sessionId, {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    }));
    assert.doesNotMatch(failed ?? "", /sk-ant-test/);
    assert.match(failed ?? "", /401/);
  });
});
