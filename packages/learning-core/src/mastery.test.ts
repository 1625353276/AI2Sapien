import assert from "node:assert/strict";
import test from "node:test";

import { deriveMasteryLevel, type MasteryEvidence } from "./index.js";

const base = {
  evidenceId: "evidence_1",
  conceptId: "concept_1",
  occurredAt: new Date("2026-08-28T00:00:00Z"),
};

function evidence(
  kind: MasteryEvidence["kind"],
  correct = true,
  reasoningCorrect = true,
): MasteryEvidence {
  return { ...base, kind, correct, reasoningCorrect };
}

test("does not award mastery for a correct conclusion with incorrect reasoning", () => {
  assert.equal(deriveMasteryLevel([evidence("application", true, false)]), 0);
});

test("uses the strongest valid evidence without letting AI set the level directly", () => {
  assert.equal(
    deriveMasteryLevel([evidence("recognition"), evidence("explanation"), evidence("transfer")]),
    4,
  );
});

test("requires spaced recall evidence for level five", () => {
  assert.equal(deriveMasteryLevel([evidence("transfer")]), 4);
  assert.equal(deriveMasteryLevel([evidence("transfer"), evidence("spaced_recall")]), 5);
});
