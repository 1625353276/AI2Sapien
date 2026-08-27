import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function collectLocalRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectLocalRefs(item, refs);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/")) refs.push(item);
      collectLocalRefs(item, refs);
    }
  }
  return refs;
}

function resolvePointer(document, pointer) {
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], document);
}

function assertLocalRefs(document, label) {
  const refs = collectLocalRefs(document);
  for (const ref of refs) {
    assert.notEqual(resolvePointer(document, ref), undefined, `${label} has unresolved ref ${ref}`);
  }
  return new Set(refs).size;
}

const openApi = await readJson("contracts/learning-core.openapi.json");
const artifactSchema = await readJson("contracts/agent-artifact.schema.json");

assert.equal(openApi.openapi, "3.1.0");
assert.equal(artifactSchema.$schema, "https://json-schema.org/draft/2020-12/schema");

const operationIds = [];
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
for (const pathItem of Object.values(openApi.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!httpMethods.has(method)) continue;
    assert.equal(typeof operation.operationId, "string", `${method} operation is missing operationId`);
    operationIds.push(operation.operationId);
  }
}

assert.equal(new Set(operationIds).size, operationIds.length, "OpenAPI operationId values must be unique");

const openApiRefCount = assertLocalRefs(openApi, "OpenAPI");
const artifactRefCount = assertLocalRefs(artifactSchema, "Agent Artifact Schema");

process.stdout.write(
  `Contracts valid: ${Object.keys(openApi.paths).length} paths, ${operationIds.length} operations, ` +
    `${openApiRefCount + artifactRefCount} unique local refs.\n`,
);
