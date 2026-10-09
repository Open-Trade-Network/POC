import { z } from "zod";

export const ConsentArtifactSchema = z.object({
  consentHandle: z.string().min(1).max(256),
  signature: z.string().min(1).max(4096),
  payload: z.record(z.unknown()),
}).strict();

export type ConsentArtifact = z.infer<typeof ConsentArtifactSchema>;

export interface ConsentSignatureVerifier {
  verify(artifact: ConsentArtifact): Promise<boolean>;
}

export interface ConsentDataAuthorizer {
  authorize(input: { artifact: ConsentArtifact; invoice: RebitInvoice }): Promise<boolean>;
}

export const RebitInvoiceSchema = z.object({
  schemaVersion: z.string().min(1),
  fiType: z.literal("INVOICE"),
  documentId: z.string().uuid(),
  invoiceNumber: z.string().min(1),
  issueDate: z.string().datetime({ offset: true }),
  sellerId: z.string().min(1),
  buyerId: z.string().min(1),
  currency: z.literal("INR"),
  totalAmountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  taxAmountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type RebitInvoice = z.infer<typeof RebitInvoiceSchema>;

export interface EncryptedFiPackage {
  algorithm: "X25519-HKDF-SHA256-AES-256-GCM";
  ephemeralPublicKey: string;
  salt: string;
  nonce: string;
  authenticationTag: string;
  ciphertext: string;
}

export type FipErrorCode =
  | "INVALID_CONSENT"
  | "CONSENT_SIGNATURE_INVALID"
  | "CONSENT_SCOPE_INVALID"
  | "FI_DATA_UNAVAILABLE"
  | "ENCRYPTION_FAILED"
  | "INTERNAL_ERROR";

export type FipResult =
  | { ok: true; consentHandle: string; package: EncryptedFiPackage }
  | { ok: false; code: FipErrorCode; message: string };
