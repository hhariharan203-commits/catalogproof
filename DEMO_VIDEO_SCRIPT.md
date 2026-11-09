# Demo video script (draft; do not record a successful end-to-end claim yet)

Target length: about 2:18. Use screen capture of the real app. No mock response should be edited in to look like a live result. Clearly label all data as synthetic.

## 0:00–0:12 — Open on the workflow overview

On screen: CatalogProof’s opening view, with “Synthetic test fixture” and “PayPal Sandbox only” visible.

Narration: “CatalogProof tests whether a shopping agent chose the right product variant before an order proceeds. This demo uses a fictional, team-authored two-item fixture, not a real merchant catalog or live inventory.”

## 0:12–0:32 — Show the two variants and controlled mismatch

On screen: The Fieldwork Cotton Canvas Tote rows and the source note. Highlight SKU `CCS-CANVAS-TOTE-ECRU-01`, imported as Stone, with the source record saying Ecru; show the Ink variant as the comparison row.

Narration: “Both rows are Fieldwork Cotton Canvas Tote test data. The Ecru SKU is imported as Stone, while its source record says Ecru. The second variant is Ink. That mismatch is deliberately authored for this software test.”

## 0:32–0:48 — Freeze the query

On screen: Query text “Find the Ecru Fieldwork Cotton Canvas Tote.” and expected SKU `CCS-CANVAS-TOTE-ECRU-01`.

Narration: “We freeze this exact shopper request and identify the intended SKU before running the check.”

## 0:48–1:10 — Live NVIDIA diagnosis and evidence

On screen: Record the actual live route result. Show the selected SKU, the cited database row, and the exact source values. Do not hide an abstention or validation error.

Narration: “The server-side model compares the selected SKU with its cited variant record. Unsupported citations or a violation of the shopper’s Ecru constraint are rejected by the validator rather than presented as proof.”

Gate: Film a successful diagnosis only if the current deployed route returns a citation that resolves to the exact source record. Otherwise show the honest blocked state or hold the recording.

## 1:10–1:28 — Seller correction

On screen: The proposed Stone-to-Ecru diff, exact source quote, and seller approval control.

Narration: “When the evidence supports it, the seller reviews the proposed change from Stone to Ecru. Nothing changes until the seller approves it.”

Gate: Show this step only if the actual live diagnosis produced a validated correction draft from that exact source quote.

## 1:28–1:48 — Replay the unchanged query

On screen: The same frozen query, the approved child catalog version, and the before/after result.

Narration: “We replay the identical frozen request against the approved catalog version. We call it a pass only if the server returns the intended Ecru SKU as a supported match.”

Gate: Do not edit the query, fixture, or expected SKU between the before and after run.

## 1:48–2:10 — PayPal Sandbox (pending)

On screen: Placeholder until the real flow is proven. After it is proven, record the buyer-approved PayPal Sandbox order, server-side capture, and authoritative PayPal readback for the exact SKU and amount.

Narration after proof: “The buyer approves this exact SKU in PayPal Sandbox. CatalogProof captures server-side, then reads the PayPal result back. It shows paid only when the completed capture matches the saved SKU, quantity, amount, and currency.”

Gate: No successful payment narration or screen recording until an actual Sandbox buyer approval, capture, and readback are documented. No Live PayPal host or real-money transaction.

## 2:10–2:18 — Close on audit and disclosure

On screen: The audit events and synthetic-data label.

Narration: “This is one traceable controlled software test: fixed request, cited evidence, seller decision, replay, and—when verified—Sandbox payment confirmation. It is not evidence of merchant outcomes.”

## Current recording gate

The live NVIDIA workflow and public 3002 browser smoke passed diagnosis, seller-approved correction, and identical-query replay on the synthetic fixture. The model selected the intended SKU both before and after the correction; this demonstrates conflict resolution, not a wrong-SKU-to-right-SKU flip. A USD 24.00 Sandbox order exists but remains `PAYER_ACTION_REQUIRED`; the seller’s receiving preference still does not persist on fresh readback, so buyer approval, capture, and authoritative PayPal paid readback are unverified. Stable judge hosting and public video recording remain pending. Do not present this as a completed transaction demo until those gates pass.
