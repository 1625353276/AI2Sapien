import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonRpcPeer,
  JsonRpcRemoteError,
  JsonRpcRequestTimeoutError,
} from "./json-rpc.js";

test("resolves a request from a matching response", async () => {
  const lines: string[] = [];
  const peer = new JsonRpcPeer({ sendLine: (line) => lines.push(line) });

  const resultPromise = peer.request<{ ok: boolean }>("account/read", { refreshToken: false });
  const sent = JSON.parse(lines[0] ?? "null") as { id: number; method: string };

  assert.equal(sent.method, "account/read");
  peer.feedLine(JSON.stringify({ id: sent.id, result: { ok: true } }));
  await assert.doesNotReject(resultPromise);
  assert.deepEqual(await resultPromise, { ok: true });
});

test("rejects a request when the remote returns an error", async () => {
  const lines: string[] = [];
  const peer = new JsonRpcPeer({ sendLine: (line) => lines.push(line) });

  const resultPromise = peer.request("thread/start");
  const sent = JSON.parse(lines[0] ?? "null") as { id: number };
  peer.feedLine(
    JSON.stringify({ id: sent.id, error: { code: -32602, message: "Invalid params" } }),
  );

  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof JsonRpcRemoteError);
    assert.equal(error.code, -32602);
    return true;
  });
});

test("delivers notifications and server-initiated requests separately", () => {
  const lines: string[] = [];
  const peer = new JsonRpcPeer({ sendLine: (line) => lines.push(line) });
  const notificationMethods: string[] = [];
  const requestMethods: string[] = [];

  peer.onNotification((notification) => notificationMethods.push(notification.method));
  peer.onServerRequest((request) => {
    requestMethods.push(request.method);
    peer.respondResult(request.id, { decision: "decline" });
  });

  peer.feedLine(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn_1" } } }));
  peer.feedLine(
    JSON.stringify({
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: { command: ["example"] },
    }),
  );

  assert.deepEqual(notificationMethods, ["turn/started"]);
  assert.deepEqual(requestMethods, ["item/commandExecution/requestApproval"]);
  assert.deepEqual(JSON.parse(lines[0] ?? "null"), { id: 77, result: { decision: "decline" } });
});

test("reports malformed input without crashing the peer", () => {
  const peer = new JsonRpcPeer({ sendLine: () => undefined });
  const errors: Error[] = [];
  peer.onProtocolError((error) => errors.push(error));

  peer.feedLine("not-json");
  peer.feedLine(JSON.stringify({ method: "account/updated", params: {} }));

  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /Invalid JSON/);
});

test("times out unanswered requests", async () => {
  const peer = new JsonRpcPeer({ sendLine: () => undefined, requestTimeoutMs: 5 });
  await assert.rejects(peer.request("never/responds"), JsonRpcRequestTimeoutError);
});
