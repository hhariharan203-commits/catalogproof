# CatalogProof — Devpost submission draft

## Title and tagline

CatalogProof

Test the SKU before the buyer pays.

## Project description

An AI shopping agent can understand the product name and still choose the wrong variant. CatalogProof lets a seller test that choice before checkout: freeze one shopper request and expected SKU, inspect the diagnosis against exact catalog evidence, approve or reject a correction, and replay the same request against a new catalog version.

The demo uses an original, team-authored fictional two-variant canvas-tote fixture. One imported variant says `Stone` while its source record says `Ecru`. This is a deliberately controlled software-test discrepancy, not a real product, merchant defect, inventory offer, customer demand, sale, or measured business outcome.

## What the AI does

NVIDIA hosted NIM diagnoses a bounded set of catalog variants against the frozen shopper request. It can propose a descriptive-field correction only when an exact source quote supports it. Server-side validation checks candidate IDs, constraints, citations, and correction evidence. Unsupported claims fail closed; the model cannot edit the catalog, set availability or price, select payment data, or mark an order paid. A seller explicitly approves or rejects a correction; approval creates a new immutable catalog version.

## What PayPal does

The app implements PayPal Orders v2 in Sandbox only. The backend creates an order from the frozen, approved SKU snapshot, reads the order back, requires buyer approval before capture, and verifies completed capture details against the saved SKU, quantity, amount, and currency before showing paid.

Release disclosure: a USD 24.00 Sandbox order was created, but PayPal blocked buyer approval because the Sandbox seller does not accept USD. The order remains `PAYER_ACTION_REQUIRED`; no buyer approval, capture, or authoritative paid readback has occurred. Unit and route tests use mocked PayPal responses and are not transaction proof. Update this wording only after the full Sandbox flow succeeds and is documented.

## Demo sequence

1. Show the synthetic two-variant tote catalog and the deliberate Stone/Ecru mismatch.
2. Freeze the exact request: “Find the Ecru Fieldwork Cotton Canvas Tote.”
3. Run the live NVIDIA diagnosis and show the actual citations and outcome.
4. If the validated evidence supports it, review and approve the Stone-to-Ecru correction as the seller.
5. Replay the unchanged query against the new catalog version and show the exact SKU result.
6. **Pending:** show PayPal Sandbox buyer approval, server-side capture, and authoritative PayPal readback only after that transaction has actually succeeded.
7. Close on the audit trail and repeat that the fixture is synthetic and demonstrates controlled software behavior, not merchant results.

## Verified checks as of Nov 9, 2026

- `npm test`: 57 passed, 0 failed, 2 opt-in live-AI tests skipped.
- `npm run test:live`: 59 passed, 0 failed, including live NVIDIA inference and synthetic before/after correction replay.
- The exact shopper query also passed once through the authenticated app route with live NVIDIA inference and a source-resolved correction draft.
- PayPal adapter and route regressions cover Sandbox-only hosts, exact order snapshots, idempotency reuse, completed-order reconciliation, and capture-mismatch rejection with mocked provider responses.
- Desktop/mobile visual QA reported zero axe violations at 1440px and 390px, and no horizontal overflow at 320px, 390px, or 1440px. This is UI QA, not PayPal or deployment proof.

## Release items still pending

- Real PayPal Sandbox buyer approval, capture, and authoritative readback.
- A stable public HTTPS deployment and clean-browser end-to-end check. Current port-3002 preview is temporary and should not be presented as stable judge hosting.
- Public video under 3 minutes, recorded from the actual successful flow and checked at its published URL.
- Final Devpost fields and links; no submission has been made.
- Verify that the cleaned local source and QA matrix are pushed to the public repository after the approved history rewrite.

## Links

- Public source repository: https://github.com/hhariharan203-commits/catalogproof
- App-code license: MIT, in `LICENSE`.
- Hosted demo: **PENDING stable deployment and clean-browser check**.
- Public demo video (under 3 minutes): **PENDING recording and YouTube verification**.

## Claims to avoid

Do not claim a real merchant catalog, persistent merchant defect, product availability, customer demand, sales or conversion lift, production readiness, or validated superiority over baseline catalog validators. Do not describe a mocked PayPal test as a real transaction. Do not say the project has been submitted until the Devpost submission is actually complete.
