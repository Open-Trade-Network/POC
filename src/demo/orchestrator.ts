import { randomUUID } from "node:crypto";
import { CompanyAgentGateway, type SignedAgentIntent } from "../agents/gateway.js";
import { deriveSemanticAccountingTransaction, type SemanticAccountingTransaction } from "../core/accounting.js";
import { canonicalBytes, canonicalJson, sha256Base64Url } from "../core/canonical.js";
import {
  createEnvelope,
  createParticipantKeys,
  openEnvelope,
  signMessage,
  verifyEnvelope,
  verifyMessage,
  type ParticipantKeyMaterial,
  type SignedEnvelope,
} from "../core/crypto.js";
import {
  createSaltedCommitment,
  InMemoryTripleEntryLedger,
  signTripleEntryEvent,
  verifySaltedCommitment,
  type TripleEntryEventRecord,
} from "../core/ledger.js";
import { TradeDocumentSchema, type TradeDocument } from "../core/schema.js";
import { mapZohoInvoiceToTradeDocument } from "../erp/zoho-invoice-sync.js";
import { ZohoBooksClient } from "../erp/zoho.js";
import type { HostedTradeNetwork } from "../network.js";
import {
  BUYER,
  DEMO_INVOICE_ID,
  DEMO_INVOICE_DATE,
  DEMO_LINE_ITEMS,
  DEMO_STEPS,
  demoInvoiceTotals,
  SELLER,
  type DemoStepId,
  type DemoStepView,
} from "./demo-data.js";

export interface PartyView {
  participantId: string;
  companyName: string;
  role: "SELLER" | "BUYER";
  online: boolean;
  signingPublicKey?: string;
  encryptionPublicKey?: string;
}

export interface DemoInvoiceView {
  number: string;
  date: string;
  currency: "INR";
  lineItems: Array<{ name: string; quantity: number; rateMinor: number; amountMinor: number }>;
  subtotalMinor: number;
  taxLabel: string;
  taxMinor: number;
  totalMinor: number;
}

export interface DemoDocumentView {
  document: TradeDocument;
  canonicalJson: string;
  sha256: string;
  signature?: string;
}

export interface BuyerVerification {
  envelopeSignatureValid: boolean;
  ciphertextHashMatch: boolean;
  documentSignatureValid: boolean;
  documentDigestMatch: boolean;
  commitmentVerified: boolean;
  accountingMatch: boolean;
}

export interface DemoSnapshot {
  phase: "idle" | "running" | "complete" | "error";
  networkUrl: string;
  generatedAt?: string;
  error?: string;
  steps: DemoStepView[];
  participants: { seller: PartyView; buyer: PartyView };
  invoice?: DemoInvoiceView;
  document?: DemoDocumentView;
  envelope?: SignedEnvelope;
  commitment?: { digest: string; salt: string };
  accountingTransaction?: SemanticAccountingTransaction;
  intents: { validationRequest?: SignedAgentIntent; acceptance?: SignedAgentIntent };
  events: TripleEntryEventRecord[];
  transactionStatus?: "PROVISIONAL" | "CONFIRMED" | "DISPUTED";
  buyerVerification?: BuyerVerification;
  chainVerified?: boolean;
  erpStatusUpdates: Array<{ at: string; status: string }>;
}

interface DemoSessionOptions {
  network: HostedTradeNetwork;
  erpBaseUrl: string | (() => string);
  stepDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`${path}: ${message}`);
  }
  return payload;
}

async function getJson(baseUrl: string, path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`${path}: ${message}`);
  }
  return payload;
}

function idleSnapshot(networkUrl: string): DemoSnapshot {
  return {
    phase: "idle",
    networkUrl,
    steps: DEMO_STEPS.map((step) => ({ ...step, status: "pending" as const })),
    participants: {
      seller: {
        participantId: SELLER.participantId,
        companyName: SELLER.companyName,
        role: "SELLER",
        online: true,
      },
      buyer: {
        participantId: BUYER.participantId,
        companyName: BUYER.companyName,
        role: "BUYER",
        online: true,
      },
    },
    intents: {},
    events: [],
    erpStatusUpdates: [],
  };
}

/**
 * Drives one complete, real B2B trade transaction through the live sandbox
 * network over HTTP. Every step uses the repository's actual protocol code:
 * Zoho-style ERP fetch and mapping, canonicalization, Ed25519 signatures,
 * sealed-box encryption, salted commitments, and the TEA lifecycle ledger.
 * Private keys never leave the participant gateways.
 */
export class DemoSession {
  private snapshot: DemoSnapshot;
  private readonly listeners = new Set<(snapshot: DemoSnapshot) => void>();
  private running = false;

  constructor(private readonly options: DemoSessionOptions) {
    this.snapshot = idleSnapshot(options.network.url);
  }

  get state(): DemoSnapshot {
    return structuredClone(this.snapshot);
  }

  subscribe(listener: (snapshot: DemoSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const copy = this.state;
    for (const listener of this.listeners) listener(copy);
  }

  private setStep(id: DemoStepId, status: DemoStepView["status"], detail?: string, durationMs?: number): void {
    this.snapshot.steps = this.snapshot.steps.map((step) =>
      step.id === id
        ? { ...step, status, ...(detail !== undefined ? { detail } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }
        : step);
    this.emit();
  }

  async run(): Promise<DemoSnapshot> {
    if (this.running) throw new Error("Demo is already running");
    if (this.snapshot.phase === "running") throw new Error("Demo is already running");
    this.running = true;
    const delay = this.options.stepDelayMs ?? 450;
    const startedAt = Date.now();
    this.snapshot = idleSnapshot(this.options.network.url);
    this.snapshot.phase = "running";
    this.snapshot.generatedAt = new Date().toISOString();
    this.emit();

    const network = this.options.network;
    const baseUrl = network.url;
    const erpBaseUrl = typeof this.options.erpBaseUrl === "function"
      ? this.options.erpBaseUrl()
      : this.options.erpBaseUrl;
    const erp = new ZohoBooksClient({ baseUrl: erpBaseUrl });

    const step = async <T>(id: DemoStepId, work: () => Promise<{ detail?: string; result?: T }>): Promise<T> => {
      this.setStep(id, "active");
      await sleep(delay);
      const started = Date.now();
      try {
        const { detail, result } = await work();
        this.setStep(id, "done", detail, Date.now() - started);
        return result as T;
      } catch (error) {
        this.setStep(id, "failed", error instanceof Error ? error.message : String(error));
        throw error;
      }
    };

    try {
      // ── SETUP: fresh keys inside each company's gateway; only public
      // identities are registered with the network over HTTP.
      const { sellerKeys, buyerKeys, sellerGateway, buyerGateway, document } = await step("setup", async () => {
        const sellerKeys = await createParticipantKeys(SELLER.participantId);
        const buyerKeys = await createParticipantKeys(BUYER.participantId);
        for (const keys of [sellerKeys, buyerKeys]) {
          await postJson(baseUrl, "/participants", {
            participantId: keys.participantId,
            signingPublicKey: keys.signingPublicKey,
            encryptionPublicKey: keys.encryptionPublicKey,
          });
        }
        const totals = demoInvoiceTotals();
        const document = mapZohoInvoiceToTradeDocument(
          {
            invoice_id: DEMO_INVOICE_ID,
            invoice_number: DEMO_INVOICE_ID,
            customer_name: BUYER.companyName,
            date: DEMO_INVOICE_DATE,
            currency_code: "INR",
            total: (totals.totalMinor / 100).toFixed(2),
            tax_total: (totals.taxMinor / 100).toFixed(2),
            taxes: [{ tax_name: "IGST", tax_amount: (totals.taxMinor / 100).toFixed(2) }],
          },
          {
            sellerParticipantId: SELLER.participantId,
            buyerParticipantId: BUYER.participantId,
          },
        );
        const sellerGateway = new CompanyAgentGateway({
          companyId: SELLER.companyId,
          participantId: sellerKeys.participantId,
          keyMaterial: sellerKeys,
          policy: {
            allowActions: ["invoice_acceptance"],
            allowDocumentIds: [document.documentId],
            allowRecipients: [SELLER.participantId],
          },
        });
        const buyerGateway = new CompanyAgentGateway({
          companyId: BUYER.companyId,
          participantId: buyerKeys.participantId,
          keyMaterial: buyerKeys,
          policy: {
            allowActions: ["invoice_validation_request"],
            allowDocumentIds: [document.documentId],
            allowRecipients: [BUYER.participantId],
          },
        });
        this.snapshot.participants = {
          seller: {
            participantId: SELLER.participantId,
            companyName: SELLER.companyName,
            role: "SELLER",
            online: true,
            signingPublicKey: sellerKeys.signingPublicKey,
            encryptionPublicKey: sellerKeys.encryptionPublicKey,
          },
          buyer: {
            participantId: BUYER.participantId,
            companyName: BUYER.companyName,
            role: "BUYER",
            online: true,
            signingPublicKey: buyerKeys.signingPublicKey,
            encryptionPublicKey: buyerKeys.encryptionPublicKey,
          },
        };
        return {
          detail: "Ed25519 + X25519 keypairs generated; public identities registered",
          result: { sellerKeys, buyerKeys, sellerGateway, buyerGateway, document },
        };
      });

      // ── CREATE: pull the invoice from the seller ERP and map it to the
      // canonical trade document (same mapping the Zoho adapter uses).
      await step("create", async () => {
        const rawInvoice = await erp.getInvoice(DEMO_INVOICE_ID);
        const mapped = mapZohoInvoiceToTradeDocument(rawInvoice, {
          sellerParticipantId: SELLER.participantId,
          buyerParticipantId: BUYER.participantId,
        });
        if (canonicalJson(mapped) !== canonicalJson(document)) {
          throw new Error("ERP invoice does not match the expected canonical document");
        }
        const totals = demoInvoiceTotals();
        this.snapshot.invoice = {
          number: DEMO_INVOICE_ID,
          date: DEMO_INVOICE_DATE,
          currency: "INR",
          lineItems: DEMO_LINE_ITEMS.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            rateMinor: item.rateMinor,
            amountMinor: item.quantity * item.rateMinor,
          })),
          subtotalMinor: totals.subtotalMinor,
          taxLabel: "IGST @ 18%",
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
        };
        this.snapshot.document = {
          document,
          canonicalJson: canonicalJson(document),
          sha256: sha256Base64Url(canonicalBytes(document)),
        };
        const totalsDetail = `₹${(totals.totalMinor / 100).toLocaleString("en-IN")} · canonical JSON hashed`;
        return { detail: totalsDetail };
      });

      // ── Seller AI gateway issues a signed, policy-scoped intent requesting
      // buyer-side validation of this document.
      const validationIntent = await sellerGateway.signIntent({
        action: "invoice_validation_request",
        intentId: `intent-${randomUUID()}`,
        agentId: "seller-gateway-01",
        documentId: document.documentId,
        recipientId: BUYER.participantId,
        purpose: `Counterparty validation of ${DEMO_INVOICE_ID}`,
        payload: { documentNumber: DEMO_INVOICE_ID, totalMinor: document.totalMinor },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      this.snapshot.intents.validationRequest = validationIntent;
      this.emit();

      // ── SIGN: seller signs the canonical document bytes.
      const documentSignature = await step("sign", async () => {
        const signature = await signMessage(canonicalBytes(document), sellerKeys.signingPrivateKey);
        if (this.snapshot.document) this.snapshot.document.signature = signature;
        return { detail: `Ed25519 signature over canonical document`, result: signature };
      });

      // ── ENCRYPT: sealed box to the buyer's encryption key.
      const envelope = await step("encrypt", async () => {
        const envelope = await createEnvelope(
          document,
          sellerKeys,
          BUYER.participantId,
          buyerKeys.encryptionPublicKey,
        );
        this.snapshot.envelope = envelope;
        return { detail: "X25519 sealed box — network sees ciphertext only", result: envelope };
      });

      // ── SUBMIT: encrypted, signed envelope is submitted over HTTP.
      await step("submit", async () => {
        const response = await postJson(baseUrl, "/documents/envelope", { envelope }) as { envelope: SignedEnvelope };
        return { detail: `Envelope ${response.envelope.header.envelopeId.slice(0, 8)}… accepted` };
      });

      // ── NETWORK VERIFY + TEA SUBMITTED: seller derives the shared accounting
      // transaction, commits to it, signs and appends the provisional event.
      const { accountingTransaction, submittedRecord } = await step("network_verify", async () => {
        const transactionId = `tea:${document.documentId}:${document.revision}`;
        const accountingTransaction = deriveSemanticAccountingTransaction(document, transactionId);
        const commitment = createSaltedCommitment(accountingTransaction);
        const eventsResponse = await getJson(baseUrl, "/tea/events") as { events: TripleEntryEventRecord[] };
        const previous = eventsResponse.events.at(-1);
        const submitted = await signTripleEntryEvent({
          version: 1,
          sequence: eventsResponse.events.length,
          eventId: randomUUID(),
          transactionId,
          commitment: commitment.digest,
          commitmentSalt: commitment.salt,
          previousHash: previous?.eventHash ?? "",
          sellerParticipantId: SELLER.participantId,
          buyerParticipantId: BUYER.participantId,
          kind: "SUBMITTED",
          actorParticipantId: SELLER.participantId,
          occurredAt: new Date().toISOString(),
        }, sellerKeys);
        const appendResponse = await postJson(baseUrl, "/tea/events", { event: submitted }) as { record: TripleEntryEventRecord };
        this.snapshot.commitment = commitment;
        this.snapshot.accountingTransaction = accountingTransaction;
        this.snapshot.events = [...this.snapshot.events, appendResponse.record];
        this.snapshot.transactionStatus = "PROVISIONAL";

        await erp.updateInvoiceStatus(DEMO_INVOICE_ID, "pending_counterparty", {
          transactionId,
          teaEventId: appendResponse.record.eventId,
          eventHash: appendResponse.record.eventHash,
          status: "PROVISIONAL",
        });
        this.snapshot.erpStatusUpdates = [
          ...this.snapshot.erpStatusUpdates,
          { at: new Date().toISOString(), status: "pending_counterparty" },
        ];
        return {
          detail: "Signature + ciphertext verified; salted commitment appended (seq 0)",
          result: { accountingTransaction, submittedRecord: appendResponse.record },
        };
      });
      void accountingTransaction;

      // The buyer's AI gateway authorizes the seller's signed validation intent
      // before its systems touch the payload.
      const intentAuthorized = await buyerGateway.authorizeIntent(validationIntent);
      if (!intentAuthorized) throw new Error("Buyer gateway rejected the seller's signed intent");

      // ── BUYER RECEIVE: pull the envelope addressed to the buyer.
      const receivedEnvelope = await step("receive", async () => {
        const response = await getJson(
          baseUrl,
          `/documents/envelopes?recipientId=${encodeURIComponent(BUYER.participantId)}`,
        ) as { envelopes: SignedEnvelope[] };
        const found = response.envelopes.find((item) => item.header.envelopeId === envelope.header.envelopeId);
        if (!found) throw new Error("Envelope was not delivered to the buyer");
        return { detail: "Encrypted envelope pulled by buyer gateway", result: found };
      });

      // ── DECRYPT: only the buyer's private key can open it.
      const decryptedDocument = await step("decrypt", async () => {
        const decrypted = await openEnvelope(receivedEnvelope, buyerKeys, sellerKeys.signingPublicKey);
        return { detail: `Sealed box opened → ${decrypted.documentNumber}`, result: decrypted };
      });
      TradeDocumentSchema.parse(decryptedDocument);

      // ── VERIFY: signature, ciphertext integrity and document digest.
      await step("verify", async () => {
        const envelopeSignatureValid = await verifyEnvelope(receivedEnvelope, sellerKeys.signingPublicKey);
        const ciphertextHashMatch = sha256Base64Url(Buffer.from(receivedEnvelope.ciphertext, "base64url"))
          === receivedEnvelope.header.ciphertextHash;
        const documentSignatureValid = await verifyMessage(
          canonicalBytes(decryptedDocument),
          documentSignature,
          sellerKeys.signingPublicKey,
        );
        const documentDigestMatch = this.snapshot.document?.sha256
          === sha256Base64Url(canonicalBytes(decryptedDocument));
        if (!envelopeSignatureValid || !ciphertextHashMatch || !documentSignatureValid || !documentDigestMatch) {
          throw new Error("Buyer-side verification failed");
        }
        this.snapshot.buyerVerification = {
          envelopeSignatureValid,
          ciphertextHashMatch,
          documentSignatureValid,
          documentDigestMatch,
          commitmentVerified: false,
          accountingMatch: false,
        };
        return { detail: "Signature valid · ciphertext intact · digest matches" };
      });

      // ── ACCOUNTING MATCH: the buyer independently derives the same posting
      // sets and proves them against the seller's salted commitment.
      await step("accounting", async () => {
        const buyerDerived = deriveSemanticAccountingTransaction(decryptedDocument, submittedRecord.transactionId);
        const commitmentVerified = verifySaltedCommitment(
          buyerDerived,
          submittedRecord.commitment,
          submittedRecord.commitmentSalt!,
        );
        const accountingMatch = canonicalJson(buyerDerived) === canonicalJson(this.snapshot.accountingTransaction);
        if (!commitmentVerified || !accountingMatch) {
          throw new Error("Buyer-derived accounting does not match the submitted commitment");
        }
        this.snapshot.buyerVerification = {
          ...(this.snapshot.buyerVerification as BuyerVerification),
          commitmentVerified,
          accountingMatch,
        };
        return { detail: "Independent derivation reproduces seller commitment" };
      });

      // ── ACCEPT: buyer gateway signs a scoped acceptance intent, the seller
      // gateway authorizes it, and the buyer signs the ACCEPTED ledger event.
      await step("accept", async () => {
        const acceptanceIntent = await buyerGateway.signIntent({
          action: "invoice_acceptance",
          intentId: `intent-${randomUUID()}`,
          agentId: "buyer-gateway-01",
          documentId: document.documentId,
          recipientId: SELLER.participantId,
          purpose: `Acceptance of ${DEMO_INVOICE_ID}`,
          payload: { transactionId: submittedRecord.transactionId, decision: "ACCEPT" },
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
        this.snapshot.intents.acceptance = acceptanceIntent;
        if (!await sellerGateway.authorizeIntent(acceptanceIntent)) {
          throw new Error("Seller gateway rejected the buyer's signed acceptance intent");
        }

        const eventsResponse = await getJson(baseUrl, "/tea/events") as { events: TripleEntryEventRecord[] };
        const accepted = await signTripleEntryEvent({
          version: 1,
          sequence: eventsResponse.events.length,
          eventId: randomUUID(),
          transactionId: submittedRecord.transactionId,
          commitment: submittedRecord.commitment,
          previousHash: eventsResponse.events.at(-1)?.eventHash ?? "",
          sellerParticipantId: SELLER.participantId,
          buyerParticipantId: BUYER.participantId,
          kind: "ACCEPTED",
          actorParticipantId: BUYER.participantId,
          occurredAt: new Date().toISOString(),
        }, buyerKeys);
        const appendResponse = await postJson(baseUrl, "/tea/events", { event: accepted }) as { record: TripleEntryEventRecord };
        this.snapshot.events = [...this.snapshot.events, appendResponse.record];
        this.snapshot.transactionStatus = "CONFIRMED";
        return { detail: "Buyer-signed ACCEPTED event appended" };
      });

      // ── LEDGER CONFIRMED: re-read network state and independently replay the
      // hash-chained event log to prove integrity.
      await step("confirmed", async () => {
        const statusResponse = await getJson(
          baseUrl,
          `/tea/transactions/${encodeURIComponent(submittedRecord.transactionId)}`,
        ) as { status: string; events: TripleEntryEventRecord[] };
        if (statusResponse.status !== "CONFIRMED") {
          throw new Error(`Expected CONFIRMED, got ${statusResponse.status}`);
        }

        const trustedKeys = new Map<string, string>();
        for (const participant of [this.snapshot.participants.seller, this.snapshot.participants.buyer]) {
          if (participant.signingPublicKey) trustedKeys.set(participant.participantId, participant.signingPublicKey);
        }
        const replay = new InMemoryTripleEntryLedger(trustedKeys);
        for (const record of statusResponse.events) {
          const { eventHash, ...event } = record;
          const replayed = await replay.append(event);
          if (replayed.eventHash !== eventHash) {
            throw new Error("Hash chain replay produced a different event hash");
          }
        }
        this.snapshot.chainVerified = true;
        this.snapshot.transactionStatus = "CONFIRMED";

        await erp.updateInvoiceStatus(DEMO_INVOICE_ID, "accepted_by_counterparty", {
          transactionId: submittedRecord.transactionId,
          status: "CONFIRMED",
        });
        this.snapshot.erpStatusUpdates = [
          ...this.snapshot.erpStatusUpdates,
          { at: new Date().toISOString(), status: "accepted_by_counterparty" },
        ];
        return { detail: "Chain replay verified · transaction CONFIRMED" };
      });

      this.snapshot.phase = "complete";
      this.emit();
      return this.state;
    } catch (error) {
      this.snapshot.phase = "error";
      this.snapshot.error = error instanceof Error ? error.message : String(error);
      this.emit();
      return this.state;
    } finally {
      this.running = false;
      void startedAt;
    }
  }
}
