# CatalogProof UI design notes

## Brief
A single-merchant, authenticated hackathon demo that tests whether a frozen shopper query selects the seller’s intended product variant, shows source evidence, makes catalog changes wait for explicit seller approval, replays the same query, and offers a PayPal Sandbox checkout tied to the exact corrected SKU. The app is not production commerce software and must not imply multi-tenant isolation.

## Concept card
- Idea: A product feed becomes a proof sheet: every recommendation is paired with its source, every change has a human signature, and every payment is reconciled to the exact SKU.
- Metaphor: A catalog inspection bench combining a print proof’s marked-up revision with a technical bench’s evidence labels.
- Signature: The before/after SKU comparison joined by one narrow “approved change” splice; the source stays fixed while only the seller-approved version changes.
- Emotion: Calm scrutiny, then confidence when the evidence lines up.
- Motion verb: Settle and register. Short transitions move a selection into its evidence row; reduced-motion users get the same clear state changes without motion.
- Screenshot: A mismatched initial SKU, the cited source field, a single reviewed correction, then the same frozen query landing on the intended SKU.
- Anchor: The workflow’s integrity depends on immutable catalog versions, exact variant SKUs, cited evidence, explicit seller approval, and PayPal readback.

## Concept alternatives
1. Proof sheet — revision/registration metaphor; exact SKU/evidence; strongest link to immutable before/after. Chosen.
2. Variant observatory — constellation of catalog attributes; selection path lights the chosen variant; attractive but risks looking like a generic AI dashboard.
3. Checkout passport — one product dossier follows the item to receipt; commerce-oriented, but less clear about version immutability and seller review.

## Art direction
- Ground: `#F3F4F0` (work surface)
- Paper: `#FBFCF9` (proof sheet)
- Ink: `#1D2524` (near-black-green)
- Muted: `#626B68` (secondary labels)
- Rule: `#D4D9D5` (hairlines)
- Signal: `#D84E37` (discrepancy and primary action)
- Verified: `#17674D` (confirmed evidence/approval)
- Type: Archivo for display and interface; IBM Plex Mono for true SKU/status values. Google Fonts are declared once in the document head.
- Grid: Desktop source rail plus evidence column, with a responsive single-column workflow on phones. Section rhythm alternates compact input, open comparison, and denser evidence groups.
- Shape: 3px utility corners; no repeated floating-card treatment or fake dashboard metrics.

## Integrity rules
- Start empty unless the server supplies a permitted public/synthetic seed. Do not silently preload LIVOStyle or present its time-sensitive conflict as proven defect or current inventory.
- Catalog import requires the user to assert rights and disallows private merchant uploads to the public demo. JSON import is size-limited and uses explicit source/license metadata.
- A catalog snapshot is not a live stock check. Checkout stays disabled unless the current approved snapshot marks the selected variant available.
- AI errors, missing credentials, ambiguous answers, and uncited suggestions are shown honestly; there is no mocked response.
- Seller approval is an explicit click. The UI never sends a client-supplied approver identity.
- Price, SKU, quantity and total shown at checkout come from the server’s immutable snapshot. Only PayPal Sandbox is linked. Browser redirects never count as approval or payment.
- CSRF stays in memory; only non-secret test/checkout IDs are kept in session storage for same-tab recovery.

## QA notes
- Current UI-only static checks: JavaScript syntax and HTML parse passed. API integration, browser visual checks, keyboard/a11y, mobile layout, real AI, PayPal Sandbox and deployment remain NOT RUN until the shared server is integrated.
