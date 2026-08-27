import { CodexAppServerClient } from "../packages/agent-runtime/dist/index.js";

const client = new CodexAppServerClient({ requestTimeoutMs: 30_000 });
let answer = "";
let expectedThreadId = null;
let expectedTurnId = null;
let resolveCompletion;
let rejectCompletion;
const completion = new Promise((resolve, reject) => {
  resolveCompletion = resolve;
  rejectCompletion = reject;
});
const timeout = setTimeout(() => rejectCompletion(new Error("Tutor turn did not complete in 90 seconds")), 90_000);

client.onNotification((notification) => {
  const params = notification.params;
  if (!params || typeof params !== "object") return;
  if (params.threadId !== expectedThreadId) return;
  if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string") {
    answer += params.delta;
  }
  if (notification.method === "turn/completed" && params.turn?.id === expectedTurnId) {
    resolveCompletion(params.turn.status);
  }
});

try {
  await client.start();
  const account = await client.readAccount(false);
  if (!account.account) throw new Error("ChatGPT account is not authenticated");
  const thread = await client.startThread({
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    baseInstructions: "You are a source-grounded tutor. Do not use tools. Explain why, not only what.",
  });
  expectedThreadId = thread.thread.id;
  const turn = await client.startTurn({
    threadId: expectedThreadId,
    input: [{
      type: "text",
      text: "Source: Visual encoding maps data attributes to visual channels such as position, length, colour, and shape. In Chinese, explain why position usually supports more accurate quantitative comparison than area. Mention that this answer is based on the supplied source.",
      text_elements: [],
    }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  expectedTurnId = turn.turn.id;
  const status = await completion;
  process.stdout.write(`${JSON.stringify({ status, answerChars: answer.length, preview: answer.slice(0, 500) }, null, 2)}\n`);
} finally {
  clearTimeout(timeout);
  await client.stop();
}
