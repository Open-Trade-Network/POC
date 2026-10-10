import { describe, expect, it } from "vitest";
import { createParticipantKeys } from "../src/core/crypto.js";
import { createWitnessedInclusionProof, verifyWitnessedInclusionProof } from "../src/core/transparency.js";

describe("witnessed transparency proofs", () => {
  it("verifies inclusion in a signed checkpoint with an odd-sized tree", async () => {
    const witnesses = await Promise.all(["witness-a", "witness-b", "witness-c"]
      .map((participantId) => createParticipantKeys(participantId)));
    const trustedKeys = new Map(witnesses.map((witness) => [
      witness.participantId,
      witness.signingPublicKey,
    ]));
    const eventHashes = [
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    ];
    const proof = await createWitnessedInclusionProof(
      eventHashes,
      eventHashes[2]!,
      "test-transparency-log",
      witnesses,
      "2026-01-01T00:00:00.000Z",
    );

    expect(await verifyWitnessedInclusionProof(proof, trustedKeys, 2, "test-transparency-log")).toBe(true);
    expect(await verifyWitnessedInclusionProof(proof, trustedKeys, 4, "test-transparency-log")).toBe(false);
    expect(await verifyWitnessedInclusionProof(proof, trustedKeys, 2, "another-log")).toBe(false);
  });

  it("rejects altered paths, checkpoint signatures, and duplicate leaf hashes", async () => {
    const witnesses = await Promise.all(["witness-a", "witness-b"]
      .map((participantId) => createParticipantKeys(participantId)));
    const trustedKeys = new Map(witnesses.map((witness) => [
      witness.participantId,
      witness.signingPublicKey,
    ]));
    const eventHashes = [
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ];
    const proof = await createWitnessedInclusionProof(
      eventHashes,
      eventHashes[1]!,
      "test-transparency-log",
      witnesses,
    );

    expect(await verifyWitnessedInclusionProof({
      ...proof,
      inclusionPath: ["0".repeat(64)],
    }, trustedKeys, 2)).toBe(false);
    expect(await verifyWitnessedInclusionProof({
      ...proof,
      checkpoint: {
        ...proof.checkpoint,
        signatures: proof.checkpoint.signatures.map((signature, index) => (
          index === 0 ? { ...signature, signature: `${signature.signature}x` } : signature
        )),
      },
    }, trustedKeys, 2)).toBe(false);
    expect(await verifyWitnessedInclusionProof(
      proof,
      new Map([[witnesses[0]!.participantId, witnesses[0]!.signingPublicKey]]),
      2,
    )).toBe(false);
    await expect(createWitnessedInclusionProof(
      [eventHashes[0]!, eventHashes[0]!],
      eventHashes[0]!,
      "test-transparency-log",
      witnesses,
    )).rejects.toThrow("must be unique");
  });
});
