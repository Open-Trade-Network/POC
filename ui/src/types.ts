// Wire types mirroring DemoSnapshot from src/demo/orchestrator.ts.
// Kept local to the UI bundle (the snapshot travels as JSON over HTTP/SSE).

export type StepStatus = "pending" | "active" | "done" | "failed";
export type DemoPhase = "idle" | "running" | "complete" | "error";

export interface DemoStepView {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  flowNode: number;
  durationMs?: number;
}

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

export interface TradeDocument {
  version: 1;
  documentId: string;
  documentNumber: string;
  revision: number;
  kind: string;
  sellerParticipantId: string;
  buyerParticipantId: string;
  issuedAt: string;
  currency: string;
  totalMinor: number;
  tax: {
    cgstMinor: number;
    sgstMinor: number;
    igstMinor: number;
    cessMinor: number;
    totalMinor: number;
  };
}

export interface DemoDocumentView {
  document: TradeDocument;
  canonicalJson: string;
  sha256: string;
  signature?: string;
}

export interface SignedEnvelope {
  header: {
    version: 1;
    envelopeId: string;
    senderId: string;
    recipientId: string;
    createdAt: string;
    ciphertextHash: string;
  };
  ciphertext: string;
  signature: string;
}

export interface AccountingPosting {
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  amountMinor: number;
}

export interface SemanticAccountingTransaction {
  transactionId: string;
  sourceDocumentId: string;
  documentKind: string;
  amountMinor: number;
  taxMinor: number;
  postingSets: Array<{
    participantId: string;
    currency: string;
    postings: AccountingPosting[];
  }>;
}

export interface TripleEntryEventRecord {
  sequence: number;
  eventId: string;
  transactionId: string;
  commitment: string;
  commitmentSalt?: string;
  previousHash: string;
  sellerParticipantId: string;
  buyerParticipantId: string;
  kind: "SUBMITTED" | "ACCEPTED" | "DISPUTED";
  actorParticipantId: string;
  occurredAt: string;
  signature: string;
  eventHash: string;
}

export interface SignedAgentIntent {
  intent: {
    action: string;
    intentId: string;
    agentId: string;
    documentId: string;
    participantId: string;
    recipientId: string;
    purpose: string;
    expiresAt: string;
  };
  signature: string;
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
  phase: DemoPhase;
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
