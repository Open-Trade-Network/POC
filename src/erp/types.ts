import type { SemanticAccountingTransaction } from "../core/accounting.js";
import type { TripleEntryEventRecord } from "../core/ledger.js";
import type { SignedEnvelope } from "../core/crypto.js";
import type { TradeDocument } from "../core/schema.js";

export interface ZohoBooksConfig {
  baseUrl: string;
  accessToken?: string;
  organizationId?: string;
  timeoutMs?: number;
}

export interface ZohoInvoiceLineItem {
  item_id?: string;
  item_name?: string;
  quantity?: number;
  rate?: number;
  amount?: number;
  tax_amount?: number;
}

export interface ZohoInvoicePayload {
  invoice_id?: string;
  invoice_number?: string;
  customer_id?: string;
  customer_name?: string;
  date?: string;
  currency_code?: string;
  total?: number | string;
  tax_total?: number | string;
  taxes?: Array<{
    tax_name?: string;
    tax_amount?: number | string;
  }>;
  line_items?: ZohoInvoiceLineItem[];
}

export interface SyncInvoiceOptions {
  sellerParticipantId: string;
  buyerParticipantId: string;
}

export interface SyncInvoiceResult {
  invoiceId: string;
  document: TradeDocument;
  envelope: SignedEnvelope;
  accountingTransaction: SemanticAccountingTransaction;
  teaEventRecord: TripleEntryEventRecord;
  status: "PROVISIONAL";
}
