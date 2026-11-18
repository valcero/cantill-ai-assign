# Approach

## How I worked

1. **Read the kit in order.** The brief, then policy v5.0, then the worked examples. I wrote the policy's rules down as data first (`policies/corvo_policy_v5.0.json`): rule order, conditions and outcomes, plus parameters for clubbing, history windows, ranking and consolidation. Then I built the engine to read that file and nothing else.
2. **Engine as a pure function.** `server/engine/` takes master data, a policy (or a "policy in force on date X" lookup) and PR lines, and returns decisions. It does no database or HTTP work, which makes it easy to test and reuse. The same engine serves batch upload, `POST /api/process-batch`, chat intake and the impact preview of a proposed policy.
3. **Checked against the worked examples.** All 14 worked decisions and the 3 preferred-supplier rankings are automated tests (`npm test`). I did not tune anything per PR or per item. The tests check the general rules.
4. **Looked for what the policy does not cover.** I scanned the data for edge cases: zero quantity, an unknown plant, blocked contract suppliers, POs from now-blocked suppliers, expired contracts, near-duplicate PRs, multi-line PRs that span plants, urgent wording on Normal lines. Each decision is recorded in `DECISIONS.md`.
5. **Policy changes as data.** An amendment becomes a list of operations on the policy JSON (change a limit or parameter, add, update, move or remove a rule). The operations are validated, turned into a plain-language diff, and stored as a proposed version. Approval activates it from its effective date. Because the operations are generic, a rule for one plant or category, or a new kind of condition over the engine's facts, needs no code.

## Stack

- Node.js 22+/24 with Express, using the built-in `node:sqlite` as the database (no native build step).
- Plain HTML/CSS/JS frontend, served by the same server.
- `csv-parse` to read CSVs, `pdf-parse` to read text from contract and policy PDFs, `multer` for uploads.
- `node:test` for tests. Docker and docker compose to run it.

## AI use

- **While building.** Kiro (an AI coding assistant) helped with code and review. In this session it reviewed the existing build against the brief and worked examples. It then made each requirement use the policy version in force on its own date, added hand-correction of proposed policies, made the amendment reader handle plant/category-scoped limits and report sentences it cannot read, and wrote the automated tests, README and Docker setup. It also drafted these documents.
- **Earlier build.** *(TODO, fill in: which tools you used before this, e.g. ChatGPT, Claude, Copilot, Kiro, and for what.)*
- **Inside the app.** Chat intake is deterministic: an item matcher plus a short dialogue. It does not use a language model, so it cannot invent items. Policy amendments are read by a built-in rule reader. If `LLM_API_KEY` is set, an OpenAI-compatible model is tried first. Its output must be the same validated operations, and it falls back to the built-in reader on any error. In both cases a person reviews the plain-language changes, and can correct them, before anything is approved.

I can explain and change any part of the code. The main entry points are `server/engine/engine.js` (`runEngine`), `server/engine/policy.js` (conditions and validation) and `server/lib/policyChange.js` (amendment reader and diff).
