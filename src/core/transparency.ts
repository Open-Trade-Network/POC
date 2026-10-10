import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import { signMessage, verifyMessage, type ParticipantKeyMaterial } from "./crypto.js";

export interface TransparencyWitnessSignature {
  witnessId: string;
  signature: string;
}

export interface SignedTransparencyCheckpoint {
  version: 1;
  logId: string;
  treeSize: number;
  rootHash: string;
  timestamp: string;
  signatures: TransparencyWitnessSignature[];
}

export interface WitnessedInclusionProof {
  eventHash: string;
  leafIndex: number;
  inclusionPath: string[];
  checkpoint: SignedTransparencyCheckpoint;
}

type CheckpointPayload = Omit<SignedTransparencyCheckpoint, "signatures">;

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashLeaf(eventHash: string): string {
  return sha256Hex(Buffer.concat([Buffer.from([0]), Buffer.from(eventHash, "utf8")]));
}

function hashNode(left: string, right: string): string {
  return sha256Hex(Buffer.concat([
    Buffer.from([1]),
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex"),
  ]));
}

function checkpointPayload(checkpoint: CheckpointPayload): Uint8Array {
  return canonicalBytes(checkpoint);
}

function inclusionPath(leaves: string[], leafIndex: number): string[] {
  const path: string[] = [];
  let level = leaves;
  let index = leafIndex;
  while (level.length > 1) {
    const siblingIndex = index ^ 1;
    path.push(level[siblingIndex] ?? level[index]!);
    const nextLevel: string[] = [];
    for (let position = 0; position < level.length; position += 2) {
      nextLevel.push(hashNode(level[position]!, level[position + 1] ?? level[position]!));
    }
    level = nextLevel;
    index = Math.floor(index / 2);
  }
  return path;
}

export async function createWitnessedInclusionProof(
  eventHashes: readonly string[],
  targetEventHash: string,
  logId: string,
  witnesses: readonly ParticipantKeyMaterial[],
  timestamp = new Date().toISOString(),
): Promise<WitnessedInclusionProof> {
  if (eventHashes.length === 0 || !logId.trim() || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("A witnessed checkpoint requires events, a log ID, and a valid timestamp");
  }
  if (eventHashes.some((hash) => !/^[A-Za-z0-9_-]{43}$/.test(hash))
    || new Set(eventHashes).size !== eventHashes.length) {
    throw new Error("Witnessed log event hashes must be unique base64url SHA-256 digests");
  }
  if (witnesses.length < 2) {
    throw new Error("A witnessed checkpoint requires at least two independent witness signers");
  }
  const leafIndex = eventHashes.indexOf(targetEventHash);
  if (leafIndex < 0) throw new Error("Target event is not present in the witnessed log");
  if (new Set(witnesses.map((witness) => witness.participantId)).size !== witnesses.length) {
    throw new Error("Witness identities must be unique");
  }

  let level = eventHashes.map(hashLeaf);
  const rootHash = (() => {
    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let index = 0; index < level.length; index += 2) {
        nextLevel.push(hashNode(level[index]!, level[index + 1] ?? level[index]!));
      }
      level = nextLevel;
    }
    return level[0]!;
  })();
  const payload: CheckpointPayload = {
    version: 1,
    logId,
    treeSize: eventHashes.length,
    rootHash,
    timestamp,
  };
  const message = checkpointPayload(payload);
  const signatures = await Promise.all(witnesses.map(async (witness) => ({
    witnessId: witness.participantId,
    signature: await signMessage(message, witness.signingPrivateKey),
  })));
  const leaves = eventHashes.map(hashLeaf);
  return {
    eventHash: targetEventHash,
    leafIndex,
    inclusionPath: inclusionPath(leaves, leafIndex),
    checkpoint: { ...payload, signatures },
  };
}

export async function verifyWitnessedInclusionProof(
  proof: WitnessedInclusionProof,
  trustedWitnessSigningKeys: ReadonlyMap<string, string>,
  minimumWitnessSignatures: number,
  expectedLogId?: string,
): Promise<boolean> {
  try {
    const { checkpoint } = proof;
    if (!Number.isInteger(minimumWitnessSignatures) || minimumWitnessSignatures < 1
      || checkpoint.version !== 1
      || checkpoint.treeSize < 1
      || !Number.isInteger(checkpoint.treeSize)
      || !Number.isInteger(proof.leafIndex)
      || proof.leafIndex < 0
      || proof.leafIndex >= checkpoint.treeSize
      || !/^[A-Za-z0-9_-]{43}$/.test(proof.eventHash)
      || !Number.isFinite(Date.parse(checkpoint.timestamp))
      || !checkpoint.logId.trim()
      || !/^[a-f0-9]{64}$/.test(checkpoint.rootHash)
      || (expectedLogId !== undefined && checkpoint.logId !== expectedLogId)) {
      return false;
    }

    const witnessIds = new Set<string>();
    let validSignatures = 0;
    const payload: CheckpointPayload = {
      version: checkpoint.version,
      logId: checkpoint.logId,
      treeSize: checkpoint.treeSize,
      rootHash: checkpoint.rootHash,
      timestamp: checkpoint.timestamp,
    };
    const message = checkpointPayload(payload);
    for (const witnessSignature of checkpoint.signatures) {
      if (witnessIds.has(witnessSignature.witnessId)) return false;
      witnessIds.add(witnessSignature.witnessId);
      const key = trustedWitnessSigningKeys.get(witnessSignature.witnessId);
      if (!key || !await verifyMessage(message, witnessSignature.signature, key)) continue;
      validSignatures += 1;
    }
    if (validSignatures < minimumWitnessSignatures) return false;

    let currentHash = hashLeaf(proof.eventHash);
    let index = proof.leafIndex;
    let width = checkpoint.treeSize;
    let pathIndex = 0;
    while (width > 1) {
      const sibling = proof.inclusionPath[pathIndex];
      if (!sibling || !/^[a-f0-9]{64}$/.test(sibling)) return false;
      currentHash = index % 2 === 0
        ? hashNode(currentHash, sibling)
        : hashNode(sibling, currentHash);
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
      pathIndex += 1;
    }
    return pathIndex === proof.inclusionPath.length && currentHash === checkpoint.rootHash;
  } catch {
    return false;
  }
}
