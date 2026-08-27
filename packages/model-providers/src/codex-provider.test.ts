import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CodexProvider } from "./codex-provider.js";

function fakeCodexClient(): any {
  const listeners = new Set<(notification: { method: string; params: unknown }) => void>();
  let turnId = "turn-1";
  return {
    listeners,
    onNotification(listener: (n: { method: string; params: unknown }) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(): Promise<void> {},
    async startThread(): Promise<{ thread: { id: string } }> {
      return { thread: { id: "thread-9" } };
    },
    async startTurn(): Promise<{ turn: { id: string } }> {
      turnId = `turn-${Math.floor(Math.random() * 1000)}`;
      return { turn: { id: turnId } };
    },
    async interruptTurn(): Promise<void> {},
    fire(method: string, params: unknown): void {
      for (const listener of listeners) listener({ method, params });
    },
  };
}

describe("CodexProvider", () => {
  it("maps thread/turn notifications into provider turn events", async () => {
    const client = fakeCodexClient();
    const provider = new CodexProvider(client);

    const events: Array<{ status: string; delta: string; message: string | null }> = [];
    provider.events((event) => events.push({ status: event.status, delta: event.delta, message: event.message }));

    const sessionId = await provider.createSession("系统提示");
    assert.equal(sessionId, "thread-9");
    const runId = await provider.sendTurn(sessionId, {
      system: "系统提示",
      messages: [{ role: "user", content: "出一道题" }],
    });
    assert.ok(runId.length > 0);

    client.fire("item/agentMessage/delta", { turnId: runId, delta: "第一段" });
    client.fire("item/agentMessage/delta", { turnId: runId, delta: "第二段" });
    client.fire("turn/completed", { turnId: runId, turn: { id: runId, status: "completed" } });

    const runningDeltas = events
      .filter((event) => event.status === "running" && event.delta.length > 0)
      .map((event) => event.delta)
      .join("");
    assert.equal(runningDeltas, "第一段第二段");
    assert.equal(events.at(-1)!.status, "succeeded");
  });

  it("routes interrupted turns as interrupted status", async () => {
    const client = fakeCodexClient();
    const provider = new CodexProvider(client);
    let finalStatus = "";
    provider.events((event) => {
      if (event.status !== "running") finalStatus = event.status;
    });

    const sessionId = await provider.createSession("s");
    const runId = await provider.sendTurn(sessionId, { system: "s", messages: [{ role: "user", content: "hi" }] });
    client.fire("turn/completed", { turnId: runId, turn: { id: runId, status: "interrupted" } });
    assert.equal(finalStatus, "interrupted");
  });
});
