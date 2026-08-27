import assert from "node:assert/strict";
import test from "node:test";

import {
  mapAccountReadResult,
  mapRateLimitsReadResult,
} from "./account-mapper.js";

test("maps a ChatGPT account without exposing credentials", () => {
  const result = mapAccountReadResult(
    {
      account: {
        type: "chatgpt",
        email: "learner@example.com",
        planType: "plus",
        accessToken: "must-not-leak",
      },
      requiresOpenaiAuth: true,
    },
    new Date("2026-08-28T00:00:00Z"),
  );

  assert.deepEqual(result, {
    authenticated: true,
    authMode: "chatgpt",
    planType: "plus",
    email: "learner@example.com",
    updatedAt: "2026-08-28T00:00:00.000Z",
  });
  assert.equal("accessToken" in result, false);
});

test("maps and deduplicates multi-bucket rate limits", () => {
  const result = mapRateLimitsReadResult({
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        planType: "plus",
        primary: {
          usedPercent: 27,
          windowDurationMins: 300,
          resetsAt: 1_787_875_200,
        },
        secondary: null,
        rateLimitReachedType: null,
      },
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.limitId, "codex");
  assert.equal(result[0]?.primary?.usedPercent, 27);
  assert.equal(result[0]?.primary?.resetsAt, "2026-08-28T00:00:00.000Z");
});
