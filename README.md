# Corvo PR-to-PO

A web app where employees raise purchase requests by chat, and a decision engine applies Corvo's procurement policy to decide between a purchase order (contract, spot or emergency PO) and a sourcing request (RFQ, RFP, capex or new-item sourcing). The policy is stored as versioned data, so Procurement changes how the app decides by uploading or describing an amendment and approving it. No code change is needed.

- `DECISIONS.md`: where the policy is silent or ambiguous, what I decided and why, including the supplier ranking method.
- `APPROACH.md`: how I built it and which tools I used.

## Run locally

With Docker:

```
docker compose up --build
```

Without Docker (Node 22.13 or later, which includes `node:sqlite`):

```
npm install
npm start
```

Open http://localhost:3000. On first start the app creates `data/app.db` and loads the kit's master data, contract register, the PDF-only contracts in `contracts/pdf` and policy v5.0. To start again from a clean state, delete `data/`.

Run the tests with `npm test`. They check all 14 worked examples, the 3 worked preferred-supplier lists, item matching, and the policy-change flow.

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DB_FILE` | SQLite file (default `data/app.db`) |
| `APP_TODAY` | Pin "today" (YYYY-MM-DD) for chat dates such as "next Friday". It can also be set in the app. |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | OpenAI-compatible model used to read free-text policy amendments. Without it, the built-in rule reader is used. |

## Screens

- **Request**: chat intake. The assistant matches the item, asks for anything missing (quantity, plant, need-by date, urgency), confirms, then creates the PR. It never guesses an item: an unclear description gets a short list to choose from, and an unknown one can be raised as a new item.
- **Buyer workspace**: upload a PR batch CSV. You see requirements with their PR lines, decision, value, supplier and price or suggested suppliers, and the reason (clause, policy version, contract or PO used). Approve creates the PO or RFQ/RFP. Override needs a written reason. Export the decisions as CSV.
- **Policy**: upload an amendment (PDF, text or JSON) or describe a change. The app shows each change in plain language and its impact on the last batch, and lets you correct the rules as JSON before approving. Approval activates the new version from its effective date.
- **Preferred suppliers**: the ranked list for every item as of any date, with the score breakdown. Export as CSV (item_code, rank, supplier_id, reference_price, top 3).
- **Contracts**: the register plus PDF-only contracts. Add a contract by hand or by extracting it from the signed PDF.
- **Activity**: every action, with who did it and when.

## API

| Method and path | What it does |
|---|---|
| `POST /api/process-batch` | PR batch CSV, as multipart field `file` or a `text/csv` body. Returns the decisions as JSON, or as CSV with `?format=csv`. |
| `GET /api/runs/:id/export.csv` | Decisions of a run in the scoring format |
| `GET /api/preferred/export.csv?as_of=YYYY-MM-DD` | Preferred supplier lists, top 3 per item |
| `GET /api/policies`, `POST /api/policies/propose`, `PUT /api/policies/:id`, `POST /api/policies/:id/approve` | Policy versions: propose, correct, approve |
| `POST /api/chat` | Chat intake (`{session_id, message}`) |
| `GET /api/audit` | Audit trail |

Example:

```
curl -F file=@pr_batches/sample_pr_batch.csv "http://localhost:3000/api/process-batch?format=csv" -o decisions.csv
```

## Blind-test procedure

1. Run 1: in Buyer workspace, upload the batch and export the decisions CSV.
2. Run 2: in Policy, upload the amendment and check the plain-language changes. Fix anything misread in the JSON editor, check the effective date, then approve. Upload the same batch again and export.
3. Preferred suppliers: set the given date and export.

## Layout

```
server/engine/   pure decision logic: matcher, policy evaluation, preferred list, engine (no I/O)
server/services/ batch runs, buyer actions, policy versions, contracts, chat
server/lib/      kit loading, policy amendment reader and diff
server/db.js     SQLite schema and seed
public/          single-page UI
tests/           node:test suite
policies/        policy v5.0 as data
```
