import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { canonicalBytes, sha256Base64Url } from "./canonical.js";
import { TradeDocumentSchema, type TradeDocument } from "./schema.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as typeof import("libsodium-wrappers");

export interface ParticipantKeyMaterial {
  participantId: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

export interface EnvelopeHeader {
  version: 1;
  envelopeId: string;
  senderId: string;
  recipientId: string;
  createdAt: string;
  ciphertextHash: string;
}

export interface SignedEnvelope {
  header: EnvelopeHeader;
  ciphertext: string;
  signature: string;
}

function encodeBase64(value: Uint8Array): string {
  return sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function decodeBase64(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function createParticipantKeys(participantId: string): Promise<ParticipantKeyMaterial> {
  await sodium.ready;
  const signingKeys = sodium.crypto_sign_keypair();
  const encryptionKeys = sodium.crypto_box_keypair();
  return {
    participantId,
    signingPublicKey: encodeBase64(signingKeys.publicKey),
    signingPrivateKey: encodeBase64(signingKeys.privateKey),
    encryptionPublicKey: encodeBase64(encryptionKeys.publicKey),
    encryptionPrivateKey: encodeBase64(encryptionKeys.privateKey),
  };
}

export async function signMessage(message: Uint8Array, privateKey: string): Promise<string> {
  await sodium.ready;
  return encodeBase64(sodium.crypto_sign_detached(message, decodeBase64(privateKey)));
}

export async function verifyMessage(message: Uint8Array, signature: string, publicKey: string): Promise<boolean> {
  await sodium.ready;
  try {
    return sodium.crypto_sign_verify_detached(
      decodeBase64(signature),
      message,
      decodeBase64(publicKey),
    );
  } catch {
    return false;
  }
}

export async function createEnvelope(
  documentInput: unknown,
  sender: ParticipantKeyMaterial,
  recipientId: string,
  recipientEncryptionPublicKey: string,
  createdAt = new Date().toISOString(),
): Promise<SignedEnvelope> {
  await sodium.ready;
  const document = TradeDocumentSchema.parse(documentInput);
  if (![document.sellerParticipantId, document.buyerParticipantId].includes(sender.participantId)
    || ![document.sellerParticipantId, document.buyerParticipantId].includes(recipientId)
    || sender.participantId === recipientId) {
    throw new Error("Envelope sender and recipient must be the document's two counterparties");
  }

  const ciphertextBytes = sodium.crypto_box_seal(
    canonicalBytes(document),
    decodeBase64(recipientEncryptionPublicKey),
  );
  const ciphertext = encodeBase64(ciphertextBytes);
  const header: EnvelopeHeader = {
    version: 1,
    envelopeId: randomUUID(),
    senderId: sender.participantId,
    recipientId,
    createdAt,
    ciphertextHash: sha256Base64Url(ciphertextBytes),
  };
  const signature = await signMessage(canonicalBytes(header), sender.signingPrivateKey);
  return { header, ciphertext, signature };
}

export async function verifyEnvelope(
  envelope: SignedEnvelope,
  trustedSenderSigningPublicKey: string,
): Promise<boolean> {
  await sodium.ready;
  try {
    const ciphertextBytes = decodeBase64(envelope.ciphertext);
    if (sha256Base64Url(ciphertextBytes) !== envelope.header.ciphertextHash) {
      return false;
    }
    return verifyMessage(
      canonicalBytes(envelope.header),
      envelope.signature,
      trustedSenderSigningPublicKey,
    );
  } catch {
    return false;
  }
}

export async function openEnvelope(
  envelope: SignedEnvelope,
  recipient: ParticipantKeyMaterial,
  trustedSenderSigningPublicKey: string,
): Promise<TradeDocument> {
  await sodium.ready;
  if (envelope.header.recipientId !== recipient.participantId) {
    throw new Error("Envelope is addressed to a different participant");
  }
  if (!await verifyEnvelope(envelope, trustedSenderSigningPublicKey)) {
    throw new Error("Envelope signature or ciphertext hash is invalid");
  }

  const plaintext = sodium.crypto_box_seal_open(
    decodeBase64(envelope.ciphertext),
    decodeBase64(recipient.encryptionPublicKey),
    decodeBase64(recipient.encryptionPrivateKey),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  const document = TradeDocumentSchema.parse(parsed);
  if (![document.sellerParticipantId, document.buyerParticipantId].includes(envelope.header.senderId)) {
    throw new Error("Envelope sender is not a party to the document");
  }
  return document;
}