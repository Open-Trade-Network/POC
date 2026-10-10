import { randomBytes, randomUUID } from "node:crypto";
import { canonicalBytes, canonicalJson, sha256Base64Url } from "./canonical.js";
import { signMessage, verifyMessage, type ParticipantKeyMaterial } from "./crypto.js";
import {
  verifyWitnessedInclusionProof,
  type WitnessedInclusionProof,
} from "./transparency.js";
export { createWitnessedInclusionProof } from "./transparency.js";

export interface LedgerSignature {
  participantId: string;
  signature: string;
}

export class TripleEntryConflictError extends Error {}

export function createCounterpartyVerificationAttestation(
  privateEvent: unknown,
  commitment: string,
  salt: string,
  derivationRulesVersion: typeof SUPPORTED_DERIVATION_RULES_VERSIONS[number],
): CounterpartyVerificationAttestation {
  if (!verifySaltedCommitment(privateEvent, commitment, salt)) {
    throw new Error("Derived accounting data does not match the submitted commitment");
  }
  return { derivationRulesVersion, rederivedCommitment: commitment };
}

export interface LedgerProposal {
  version: 1;
  sequence: number;
  eventId: string;
  commitment: string;
  previousHash: string;
  parties: [string, string];
  signatures: LedgerSignature[];
}

export interface LedgerRecord extends LedgerProposal {
  chainHash: string;
}

export interface SaltedCommitment {
  digest: string;
  salt: string;
}

function signingPayload(proposal: Omit<LedgerProposal, "signatures">): Uint8Array {
  return canonicalBytes(proposal);
}

function recordHash(proposal: LedgerProposal): string {
  return sha256Base64Url(canonicalBytes(proposal));
}

function freezeRecord(record: LedgerRecord): LedgerRecord {
  Object.freeze(record.parties);
  Object.freeze(record.signatures);
  for (const signature of record.signatures) Object.freeze(signature);
  return Object.freeze(record);
}

export function createSaltedCommitment(privateEvent: unknown): SaltedCommitment {
  const salt = randomBytes(32);
  const digest = sha256Base64Url(Buffer.concat([salt, Buffer.from(canonicalJson(privateEvent))]));
  return {
    digest,
    salt: salt.toString("base64url"),
  };
}

export function verifySaltedCommitment(privateEvent: unknown, digest: string, salt: string): boolean {
  try {
    const saltBytes = Buffer.from(salt, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(salt)
      || saltBytes.length !== 32
      || saltBytes.toString("base64url") !== salt) return false;
    const expected = sha256Base64Url(Buffer.concat([saltBytes, Buffer.from(canonicalJson(privateEvent))]));
    return expected === digest;
  } catch {
    return false;
  }
}

export async function createLedgerProposal(
  input: {
    sequence: number;
    eventId?: string;
    commitment: string;
    previousHash: string;
    signers: [ParticipantKeyMaterial, ParticipantKeyMaterial];
  },
): Promise<LedgerProposal> {
  const parties = input.signers.map((signer) => signer.participantId).sort() as [string, string];
  if (parties[0] === parties[1]) throw new Error("Ledger event requires two distinct counterparties");
  const unsigned = {
    version: 1 as const,
    sequence: input.sequence,
    eventId: input.eventId ?? randomUUID(),
    commitment: input.commitment,
    previousHash: input.previousHash,
    parties,
  };
  const message = signingPayload(unsigned);
  const signatures = await Promise.all(input.signers.map(async (signer) => ({
    participantId: signer.participantId,
    signature: await signMessage(message, signer.signingPrivateKey),
  })));
  signatures.sort((left, right) => left.participantId.localeCompare(right.participantId));
  return { ...unsigned, signatures };
}

export async function verifyLedgerProposal(
  proposal: LedgerProposal,
  trustedSigningKeys: ReadonlyMap<string, string>,
): Promise<boolean> {
  if (proposal.version !== 1 || proposal.sequence < 0 || proposal.parties.length !== 2) return false;
  if (proposal.parties[0] >= proposal.parties[1] || proposal.signatures.length !== 2) return false;
  const unsigned = {
    version: proposal.version,
    sequence: proposal.sequence,
    eventId: proposal.eventId,
    commitment: proposal.commitment,
    previousHash: proposal.previousHash,
    parties: proposal.parties,
  };
  const message = signingPayload(unsigned);
  const signers = new Set<string>();
  for (const signature of proposal.signatures) {
    const trustedKey = trustedSigningKeys.get(signature.participantId);
    if (!trustedKey || signers.has(signature.participantId)) return false;
    if (!proposal.parties.includes(signature.participantId)) return false;
    signers.add(signature.participantId);
    if (!await verifyMessage(message, signature.signature, trustedKey)) return false;
  }
  return proposal.parties.every((party) => signers.has(party));
}

export class InMemoryAppendOnlyLedger {
  private readonly records: LedgerRecord[] = [];
  private readonly eventIds = new Set<string>();

  constructor(private readonly trustedSigningKeys: ReadonlyMap<string, string>) {}

  async append(proposal: LedgerProposal): Promise<LedgerRecord> {
    const previous = this.records.at(-1);
    const expectedSequence = this.records.length;
    const expectedPreviousHash = previous?.chainHash ?? "";
    if (proposal.sequence !== expectedSequence || proposal.previousHash !== expectedPreviousHash) {
      throw new Error("Ledger proposal does not extend the current chain head");
    }
    if (this.eventIds.has(proposal.eventId)) throw new Error("Duplicate ledger event ID");
    if (!await verifyLedgerProposal(proposal, this.trustedSigningKeys)) {
      throw new Error("Ledger proposal lacks valid signatures from both counterparties");
    }
    const record = freezeRecord({ ...structuredClone(proposal), chainHash: recordHash(proposal) });
    this.records.push(record);
    this.eventIds.add(record.eventId);
    return structuredClone(record);
  }

  getRecords(): LedgerRecord[] {
    return structuredClone(this.records);
  }

  async verify(): Promise<boolean> {
    let previousHash = "";
    const seenEventIds = new Set<string>();
    for (let sequence = 0; sequence < this.records.length; sequence += 1) {
      const record = this.records[sequence];
      if (!record || record.sequence !== sequence || record.previousHash !== previousHash) return false;
      if (seenEventIds.has(record.eventId)) return false;
      if (!await verifyLedgerProposal(record, this.trustedSigningKeys)) return false;
      const { chainHash, ...proposal } = record;
      if (recordHash(proposal) !== chainHash) return false;
      seenEventIds.add(record.eventId);
      previousHash = chainHash;
    }
    return true;
  }
}

export type TripleEntryEventKind = "SUBMITTED" | "ACCEPTED" | "DISPUTED" | "EXPIRED" | "WITHDRAWN";
export type TEATransactionStatus = "PROVISIONAL" | "CONFIRMED" | "DISPUTED" | "EXPIRED" | "WITHDRAWN";
export type TripleEntryDisputeReason =
  | "ARITHMETIC_MISMATCH"
  | "TAX_MISMATCH"
  | "DOCUMENT_MISMATCH"
  | "OTHER";

export interface CounterpartyVerificationAttestation {
  derivationRulesVersion: string;
  rederivedCommitment: string;
}
export const SUPPORTED_DERIVATION_RULES_VERSIONS = ["otn-accounting-v1"] as const;

export interface TripleEntryEvent {
  version: 2;
  sequence: number;
  eventId: string;
  transactionId: string;
  documentId: string;
  documentRevision: number;
  documentDigest: string;
  commitment: string;
  expiresAt?: string | undefined;
  supersedesEventHash?: string | undefined;
  verification?: CounterpartyVerificationAttestation | undefined;
  disputeReason?: TripleEntryDisputeReason | undefined;
  witnessedSubmission?: WitnessedInclusionProof | undefined;
  previousHash: string;
  sellerParticipantId: string;
  buyerParticipantId: string;
  kind: TripleEntryEventKind;
  actorParticipantId: string;
  occurredAt: string;
  signature: string;
}

export interface TripleEntryEventRecord extends TripleEntryEvent {
  eventHash: string;
  witnessedInclusion?: WitnessedInclusionProof;
}

export type UnsignedTripleEntryEvent = Omit<TripleEntryEvent, "eventId" | "signature"> & { eventId?: string };

export function deriveTripleEntryEventId(input: {
  actorParticipantId: string;
  documentId: string;
  documentRevision: number;
  kind: TripleEntryEventKind;
}): string {
  return sha256Base64Url(canonicalBytes({
    protocol: "otn-tea-event-id-v2",
    actorParticipantId: input.actorParticipantId,
    documentId: input.documentId,
    documentRevision: input.documentRevision,
    kind: input.kind,
  }));
}

function unsignedTripleEntryEvent(event: TripleEntryEvent): UnsignedTripleEntryEvent {
  const { signature: _signature, ...unsigned } = event;
  return unsigned;
}

export async function signTripleEntryEvent(
  event: UnsignedTripleEntryEvent,
  signer: ParticipantKeyMaterial,
): Promise<TripleEntryEvent> {
  if (event.actorParticipantId !== signer.participantId) {
    throw new Error("Event actor must match the signing participant");
  }
  const eventId = deriveTripleEntryEventId({
    actorParticipantId: event.actorParticipantId,
    documentId: event.documentId,
    documentRevision: event.documentRevision,
    kind: event.kind,
  });
  if (event.eventId !== undefined && event.eventId !== eventId) {
    throw new Error("Event ID does not match the deterministic protocol identifier");
  }
  const unsigned = { ...event, version: 2 as const, eventId };
  return {
    ...unsigned,
    signature: await signMessage(canonicalBytes(unsigned), signer.signingPrivateKey),
  };
}

interface TransactionLifecycle {
  commitment: string;
  documentId: string;
  documentRevision: number;
  documentDigest: string;
  submissionEventHash: string;
  submittedAt: string;
  expiresAt: string;
  sellerParticipantId: string;
  buyerParticipantId: string;
  submitterParticipantId: string;
  status: TEATransactionStatus;
}

export class InMemoryTripleEntryLedger {
  private readonly records: TripleEntryEventRecord[] = [];
  private readonly eventsById = new Map<string, TripleEntryEventRecord>();
  private readonly transactions = new Map<string, TransactionLifecycle>();
  private readonly revisions = new Map<string, { digest: string; eventHash: string }>();
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly trustedSigningKeys: ReadonlyMap<string, string>,
    private readonly trustedWitnessSigningKeys: ReadonlyMap<string, string> = new Map(),
    private readonly minimumWitnessSignatures = 2,
    private readonly expectedWitnessLogId?: string,
  ) {
    if (!Number.isInteger(minimumWitnessSignatures) || minimumWitnessSignatures < 2
      || (trustedWitnessSigningKeys.size > 0 && minimumWitnessSignatures > trustedWitnessSigningKeys.size)) {
      throw new Error("Minimum witness signatures must be at least two and no greater than the trusted witness set");
    }
  }

  async append(
    event: TripleEntryEvent,
    witnessedInclusion?: WitnessedInclusionProof,
  ): Promise<TripleEntryEventRecord> {
    const previousAppend = this.appendQueue;
    let releaseQueue!: () => void;
    this.appendQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousAppend;
    try {
      return await this.appendInOrder(event, witnessedInclusion);
    } finally {
      releaseQueue();
    }
  }

  private async appendInOrder(
    event: TripleEntryEvent,
    witnessedInclusion?: WitnessedInclusionProof,
  ): Promise<TripleEntryEventRecord> {
    const existing = this.eventsById.get(event.eventId);
    if (existing) {
      const {
        eventHash: _eventHash,
        witnessedInclusion: _witnessedInclusion,
        ...recordedEvent
      } = existing;
      if (canonicalJson(recordedEvent) === canonicalJson(event)) return structuredClone(existing);
      throw new TripleEntryConflictError("Event ID was reused for conflicting signed content");
    }
    const previous = this.records.at(-1);
    if (event.version !== 2 || !Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new Error("Triple-entry event version or sequence is invalid");
    }
    if (event.sequence !== this.records.length || event.previousHash !== (previous?.eventHash ?? "")) {
      throw new TripleEntryConflictError("Triple-entry event does not extend the current chain head");
    }
    if (!event.eventId
      || event.eventId !== deriveTripleEntryEventId({
        actorParticipantId: event.actorParticipantId,
        documentId: event.documentId,
        documentRevision: event.documentRevision,
        kind: event.kind,
      })) {
      throw new Error("Triple-entry event ID is invalid or not deterministic");
    }
    if (!event.transactionId || !event.documentId || !event.commitment
      || !/^[A-Za-z0-9_-]{43}$/.test(event.documentDigest)
      || Buffer.from(event.documentDigest, "base64url").length !== 32
      || Buffer.from(event.documentDigest, "base64url").toString("base64url") !== event.documentDigest
      || !Number.isInteger(event.documentRevision) || event.documentRevision < 0
      || !Number.isFinite(Date.parse(event.occurredAt))) {
      throw new Error("Triple-entry event document binding, commitment, or timestamp is invalid");
    }
    if (!event.sellerParticipantId || !event.buyerParticipantId
      || event.sellerParticipantId === event.buyerParticipantId) {
      throw new Error("Triple-entry event requires two distinct counterparties");
    }
    if (!["SUBMITTED", "ACCEPTED", "DISPUTED", "EXPIRED", "WITHDRAWN"].includes(event.kind)) {
      throw new Error("Triple-entry event kind is invalid");
    }
    if (![event.sellerParticipantId, event.buyerParticipantId].includes(event.actorParticipantId)) {
      throw new Error("Triple-entry event actor is not a counterparty");
    }

    const trustedKey = this.trustedSigningKeys.get(event.actorParticipantId);
    if (!trustedKey || !await verifyMessage(
      canonicalBytes(unsignedTripleEntryEvent(event)),
      event.signature,
      trustedKey,
    )) {
      throw new Error("Triple-entry event signature is invalid");
    }

    const lifecycle = this.transactions.get(event.transactionId);
    if (event.kind === "SUBMITTED") {
      if (lifecycle) throw new TripleEntryConflictError("Transaction has already been submitted");
      const revisionKey = `${event.sellerParticipantId}:${event.documentId}:${event.documentRevision}`;
      if (this.revisions.has(revisionKey)) {
        throw new TripleEntryConflictError("Sender has already submitted this document revision");
      }
      if (!event.expiresAt || !Number.isFinite(Date.parse(event.expiresAt))) {
        throw new Error("Submission requires a valid expiry timestamp");
      }
      const lifetime = Date.parse(event.expiresAt) - Date.parse(event.occurredAt);
      if (lifetime < 60_000 || lifetime > 30 * 24 * 60 * 60 * 1000) {
        throw new Error("Submission expiry must be between one minute and 30 days after submission");
      }
      if (event.documentRevision === 0 && event.supersedesEventHash !== undefined) {
        throw new Error("The initial document revision cannot supersede an earlier event");
      }
      if (event.documentRevision > 0) {
        const priorRevision = this.revisions.get(
          `${event.sellerParticipantId}:${event.documentId}:${event.documentRevision - 1}`,
        );
        if (!priorRevision || event.supersedesEventHash !== priorRevision.eventHash) {
          throw new Error("Revised document must reference the preceding revision event");
        }
      }
      if (event.verification || event.disputeReason || event.witnessedSubmission) {
        throw new Error("Submission cannot contain a counterparty decision or witness proof");
      }
    } else {
      if (!lifecycle || lifecycle.status !== "PROVISIONAL") {
        throw new TripleEntryConflictError("Only a provisional transaction can be accepted or disputed");
      }
      if (event.kind === "WITHDRAWN") {
        if (event.actorParticipantId !== lifecycle.submitterParticipantId) {
          throw new TripleEntryConflictError("Only the submitter can withdraw a provisional transaction");
        }
      } else if (event.actorParticipantId === lifecycle.submitterParticipantId) {
        throw new TripleEntryConflictError("Only the counterparty can accept or dispute a submission");
      }
      if (event.commitment !== lifecycle.commitment
        || event.documentId !== lifecycle.documentId
        || event.documentRevision !== lifecycle.documentRevision
        || event.documentDigest !== lifecycle.documentDigest
        || event.sellerParticipantId !== lifecycle.sellerParticipantId
        || event.buyerParticipantId !== lifecycle.buyerParticipantId) {
        throw new Error("Counterparty event does not match the submitted transaction");
      }
      if (event.kind === "ACCEPTED") {
        const witnessIds = event.witnessedSubmission?.checkpoint.signatures.map((item) => item.witnessId) ?? [];
        const acceptanceEventHash = sha256Base64Url(canonicalBytes(event));
        if (!event.verification || event.verification.rederivedCommitment !== lifecycle.commitment
          || !SUPPORTED_DERIVATION_RULES_VERSIONS.includes(
            event.verification.derivationRulesVersion as typeof SUPPORTED_DERIVATION_RULES_VERSIONS[number],
          )
          || event.disputeReason !== undefined
          || !event.witnessedSubmission
          || event.witnessedSubmission.eventHash !== lifecycle.submissionEventHash
          || witnessIds.includes(lifecycle.sellerParticipantId)
          || witnessIds.includes(lifecycle.buyerParticipantId)
          || !await verifyWitnessedInclusionProof(
            event.witnessedSubmission,
            this.trustedWitnessSigningKeys,
            this.minimumWitnessSignatures,
            this.expectedWitnessLogId,
          )
          || Date.parse(event.witnessedSubmission.checkpoint.timestamp) < Date.parse(lifecycle.submittedAt)
          || Date.parse(event.witnessedSubmission.checkpoint.timestamp) >= Date.parse(lifecycle.expiresAt)
          || !witnessedInclusion
          || witnessedInclusion.eventHash !== acceptanceEventHash
          || !await verifyWitnessedInclusionProof(
            witnessedInclusion,
            this.trustedWitnessSigningKeys,
            this.minimumWitnessSignatures,
            this.expectedWitnessLogId,
          )
          || witnessedInclusion.checkpoint.treeSize <= event.witnessedSubmission.checkpoint.treeSize
          || Date.parse(witnessedInclusion.checkpoint.timestamp) < Date.parse(event.witnessedSubmission.checkpoint.timestamp)
          || Date.parse(witnessedInclusion.checkpoint.timestamp) >= Date.parse(lifecycle.expiresAt)) {
          throw new Error("Acceptance requires witnessed inclusion of both submission and acceptance before expiry, plus a matching verification attestation");
        }
      } else if (event.kind === "DISPUTED") {
        if (!event.disputeReason || event.verification !== undefined
          || event.witnessedSubmission !== undefined) {
          throw new Error("Dispute requires a typed reason and cannot claim successful verification");
        }
      } else if (event.kind === "EXPIRED") {
        const witnessIds = event.witnessedSubmission?.checkpoint.signatures.map((item) => item.witnessId) ?? [];
        if (event.actorParticipantId !== lifecycle.buyerParticipantId
          || !event.witnessedSubmission
          || event.witnessedSubmission.eventHash !== lifecycle.submissionEventHash
          || witnessIds.includes(lifecycle.sellerParticipantId)
          || witnessIds.includes(lifecycle.buyerParticipantId)
          || !await verifyWitnessedInclusionProof(
            event.witnessedSubmission,
            this.trustedWitnessSigningKeys,
            this.minimumWitnessSignatures,
            this.expectedWitnessLogId,
          )
          || Date.parse(event.witnessedSubmission.checkpoint.timestamp) < Date.parse(lifecycle.expiresAt)
          || Date.parse(event.occurredAt) < Date.parse(event.witnessedSubmission.checkpoint.timestamp)) {
          throw new Error("Expiry requires the counterparty and a witnessed checkpoint at or after submission expiry");
        }
      } else if (event.kind === "WITHDRAWN") {
        if (event.verification || event.disputeReason || event.witnessedSubmission) {
          throw new Error("Withdrawal cannot contain another lifecycle decision's evidence");
        }
      }
      if (event.kind !== "ACCEPTED" && event.verification !== undefined) {
        throw new Error("Verification attestation is only valid on acceptance events");
      }
      if (event.kind !== "DISPUTED" && event.disputeReason !== undefined) {
        throw new Error("Dispute reason is only valid on dispute events");
      }
      if (event.expiresAt !== undefined || event.supersedesEventHash !== undefined) {
        throw new Error("Expiry and revision linkage are only valid on submission events");
      }
    }

    const eventHash = sha256Base64Url(canonicalBytes(event));
    const record = {
      ...structuredClone(event),
      eventHash,
      ...(witnessedInclusion ? { witnessedInclusion: structuredClone(witnessedInclusion) } : {}),
    };
    this.records.push(record);
    this.eventsById.set(event.eventId, record);

    if (event.kind === "SUBMITTED") {
      const lifecycleRecord: TransactionLifecycle = {
        commitment: event.commitment,
        documentId: event.documentId,
        documentRevision: event.documentRevision,
        documentDigest: event.documentDigest,
        submissionEventHash: eventHash,
        submittedAt: event.occurredAt,
        expiresAt: event.expiresAt!,
        sellerParticipantId: event.sellerParticipantId,
        buyerParticipantId: event.buyerParticipantId,
        submitterParticipantId: event.actorParticipantId,
        status: "PROVISIONAL",
      };
      this.transactions.set(event.transactionId, lifecycleRecord);
      this.revisions.set(`${event.sellerParticipantId}:${event.documentId}:${event.documentRevision}`, {
        digest: event.documentDigest,
        eventHash,
      });
    } else if (lifecycle) {
      const statuses: Record<Exclude<TripleEntryEventKind, "SUBMITTED">, TEATransactionStatus> = {
        ACCEPTED: "CONFIRMED",
        DISPUTED: "DISPUTED",
        EXPIRED: "EXPIRED",
        WITHDRAWN: "WITHDRAWN",
      };
      lifecycle.status = statuses[event.kind as Exclude<TripleEntryEventKind, "SUBMITTED">];
    }

    return structuredClone(record);
  }

  getTransactionStatus(transactionId: string): TEATransactionStatus | undefined {
    return this.transactions.get(transactionId)?.status;
  }

  getRecords(): TripleEntryEventRecord[] {
    return structuredClone(this.records);
  }

  async verify(): Promise<boolean> {
    const verifier = new InMemoryTripleEntryLedger(
      this.trustedSigningKeys,
      this.trustedWitnessSigningKeys,
      this.minimumWitnessSignatures,
      this.expectedWitnessLogId,
    );
    try {
      for (const record of this.records) {
        const { eventHash, witnessedInclusion, ...event } = record;
        const verifiedRecord = await verifier.append(event, witnessedInclusion);
        if (verifiedRecord.eventHash !== eventHash) return false;
      }
    } catch {
      return false;
    }
    return true;
  }
}