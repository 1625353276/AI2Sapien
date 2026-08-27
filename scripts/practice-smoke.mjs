import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(".");
const temporaryDirectory = await mkdtemp(join(workspaceRoot, ".ai2sapien-practice-smoke-"));
const bundlePath = join(temporaryDirectory, "practice-loop.mjs");

const questionJson = JSON.stringify({
  stem: "在柱状图中，纵坐标轴的作用是什么？",
  options: [
    { label: "A", text: "表示分类标签" },
    { label: "B", text: "表示数值的量级" },
    { label: "C", text: "表示图表的标题" },
    { label: "D", text: "表示数据来源" },
  ],
  correctOptionId: "B",
  rationale: "纵坐标轴承载数值量级，横坐标轴承载分类；混淆二者是常见作图错误。",
  evidenceRefs: ["第 3 页 坐标轴说明"],
});

const verifierJson = JSON.stringify({
  verified: true,
  checks: { sourceSupport: true, singleBestAnswer: true, noAnswerLeak: true, completeStem: true },
  notes: "来源支持，唯一最佳答案成立。",
});

const reasoningWrongJson = JSON.stringify({
  reasoningCorrect: false,
  reason: "选了数值但把轴说成分类，推理与选择互相矛盾。",
});

const reasoningRightJson = JSON.stringify({
  reasoningCorrect: true,
  reason: "准确定位数值轴与分类轴的区别，依据来源成立。",
});

const remediationJson = JSON.stringify({
  cause: "误以为纵轴表示分类，因而混淆了坐标轴的作用。",
  howToNotice: "先看轴是承载数字还是文字，再判断量级由谁表达。",
});

try {
  await build({
    entryPoints: ["apps/desktop/src/main/practice-loop-smoke-entry.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundlePath,
    external: ["electron"],
  });

  const { runPracticeLoopSmoke } = await import(pathToFileURL(bundlePath).href);
  const result = await runPracticeLoopSmoke({
    questionJson,
    verifierJson,
    reasoningWrongJson,
    reasoningRightJson,
    remediationJson,
    rootDirectory: join(temporaryDirectory, "learning-data"),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 1;
} finally {
  if (temporaryDirectory.startsWith(workspaceRoot)) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
