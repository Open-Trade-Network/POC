import { canonicalBytes, sha256Base64Url } from "./canonical.js";
import type { TradeDocument } from "./schema.js";

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