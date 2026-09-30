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