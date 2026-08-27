import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const port = process.argv[2] ?? "9333";
const outputPath = resolve(process.argv[3] ?? "apps/desktop/release/ui-smoke.png");
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page" && candidate.title.includes("AI2Sapien"));
if (!target) throw new Error("AI2Sapien renderer target was not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (typeof message.id !== "number") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  await send("Page.enable");
  const evaluation = await send("Runtime.evaluate", {
    expression: `JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 1200), buttons: document.querySelectorAll("button").length, hasErrors: document.querySelectorAll(".tutor-error").length })`,
    returnByValue: true,
  });
  const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  process.stdout.write(`${evaluation.result.value}\n${outputPath}\n`);
} finally {
  socket.close();
}
