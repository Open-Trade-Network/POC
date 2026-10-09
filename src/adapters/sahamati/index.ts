import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { canonicalBytes } from "../../core/canonical.js";
import { TradeDocumentSchema, type TradeDocument } from "../../core/schema.js";
import {
  ConsentArtifactSchema,
  RebitInvoiceSchema,
  type ConsentArtifact,
  type ConsentDataAuthorizer,
  type ConsentSignatureVerifier,
  type EncryptedFiPackage,
  type FipResult,
  type RebitInvoice,
} from "./types.js";

export * from "./types.js";

export function decodeConsentArtifact(serialized: string): ConsentArtifact {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new TypeError("Consent artifact must be valid JSON");
  }
  return ConsentArtifactSchema.parse(decoded);
}

export function mapInvoiceToRebit(documentInput: unknown, schemaVersion = "1.0"): RebitInvoice {
  const document = TradeDocumentSchema.parse(documentInput);
  if (document.kind !== "INVOICE") {
    throw new TypeError("Only OTN invoices can be mapped to the ReBIT invoice information type");
  }
  return RebitInvoiceSchema.parse({
    schemaVersion,
    fiType: "INVOICE",
    documentId: document.documentId,
    invoiceNumber: document.documentNumber,
    issueDate: document.issuedAt,
    sellerId: document.sellerParticipantId,
    buyerId: document.buyerParticipantId,
    currency: document.currency,
    totalAmountMinor: document.totalMinor,
    taxAmountMinor: document.tax.totalMinor,
  });
}

export function encryptFiPackage(
  data: RebitInvoice,
  recipientPublicKeyPem: string,
): EncryptedFiPackage {
  const recipientPublicKey = createPublicKey(recipientPublicKeyPem);
  if (recipientPublicKey.asymmetricKeyType !== "x25519") {
    throw new TypeError("The recipient key must be an X25519 public key");
  }
  const ephemeral = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey });
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from("OTN-AA-FI"), 32));
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(canonicalBytes(data)), cipher.final()]);
  return {
    algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    ephemeralPublicKey: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(),
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authenticationTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptFiPackage(
  envelope: EncryptedFiPackage,
  recipientPrivateKeyPem: string,
): Uint8Array {
  const recipientPrivateKey = createPrivateKey(recipientPrivateKeyPem);
  if (recipientPrivateKey.asymmetricKeyType !== "x25519") {
    throw new TypeError("The recipient key must be an X25519 private key");
  }
  const ephemeralPublicKey = createPublicKey(envelope.ephemeralPublicKey);
  if (ephemeralPublicKey.asymmetricKeyType !== "x25519") {
    throw new TypeError("The ephemeral key must be X25519");
  }
  const sharedSecret = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralPublicKey });
  const salt = Buffer.from(envelope.salt, "base64url");
  const key = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from("OTN-AA-FI"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export async function createFipPackage(input: {
  serializedConsent: string;
  invoice: unknown;
  recipientPublicKeyPem: string;
  signatureVerifier: ConsentSignatureVerifier;
  dataAuthorizer: ConsentDataAuthorizer;
}): Promise<FipResult> {
  let artifact: ConsentArtifact;
  try {
    artifact = decodeConsentArtifact(input.serializedConsent);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_CONSENT",
      message: error instanceof Error ? error.message : "Consent artifact is invalid",
    };
  }

  try {
    if (!await input.signatureVerifier.verify(artifact)) {
      return { ok: false, code: "CONSENT_SIGNATURE_INVALID", message: "Consent signature verification failed" };
    }
  } catch (error) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Consent signature verification failed",
    };
  }
  let invoice: RebitInvoice;
  try {
    invoice = mapInvoiceToRebit(input.invoice);
  } catch (error) {
    return {
      ok: false,
      code: "FI_DATA_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Invoice data is unavailable",
    };
  }
  try {
    if (!await input.dataAuthorizer.authorize({ artifact, invoice })) {
      return {
        ok: false,
        code: "CONSENT_SCOPE_INVALID",
        message: "Consent does not authorize disclosure of this invoice",
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Consent scope authorization failed",
    };
  }
  try {
    return {
      ok: true,
      consentHandle: artifact.consentHandle,
      package: encryptFiPackage(invoice, input.recipientPublicKeyPem),
    };
  } catch (error) {
    return {
      ok: false,
      code: "ENCRYPTION_FAILED",
      message: error instanceof Error ? error.message : "FI package encryption failed",
    };
  }
}

export function canonicalRebitBytes(document: RebitInvoice): Uint8Array {
  return canonicalBytes(RebitInvoiceSchema.parse(document));
}
