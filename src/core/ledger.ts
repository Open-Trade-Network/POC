import { randomBytes, randomUUID } from "node:crypto";
import { canonicalBytes, canonicalJson, sha256Base64Url } from "./canonical.js";
import { signMessage, verifyMessage, type ParticipantKeyMaterial } from "./crypto.js";

export interface LedgerSignature {
  participantId: string;
  signature: string;
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

export type TripleEntryEventKind = "SUBMITTED" | "ACCEPTED" | "DISPUTED";
export type TEATransactionStatus = "PROVISIONAL" | "CONFIRMED" | "DISPUTED";

export interface TripleEntryEvent {
  version: 1;
  sequence: number;
  eventId: string;
  transactionId: string;
  commitment: string;
  commitmentSalt?: string | undefined;
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
}

export type UnsignedTripleEntryEvent = Omit<TripleEntryEvent, "signature">;

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
  return {
    ...event,
    signature: await signMessage(canonicalBytes(event), signer.signingPrivateKey),
  };
}

interface TransactionLifecycle {
  commitment: string;
  sellerParticipantId: string;
  buyerParticipantId: string;
  submitterParticipantId: string;
  status: TEATransactionStatus;
}

export class InMemoryTripleEntryLedger {
  private readonly records: TripleEntryEventRecord[] = [];
  private readonly eventIds = new Set<string>();
  private readonly transactions = new Map<string, TransactionLifecycle>();
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly trustedSigningKeys: ReadonlyMap<string, string>) {}

  async append(event: TripleEntryEvent): Promise<TripleEntryEventRecord> {
    const previousAppend = this.appendQueue;
    let releaseQueue!: () => void;
    this.appendQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousAppend;
    try {
      return await this.appendInOrder(event);
    } finally {
      releaseQueue();
    }
  }

  private async appendInOrder(event: TripleEntryEvent): Promise<TripleEntryEventRecord> {
    const previous = this.records.at(-1);
    if (event.version !== 1 || !Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new Error("Triple-entry event version or sequence is invalid");
    }
    if (event.sequence !== this.records.length || event.previousHash !== (previous?.eventHash ?? "")) {
      throw new Error("Triple-entry event does not extend the current chain head");
    }
    if (!event.eventId || this.eventIds.has(event.eventId)) {
      throw new Error("Triple-entry event ID is missing or duplicated");
    }
    if (!event.transactionId || !event.commitment || !Number.isFinite(Date.parse(event.occurredAt))) {
      throw new Error("Triple-entry event transaction, commitment, or timestamp is invalid");
    }
    if (!event.sellerParticipantId || !event.buyerParticipantId
      || event.sellerParticipantId === event.buyerParticipantId) {
      throw new Error("Triple-entry event requires two distinct counterparties");
    }
    if (event.kind !== "SUBMITTED" && event.kind !== "ACCEPTED" && event.kind !== "DISPUTED") {
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
      if (lifecycle) throw new Error("Transaction has already been submitted");
      if (!event.commitmentSalt
        || !/^[A-Za-z0-9_-]{43}$/.test(event.commitmentSalt)
        || Buffer.from(event.commitmentSalt, "base64url").length !== 32
        || Buffer.from(event.commitmentSalt, "base64url").toString("base64url") !== event.commitmentSalt) {
        throw new Error("Submission requires a 32-byte commitment salt");
      }
    } else {
      if (!lifecycle || lifecycle.status !== "PROVISIONAL") {
        throw new Error("Only a provisional transaction can be accepted or disputed");
      }
      if (event.actorParticipantId === lifecycle.submitterParticipantId) {
        throw new Error("Only the counterparty can accept or dispute a submission");
      }
      if (event.commitment !== lifecycle.commitment
        || event.sellerParticipantId !== lifecycle.sellerParticipantId
        || event.buyerParticipantId !== lifecycle.buyerParticipantId) {
        throw new Error("Counterparty event does not match the submitted transaction");
      }
      if (event.commitmentSalt !== undefined) {
        throw new Error("Counterparty decision must not change the commitment salt");
      }
    }

    const eventHash = sha256Base64Url(canonicalBytes(event));
    const record = { ...structuredClone(event), eventHash };
    this.records.push(record);
    this.eventIds.add(event.eventId);

    if (event.kind === "SUBMITTED") {
      this.transactions.set(event.transactionId, {
        commitment: event.commitment,
        sellerParticipantId: event.sellerParticipantId,
        buyerParticipantId: event.buyerParticipantId,
        submitterParticipantId: event.actorParticipantId,
        status: "PROVISIONAL",
      });
    } else if (lifecycle) {
      lifecycle.status = event.kind === "ACCEPTED" ? "CONFIRMED" : "DISPUTED";
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
    const verifier = new InMemoryTripleEntryLedger(this.trustedSigningKeys);
    try {
      for (const record of this.records) {
        const { eventHash, ...event } = record;
        const verifiedRecord = await verifier.append(event);
        if (verifiedRecord.eventHash !== eventHash) return false;
      }
    } catch {
      return false;
    }
    return true;
  }
}