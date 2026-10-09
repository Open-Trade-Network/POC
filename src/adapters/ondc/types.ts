import { z } from "zod";
import { TradeDocumentSchema, type TradeDocument } from "../../core/schema.js";

const decimalAmount = z.string().regex(/^\d+(?:\.\d{1,2})?$/);

const BecknContextSchema = z.object({
  action: z.enum(["confirm", "update"]),
  bap_id: z.string().min(1).max(128),
  bpp_id: z.string().min(1).max(128),
  timestamp: z.string().datetime({ offset: true }),
}).passthrough();

const BecknItemSchema = z.object({
  id: z.string().min(1).max(128),
  descriptor: z.object({ name: z.string().min(1).max(256) }).passthrough().optional(),
  quantity: z.object({ count: decimalAmount }).passthrough(),
  price: z.object({
    currency: z.literal("INR"),
    value: decimalAmount,
  }).passthrough(),
}).passthrough();

const BecknOrderSchema = z.object({
  id: z.string().min(1).max(128),
  provider: z.object({ id: z.string().min(1).max(128) }).passthrough(),
  items: z.array(BecknItemSchema).min(1).max(1000),
  quote: z.object({
    price: z.object({
      currency: z.literal("INR"),
      value: decimalAmount,
    }).passthrough(),
  }).passthrough(),
  created_at: z.string().datetime({ offset: true }).optional(),
}).passthrough();

const BecknConfirmRequestSchema = z.object({
  context: BecknContextSchema.extend({ action: z.literal("confirm") }),
  message: z.object({ order: BecknOrderSchema }).passthrough(),
}).passthrough();

const BecknUpdateRequestSchema = z.object({
  context: BecknContextSchema.extend({ action: z.literal("update") }),
  message: z.object({
    order: BecknOrderSchema.optional(),
    invoice: z.unknown().optional(),
  }).passthrough(),
}).passthrough().superRefine(({ message }, context) => {
  if (!message.order && !message.invoice) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An order or invoice is required for an update" });
  }
});

const OtnPurchaseOrderItemSchema = z.object({
  itemId: z.string().min(1).max(128),
  description: z.string().min(1).max(256),
  quantity: decimalAmount,
  unitPriceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const OtnPurchaseOrderSchema = z.object({
  documentType: z.literal("PURCHASE_ORDER"),
  documentId: z.string().min(1).max(128),
  documentNumber: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  buyerParticipantId: z.string().min(1).max(128),
  sellerParticipantId: z.string().min(1).max(128),
  issuedAt: z.string().datetime({ offset: true }),
  currency: z.literal("INR"),
  totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z.array(OtnPurchaseOrderItemSchema).min(1).max(1000),
}).strict().superRefine((order, context) => {
  if (order.buyerParticipantId === order.sellerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Order parties must be distinct" });
  }
});

export type OtnPurchaseOrder = z.infer<typeof OtnPurchaseOrderSchema>;
export type OtnInvoice = TradeDocument;
export type OndcAction = "confirm" | "update";
export type OndcTradeEvent =
  | { kind: "PURCHASE_ORDER_CONFIRMED"; action: "confirm"; document: OtnPurchaseOrder }
  | { kind: "PURCHASE_ORDER_UPDATED"; action: "update"; document: OtnPurchaseOrder }
  | { kind: "INVOICE_UPDATED"; action: "update"; document: OtnInvoice };

export type BecknAckStatus = "ACK" | "NACK";
export interface BecknAck {
  message: { ack: { status: BecknAckStatus } };
}

export interface BecknError {
  type: "JSON-SCHEMA-ERROR" | "DOMAIN-ERROR" | "APPLICATION-ERROR";
  code: string;
  message: string;
}

export interface BecknNack extends BecknAck {
  error: BecknError;
}

export class OndcWebhookError extends Error {
  constructor(
    readonly error: BecknError,
    readonly statusCode = 400,
  ) {
    super(error.message);
  }
}

export function parseBecknEnvelope(action: OndcAction, input: unknown): OndcTradeEvent {
  if (action === "confirm") {
    const parsed = BecknConfirmRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new OndcWebhookError({
        type: "JSON-SCHEMA-ERROR",
        code: "40000",
        message: "Request does not match the Beckn confirm envelope",
      });
    }
    const { context, message } = parsed.data;
    return {
      kind: "PURCHASE_ORDER_CONFIRMED",
      action,
      document: mapBecknOrder(message.order, context.bap_id, context.timestamp),
    };
  }

  const parsed = BecknUpdateRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new OndcWebhookError({
      type: "JSON-SCHEMA-ERROR",
      code: "40000",
      message: "Request does not match the Beckn update envelope",
    });
  }
  const { context, message } = parsed.data;
  if (message.invoice !== undefined) {
    const invoice = TradeDocumentSchema.safeParse(message.invoice);
    if (!invoice.success || invoice.data.kind !== "INVOICE") {
      throw new OndcWebhookError({
        type: "DOMAIN-ERROR",
        code: "40001",
        message: "The update invoice must match the OTN invoice schema",
      });
    }
    return { kind: "INVOICE_UPDATED", action, document: invoice.data };
  }
  if (!message.order) {
    throw new OndcWebhookError({
      type: "DOMAIN-ERROR",
      code: "40001",
      message: "The update does not contain a mappable OTN document",
    });
  }
  return {
    kind: "PURCHASE_ORDER_UPDATED",
    action,
    document: mapBecknOrder(message.order, context.bap_id, context.timestamp),
  };
}

function toMinorUnits(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw new OndcWebhookError({
      type: "DOMAIN-ERROR",
      code: "40001",
      message: "A Beckn amount exceeds the supported INR minor-unit range",
    });
  }
  return minor;
}

function mapBecknOrder(
  order: z.infer<typeof BecknOrderSchema>,
  buyerParticipantId: string,
  contextTimestamp: string,
): OtnPurchaseOrder {
  const mapped = OtnPurchaseOrderSchema.safeParse({
    documentType: "PURCHASE_ORDER",
    documentId: order.id,
    documentNumber: order.id,
    revision: 0,
    buyerParticipantId,
    sellerParticipantId: order.provider.id,
    issuedAt: order.created_at ?? contextTimestamp,
    currency: "INR",
    totalMinor: toMinorUnits(order.quote.price.value),
    items: order.items.map((item) => ({
      itemId: item.id,
      description: item.descriptor?.name ?? item.id,
      quantity: item.quantity.count,
      unitPriceMinor: toMinorUnits(item.price.value),
    })),
  });
  if (!mapped.success) {
    throw new OndcWebhookError({
      type: "DOMAIN-ERROR",
      code: "40001",
      message: "Beckn order could not be mapped to the OTN purchase-order model",
    });
  }
  return mapped.data;
}
