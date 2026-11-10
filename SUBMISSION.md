# CatalogProof — Devpost submission copy

## Project title

CatalogProof

## Tagline

Test the SKU before the buyer pays.

## Short description

CatalogProof helps a seller test whether an AI shopping workflow can support the exact product variant a shopper requested—before checkout. It freezes the shopper question and expected SKU, compares the model’s diagnosis with source-backed catalog evidence, puts any correction behind explicit seller approval, and replays the same question against a new catalog version.

## Inspiration

An AI system can understand a product name and still be uncertain about its color, size, or other variant. We wanted a small, inspectable workflow that asks more than “did the model return a product?” It asks whether the selected SKU is supported by the seller’s evidence, what changed after review, and whether a later payment is tied to that exact choice.

## What it does

A merchant imports product-variant data and freezes a shopper request plus its expected SKU. CatalogProof sends a bounded candidate set to NVIDIA hosted NIM for diagnosis, then validates the result server-side: candidate IDs, hard variant constraints, cited fields, and exact source quotes must check out. Unsupported answers fail closed; the model cannot change the catalog or commerce fields.

The seller can approve or reject a source-supported descriptive correction. Approval creates a new immutable catalog version; the unchanged request is replayed so the before/after result can be compared. Checkout is separate and PayPal Sandbox-only. The backend derives the cart from the approved snapshot, waits for buyer approval, and reports paid only after authoritative readback confirms exactly one completed capture matching the saved SKU, quantity, amount, and currency.

The current fixture is original team-authored synthetic data: two fictional canvas-tote variants, with one imported color set to `Stone` while its retained source says `Ecru`. This controlled discrepancy is a test fixture—not a real merchant defect, live inventory, sale, customer demand, or business-outcome claim.

## How we built it

The app uses Node.js 24, Node’s built-in HTTP server and SQLite, and a responsive HTML/CSS/JavaScript interface. AI requests run server-side through an OpenAI-compatible endpoint, with NVIDIA hosted NIM used for the live fixture tests. PayPal Orders v2 is integrated in Sandbox only. Catalog versions and checkout snapshots are server-owned; the browser redirect alone cannot establish approval or payment.

## Challenges and what we learned

The hard part was making evidence and commerce state more trustworthy than a plausible model response. We added strict checks for candidate and citation identity, exact quotes, protected catalog fields, frozen snapshots, idempotent PayPal retries, authoritative order readbacks, and multiple-capture rejection. A successful synthetic test demonstrates controlled software behavior; it does not prove that merchants have this problem at scale or that the product improves sales.

## What’s next

The next steps are a stable judge-facing deployment, broader clearly licensed or explicitly authorized catalogs, baseline comparisons, and more variant-conflict cases. Production or multi-merchant use would also need durable shared sessions, stronger operational controls, and broader security and deployment testing.

## Demo walkthrough

1. Show the clearly labeled synthetic tote fixture and the deliberate `Stone`/`Ecru` discrepancy.
2. Freeze the query “Find the Ecru Fieldwork Cotton Canvas Tote” and show the actual live model diagnosis and citations.
3. If the validated evidence supports the correction, approve it as the seller, then replay the identical query and compare catalog versions.
4. Show the separate PayPal Sandbox checkout and authoritative completed-payment readback, then close on the audit trail and synthetic-data disclosure.

The observed run selected the intended SKU both before and after the correction: it demonstrates conflict resolution, not an incorrect-SKU-to-correct-SKU flip. Do not script or edit the live model result to imply otherwise.

## Verification and limitations

- Latest `npm test`: 66 passed, 0 failed, 2 opt-in live-AI tests skipped.
- Latest `npm run test:live`: 68 passed, 0 failed, 0 skipped, including live NVIDIA diagnosis and synthetic before/after replay. These automated tests did not call PayPal.
- A separate PayPal Sandbox end-to-end transaction for `CCS-CANVAS-TOTE-ECRU-01`, quantity 1, USD 24.00 completed with one verified capture. Order `9CG69864LK862084H` and capture `6VR778831W402035T` read `COMPLETED`; fresh app/provider readbacks confirmed `verifiedPaid: true`. No real money moved. A separate older Sandbox attempt remains pending and uncaptured.
- Previously reported UI QA found no axe violations at 1440px and 390px, and no horizontal overflow at 320px, 390px, or 1440px. These are UI checks, not proof of a stable deployment. The full P0 security/deployment matrix has not been completed.
- The app is a single-workspace hackathon demo, not production-ready or multi-tenant software. The current hosted preview is temporary and is not a durable judge link.

## Links and final manual fields

- Source repository: https://github.com/hhariharan203-commits/catalogproof
- License: MIT (`LICENSE` in the repository).
- Public YouTube demo: https://www.youtube.com/watch?v=gMjwFVx-D7s (1:54, public, English captions, posted on Hari Haran’s channel). Hari confirmed that it plays. The exact approved footage is used; the demo is synthetic and PayPal Sandbox-only.
- The original review MP4 and SRT sidecar are local files; the published video player is the public deliverable.
- Hosted demo: no durable public judge URL is ready. Use the repository’s local setup instructions as the fallback; do not submit a temporary preview as stable hosting.

## Submission status

The owner submitted the entry manually. The public project page is https://devpost.com/software/catalogproof. The public repository and 1:54 YouTube video are linked from the entry, and Hari confirmed the video plays. There is no durable hosted demo; judges can use the public README’s complete local setup/run instructions and will need their own NVIDIA and PayPal Sandbox test credentials for live provider steps.

## Claims to avoid

Do not claim real merchant data or a persistent merchant defect, product availability, customer demand, sales/conversion lift, production readiness, multi-tenant security, superiority over baseline validators, or a wrong-SKU-to-right-SKU flip. Do not call mocked PayPal checks real transactions; the only completed transaction cited here was a PayPal Sandbox test, not real money.
