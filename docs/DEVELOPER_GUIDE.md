# Open Trade Network (OTN) Developer and Protocol Contribution Guide

**Document status:** developer guide for the current proof of concept
**Repository:** Open-Trade-Network/POC
**Last reviewed:** 10 October 2026
**Audience:** application integrators, adapter developers, protocol contributors, and reviewers

## 1. What this repository is

OTN is a TypeScript proof of concept for exchanging Indian domestic B2B trade documents and recording bilateral accounting-workflow events. It contains a canonical trade document model, signing and recipient encryption utilities, a single-process HTTP sandbox, an in-memory event ledger, a Zoho Books-oriented invoice adapter, a browser demo, and ONDC, BharatTradeNet, and Sahamati Account Aggregator (AA) adapter scaffolds.

This is **not a production network**. It has no durable database, independently operated validator or witness network, business identity issuance, production key management, high-availability service, or certified connection to ONDC, BTN, Sahamati, or a live Zoho tenant. The network process loses all state when it stops. Treat all external-network adapters as starting points for profile-specific implementation, not certification or authorization to exchange real regulated data.

### Current external-network readiness

- **ONDC/Beckn:** typed parsing and mapping for a limited `confirm` and `update` payload shape, ACK/NACK formatting, and a callback hook. No live profile conformance, Beckn authentication/signature verification, durable work queue, or ONDC connection.
- **BharatTradeNet/MLETR:** typed MLETR-shaped document, RFC 8785 canonicalization, SHA-256 digest, and an injected Class-3 DSC signer interface. No BTN transport, title-transfer workflow, certificate-chain/revocation validation, or approved HSM integration.
- **Sahamati AA/FIP:** consent artifact decoding, injected signature-verification and data-authorization interfaces, a local ReBIT-oriented invoice mapping, and an encrypted FI package utility. No registry lookup, concrete trust verifier, official profile validation, AA transport, or FIP lifecycle implementation.
- **Zoho:** invoice mapping and sync logic tested against a fake HTTP service. Live OAuth, production organization compatibility, secret lifecycle, retries/reconciliation, and later counterparty status callbacks remain future work.

## 2. Architecture at a glance

The code separates a few responsibilities:

1. `src/core/schema.ts` validates canonical OTN trade-document metadata.
2. `src/core/canonical.ts` creates deterministic JSON bytes and SHA-256 base64url digests.
3. `src/core/crypto.ts` generates participant keys, signs messages, and creates/verifies recipient-encrypted envelopes. The private trade package may carry the commitment salt to the recipient inside the encrypted payload.
4. `src/core/accounting.ts` derives versioned-by-code semantic posting sets for supported invoices and credit notes; posting sets must balance in INR minor units.
5. `src/core/ledger.ts` implements a legacy bilateral proposal ledger and protocol-v2 TEA event lifecycle.
6. `src/core/transparency.ts` implements Merkle inclusion proofs and signed checkpoint verification for the POC.
7. `src/network.ts` hosts HTTP routes and applies request parsing, size limits, optional bearer-token protection, and route-level validation.
8. `src/adapters/` contains typed boundaries for ONDC, BTN, and Sahamati; `src/erp/` contains the Zoho-oriented connector.
9. `src/demo/` and `ui/` provide a runnable, single-process demonstration and user interface.

The sandbox HTTP server is a relay and in-memory test harness, not an authority that establishes invoice truth. A recipient is expected to decrypt the document, derive the accounting transaction locally, and verify the commitment before signing acceptance. The protocol currently verifies signatures and lifecycle rules; it does not independently verify economic truth, tax eligibility, or statutory registration.

## 3. Repository map

- `src/core/`: canonical schemas, cryptographic helpers, accounting derivation, ledger and transparency proof mechanics.
- `src/network.ts`: `HostedTradeNetwork`, sandbox HTTP API, environment-driven standalone entry point.
- `src/adapters/ondc/`: Beckn parsing, OTN mapping, ACK/NACK conversion, async callback controller.
- `src/adapters/bharattradenet/`: MLETR-shaped schema, canonical hash and injected DSC signer boundary.
- `src/adapters/sahamati/`: consent/FI mapping interfaces and package encryption/decryption.
- `src/adapters/pinelabs/`: provider-neutral payout port and normalized provider status mapping; no Pine Labs API client yet.
- `src/core/payouts.ts`: payment terms, agreements, payout intent schemas, and release-policy evaluation.
- `src/erp/`: Zoho Books HTTP client, invoice mapping and sync adapter.
- `src/agents/`: company-owned signed intent and local policy gateway.
- `src/demo/`: demo orchestration, fake Zoho endpoint, and demo web server.
- `ui/`: React and TypeScript demo interface.
- `test/`: Vitest coverage for protocol, adapters, ERP, agent gateway, transparency proofs, and demo.
- `ARCHITECTURE_BLUEPRINT.md`: broader target architecture, assumptions, open decisions, and roadmap.

`src/index.ts` re-exports the public TypeScript API. Prefer importing public exports for application-level integrations; use module-level imports when a focused implementation or test needs them.

## 4. Prerequisites and local setup

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Run the API sandbox on loopback:

```sh
npm run sandbox
curl http://127.0.0.1:3000/health
```

Run the full browser demo:

```sh
npm run demo
```

Open `http://127.0.0.1:8080`, then start the demo. It builds the server and UI, starts a separate in-memory network, and drives a simulated Zoho invoice through encryption, submission, buyer verification, witnessed proof mechanics, and acceptance. The demo's witness keys are generated in-process for demonstration and are not independent witnesses.

### Sandbox exposure

The server binds to `127.0.0.1:3000` by default. Binding outside loopback requires TLS and a bearer token at least 32 bytes long. Example:

```sh
HOST=0.0.0.0 \
NETWORK_API_TOKEN='use-a-random-secret-at-least-32-bytes' \
TLS_CERT_PATH='/secure/path/cert.pem' \
TLS_KEY_PATH='/secure/path/key.pem' \
npm run sandbox
```

Protect the token and TLS private key; do not paste real credentials into source, issues, or logs. This option does not make the sandbox production-ready. The standalone CLI does not configure independent witness keys; integrations that exercise acceptance must instantiate `HostedTradeNetwork` with an explicit trusted witness set, quorum, and log ID. The in-memory state disappears at restart.

## 5. Core document and accounting model

`TradeDocumentSchema` (`src/core/schema.ts`) currently accepts document kinds `INVOICE`, `CREDIT_NOTE`, `ORDER`, `DISPATCH`, `GRN`, and `PAYMENT_ADVICE`. The schema requires INR, nonnegative integer minor-unit amounts, distinct seller/buyer IDs, timestamp and UUID document identity, revision, and tax components whose sum equals total tax.

The semantic accounting derivation currently supports only `INVOICE` and `CREDIT_NOTE`. It emits seller and buyer posting sets and checks that each set balances. Values are INR paise. This is an illustrative protocol rule set, not accounting or tax advice. A change to posting semantics is a protocol-relevant change: preserve old derivation behavior by explicit rule version, add deterministic test vectors, and do not silently change the rule behind an existing version identifier.

`bindTradeDocument` binds an event to document ID, revision, and canonical document digest. The salted commitment binds derived posting data. The salt is not stored in shared ledger events; the seller should deliver it to the recipient inside a recipient-encrypted trade package. Each party needs an appropriate private encrypted archive and retention policy before relying on commitments in production.

## 6. TEA event lifecycle and witnessed proof prototype

Protocol-v2 events are signed by the acting participant and include a deterministic event ID, transaction and document binding, predecessor hash, event kind, and timestamp.

- `SUBMITTED`: seller's provisional proposal, with expiry and commitment.
- `ACCEPTED`: counterparty's decision; requires a supported derivation-rule version, re-derived commitment, proof of witnessed submission inclusion, and a separate witnessed inclusion proof for the acceptance event.
- `DISPUTED`: counterparty's typed disagreement, such as `ARITHMETIC_MISMATCH`, `TAX_MISMATCH`, or `DOCUMENT_MISMATCH`.
- `EXPIRED`: counterparty records silence/expiry using a witnessed checkpoint at or after the submission expiry.
- `WITHDRAWN`: submitter withdraws before a counterparty decision.

Revisions are unique per seller/document/revision and must reference the preceding revision event. Exact identical event retries are idempotent; reuse of a deterministic event ID for different signed content is rejected. Invalid chain-head/lifecycle conflicts map to HTTP 409; malformed or invalid events generally map to HTTP 400.

### Receipt construction and verification

`createWitnessedInclusionProof` in `src/core/transparency.ts` is a local proof construction helper used by tests and the demo. It builds a Merkle inclusion path and signs a checkpoint with supplied witness key material. `InMemoryTripleEntryLedger` verifies checkpoint signatures against its configured trusted witness keys and requires a quorum of at least two.

For acceptance, the signed acceptance event cannot contain its own proof without creating a self-referential hash. The event body includes the submission proof. The acceptance-event proof is carried separately in the HTTP request as `witnessedInclusion`. Its checkpoint must be later in tree size than the submission checkpoint and before expiry.

This is a proof-mechanics prototype only. There is no witness service, independent witness governance, append/merge-delay SLA, consistency proof between checkpoints, gossip, split-view detection, durable log, or automated expiry worker. Consequently, inclusion evidence here does not establish global finality or prevent an operator from showing inconsistent views.

## 7. HTTP API reference

All request and response bodies are JSON. Request bodies default to a 1 MiB limit. Responses set `Cache-Control: no-store`. `/health` is unauthenticated; when an API token is configured, other routes require `Authorization: Bearer <token>`. Without a token, access is limited to loopback-bound servers. Cross-origin browser requests are denied unless the origin is explicitly allowlisted.

- `GET /health` — sandbox health.
- `GET /participants` — public participant identifiers and public signing/encryption keys.
- `POST /participants` — registers a public identity; send `participantId`, `signingPublicKey`, and `encryptionPublicKey`. Do not send private keys.
- `POST /documents/envelope` — submits `{ "envelope": <signed encrypted envelope> }`.
- `GET /documents/envelopes?recipientId=<id>` — returns ciphertext envelopes addressed to that participant.
- `GET /ledger` — reads legacy bilateral proposal records.
- `POST /ledger/events` — submits a legacy signed two-party proposal.
- `GET /tea/events` — reads TEA event records.
- `POST /tea/events` — submits `{ "event": <signed v2 event>, "witnessedInclusion": <proof> }`; the outer proof is required for acceptance events and otherwise normally omitted.
- `GET /tea/transactions/{transactionId}` — returns current status and that transaction's event records.
- `POST /ondc/confirm`, `POST /ondc/update` — available only when an `OndcWebhookController` is supplied during `HostedTradeNetwork` construction.

The sandbox does not currently expose dedicated BTN or Sahamati HTTP routes. Their modules are library boundaries. Verify the selected network's current API profile and authentication requirements before adding a transport.

## 8. ONDC/Beckn adapter

`parseBecknEnvelope` accepts a constrained `confirm` or `update` context. Confirm maps order provider, items, quote, and context into `OtnPurchaseOrder`. Update can map an order or an OTN invoice. Amounts must be decimal INR values and convert to safe integer minor units.

Create a controller with a downstream processor and explicit error reporter:

```ts
import { createOndcWebhookController } from "./src/adapters/ondc/index.js";

const controller = createOndcWebhookController({
  processEvent: async (event) => {
    // Enqueue durable processing in a real deployment.
    console.info("Accepted ONDC event", event.kind);
  },
  onProcessingError: async (error, event) => {
    // Report to an operational system; do not silently discard failures.
    console.error("ONDC processing failed", event.kind, error);
  },
});
```

The controller validates and maps synchronously, schedules the processor asynchronously, and returns Beckn ACK. Processing failures after ACK cannot be returned as NACK; a production adapter needs durable queueing, retries, dead-letter handling, monitoring, idempotency, and agreed callback semantics. Add the selected ONDC/Beckn profile's authentication and conformance fixtures; the sandbox bearer token is not that authentication.

## 9. BharatTradeNet / MLETR adapter

`MletrDocumentSchema` currently accepts a document ID, `INVOICE` or `DELIVERY_NOTE`, issuer, timestamp, and opaque typed-as-JSON payload. `hashMletrDocument` validates, canonicalizes with RFC 8785 through the shared canonical serializer, and returns a SHA-256 hex digest. `signMletrDocument` calls the injected `Class3DscSigner` and validates the returned signature envelope.

The adapter does not hold a certificate or sign by itself. Provide an approved hardware-backed signer and separately implement certificate-chain, identity, revocation, legal title/control, transfer, and evidence lifecycle requirements. Do not describe an object as a legally effective electronic transferable record solely because it has a digest or a signature-shaped field.

## 10. Sahamati / ReBIT AA FIP scaffold

The current `src/adapters/sahamati/` exports:

- `decodeConsentArtifact(serialized)`: parses the POC shape `{ consentHandle, signature, payload }`.
- `mapInvoiceToRebit(document)`: maps an OTN `INVOICE` to a small local ReBIT-oriented metadata schema.
- `createFipPackage(...)`: verifies consent through a supplied `ConsentSignatureVerifier`, authorizes disclosure through a supplied `ConsentDataAuthorizer`, then encrypts the mapped invoice for a recipient.
- `encryptFiPackage(...)` / `decryptFiPackage(...)`: use ephemeral X25519 ECDH, HKDF-SHA-256, and AES-256-GCM with an authenticated encryption tag.

Illustrative integration boundary:

```ts
const result = await createFipPackage({
  serializedConsent,
  invoice: canonicalInvoice,
  recipientPublicKeyPem,
  signatureVerifier: registryBackedVerifier,
  dataAuthorizer: consentScopePolicy,
});

if (!result.ok) {
  // Map the typed code to the applicable ReBIT/AA response profile.
  throw new Error(`${result.code}: ${result.message}`);
}
// Deliver result.package using the selected FIP/AA transport.
```

`registryBackedVerifier` and `consentScopePolicy` above are application-supplied implementations, not included services. This repository does **not** call the Sahamati registry, validate current official consent artefacts, implement AA authentication or FI request/response transport, or provide a certified ReBIT schema/envelope. Before a pilot: pin official versions and test vectors, implement registry trust and key rotation/revocation, enforce consent expiry and purpose/field scope, add audit and replay controls, validate the actual FI data schema and encryption envelope, and obtain applicable governance/compliance review. Never use the current simplified mapping to make a real credit decision or disclose real financial information.

## Pine Labs vendor payout foundation (contract only)

The POC now has provider-independent groundwork, not an operational payout integration:

- `PaymentTermsTemplateSchema` supports versioned reusable templates.
- `AgreedPaymentTermsSchema` binds a versioned terms snapshot to an invoice revision and holds separate buyer and seller agreement-event references.
- Schedules support fixed INR minor-unit installments or percentage allocations, with due days measured from buyer approval of a delivery note.
- Buyer release policy is separate from the mutually agreed commercial payment terms. It supports manual, automatic, and threshold-based modes. The buyer selects whether amounts below the threshold are automatic or still require approval; amounts at or above it require approval.
- `PayoutIntentSchema` carries invoice and delivery approval references and timestamps, a versioned buyer policy snapshot, release authorization evidence, a stable OTN idempotency key, amount, due time, provider/account/beneficiary references, and a payout state separate from TEA and invoice states.
- `PineLabsPayoutPort` defines the future submission, status-query, and webhook-verification boundary. Normalized provider outcomes map `ACCEPTED` conservatively to `PROCESSING`; only `SUCCEEDED` maps to a paid outcome.

The schemas validate shape only. They do not look up or verify approval events, calculate due dates, enforce buyer authorization, reserve funds, execute payouts, or persist intents. The port is deliberately not an HTTP client: Pine Labs' official payout pack must define endpoint paths, authentication, field mapping, idempotency semantics, webhook signatures, status transitions, retries, and cancellation behavior before implementation. No Pine Labs secrets or bank account details belong in shared TEA events.

### Step-by-step implementation plan

1. **Pin the provider contract.** Obtain the official API pack, Postman collection, sandbox credentials, webhook examples, and test cases. Record the confirmed API version, auth/token renewal, buyer-account setup, beneficiary lifecycle, limits, rails/cutoffs/holidays, statuses, duplicate behavior, and reversal semantics.
2. **Finalize buyer policy and terms.** Confirm who may approve, buyer-level defaults and per-payment overrides, partial-installment arithmetic/rounding, credit-note/dispute behavior, and banking-calendar rules. Version both the terms snapshot and buyer release policy.
3. **Add durable payout storage.** Persist terms/templates, approval evidence references, payout intents, provider identifiers, webhook inbox/deduplication records, and an outbox. Add database uniqueness constraints for OTN idempotency keys and provider event IDs. Do not use the in-memory ledger as the payout source of truth.
4. **Implement eligibility and authorization.** Verify invoice and delivery approvals against authenticated OTN events; compute installment amounts and due dates; require both parties' terms agreement; enforce buyer roles and threshold policy; create an auditable authorization before any provider call.
5. **Implement the Pine Labs adapter.** Map the confirmed API into `PineLabsPayoutPort`; store credentials outside business data; submit one payout per installment with the provider-supported idempotency/reference mechanism. On ambiguous timeouts, query by that reference before any resubmission.
6. **Add webhook and reconciliation processing.** Preserve raw-body signature verification, deduplicate provider events, validate status transitions, and update payout state transactionally. Poll unresolved payouts as fallback if the contract permits; alert on stale or contradictory provider state.
7. **Test in sandbox and pilot.** Cover success, pending, timeout, duplicate, validation failure, insufficient funds, cancellation, reversal, webhook replay/forgery, and polling recovery. Pilot individual payouts before designing bulk payout processing.
8. **Review production readiness.** Complete security/privacy review, buyer credential isolation, audit/retention policy, operational alerts and runbooks, backup/recovery drills, legal/compliance review, and provider approval before real funds are enabled.

Until these steps are complete, this code must not be used to move funds or represented as a live Pine Labs connection.

## 11. Zoho and company-owned AI gateway

The Zoho adapter fetches an invoice, maps it to `TradeDocument`, creates an accounting commitment, encrypts a package to the buyer, submits a seller-signed provisional event, and updates invoice metadata. The repository's tests use a fake Zoho Books-shaped HTTP server. Supply credentials only through a suitable secret-management layer; the current client is not a complete OAuth application.

`CompanyAgentGateway` signs intents and authorizes scoped actions against local policy such as allowed action, document, recipient, and expiry. It is a local policy boundary, not a cross-company agent transport, identity directory, consent engine, or durable replay store.

## 12. Security, privacy, and statutory boundaries

- Keep signing and decryption keys in participant-controlled infrastructure; do not register or transmit private keys.
- A signed digest proves integrity relative to the signed bytes, not truth of business facts or authority of an unverified identity.
- Validate public keys and participant identity through an independently governed trust process before real use; sandbox registration is not proof of legal business identity.
- Encrypt documents to intended recipients. Shared event records expose identifiers, event types, timestamps, commitments, and linkage metadata.
- Do not log plaintext invoices, salts, API tokens, private keys, registry responses containing sensitive data, or unredacted consent artefacts.
- OTN is a commercial workflow and accounting evidence prototype, not a replacement for IRP-issued IRN/acknowledgements, e-way bills, GSTR-2B, or statutory records.
- Provisional/accepted event treatment, retention, legal holds, key destruction, and payload/salt backup policy require explicit operator decisions and legal/tax advice.
- The demo creates witness keys in the same process. A production witness set must be independent, governed, monitored, and paired with consistency proofs and gossip before anti-equivocation or finality claims are made.

## 13. Contributing to the protocol

Protocol work should optimize for explicit semantics, interoperable deterministic behavior, backwards compatibility, and independently reproducible tests.

1. **Start from a concrete problem.** Describe actors, trust assumptions, data disclosed, expected failure cases, and why the existing schema or lifecycle is insufficient.
2. **Separate proposal from implementation.** For changes that affect signatures, canonical bytes, event IDs, lifecycle, accounting derivation, or external wire formats, first document the change and migration/compatibility implications for review.
3. **Version protocol-visible behavior.** Never silently reinterpret an existing version, derivation-rule identifier, canonicalization rule, hash domain, or signature payload. Add an explicit version and define mixed-version behavior.
4. **Write normative invariants.** Specify allowed event transitions, who may sign, required predecessor/receipt proofs, duplicate and retry behavior, expiry and outage semantics, and error responses.
5. **Add deterministic vectors.** Include canonical input, expected bytes/digests/IDs, valid and invalid signatures/proofs, and expected state transitions. Test malformed input and adversarial cases, not only happy paths.
6. **Preserve privacy.** Keep salts and private accounting details out of public/shared records unless a reviewed protocol change explicitly requires disclosure. Update threat and metadata analysis when changing fields.
7. **Implement and test all affected surfaces.** Update schemas, core validators, HTTP boundaries, adapters, demo/UI types where relevant, README, and `ARCHITECTURE_BLUEPRINT.md`. Add focused Vitest tests.
8. **Run checks before proposing a change.**

```sh
npm run build
npm run typecheck
npm test
npm run build:ui
git diff --check
```

9. **Submit a reviewable PR.** State motivation, protocol/version impact, wire examples, privacy/security assumptions, migration path, tests run, and explicit non-goals. Mark unresolved cryptographic/legal decisions rather than implying they are solved.

### Review checklist

- Is the input schema strict at trust boundaries and are outputs deterministic?
- Are signatures checked against trusted keys and correct domain-separated payloads?
- Are retries idempotent without accepting conflicting content under one identity?
- Does the change preserve predecessor and lifecycle invariants?
- Can all participants reproduce the same result from published vectors?
- Are salts, plaintext and secrets kept out of shared state, UI snapshots, and logs?
- Are production dependencies and unsupported profile assumptions made explicit?
- Are documentation and status statements honest about the POC boundary?

## 14. Roadmap and unresolved work

The next major work is not simply adding more endpoints. It includes durable event and ciphertext storage, independent witness operations, checkpoint consistency and gossip, automated terminal expiry, identity issuance and key lifecycle, trust governance, observability, backup/recovery, rate limiting, conformance fixtures, selected ONDC/BTN/AA profiles, and production legal/security review. Evaluate witnessed logs versus BFT or a hybrid ordering model before selecting finality semantics. Reconcile OTN events to authoritative statutory records without claiming replacement.

The [architecture blueprint](../ARCHITECTURE_BLUEPRINT.md) records the broader target design and open decisions. Keep this guide and the README aligned with the implementation as it evolves.
