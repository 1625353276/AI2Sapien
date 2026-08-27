import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asMasteryEvidence,
  checkRemediation,
  evidenceKindForAttempt,
  parseJsonFence,
  validateQuestionDraft,
  validateQuestionVerification,
  validateReasoningReview,
} from "./index.js";

function validDraft(): unknown {
  return {
    stem: "在柱状图中，纵坐标轴的作用是什么？",
    options: [
      { label: "A", text: "表示分类标签" },
      { label: "B", text: "表示数值的量级" },
      { label: "C", text: "表示图表的标题" },
      { label: "D", text: "表示数据来源" },
    ],
    correctOptionId: "B",
    rationale: "纵坐标轴承载数值量级，横坐标轴承载分类；混淆二者是常见作图错误。",
    evidenceRefs: ["第 3 页：坐标轴说明部分"],
  };
}

describe("parseJsonFence", () => {
  it("extracts the last fenced json artifact", () => {
    const payload = parseJsonFence("先解释机制。\n\n```json\n{\"ok\": true}\n```\n\n结尾说明。");
    assert.deepEqual(payload, { ok: true });
  });

  it("falls back to direct JSON when there is no fence", () => {
    const payload = parseJsonFence('{"ok": false}');
    assert.deepEqual(payload, { ok: false });
  });

  it("returns null for untrusted or malformed output", () => {
    assert.equal(parseJsonFence("这是一段没有 JSON 的说明"), null);
    assert.equal(parseJsonFence("```json\n{broken\n```"), null);
  });
});

describe("validateQuestionDraft", () => {
  it("accepts a well-formed single-choice draft", () => {
    const { draft, validation } = validateQuestionDraft(validDraft());
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.errors, []);
    assert.ok(draft);
    assert.equal(draft.options.length, 4);
    assert.equal(draft.correctOptionId, "B");
  });

  it("rejects repeated or extra options", () => {
    const payload = validDraft() as Record<string, unknown>;
    payload.options = [
      { label: "A", text: "选项一" },
      { label: "B", text: "选项二" },
      { label: "B", text: "选项三" },
      { label: "C", text: "选项四" },
    ];
    const { validation } = validateQuestionDraft(payload);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.includes("4 个选项") || error.includes("重复")));
  });

  it("rejects leaks of missing evidence refs and short rationale", () => {
    const payload = validDraft() as Record<string, unknown>;
    payload.evidenceRefs = [];
    payload.rationale = "太短";
    const { validation } = validateQuestionDraft(payload);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.includes("证据")));
    assert.ok(validation.errors.some((error) => error.includes("解析")));
  });
});

describe("validateQuestionVerification", () => {
  it("rejects when the independent review fails any check", () => {
    const result = validateQuestionVerification({
      verified: true,
      checks: { sourceSupport: true, singleBestAnswer: true, noAnswerLeak: false, completeStem: true },
      notes: "两个选项可能都成立",
    });
    assert.equal(result.verified, false);
  });

  it("accepts a fully passing independent review", () => {
    const result = validateQuestionVerification({
      verified: true,
      checks: { sourceSupport: true, singleBestAnswer: true, noAnswerLeak: true, completeStem: true },
      notes: "来源支持，唯一答案成立",
    });
    assert.equal(result.verified, true);
  });
});

describe("validateReasoningReview", () => {
  it("accepts a reasoning review that disagrees with the conclusion", () => {
    const result = validateReasoningReview({ reasoningCorrect: false, reason: "正确选项是对的，但解释混用了坐标轴定义。" });
    assert.equal(result.valid, true);
    assert.equal(result.reasoningCorrect, false);
  });

  it("rejects malformed reasoning payloads", () => {
    assert.equal(validateReasoningReview({ reason: "ok" }).valid, false);
    assert.equal(validateReasoningReview(null).valid, false);
  });
});

describe("checkRemediation", () => {
  it("requires an explanation of cause and warning, not only the answer", () => {
    const result = checkRemediation({ cause: "误以为纵轴表示分类，因而混淆了轴的作用。", howToNotice: "先找数值边界再判断哪个轴承载度量。" });
    assert.equal(result.valid, true);
  });

  it("rejects empty cause or how-to-notice", () => {
    const result = checkRemediation({ cause: "", howToNotice: "短" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 2);
  });
});

describe("mastery evidence mapping", () => {
  it("maps first attempts to application and retests to transfer", () => {
    assert.equal(evidenceKindForAttempt(false), "application");
    assert.equal(evidenceKindForAttempt(true), "transfer");
  });

  it("builds evidence that feeds the mastery ladder without letting AI set level", () => {
    const evidence = asMasteryEvidence({
      evidenceId: "attempt-1",
      conceptId: "concept-1",
      isRetest: false,
      correct: true,
      reasoningCorrect: true,
      occurredAt: "2026-08-28T00:00:00.000Z",
    });
    assert.equal(evidence.kind, "application");
    assert.ok(evidence.occurredAt instanceof Date);
  });
});
