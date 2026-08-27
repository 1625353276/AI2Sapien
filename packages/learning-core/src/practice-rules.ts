import type { MasteryEvidence } from "./index.js";

export interface FieldValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Extract the last fenced JSON artifact from AI text output.
 * AI output is untrusted; returns null when nothing parseable is present.
 */
export function parseJsonFence(text: string): unknown | null {
  const normalized = String(text ?? "");
  const fences = [...normalized.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/gi)];
  const candidates = fences.length > 0
    ? [...fences].reverse().map((match) => match[1])
    : [normalized.trim()];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? "";
    if (trimmed.length === 0) continue;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

export interface NormalizedQuestionDraft {
  stem: string;
  options: Array<{ id: string; label: "A" | "B" | "C" | "D"; text: string }>;
  correctOptionId: string;
  rationale: string;
  evidenceRefs: string[];
}

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

/**
 * Domain validation for a creator-role question artifact.
 * Rejects answers that leak facts not supported by the stem, empty options, etc.
 */
export function validateQuestionDraft(payload: unknown): { draft: NormalizedQuestionDraft | null; validation: FieldValidation } {
  const errors: string[] = [];
  if (!isRecord(payload)) {
    return { draft: null, validation: { valid: false, errors: ["题目载荷必须是 JSON 对象。"] } };
  }

  const stem = typeof payload.stem === "string" ? payload.stem.trim() : "";
  if (stem.length < 8) errors.push("题干过短（至少 8 个字符）。");
  if (stem.length > 800) errors.push("题干过长（最多 800 个字符）。");

  const draft: NormalizedQuestionDraft = {
    stem,
    options: [],
    correctOptionId: "",
    rationale: "",
    evidenceRefs: [],
  };

  const rawOptions = payload.options;
  if (!Array.isArray(rawOptions) || rawOptions.length !== 4) {
    errors.push("必须提供 4 个选项。");
  } else {
    const seenLabels = new Set<string>();
    const seenTexts = new Set<string>();
    for (const option of rawOptions) {
      const label = isRecord(option) && option.label != null ? String(option.label).toUpperCase() : "";
      const text = isRecord(option) && typeof option.text === "string" ? option.text.trim() : "";
      if (!OPTION_LABELS.includes(label as (typeof OPTION_LABELS)[number])) {
        errors.push(`选项标签不合法：${label || "(空)"}`);
        continue;
      }
      if (seenLabels.has(label)) errors.push(`重复的选项标签：${label}`);
      seenLabels.add(label);
      if (text.length < 1 || text.length > 300) errors.push(`选项 ${label} 内容必须为 1–300 个字符。`);
      if (seenTexts.has(text)) errors.push(`存在重复选项 ${label}。`);
      seenTexts.add(text);
      draft.options.push({ id: label, label: label as "A" | "B" | "C" | "D", text });
    }
  }

  const correctOptionId = typeof payload.correctOptionId === "string"
    ? payload.correctOptionId.toUpperCase()
    : "";
  if (!OPTION_LABELS.includes(correctOptionId as (typeof OPTION_LABELS)[number])) {
    errors.push("correctOptionId 必须是 A–D 之一。");
  }
  if (draft.options.length === 4 && !draft.options.some((option) => option.id === correctOptionId)) {
    errors.push("correctOptionId 不指向任何选项。");
  }
  draft.correctOptionId = correctOptionId;

  const rationale = typeof payload.rationale === "string" ? payload.rationale.trim() : "";
  if (rationale.length < 20) errors.push("答案解析至少 20 个字符，用于说明原因与依据。");
  draft.rationale = rationale;

  const evidenceRefs = Array.isArray(payload.evidenceRefs)
    ? payload.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    : [];
  if (evidenceRefs.length === 0) errors.push("必须提供至少一条来源证据引用。");
  draft.evidenceRefs = evidenceRefs;

  return { draft: errors.length === 0 ? draft : null, validation: { valid: errors.length === 0, errors } };
}

export function validateQuestionVerification(payload: unknown): { verified: boolean; checks: boolean[]; notes: string } {
  if (!isRecord(payload)) return { verified: false, checks: [false], notes: "验题结果不是 JSON。", };
  const checks = isRecord(payload.checks) ? payload.checks : {};
  const flags = [
    checks.sourceSupport,
    checks.singleBestAnswer,
    checks.noAnswerLeak,
    checks.completeStem,
  ].map((flag) => flag === true);
  const verified = payload.verified === true && flags.every(Boolean);
  const notes = typeof payload.notes === "string" ? payload.notes.trim() : "";
  return { verified, checks: flags, notes: notes.length > 0 ? notes : "未提供验题说明。" };
}

export function validateReasoningReview(payload: unknown): ReasoningReviewResult {
  if (!isRecord(payload) || typeof payload.reasoningCorrect !== "boolean") {
    return { valid: false, reasoningCorrect: false, reason: "推理评审结果格式无效。" };
  }
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (reason.length < 10) {
    return { valid: false, reasoningCorrect: payload.reasoningCorrect, reason: "推理评审说明过短（至少 10 个字符）。" };
  }
  return { valid: true, reasoningCorrect: payload.reasoningCorrect, reason };
}

export interface ReasoningReviewResult {
  valid: boolean;
  reasoningCorrect: boolean;
  reason: string;
}

export function checkRemediation(payload: unknown): RemediationValidation {
  const errors: string[] = [];
  if (!isRecord(payload)) return { valid: false, cause: "", howToNotice: "", errors: ["补救结果必须是 JSON 对象。"] };
  const cause = typeof payload.cause === "string" ? payload.cause.trim() : "";
  const howToNotice = typeof payload.howToNotice === "string" ? payload.howToNotice.trim() : "";
  if (cause.length < 10) errors.push("错过原因分析至少 10 个字符。");
  if (howToNotice.length < 10) errors.push("识别建议至少 10 个字符。");
  return { valid: errors.length === 0, cause, howToNotice, errors };
}

export interface RemediationValidation {
  valid: boolean;
  cause: string;
  howToNotice: string;
  errors: string[];
}

export function evidenceKindForAttempt(isRetest: boolean): "application" | "transfer" {
  return isRetest ? "transfer" : "application";
}

/**
 * Objective rule for single-choice questions: the chosen option must match the
 * verified correct option. AI reasoning can never override this comparison.
 */
export function evaluateSingleChoice(correctOptionId: string, chosenOptionId: string): boolean {
  return chosenOptionId === correctOptionId;
}

export function asMasteryEvidence(input: {
  evidenceId: string;
  conceptId: string;
  isRetest: boolean;
  correct: boolean;
  reasoningCorrect: boolean;
  occurredAt: string;
}): MasteryEvidence {
  return {
    evidenceId: input.evidenceId,
    conceptId: input.conceptId,
    kind: evidenceKindForAttempt(input.isRetest),
    correct: input.correct,
    reasoningCorrect: input.reasoningCorrect,
    occurredAt: new Date(input.occurredAt),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
