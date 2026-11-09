# Demo video script and recording status

## Current local draft

- File: `catalogproof_review_cut.mp4` (plus `catalogproof_review_cut.srt`)
- Runtime: 1:49 (109 seconds), 1280×720 H.264, AAC narration, embedded English captions and SRT sidecar.
- Status: local owner-review draft only. It has not been uploaded to YouTube, and there is no public video URL yet.
- Source: real 3002 app footage and read-only API responses. The original video stream is unchanged; narration, captions, cuts, and readability zooms were added. There are no recreated app screens or staged results.
- Privacy: no buyer email or credentials are shown. No music is used.

## What the current draft shows

This is a factual run-of-show for the existing local draft, not a request to create a new model run or payment.

1. **Synthetic fixture:** The team-authored two-row tote fixture, labeled synthetic and not live inventory. The record documents the controlled Stone/Ecru discrepancy and the Ink comparison variant.
2. **Frozen request and diagnosis:** The shopper query “Find the Ecru Fieldwork Cotton Canvas Tote.” The saved live NVIDIA result is `conflicting_evidence`; it selected the intended SKU `CCS-CANVAS-TOTE-ECRU-01` before correction and flagged the mismatch between imported `Stone` and source `Ecru`.
3. **Seller review:** The approved change is limited to `variantAttributes.Color: Stone → Ecru`, with the stored exact source quote “Ecru.” The original catalog version remains preserved.
4. **Unchanged replay:** The same frozen query returns `supported_match` for the same intended SKU after approval. This demonstrates conflict resolution; the SKU selection itself did not flip from wrong to right.
5. **Audit and Sandbox receipt:** The query audit shows six events. The existing completed PayPal Sandbox transaction is for the exact SKU, quantity 1, USD 24.00; order `9CG69864LK862084H` and capture `6VR778831W402035T` read `COMPLETED`, with the app’s `verifiedPaid: true` readback. No new inference or payment was performed for this recording.
6. **Close:** Keep the synthetic-data and PayPal Sandbox disclosures visible. This is one controlled software test, not proof of real merchant outcomes, live inventory, customer demand, or sales impact. No real money moved.

## Claims and release gate

The intended SKU was selected both before and after correction. Describe the result as source-cited conflict diagnosis, seller approval, and supported replay—not a wrong-SKU-to-right-SKU flip. The local draft is for owner review only. Upload to YouTube and verify the published page only after owner approval; until then, leave the public video URL blank.
