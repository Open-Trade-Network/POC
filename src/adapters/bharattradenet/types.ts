import { z } from "zod";

export const MletrDocumentSchema = z.object({
  documentId: z.string().min(1).max(128),
  documentType: z.enum(["INVOICE", "DELIVERY_NOTE"]),
  issuerParticipantId: z.string().min(1).max(128),
  issuedAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
}).strict();

export type MletrDocument = z.infer<typeof MletrDocumentSchema>;

export const Class3DscSignatureSchema = z.object({
  certificateClass: z.literal("CLASS_3"),
  certificateFingerprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  signatureAlgorithm: z.string().min(1).max(64),
  signature: z.string().min(1),
  signedAt: z.string().datetime({ offset: true }),
}).strict();

export type Class3DscSignature = z.infer<typeof Class3DscSignatureSchema>;

export interface MletrSignedDocument {
  document: MletrDocument;
  canonicalization: "RFC8785";
  digestAlgorithm: "SHA-256";
  documentDigest: string;
  signature: Class3DscSignature;
}

export interface Class3DscSigner {
  signDigest(input: {
    digestAlgorithm: "SHA-256";
    documentDigest: string;
    documentId: string;
  }): Promise<Class3DscSignature>;
}
