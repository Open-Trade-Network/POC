# Pine Labs B2B Vendor Payout Integration Plan

**Status:** Contract specification and groundwork complete; Pine Labs API details pending  
**Version:** 0.1  
**Scope:** Phased implementation of buyer-controlled, installment-based payments via Pine Labs  

## 1. Executive Summary

This document describes the step-by-step integration of Pine Labs payouts into OTN, enabling each buyer to disburse funds to vendors directly from its own Pine Labs merchant account in response to approved invoices and delivery notes.

The scope is individual payouts first; bulk processing is deferred until single-payment reconciliation is proven. Payment eligibility requires both invoice and delivery-note buyer approval. Due dates are calculated from the buyer's delivery-note approval with support for calendar-day schedules. Release policies are buyer-configured and may use manual, automatic, or threshold-based modes. Each buyer selects below-threshold behavior independently.

The integration is buyer-controlled: OTN orchestrates and records the payment instruction but does not pool funds, hold credentials, or bypass the buyer's approval workflow.

## 2. Requirements and Decisions

### Buyer and Seller Arrangement

- Each buyer uses its own Pine Labs merchant account and credentials.
- Buyers onboard vendor beneficiaries directly in Pine Labs.
- OTN stores only the Pine Labs beneficiary reference, not bank account details or IFSC codes.
- Payment terms and installment schedules are mutually agreed between buyer and seller.
- Payment completion is separate from invoice acceptance and depends only on Pine Labs' confirmed success.

### Payment Terms Model

Payment terms are bilateral agreements with the following structure:

- **Template:** Versioned, buyer-owned, reusable payment-terms template (e.g., "Net 30, split 50/50").
- **Agreement:** Linked to an invoice revision and holds separate buyer and seller signature-event references.
- **Installments:** Fixed amounts or percentages, each with a due-day offset from buyer delivery-note approval.
- **Release policy:** Separate buyer operational control (manual, automatic, or threshold-based).

### Release Policy

The buyer's release policy applies to a payable installment:

| Policy Mode | Behavior |
|---|---|
| **Manual** | Buyer finance user explicitly approves each payment before submission. |
| **Automatic** | Payment is submitted when it becomes due, without per-payment confirmation. |
| **Threshold** | Buyer configures a threshold amount. Payments below it follow the buyer's configuration (auto or require approval); payments at or above the threshold require approval. |

Each buyer configures below-threshold behavior once. All three modes must be available to buyers; policy scope is organization-level with optional per-payable overrides (to be decided).

### Status and Lifecycle

A payout transitions through the following states:

```
SCHEDULED → AWAITING_APPROVAL → READY → SUBMITTED → PROCESSING → SUCCEEDED
                                              ↘ FAILED
                                              ↘ CANCELLED
                                              ↘ REVERSED
```

- **SCHEDULED:** Payout is created and awaiting its due time.
- **AWAITING_APPROVAL:** Payout is due or overdue; requires buyer release authorization.
- **READY:** Buyer has approved; ready to submit to Pine Labs.
- **SUBMITTED:** Request sent to Pine Labs.
- **PROCESSING:** Pine Labs has accepted and is processing.
- **SUCCEEDED:** Pine Labs confirmed final success.
- **FAILED:** Pine Labs reported a terminal failure.
- **CANCELLED:** Buyer or system cancelled before submission.
- **REVERSED:** Pine Labs reported a reversal after success.

The authorization step is explicit and audited before any provider call. Provisional states remain distinct from confirmed payment success.

### Key Principles

1. **Buyer-controlled:** Each buyer approves its own vendor list, payment terms, release policies, and credentials.
2. **Eligibility tied to evidence:** Payment requires approved invoice and approved delivery note.
3. **Due-date calculation:** Start from buyer delivery-note approval; apply calendar days; submit on the next eligible banking window.
4. **Separate statuses:** Payout status is independent from invoice TEA status. Acceptance of an invoice does not imply payment.
5. **Provider as source of truth:** Only Pine Labs' confirmed success marks a payout as paid. Reversals are terminal separate states.
6. **Idempotent retries:** Use stable OTN idempotency keys; query Pine Labs by reference before resubmitting on timeout.
7. **Durable audit trail:** Record approval events, release decisions, provider submissions, and status updates.

## 3. Implemented Foundation

### Core Types (`src/core/payouts.ts`)

- `PaymentTermsSchema`: Installment schedule and allocation model (fixed or percentage).
- `PaymentTermsTemplateSchema`: Versioned, buyer-owned reusable templates.
- `AgreedPaymentTermsSchema`: Bilateral agreement snapshot with approval event references.
- `BuyerPayoutPolicySchema`: Buyer release-policy configuration.
- `PayoutStatusSchema`: Distinct payout states.
- `PayoutIntentSchema`: Complete payout record linking approval events, policy, authorization, and provider references.
- `evaluatePayoutReleasePolicy()`: Evaluate whether a payout requires manual approval based on the buyer's policy and amount.

### Adapter Boundary (`src/adapters/pinelabs/types.ts`)

- `PineLabsPayoutPort`: Provider-neutral interface for submission, status query, and webhook verification.
- `ProviderPayoutRequest`: Normalized input to the provider.
- `ProviderPayoutStatus` & `ProviderPayoutResult`: Provider outcomes.
- `mapProviderPayoutStatus()`: Conservative mapping (e.g., `ACCEPTED` → `PROCESSING`, not paid).

### Tests (`test/payouts.test.ts`)

- Validates installment schedule constraints (no mixing fixed/percentage, percentages ≤ 100%).
- Tests release-policy evaluation under different amounts and threshold configurations.
- Confirms payout intent authorization constraints.
- Validates provider status mapping.

### Documentation

- `README.md`: Added overview of the Pine Labs foundation.
- `DEVELOPER_GUIDE.md`: Detailed contract, implementation steps, and production readiness checklist.
- `ARCHITECTURE_BLUEPRINT.md`: Phase 8 roadmap.

## 4. Step-by-Step Implementation Roadmap

### Phase 1: Pin the Provider Contract

**Deliverables:**
- Official Pine Labs payout API pack (Postman collection, endpoint schemas, auth details).
- Sandbox environment and test credentials.
- Webhook event definitions and signature verification method.
- Beneficiary onboarding and reference semantics.
- Status lifecycle, idempotency guarantees, retry/cancel/reversal behavior.
- Rails (IMPS/NEFT/RTGS/UPI), limits, cutoffs, banking-holiday rules.
- Test cases for success, pending, failure, duplicate, cancellation, and reversal.

**Questions to Answer:**
- How is beneficiary ownership verified? Does the buyer alone manage beneficiary list in Pine Labs, or does OTN help?
- How do we handle duplicate submissions? Does Pine Labs use an idempotency header, and what is the semantic?
- What status transitions are possible, and which are terminal?
- What happens on timeout or network failure? Can we query by reference to deduplicate?
- How are webhooks signed? What is the retry/replay policy?
- How long must we retain audit evidence (salt, payload, approvals) for disputes?

### Phase 2: Finalize Buyer Policy and Terms

**Decisions to Make:**
- Should release policy be organization-level with per-payable overrides, independently per-payable, or org-only?
- How should buyers set defaults for below-threshold behavior (auto vs. require approval)?
- How do partial refunds and credit notes interact with installment schedules?
- If a delivery note is disputed, what happens to the related payout?
- How do we calculate business-day cutoffs for banking windows? Should we support buyer-specific holidays?

**Deliverables:**
- Versioning strategy for payment-terms templates and buyer release policies.
- Approved partial-installment arithmetic and rounding rules.
- Dispute/credit-note impact rules.
- Banking-calendar configuration (weekends, holidays, rail cutoffs).

### Phase 3: Add Durable Payout Storage

**Deliverables:**
- Durable storage for payment-terms templates, agreed terms, and payout intents.
- Durable webhook inbox with event deduplication by provider event ID.
- Outbox for pending provider submissions with retry tracking.
- Database uniqueness constraints for OTN idempotency keys and provider event IDs.
- Audit tables recording approvals, policy snapshots, and status transitions.

**Migrations:**
- Do not use the in-memory ledger as the payout source of truth.
- Keep trade-document TEA events and payout records separate.

### Phase 4: Implement Eligibility and Authorization

**Deliverables:**
- Payout-eligibility check: confirm invoice and delivery-note approvals against authenticated OTN TEA events.
- Due-date calculation from buyer's delivery-note approval timestamp using configured calendar-day rules.
- Dual-party terms agreement verification: both buyer and seller have signed.
- Buyer role and policy enforcement: only authorized users can release payouts; threshold and mode constraints are applied.
- Auditable authorization record created before any provider call.

**API Endpoints** (not yet implemented):
- `POST /payables`: Create a payable from a confirmed invoice and delivery approval.
- `GET /payables/{id}`: Inspect payout eligibility, due date, and authorization state.
- `POST /payables/{id}/approve`: Finance user releases the payout.

### Phase 5: Implement the Pine Labs Adapter

**Deliverables:**
- Concrete `PineLabsPayoutPort` implementation using the confirmed API.
- Authentication: manage buyer merchant-account credentials (API key, token lifecycle).
- Beneficiary reference validation: ensure the reference exists in Pine Labs.
- Payout submission: construct the request, store provider payout ID, record submission time.
- Status query: poll by idempotency key or provider payout ID.
- Idempotency: on timeout, query by OTN idempotency key before resubmitting.

**Secrets Management:**
- Do not embed Pine Labs credentials in business logic or TEA events.
- Use a dedicated credential store (environment variables, vault, or buyer-supplied credential endpoint).
- Rotate credentials periodically; log rotations but not credential values.

### Phase 6: Add Webhook and Reconciliation Processing

**Deliverables:**
- Webhook receiver (`POST /payouts/webhook`): verify Pine Labs' signature, deserialize, record raw body for audit.
- Replay prevention: deduplicate by provider event ID; reject stale timestamps.
- Status transition validation: reject impossible transitions (e.g., SUCCEEDED → PROCESSING).
- Transactional state update: update payout status, record event timestamp, append audit trail.
- Reconciliation worker: periodically poll unresolved payouts as fallback.
- Alert on stale or contradictory state: if a payout is marked paid but later shows as failed.

### Phase 7: Test in Sandbox and Pilot

**Test Coverage:**
- Payout creation, due-date calculation, authorization.
- Release policy evaluation under manual, automatic, and threshold modes.
- Successful payout flow (submission → processing → succeeded).
- Pending/timeout scenario: query by reference, deduplicate, resume.
- Provider rejection and failure handling.
- Cancellation before and after submission.
- Reversal after success.
- Webhook replay/forgery detection.
- Duplicate submission (buyer accidentally retries in UI).
- Insufficient funds (if provider reports it).

**Pilot Scope:**
- Start with individual payouts only.
- Use a small set of test beneficiaries and controlled invoice/delivery amounts.
- Do not enable bulk payout processing yet.

### Phase 8: Production Readiness Review

**Checklist:**
- [ ] Security review: key management, secret rotation, webhook verification, input validation.
- [ ] Privacy review: credential isolation, audit logging (no plaintext secrets), beneficiary data handling.
- [ ] Compliance review: audit trail, retention policy, key-loss/recovery procedures.
- [ ] Operational review: alerts, runbooks, incident response, backup/restore drills.
- [ ] Legal review: contract terms with Pine Labs, statutory record retention, refund/reversal handling.
- [ ] Provider approval: Pine Labs confirms production use and SLA.
- [ ] Buyer and seller acceptance: pilot results shared, confidence established.

## 5. API Sketch (Not Yet Implemented)

These endpoints are proposals pending detailed design and durable-storage implementation.

### Create a Payable

```
POST /payables
{
  "invoiceDocumentId": "5fb02c4a-...",
  "invoiceRevision": 0,
  "invoiceApprovalEventId": "tea-event-1",
  "deliveryNoteDocumentId": "8a2ecf95-...",
  "deliveryNoteRevision": 0,
  "deliveryApprovalEventId": "tea-event-2",
  "agreedPaymentTermsId": "terms-1",
  "agreedPaymentTermsVersion": 1
}

Response (201):
{
  "payoutId": "...",
  "status": "SCHEDULED",
  "dueAt": "2026-10-15T23:59:59Z",
  "installments": [...]
}
```

### Approve and Release a Payout

```
POST /payables/{payoutId}/approve
{
  "approverParticipantId": "buyer-finance-user-1",
  "authorizationReference": "policy-check-123"
}

Response (200):
{
  "payoutId": "...",
  "status": "READY",
  "releaseAuthorization": {
    "state": "APPROVED",
    "approvedAt": "2026-10-14T15:30:00Z"
  }
}
```

### Query Payout Status

```
GET /payables/{payoutId}

Response (200):
{
  "payoutId": "...",
  "status": "PROCESSING",
  "providerPayoutId": "PINE-REF-123",
  "providerUpdatedAt": "2026-10-14T15:31:00Z",
  "releaseAuthorization": { ... },
  "events": [ ... ]
}
```

### Webhook (Pine Labs → OTN)

```
POST /payouts/webhook
{
  "timestamp": "2026-10-14T15:35:00Z",
  "eventId": "pine-webhook-456",
  "idempotencyKey": "otn-payout-inst-1",
  "payoutId": "PINE-REF-123",
  "status": "SUCCEEDED"
}

Signature header: X-Pine-Labs-Signature: HMAC-SHA256(raw-body)

Response (200):
{ "received": true }
```

## 6. Not Yet Implemented

The following are deferred or require external input:

- Durable storage backend.
- Buyer release-policy UI and approval workflow.
- Beneficiary management (if OTN assists buyer onboarding).
- Bulk payout processing.
- Pine Labs authentication and token management (awaiting API pack).
- Webhook endpoint and signature verification (awaiting API pack).
- Banking-calendar configuration and due-date calculation rules.
- Reconciliation worker and alert/monitoring infrastructure.

## 7. Key Assumptions and Risks

| Assumption | Risk | Mitigation |
|---|---|---|
| Buyer owns Pine Labs merchant account. | Buyers must handle credentials and liability. | Documented buyer responsibility; OTN does not custody funds. |
| Beneficiary reference is stable in Pine Labs. | Reference changes could break payouts. | Record reference version; refresh periodically; alert on changes. |
| Pine Labs supports idempotent payout queries. | Ambiguous timeouts could lead to duplicate transfers. | Pin API contract; test duplicate scenarios; implement reconciliation polling. |
| Webhooks are available and signed. | Network unreliability could defer updates. | Combine webhooks with scheduled reconciliation polling. |
| Due-date calculation is deterministic. | Rounding or banking-window handling could cause disputes. | Document rules clearly; version calculation logic; provide test cases. |
| Release authorization is sufficient audit. | Approval could be circumvented or forged. | Require cryptographic signatures or tamper-evident audit logs; define key recovery. |

## 8. Roadmap Summary

| Phase | Effort | Dependencies |
|---|---|---|
| 1. Pin provider contract | 2–3 weeks | Pine Labs API pack, sandbox access. |
| 2. Finalize policy and terms | 1–2 weeks | Buyer/seller requirements gathering; legal counsel. |
| 3. Durable storage | 2–3 weeks | Database schema; migrations; no external dependencies. |
| 4. Eligibility and authorization | 2–3 weeks | TEA event API; approval audit schema. |
| 5. Pine Labs adapter | 2–3 weeks | Phase 1 contract; secret management infrastructure. |
| 6. Webhook and reconciliation | 2–3 weeks | Phase 1 contract; message queue or background-job runner. |
| 7. Sandbox testing and pilot | 3–4 weeks | Phases 1–6; test cases; buyer/seller participation. |
| 8. Production readiness | 2–3 weeks | Security, legal, operational reviews. |

**Estimated Total:** 16–26 weeks (4–6 months) for full production readiness, running phases sequentially.

## 9. Success Criteria

- [x] Provider-neutral payout domain and release-policy model defined and tested.
- [ ] Pine Labs official API contract obtained and documented.
- [ ] Durable payout storage with audit trail implemented.
- [ ] Eligibility and authorization enforced before provider calls.
- [ ] Pine Labs adapter passing sandbox test cases.
- [ ] Webhook replay and duplicate-submission detection working.
- [ ] Individual-payout reconciliation working under success, failure, timeout, reversal scenarios.
- [ ] Buyer release-policy UI allowing manual, automatic, and threshold-based choices.
- [ ] Pilot executed with real test vendors and approval workflows.
- [ ] Security, legal, and operational reviews complete.
- [ ] Provider approval and production SLA in place.

## 10. Questions for Pine Labs Clarification

The following must be answered before Phase 1 completes:

1. Is there an approved beneficiary onboarding flow, and does OTN need to integrate it, or is the buyer solely responsible?
2. What is the exact idempotency guarantee? If a submit request times out, can we query by idempotency key to check status without risk of duplicate transfer?
3. What webhook events are available? Do they cover ACCEPTED, PROCESSING, SUCCEEDED, FAILED, CANCELLED, and REVERSED?
4. How is the webhook signature generated? (HMAC algorithm, key, signed content.)
5. What are the supported transfer rails, limits, and cutoff times? Do they vary by bank/IFSC?
6. How long does a transfer typically take (IMPS vs. NEFT vs. RTGS)?
7. Can a payout be cancelled after submission? What happens if it's cancelled mid-transfer?
8. How are reversals initiated, and what is the reversal timeline?
9. What are the failure modes and error codes? (Insufficient funds, invalid beneficiary, rate limit, etc.)
10. Do you maintain a transaction history report? Can we reconcile by merchant reference?
11. What is the test data (test beneficiaries, test amounts) available in sandbox?
12. What is the SLA for sandbox behavior vs. production?

---

**Document Control**  
Version: 0.1  
Last Updated: 10 October 2026  
Status: Implementation Pending Pine Labs API Access  
Contact: Open Trade Network contributors
