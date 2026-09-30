import { createHash } from "node:crypto";
import { deriveAccountingEvent } from "../core/accounting.js";
import { createLedgerProposal, createSaltedCommitment } from "../core/ledger.js";
import { type ParticipantKeyMaterial } from "../core/crypto.js";
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
    return new Date().toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

export function mapZohoInvoiceToTradeDocument(
  invoice: ZohoInvoicePayload,
  options: SyncInvoiceOptions,
): TradeDocument {
  const invoiceId = invoice.invoice_id ?? invoice.invoice_number ?? `erp-${Date.now()}`;
  const totalMinor = Number(invoice.total ?? 0);
  const taxTotalMinor = Number(invoice.tax_total ?? 0);

  const normalizedTaxTotal = taxTotalMinor || 0;
  const cgstMinor = normalizedTaxTotal > 0 ? Math.round(normalizedTaxTotal / 2) : 0;
  const sgstMinor = normalizedTaxTotal > 0 ? normalizedTaxTotal - cgstMinor : 0;

  return TradeDocumentSchema.parse({
    version: 1,
    documentId: uuidv5(`${invoiceId}:${options.sellerParticipantId}:${options.buyerParticipantId}`),
    documentNumber: invoice.invoice_number ?? invoiceId,
    revision: 0,
    kind: "INVOICE",
    sellerParticipantId: options.sellerParticipantId,
    buyerParticipantId: options.buyerParticipantId,
    issuedAt: toIsoDate(invoice.date),
    currency: (invoice.currency_code ?? "INR").toUpperCase() === "INR" ? "INR" : "INR",
    totalMinor,
    tax: {
      cgstMinor,
      sgstMinor,
      igstMinor: 0,
      cessMinor: 0,
      totalMinor: normalizedTaxTotal,
    },
  });
}

export class ZohoBooksTradeAdapter {
  readonly client: ZohoBooksClient;

  constructor(
    private readonly config: ZohoBooksConfig,
    private readonly network: HostedTradeNetwork,
  ) {
    this.client = new ZohoBooksClient(config);
  }

  async syncInvoice(invoiceId: string, options: SyncInvoiceOptions): Promise<SyncInvoiceResult> {
    const invoice = await this.client.getInvoice(invoiceId);
    const document = mapZohoInvoiceToTradeDocument(invoice, options);

    const seller = this.network.getParticipant(options.sellerParticipantId);
    const buyer = this.network.getParticipant(options.buyerParticipantId);
    if (!seller || !buyer) {
      throw new Error("Both seller and buyer participants must already be registered with the network");
    }

    const envelope = await this.network.createEnvelopeForDocument(
      document,
      options.sellerParticipantId,
      options.buyerParticipantId,
    );

    const eventId = `erp:${document.documentId}`;
    const privateEvent = deriveAccountingEvent(document, eventId);
    const proposal = await createLedgerProposal({
      sequence: this.network.getLedgerRecords().length,
      eventId,
      commitment: createSaltedCommitment(privateEvent).digest,
      previousHash: this.network.getLedgerRecords().at(-1)?.chainHash ?? "",
      signers: [seller, buyer] as [ParticipantKeyMaterial, ParticipantKeyMaterial],
    });

    const ledgerRecord = await this.network.submitLedgerProposal(proposal);
    await this.client.updateInvoiceStatus(invoiceId, "accepted", {
      documentId: document.documentId,
      ledgerEventId: ledgerRecord.eventId,
      chainHash: ledgerRecord.chainHash,
      participantIds: ledgerRecord.parties,
    });

    return { invoiceId, document, envelope, ledgerRecord };
  }
}
