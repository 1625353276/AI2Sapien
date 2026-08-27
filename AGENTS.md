# AI2Sapien repository guidance

## Scope

AI2Sapien is a local-first adaptive learning desktop application. Keep the product domain independent from Codex protocol details.

## Architecture rules

- Renderer code may only call the typed preload API. It must not import Node.js modules, access local paths, or speak JSON-RPC directly.
- `packages/agent-runtime` owns Codex App Server process management and protocol translation.
- `packages/learning-core` owns learning rules and depends on ports, not Electron or Codex process classes.
- `packages/contracts` contains dependency-light types shared across boundaries.
- Raw ChatGPT tokens must never enter application logs, renderer state, or the learning database.
- Prefer stable App Server methods. Experimental protocol fields require an explicit architecture decision.
- AI output is untrusted until it passes its JSON Schema and domain validation.

## Learning rules

- Every factual concept, question, answer, and remediation explanation must retain source evidence.
- Question creation and question verification are separate roles.
- Correct conclusions with incorrect reasoning do not receive full mastery credit.
- Remediation must explain why the error happens, not only reveal the answer.
- Any referenced image must exist, decode, have non-zero dimensions and alt text, avoid answer leakage, and pass a renderer probe before publication.

## Commands

- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Full verification: `npm run check`
- Generate current Codex protocol types: `npm run generate:codex-schema`

## Change discipline

- Update `contracts/` before changing public request or response shapes.
- Add or update tests for JSON-RPC framing, lifecycle, auth mapping, and cancellation behavior.
- Do not commit credentials, local course files, generated learner answers, or application databases.
