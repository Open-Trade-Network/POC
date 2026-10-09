import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOndcWebhookController,
  hashMletrDocument,
  parseBecknEnvelope,
  signMletrDocument,
} from "../src/adapters/index.js";
import {
  createFipPackage,
  decryptFiPackage,
  mapInvoiceToRebit,
} from "../src/adapters/sahamati/index.js";
import { HostedTradeNetwork } from "../src/network.js";
import { TradeDocumentSchema } from "../src/core/schema.js";

const context = {
  action: "confirm",
  bap_id: "buyer.example",
  bpp_id: "network.example",
  timestamp: "2026-10-09T12:00:00.000Z",
  domain: "ONDC:RET10",
  country: "IND",
  city: "std:080",
  core_version: "1.2.0",
  transaction_id: "txn-1",
  message_id: "msg-1",
};

function confirmPayload() {
  return {
    context,
    message: {
      order: {
        id: "order-1",
        provider: { id: "seller.example" },
        items: [{
          id: "item-1",
          descriptor: { name: "Tea" },
          quantity: { count: "2" },
          price: { currency: "INR", value: "10.50" },
        }],
        quote: { price: { currency: "INR", value: "21.00" } },
        created_at: "2026-10-09T11:00:00.000Z",
      },
    },
  };
}

function sampleInvoice() {
  return TradeDocumentSchema.parse({
    version: 1,
    documentId: "5fb02c4a-32f1-4c3b-9f98-40e0c3192272",
    documentNumber: "OTN-INV-100",
    revision: 0,
    kind: "INVOICE",
    sellerParticipantId: "seller.example",
    buyerParticipantId: "buyer.example",
    issuedAt: "2026-10-09T11:00:00.000Z",
    currency: "INR",
    totalMinor: 2100,
    tax: { cgstMinor: 0, sgstMinor: 0, igstMinor: 0, cessMinor: 0, totalMinor: 0 },
  });
}

describe("ONDC webhook adapter", () => {
  it("returns ACK before asynchronous processing finishes", async () => {
    let releaseProcessing: (() => void) | undefined;
    let receivedEvent: unknown;
    const processing = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    const controller = createOndcWebhookController({
      processEvent: async (event) => {
        receivedEvent = event;
        await processing;
      },
      onProcessingError: () => undefined,
    });

    const ack = controller.receive("confirm", confirmPayload());
    expect(ack).toEqual({ message: { ack: { status: "ACK" } } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receivedEvent).toMatchObject({
      kind: "PURCHASE_ORDER_CONFIRMED",
      document: {
        documentId: "order-1",
        buyerParticipantId: "buyer.example",
        sellerParticipantId: "seller.example",
        totalMinor: 2100,
        items: [{ itemId: "item-1", unitPriceMinor: 1050 }],
      },
    });
    releaseProcessing?.();
  });

  it("wires the receiver into the existing HTTP server and ACKs without waiting for downstream work", async () => {
    let processed = false;
    const network = new HostedTradeNetwork({
      host: "127.0.0.1",
      port: 0,
      ondcWebhook: createOndcWebhookController({
        processEvent: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          processed = true;
        },
        onProcessingError: () => undefined,
      }),
    });
    await network.start();
    try {
      const response = await fetch(`http://127.0.0.1:${network.port}/ondc/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirmPayload()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: { ack: { status: "ACK" } } });
      expect(processed).toBe(false);
    } finally {
      await network.stop();
    }
  });

  it("rejects malformed envelopes synchronously", () => {
    const controller = createOndcWebhookController({
      processEvent: async () => undefined,
      onProcessingError: () => undefined,
    });
    expect(() => controller.receive("confirm", { context, message: {} })).toThrow();
  });

  it("maps an ONDC update invoice to the existing OTN invoice model", () => {
    const invoice = sampleInvoice();
    const event = parseBecknEnvelope("update", {
      context: { ...context, action: "update" },
      message: { invoice },
    });
    expect(event).toEqual({ kind: "INVOICE_UPDATED", action: "update", document: invoice });
  });
});

describe("BharatTradeNet structural utilities", () => {
  const document = {
    documentId: "delivery-1",
    documentType: "DELIVERY_NOTE",
    issuerParticipantId: "seller.example",
    issuedAt: "2026-10-09T11:00:00.000Z",
    payload: { z: 1, a: "value" },
  };

  it("canonicalizes and hashes MLETR document payloads", () => {
    const first = hashMletrDocument(document);
    const reordered = hashMletrDocument({ ...document, payload: { a: "value", z: 1 } });
    expect(first).toEqual(reordered);
    expect(first.documentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps a validated Class-3 signer result onto the document digest", async () => {
    const signed = await signMletrDocument(document, {
      signDigest: async ({ documentDigest }) => ({
        certificateClass: "CLASS_3",
        certificateFingerprintSha256: "a".repeat(64),
        signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA256",
        signature: `signature-for-${documentDigest}`,
        signedAt: "2026-10-09T12:00:00.000Z",
      }),
    });
    expect(signed.documentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.signature.certificateClass).toBe("CLASS_3");
  });
});

describe("Sahamati FIP scaffolding", () => {
  it("maps invoice metadata and encrypts it with ephemeral X25519 ECDH", async () => {
    const keyPair = generateKeyPairSync("x25519");
    const invoice = sampleInvoice();
    const mapped = mapInvoiceToRebit(invoice);
    const result = await createFipPackage({
      serializedConsent: JSON.stringify({
        consentHandle: "consent-1",
        signature: "signed-consent",
        payload: { version: "dynamic", requestedFiTypes: ["INVOICE"] },
      }),
      invoice,
      recipientPublicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      signatureVerifier: { verify: async () => true },
      dataAuthorizer: { authorize: async () => true },
    });
    expect(mapped.totalAmountMinor).toBe(2100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plaintext = decryptFiPackage(
      result.package,
      keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(mapped);
  });

  it("returns a network error code for failed consent signature verification", async () => {
    const keyPair = generateKeyPairSync("x25519");
    const result = await createFipPackage({
      serializedConsent: JSON.stringify({
        consentHandle: "consent-1",
        signature: "invalid",
        payload: {},
      }),
      invoice: sampleInvoice(),
      recipientPublicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      signatureVerifier: { verify: async () => false },
      dataAuthorizer: { authorize: async () => true },
    });
    expect(result).toEqual({
      ok: false,
      code: "CONSENT_SIGNATURE_INVALID",
      message: "Consent signature verification failed",
    });
  });

  it("does not disclose invoice data when consent scope authorization denies access", async () => {
    const keyPair = generateKeyPairSync("x25519");
    const result = await createFipPackage({
      serializedConsent: JSON.stringify({
        consentHandle: "consent-1",
        signature: "signed-consent",
        payload: {},
      }),
      invoice: sampleInvoice(),
      recipientPublicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      signatureVerifier: { verify: async () => true },
      dataAuthorizer: { authorize: async () => false },
    });
    expect(result).toMatchObject({ ok: false, code: "CONSENT_SCOPE_INVALID" });
  });
});
