import type { ZohoInvoicePayload } from "../erp/types.js";

export const SELLER = {
  participantId: "kerala-industrial-supplies",
  companyId: "kerala-industrial-supplies",
  companyName: "Kerala Industrial Supplies Pvt Ltd",
  role: "SELLER" as const,
};

export const BUYER = {
  participantId: "hyderabad-manufacturing",
  companyId: "hyderabad-manufacturing",
  companyName: "Hyderabad Manufacturing Pvt Ltd",
  role: "BUYER" as const,
};

export const DEMO_INVOICE_ID = "INV-2026-0001";
export const DEMO_INVOICE_DATE = "2026-10-01";

export interface DemoLineItem {
  name: string;
  quantity: number;
  rateMinor: number;
}

/**
 * The demo invoice exists in the seller's ERP with line items. The canonical
 * trade document carries only totals, so the line-level view lives here and
 * every total is computed from these rows.
 */
export const DEMO_LINE_ITEMS: DemoLineItem[] = [
  { name: "Industrial Valve", quantity: 10, rateMinor: 500_000 },
  { name: "Pressure Gauge", quantity: 10, rateMinor: 300_000 },
];

/** Interstate sale (Kerala -> Telangana): IGST at 18%. */
export const DEMO_IGST_RATE = 0.18;

export function demoInvoiceTotals() {
  const subtotalMinor = DEMO_LINE_ITEMS.reduce(
    (total, item) => total + item.quantity * item.rateMinor,
    0,
  );
  const taxMinor = Math.round(subtotalMinor * DEMO_IGST_RATE);
  return {
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
  };
}

/**
 * The invoice exactly as the seller's Zoho Books ERP would serve it. Major-unit
 * decimal strings match how Zoho returns money fields.
 */
export function demoZohoInvoicePayload(): ZohoInvoicePayload {
  const totals = demoInvoiceTotals();
  const toMajor = (minor: number) => (minor / 100).toFixed(2);
  return {
    invoice_id: DEMO_INVOICE_ID,
    invoice_number: DEMO_INVOICE_ID,
    customer_id: "cust-hyderabad-manufacturing",
    customer_name: BUYER.companyName,
    date: DEMO_INVOICE_DATE,
    currency_code: "INR",
    total: toMajor(totals.totalMinor),
    tax_total: toMajor(totals.taxMinor),
    taxes: [{ tax_name: "IGST", tax_amount: toMajor(totals.taxMinor) }],
    line_items: DEMO_LINE_ITEMS.map((item, index) => ({
      item_id: `item-${index + 1}`,
      item_name: item.name,
      quantity: item.quantity,
      rate: item.rateMinor / 100,
      amount: (item.quantity * item.rateMinor) / 100,
    })),
  };
}

export type DemoStepId =
  | "setup"
  | "create"
  | "sign"
  | "encrypt"
  | "submit"
  | "network_verify"
  | "receive"
  | "decrypt"
  | "verify"
  | "accounting"
  | "accept"
  | "confirmed";

export interface DemoStepView {
  id: DemoStepId;
  label: string;
  status: "pending" | "active" | "done" | "failed";
  detail?: string;
  flowNode: number;
  durationMs?: number;
}

export const DEMO_STEPS: Array<Omit<DemoStepView, "status">> = [
  { id: "setup", label: "SETUP", flowNode: -1 },
  { id: "create", label: "CREATE", flowNode: 0 },
  { id: "sign", label: "SIGN", flowNode: 2 },
  { id: "encrypt", label: "ENCRYPT", flowNode: 3 },
  { id: "submit", label: "SUBMIT", flowNode: 4 },
  { id: "network_verify", label: "NETWORK VERIFY", flowNode: 4 },
  { id: "receive", label: "BUYER RECEIVE", flowNode: 5 },
  { id: "decrypt", label: "DECRYPT", flowNode: 6 },
  { id: "verify", label: "VERIFY", flowNode: 7 },
  { id: "accounting", label: "ACCOUNTING MATCH", flowNode: 7 },
  { id: "accept", label: "ACCEPT", flowNode: 8 },
  { id: "confirmed", label: "LEDGER CONFIRMED", flowNode: 8 },
];

export const FLOW_NODES = [
  "SELLER ERP",
  "AI GATEWAY",
  "SIGN",
  "ENCRYPT",
  "OPEN TRADE NETWORK",
  "BUYER GATEWAY",
  "DECRYPT",
  "VERIFY",
  "BUYER ERP",
] as const;
