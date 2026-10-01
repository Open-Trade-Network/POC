import { createHash, randomUUID } from "node:crypto";
import { deriveSemanticAccountingTransaction } from "../core/accounting.js";
import { createEnvelope, type ParticipantKeyMaterial } from "../core/crypto.js";
import { createSaltedCommitment, signTripleEntryEvent } from "../core/ledger.js";
import { TradeDocumentSchema, type TradeDocument } from "../core/schema.js";
import type { HostedTradeNetwork } from "../network.js";
import { ZohoBooksClient } from "./zoho.js";
import type { SyncInvoiceOptions, SyncInvoiceResult, ZohoBooksConfig, ZohoInvoicePayload } from "./types.js";

function uuidv5(name: string): string {
  const hash = createHash("sha256").update(name).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  if (bytes[6] === undefined || bytes[8] === undefined) {
    throw new Error("Unable to generate invoice UUID from ERP source value");
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function toIsoDate(value?: string): string {
  if (!value) {
    throw new Error("Invoice issue date is required");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invoice issue date is invalid");
  }
  return parsed.toISOString();
}

function toMinorUnits(value: number | string | undefined, label: string): number {
  if (value === undefined) throw new Error(`${label} is required`);
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`${label} must be a non-negative INR amount with at most two decimal places`);
  const minorUnits = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the supported range`);
  return Number(minorUnits);
}

function mapZohoTax(invoice: ZohoInvoicePayload): {
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  cessMinor: number;
  totalMinor: number;
} {
  const totalMinor = toMinorUnits(invoice.tax_total ?? 0, "Invoice tax total");
  const components = { cgstMinor: 0, sgstMinor: 0, igstMinor: 0, cessMinor: 0, totalMinor };

  for (const tax of invoice.taxes ?? []) {
    const amountMinor = toMinorUnits(tax.tax_amount, "Tax component amount");
    const taxName = tax.tax_name?.toUpperCase() ?? "";
    if (taxName.includes("CGST")) components.cgstMinor += amountMinor;
    else if (taxName.includes("SGST")) components.sgstMinor += amountMinor;
    else if (taxName.includes("IGST")) components.igstMinor += amountMinor;
    else if (taxName.includes("CESS")) components.cessMinor += amountMinor;
    else if (amountMinor > 0) throw new Error(`Unsupported or ambiguous Zoho tax component: ${tax.tax_name ?? "unnamed"}`);
  }

  const componentTotal = components.cgstMinor + components.sgstMinor + components.igstMinor + components.cessMinor;
  if (!Number.isSafeInteger(componentTotal) || componentTotal !== totalMinor) {
    throw new Error("Zoho tax components must be classified and add up to the invoice tax total");
  }
  return components;
}

export function mapZohoInvoiceToTradeDocument(
  invoice: ZohoInvoicePayload,
  options: SyncInvoiceOptions,
): TradeDocument {
  const invoiceId = invoice.invoice_id ?? invoice.invoice_number;
  if (!invoiceId) throw new Error("Zoho invoice ID or invoice number is required");
  const totalMinor = toMinorUnits(invoice.total, "Invoice total");
  const tax = mapZohoTax(invoice);
  if (invoice.currency_code?.toUpperCase() !== "INR") {
    throw new Error("Only INR Zoho invoices are supported by this pilot");
  }

  return TradeDocumentSchema.parse({
    version: 1,
    documentId: uuidv5(`${invoiceId}:${options.sellerParticipantId}:${options.buyerParticipantId}`),
    documentNumber: invoice.invoice_number ?? invoiceId,
    revision: 0,
    kind: "INVOICE",
    sellerParticipantId: options.sellerParticipantId,
    buyerParticipantId: options.buyerParticipantId,
    issuedAt: toIsoDate(invoice.date),
    currency: "INR",
    totalMinor,
    tax,
  });
}

export class ZohoBooksTradeAdapter {
  readonly client: ZohoBooksClient;

  constructor(
    private readonly config: ZohoBooksConfig,
    private readonly network: HostedTradeNetwork,
    private readonly sellerKeyMaterial: ParticipantKeyMaterial,
  ) {
    this.client = new ZohoBooksClient(config);
  }

  async syncInvoice(invoiceId: string, options: SyncInvoiceOptions): Promise<SyncInvoiceResult> {
    const invoice = await this.client.getInvoice(invoiceId);
    const document = mapZohoInvoiceToTradeDocument(invoice, options);

    const seller = this.network.getParticipantIdentity(options.sellerParticipantId);
    const buyer = this.network.getParticipantIdentity(options.buyerParticipantId);
    if (!seller || !buyer) {
      throw new Error("Both seller and buyer participants must already be registered with the network");
    }
    if (this.sellerKeyMaterial.participantId !== seller.participantId
      || this.sellerKeyMaterial.signingPublicKey !== seller.signingPublicKey
      || this.sellerKeyMaterial.encryptionPublicKey !== seller.encryptionPublicKey) {
      throw new Error("Seller key material does not match the registered seller identity");
    }

    const envelope = await createEnvelope(
      document,
      this.sellerKeyMaterial,
      options.buyerParticipantId,
      buyer.encryptionPublicKey,
    );
    await this.network.submitEnvelope(envelope);

    const transactionId = `zoho:${document.documentId}:${document.revision}`;
    const accountingTransaction = deriveSemanticAccountingTransaction(document, transactionId);
    const commitment = createSaltedCommitment(accountingTransaction);
    const previousEvent = this.network.getTripleEntryEvents().at(-1);
    const event = await signTripleEntryEvent({
      version: 1,
      sequence: this.network.getTripleEntryEvents().length,
      eventId: randomUUID(),
      transactionId,
      commitment: commitment.digest,
      commitmentSalt: commitment.salt,
      previousHash: previousEvent?.eventHash ?? "",
      sellerParticipantId: options.sellerParticipantId,
      buyerParticipantId: options.buyerParticipantId,
      kind: "SUBMITTED",
      actorParticipantId: options.sellerParticipantId,
      occurredAt: new Date().toISOString(),
    }, this.sellerKeyMaterial);
    const teaEventRecord = await this.network.submitTripleEntryEvent(event);

    await this.client.updateInvoiceStatus(invoiceId, "pending_counterparty", {
      transactionId,
      teaEventId: teaEventRecord.eventId,
      eventHash: teaEventRecord.eventHash,
      status: "PROVISIONAL",
      participantIds: [options.sellerParticipantId, options.buyerParticipantId],
    });
    return { invoiceId, document, envelope, accountingTransaction, teaEventRecord, status: "PROVISIONAL" };
  }
}
