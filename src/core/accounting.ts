import { canonicalBytes, sha256Base64Url } from "./canonical.js";
import { z } from "zod";
import type { TradeDocument } from "./schema.js";

const postingSchema = z.object({
  accountCode: z.string().min(1).max(64),
  side: z.enum(["DEBIT", "CREDIT"]),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const AccountingPostingSetSchema = z.object({
  participantId: z.string().min(1).max(128),
  currency: z.literal("INR"),
  postings: z.array(postingSchema).min(2).max(16),
}).strict().superRefine((postingSet, context) => {
  const debits = postingSet.postings
    .filter((posting) => posting.side === "DEBIT")
    .reduce((total, posting) => total + posting.amountMinor, 0);
  const credits = postingSet.postings
    .filter((posting) => posting.side === "CREDIT")
    .reduce((total, posting) => total + posting.amountMinor, 0);
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits) || debits !== credits) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Accounting posting set must balance in minor units" });
  }
});

export const SemanticAccountingTransactionSchema = z.object({
  version: z.literal(1),
  transactionId: z.string().min(1).max(256),
  sourceDocumentId: z.string().uuid(),
  sourceRevision: z.number().int().nonnegative(),
  sourceDigest: z.string().min(1).max(128),
  documentKind: z.enum(["INVOICE", "CREDIT_NOTE"]),
  sellerParticipantId: z.string().min(1).max(128),
  buyerParticipantId: z.string().min(1).max(128),
  occurredAt: z.string().datetime({ offset: true }),
  currency: z.literal("INR"),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  taxMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  postingSets: z.tuple([AccountingPostingSetSchema, AccountingPostingSetSchema]),
}).strict().superRefine((transaction, context) => {
  if (transaction.sellerParticipantId === transaction.buyerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Transaction parties must be distinct" });
  }
  if (transaction.taxMinor > transaction.amountMinor) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Tax cannot exceed transaction amount" });
  }
  const [sellerSet, buyerSet] = transaction.postingSets;
  if (sellerSet.participantId !== transaction.sellerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "First posting set must belong to the seller" });
  }
  if (buyerSet.participantId !== transaction.buyerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Second posting set must belong to the buyer" });
  }
  for (const postingSet of transaction.postingSets) {
    const debits = postingSet.postings
      .filter((posting) => posting.side === "DEBIT")
      .reduce((total, posting) => total + posting.amountMinor, 0);
    if (debits !== transaction.amountMinor) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Each party's debit total must equal the transaction amount" });
    }
  }
});

export type SemanticAccountingTransaction = z.infer<typeof SemanticAccountingTransactionSchema>;

export interface PrivateAccountingEvent {
  eventId: string;
  documentId: string;
  documentRevision: number;
  documentDigest: string;
  documentKind: TradeDocument["kind"];
  sellerParticipantId: string;
  buyerParticipantId: string;
  debitAccount: string;
  creditAccount: string;
  amountMinor: number;
  tax: TradeDocument["tax"];
}

export function deriveAccountingEvent(document: TradeDocument, eventId: string): PrivateAccountingEvent {
  let debitAccount: string;
  let creditAccount: string;
  switch (document.kind) {
    case "INVOICE":
      debitAccount = `${document.buyerParticipantId}:purchases`;
      creditAccount = `${document.sellerParticipantId}:sales-revenue`;
      break;
    case "CREDIT_NOTE":
      debitAccount = `${document.sellerParticipantId}:sales-returns`;
      creditAccount = `${document.buyerParticipantId}:purchase-returns`;
      break;
    case "PAYMENT_ADVICE":
      debitAccount = `${document.sellerParticipantId}:bank`;
      creditAccount = `${document.buyerParticipantId}:bank`;
      break;
    case "ORDER":
    case "DISPATCH":
    case "GRN":
      debitAccount = `${document.buyerParticipantId}:commitments`;
      creditAccount = `${document.sellerParticipantId}:commitments`;
      break;
  }
  return {
    eventId,
    documentId: document.documentId,
    documentRevision: document.revision,
    documentDigest: sha256Base64Url(canonicalBytes(document)),
    documentKind: document.kind,
    sellerParticipantId: document.sellerParticipantId,
    buyerParticipantId: document.buyerParticipantId,
    debitAccount,
    creditAccount,
    amountMinor: document.totalMinor,
    tax: document.tax,
  };
}

export function deriveSemanticAccountingTransaction(
  document: TradeDocument,
  transactionId: string,
): SemanticAccountingTransaction {
  if (document.kind !== "INVOICE" && document.kind !== "CREDIT_NOTE") {
    throw new Error(`Document kind ${document.kind} is not supported for financial TEA postings`);
  }

  const netMinor = document.totalMinor - document.tax.totalMinor;
  const taxEntries = [
    ["CGST", document.tax.cgstMinor],
    ["SGST", document.tax.sgstMinor],
    ["IGST", document.tax.igstMinor],
    ["CESS", document.tax.cessMinor],
  ] as const;
  const nonzeroTaxEntries = taxEntries.filter(([, amountMinor]) => amountMinor > 0);

  const sellerPostings = document.kind === "INVOICE"
    ? [
        { accountCode: "asset.trade_receivable", side: "DEBIT" as const, amountMinor: document.totalMinor },
        ...(netMinor > 0 ? [{ accountCode: "income.trade_sales", side: "CREDIT" as const, amountMinor: netMinor }] : []),
        ...nonzeroTaxEntries.map(([taxCode, amountMinor]) => ({
          accountCode: `liability.output_${taxCode.toLowerCase()}`,
          side: "CREDIT" as const,
          amountMinor,
        })),
      ]
    : [
        ...(netMinor > 0 ? [{ accountCode: "contra_income.sales_returns", side: "DEBIT" as const, amountMinor: netMinor }] : []),
        ...nonzeroTaxEntries.map(([taxCode, amountMinor]) => ({
          accountCode: `liability.output_${taxCode.toLowerCase()}`,
          side: "DEBIT" as const,
          amountMinor,
        })),
        { accountCode: "asset.trade_receivable", side: "CREDIT" as const, amountMinor: document.totalMinor },
      ];

  const buyerPostings = document.kind === "INVOICE"
    ? [
        ...(netMinor > 0 ? [{ accountCode: "expense.trade_purchases", side: "DEBIT" as const, amountMinor: netMinor }] : []),
        ...nonzeroTaxEntries.map(([taxCode, amountMinor]) => ({
          accountCode: `asset.input_${taxCode.toLowerCase()}`,
          side: "DEBIT" as const,
          amountMinor,
        })),
        { accountCode: "liability.trade_payable", side: "CREDIT" as const, amountMinor: document.totalMinor },
      ]
    : [
        { accountCode: "liability.trade_payable", side: "DEBIT" as const, amountMinor: document.totalMinor },
        ...(netMinor > 0 ? [{ accountCode: "contra_expense.purchase_returns", side: "CREDIT" as const, amountMinor: netMinor }] : []),
        ...nonzeroTaxEntries.map(([taxCode, amountMinor]) => ({
          accountCode: `asset.input_${taxCode.toLowerCase()}`,
          side: "CREDIT" as const,
          amountMinor,
        })),
      ];

  return SemanticAccountingTransactionSchema.parse({
    version: 1,
    transactionId,
    sourceDocumentId: document.documentId,
    sourceRevision: document.revision,
    sourceDigest: sha256Base64Url(canonicalBytes(document)),
    documentKind: document.kind,
    sellerParticipantId: document.sellerParticipantId,
    buyerParticipantId: document.buyerParticipantId,
    occurredAt: document.issuedAt,
    currency: document.currency,
    amountMinor: document.totalMinor,
    taxMinor: document.tax.totalMinor,
    postingSets: [
      { participantId: document.sellerParticipantId, currency: document.currency, postings: sellerPostings },
      { participantId: document.buyerParticipantId, currency: document.currency, postings: buyerPostings },
    ],
  });
}