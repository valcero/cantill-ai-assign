# Decisions

These are the places where the policy (v5.0), the brief or the data is silent or ambiguous. Each entry says what I noticed, what the app does, and why. Clause numbers refer to the policy.

## Input lines

**Lines that cannot be processed.** The sample batch has a line with quantity 0 (PR-26-00172) and a line for plant PUN2 (PR-26-00173), which is not a Corvo plant. The policy applies only to PUN1 and CHK1. These lines get route `NOT_PROCESSED` with the reason, and they are not clubbed or valued. The same applies to a missing PR number, plant or creation time, a quantity that is not a positive number, a line with neither item code nor description, and a repeated `pr_no`/`pr_line` within the same batch. Guessing a plant or a quantity would put a wrong PO in front of a supplier. Sending the line back costs the requester one correction.

**Urgency comes from the urgency field only.** PR-26-00167/2 says "Forklift electric 2 ton - urgent" but is marked Normal. Words in the description do not make a line an emergency. Emergency lifts the PO limit to ₹5 lakh (5.3), so it should be a deliberate choice by the requester. In chat, the assistant notices words like "urgent" and asks whether to mark the request as Emergency.

**Item code given but not in the item master.** The app falls back to matching the description. If that also fails, the line is a new item (1.2).

**Free-text matching (1.1).** Matching is deterministic: common short forms are expanded (brg → bearing, hyd → hydraulic) and noise words are dropped. Every number the requester typed must appear in the item, so "brg 6308" can never become a 6205 bearing. A description that fits two items equally well is not matched. In a batch it becomes a new item, with the candidates noted in the reason. In chat, the assistant asks the requester to choose. Wrongly matching an item would send money to the wrong supplier. A missed match only costs a sourcing request.

**Possible duplicates.** PR-26-00174 and PR-26-00175 are the same requester, item, quantity and need-by date, raised 4 minutes apart. I do not drop either line. The policy's answer to near-identical PRs is clubbing (2.1), so they become one requirement of 2 units and the buyer sees both lines under it. Dropping a line on suspicion could leave a real need unmet.

## Clubbing (section 2)

- "Within 14 calendar days" and "within 7 days (either side)" are inclusive and measured in calendar days. Times of day are ignored for these windows.
- A line is always compared with the requirement's **first** line, not the latest one, as 2.2 says. This stops a chain of PRs, each 10 days after the previous one, from drifting into one ever-growing requirement.
- New items are never clubbed (1.2), even when two lines have the same description.
- A multi-line PR is split by line. Each line is clubbed on its own item and plant, so one PR can feed several requirements.
- If one line has no need-by date and the other does, they are not clubbed. All sample lines have one.

## Valuing (section 3)

- **Price from the most recent PO, 3.1(b).** I use the most recent PO in the 365 days whatever the supplier's current status, because 3.1(b) does not ask for an Active supplier. Example: ITM-1017's last PO is from S011, now Blocked. Its price is still the best evidence of what the item costs. Being "bought recently" for rules 5.3 and 5.4 does require an Active supplier, because those clauses say so.
- **New items** are valued at quantity × the requester's estimated price. If the estimate is missing, the value is 0 and the reason says so. The route is always NEW_ITEM_SOURCING anyway.
- **Rounding.** Values and prices are kept to 2 decimals. The CSV shows unrounded totals rather than rounding each line.

## Contracts (section 4)

- **Ceiling test (4.2).** A contract can be used when consumed + value ≤ ceiling. Exactly reaching the ceiling is allowed.
- **Consumption order.** Within a batch, requirements consume ceilings in requirement-date order. Every batch run starts from the register's consumed values, so run 1 and run 2 of the blind test do not eat into each other's ceiling. Each run is a what-if over the same starting position. In chat intake, PRs already approved by a buyer count as consumed for later chat PRs.
- **Blocked contract supplier.** RC-2026-005 belongs to S004, which is Blocked, so the contract does not apply (4.1). It is also not used for valuation, because 3.1(a) refers to an applicable contract.
- **Tie between contracts** with the same rate: the lower contract number wins, so the result is deterministic.
- **PDF-only contracts (4.4).** RC-2026-031 and RC-2026-033 are read from their signed PDFs at start-up and stored with source `pdf`, starting at zero consumed. Buyers can add more through the Contracts screen, by hand or by extracting from a PDF. The extracted draft is shown for confirmation before it is saved.
- **Expired contracts** (RC-2025-020 ended 30 Sep 2026) do not apply to November requirements. They still count for the preferred list, since 6.1(b) says "even if it has since expired".

## Decision rules (section 5)

- **Boundaries** follow the wording exactly. 5.3 is "≤ ₹5,00,000" (inclusive). 5.4 is "below ₹2,00,000" and 5.5 is "below ₹10,00,000" (both exclusive). 5.6 is "₹10,00,000 or more".
- **Capex (5.1)** comes before contracts, so a capex item on contract still goes to sourcing.
- **Emergency capex** still goes to CAPEX_SOURCING, because 5.1 comes first.
- **A rule that cannot be carried out is skipped.** A PO rule needs a supplier: a contract for CONTRACT_PO, and a 1st preferred supplier with a reference price for SPOT/EMERGENCY_PO. If the conditions match but no such supplier exists, the engine moves on to the next rule and records this in the decision trace. With v5.0 this cannot happen, because "bought from an Active supplier in 365 days" implies a preferred supplier. A future amendment could change that.
- **No rule matches.** If an amended policy leaves a gap, the engine falls back to RFQ. Getting quotes is the safe default, and the reason shows "No rule matched".
- **Fewer suggestions than required.** 6.4 tops up from the category. If the category still does not have enough Active suppliers, the app suggests the ones it has rather than inventing more. Worked example 11 has 4 suggestions for an RFP.

## Preferred supplier list and ranking (section 6)

**Who is on the list (6.1).** Active suppliers with a PO for the item in the 548 days up to the date, or with a contract for the item that started on or before the date. Blocked and Inactive suppliers are excluded everywhere (5.7). The date is the requirement date when deciding, and the chosen date when exporting.

**Ranking method (6.2).** Each supplier gets a score from 0 to 1, a weighted sum of five factors, each scaled to 0–1:

| Factor | How it is measured | Weight |
|---|---|---|
| Frequency | POs for the item in 548 days ÷ the highest count among suppliers on this list | 0.30 |
| Recency | 1 if the last PO is within 90 days, 0.5 within 365 days, else 0 | 0.25 |
| Contract | 1 if the supplier has held a contract for the item | 0.15 |
| On-time | on-time % from the supplier master ÷ 100 | 0.15 |
| Quality | quality rating ÷ 5 | 0.15 |

Ties are broken by on-time %, then quality, then supplier ID.

Why this method:
- Buying history (frequency plus recency, 55%) dominates. 6.2 says the list picks "the best choice for a direct PO", and the supplier we keep buying from is the proven choice.
- Frequency is relative to the other suppliers for the same item. Five POs means a lot for a capex item and little for gloves.
- The recency tiers are the ones Corvo's buyers use in the worked examples.
- A contract is a signal of a negotiated relationship. It is kept modest, because contract POs are already handled by rule 5.2.
- Delivery and quality decide between suppliers with similar history.

The method reproduces all three worked rankings: ITM-1048 S029 > S030; ITM-1036 S023 > S022 > S024; ITM-1016 S009 > S010.

The weights and recency tiers are part of the policy data (`parameters.ranking`), so Procurement can change them through an amendment. The Preferred suppliers screen shows each supplier's points per factor, so a buyer can see why a supplier is ranked where it is.

**Reference price (6.3).** The price on that supplier's most recent PO for the item in the 548 days. If there is none, the rate in its most recent contract for the item (latest start date).

**Category top-up (6.4).** "Best delivery and quality record first" is scored as on-time %/100 + quality/5, equally weighted, with supplier ID as the tie-break.

## PO consolidation (section 7)

- "Within 24 hours" is inclusive and measured from the creation time of each requirement's first line.
- A requirement joins the earliest open PO with the same supplier, plant and route. Requirements are taken in creation order.
- PO numbers (PO-0001, …) and requirement IDs (REQ-0001, …) are given in creation order within each run.

## Policy versions and amendments

- **Which version decides.** Each requirement is decided by the approved version in force on its requirement date (the latest `effective_from` on or before that date). So an amendment effective mid-batch changes only the requirements dated on or after its effective date. This follows 2.3, which ties contract and history checks to the requirement date, and the brief's "activates the new version from its effective date". The `policy_version` column shows the version used for each line. Before approving, the impact preview says how many lines of the last batch fall before the effective date. The Procurement user can then confirm or change the date.
- **Windows across versions.** A requirement uses the clubbing windows of the version in force on its first line's date. An open PO keeps the consolidation rules of the version that governed its first requirement.
- **Nothing changes until approval.** An uploaded or chat-described amendment becomes a *proposed* version. The app shows the changes in plain language and the impact on the last batch. Procurement can correct the rules in a JSON editor before approving: the app validates every field and operator and re-shows the changes. Approval records who approved and when, and activates the version from its effective date. Older versions are kept, and any run can be repeated under a specific version.
- **Effective date.** The date taken from the document ("effective 1 December 2026"), unless Procurement changes it on approval. If the document gives no date, the proposal keeps the previous version's effective date, so it replaces that version for every requirement it would have governed. The date is shown on the approval screen and can be changed there. I chose this over "today" because an undated amendment to be applied to pending PRs is more likely than one meant to skip them, and the buyer sees the choice before approving.
- **Version number.** The one stated in the document. Otherwise the next minor number (5.0 → 5.1).
- **Limits that apply to one plant or category.** For example "for CHK1 the spot limit is ₹1 lakh". The app adds a scoped copy of the rule with the new limit, placed just before the original, and excludes the scope from the original. Other plants are unaffected.
- **New rules from plain language** ("for plant CHK1, Safety & PPE above ₹50,000 must go to RFQ") are placed after capex and new-item handling and before the contract rule. A "must go to" sentence reads as overriding the normal PO routes. The plain-language view shows the position, and it can be moved in the editor.
- **Sentences the reader does not understand** are listed under "Sentences I could not turn into rules". They are never ignored silently, so Procurement can encode them in the editor.

## Buyer actions

- Override needs a written reason of at least 5 characters. The original decision is kept next to the override.
- A PO can never go to a Blocked or Inactive supplier, even through an override. Suggested suppliers in an override are checked the same way.
- The CSV export shows the engine's decisions, which is the scoring format. Overrides are visible in the workspace and the audit trail.

## Dates and times

- Timestamps in the batch are taken as plant local time (IST) with no time-zone conversion.
- In chat, "today" is the server date unless it is pinned in Settings or with `APP_TODAY`, which is useful because the kit's data is in November 2026.
