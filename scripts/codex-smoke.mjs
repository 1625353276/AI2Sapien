import { CodexAppServerClient } from "../packages/agent-runtime/dist/index.js";

const client = new CodexAppServerClient({ requestTimeoutMs: 15_000 });
client.onDiagnostic((message) => {
  if (!message.includes("PATH aliases")) process.stderr.write(`[codex] ${message}\n`);
});

try {
  await client.start();
  const account = await client.readAccount(false);
  await client.readRateLimits();

  const safeAccount = {
    connected: true,
    authenticated: account.account !== null,
    accountType: account.account?.type ?? null,
    planType: account.account?.planType ?? null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
    rateLimitsReadable: true,
  };

  process.stdout.write(`${JSON.stringify(safeAccount, null, 2)}\n`);
} finally {
  await client.stop();
}
