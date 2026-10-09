import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/canonical.js";
import {
  Class3DscSignatureSchema,
  MletrDocumentSchema,
  type Class3DscSigner,
  type MletrSignedDocument,
} from "./types.js";
import type { MletrDocument } from "./types.js";

export * from "./types.js";

export function hashMletrDocument(input: unknown): {
  canonicalization: "RFC8785";
  digestAlgorithm: "SHA-256";
  documentDigest: string;
} {
  const document = MletrDocumentSchema.parse(input);
  return {
    canonicalization: "RFC8785",
    digestAlgorithm: "SHA-256",
    documentDigest: createHash("sha256").update(canonicalBytes(document)).digest("hex"),
  };
}

export async function signMletrDocument(
  input: unknown,
  signer: Class3DscSigner,
): Promise<MletrSignedDocument> {
  const document = MletrDocumentSchema.parse(input);
  const digest = hashMletrDocument(document);
  const signature = Class3DscSignatureSchema.parse(await signer.signDigest({
    digestAlgorithm: digest.digestAlgorithm,
    documentDigest: digest.documentDigest,
    documentId: document.documentId,
  }));
  return { document, ...digest, signature };
}

export function canonicalMletrBytes(document: MletrDocument): Uint8Array {
  return canonicalBytes(MletrDocumentSchema.parse(document));
}
