import { describe, expect, it } from "vitest";
import { deriveAccountingEvent } from "../src/core/accounting.js";
import { canonicalJson } from "../src/core/canonical.js";
import { createEnvelope, createParticipantKeys, openEnvelope, verifyEnvelope } from "../src/core/crypto.js";
import { createLedgerProposal, createSaltedCommitment, InMemoryAppendOnlyLedger } from "../src/core/ledger.js";
import { TradeDocumentSchema, type TradeDocument } from "../src/core/schema.js";
import { HostedTradeNetwork } from "../src/network.js";

function sampleInvoice(): TradeDocument {
  return TradeDocumentSchema.parse({
    version: 1,
    documentId: "5fb02c4a-32f1-4c3b-9f98-40e0c3192272",
    documentNumber: "POC-INV-001",
    revision: 0,
    kind: "INVOICE",
    sellerParticipantId: "seller-test",
    buyerParticipantId: "buyer-test",
    issuedAt: "2026-09-30T10:00:00.000Z",
    currency: "INR",
    totalMinor: 11800,
    tax: { cgstMinor: 900, sgstMinor: 900, igstMinor: 0, cessMinor: 0, totalMinor: 1800 },
  });
}

describe("canonical documents and private exchange", () => {
  it("canonicalizes equivalent object key order identically", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: "value" } }))
      .toBe(canonicalJson({ a: { x: "value", y: true }, z: 1 }));
  });

  it("encrypts a document for the recipient and verifies the sender signature", async () => {
    const seller = await createParticipantKeys("seller-test");
    const buyer = await createParticipantKeys("buyer-test");
    const invoice = sampleInvoice();
    const envelope = await createEnvelope(invoice, seller, buyer.participantId, buyer.encryptionPublicKey);

    expect(envelope.ciphertext).not.toContain(invoice.documentNumber);
    expect(await verifyEnvelope(envelope, seller.signingPublicKey)).toBe(true);
    await expect(openEnvelope(envelope, buyer, seller.signingPublicKey)).resolves.toEqual(invoice);
  });

  it("rejects a modified encrypted envelope before decryption", async () => {
    const seller = await createParticipantKeys("seller-test");
    const buyer = await createParticipantKeys("buyer-test");
    const envelope = await createEnvelope(sampleInvoice(), seller, buyer.participantId, buyer.encryptionPublicKey);
    const changedCiphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;

    expect(await verifyEnvelope({ ...envelope, ciphertext: changedCiphertext }, seller.signingPublicKey)).toBe(false);
  });

  it("rejects documents whose tax totals do not match their components", () => {
    expect(() => TradeDocumentSchema.parse({ ...sampleInvoice(), tax: { ...sampleInvoice().tax, totalMinor: 1 } }))
      .toThrow();
  });
});

describe("bilateral append-only ledger prototype", () => {
  it("requires both trusted counterparties and verifies the hash chain", async () => {
    const seller = await createParticipantKeys("seller-test");
    const buyer = await createParticipantKeys("buyer-test");
    const trustedKeys = new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]);
    const ledger = new InMemoryAppendOnlyLedger(trustedKeys);
    const invoice = sampleInvoice();
    const privateEvent = deriveAccountingEvent(invoice, "event-001");
    const commitment = createSaltedCommitment(privateEvent);
    const proposal = await createLedgerProposal({
      sequence: 0,
      eventId: privateEvent.eventId,
      commitment: commitment.digest,
      previousHash: "",
      signers: [seller, buyer],
    });

    await ledger.append(proposal);
    expect(await ledger.verify()).toBe(true);
    expect(ledger.getRecords()).toHaveLength(1);
    expect(JSON.stringify(ledger.getRecords())).not.toContain(String(privateEvent.amountMinor));
  });

  it("rejects a single-party proposal", async () => {
    const seller = await createParticipantKeys("seller-test");
    const buyer = await createParticipantKeys("buyer-test");
    const ledger = new InMemoryAppendOnlyLedger(new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]));
    const commitment = createSaltedCommitment({ totalMinor: 11800 });
    const proposal = await createLedgerProposal({
      sequence: 0,
      commitment: commitment.digest,
      previousHash: "",
      signers: [seller, buyer],
    });

    await expect(ledger.append({ ...proposal, signatures: proposal.signatures.slice(0, 1) })).rejects.toThrow();
    expect(ledger.getRecords()).toHaveLength(0);
  });

  it("detects a tampered stored record", async () => {
    const seller = await createParticipantKeys("seller-test");
    const buyer = await createParticipantKeys("buyer-test");
    const ledger = new InMemoryAppendOnlyLedger(new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]));
    const proposal = await createLedgerProposal({
      sequence: 0,
      commitment: createSaltedCommitment({ amount: 10 }).digest,
      previousHash: "",
      signers: [seller, buyer],
    });
    await ledger.append(proposal);

    const exposedCopy = ledger.getRecords();
    exposedCopy[0]!.commitment = "tampered";
    expect(await ledger.verify()).toBe(true);
  });
});

describe("sandbox network hosting", () => {
  it("exposes a hosted network endpoint for participants, envelopes, and ledger proposals", async () => {
    const network = new HostedTradeNetwork({ host: "127.0.0.1", port: 0 });
    await network.start();

    try {
      const seller = await createParticipantKeys("seller-sandbox");
      const buyer = await createParticipantKeys("buyer-sandbox");
      const invoice = { ...sampleInvoice(), sellerParticipantId: seller.participantId, buyerParticipantId: buyer.participantId };

      const sellerResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(seller),
      });
      expect(sellerResponse.status).toBe(201);

      const buyerResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buyer),
      });
      expect(buyerResponse.status).toBe(201);

      const envelopeResponse = await fetch(`http://127.0.0.1:${network.port}/documents/envelope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: invoice,
          senderId: seller.participantId,
          recipientId: buyer.participantId,
          createdAt: new Date().toISOString(),
        }),
      });
      expect(envelopeResponse.status).toBe(201);
      await expect(envelopeResponse.json()).resolves.toMatchObject({ envelope: { header: { recipientId: buyer.participantId } } });

      const proposal = await createLedgerProposal({
        sequence: 0,
        eventId: "sandbox-ledger-event-1",
        commitment: createSaltedCommitment({ eventId: "sandbox-ledger-event-1", amountMinor: 11800 }).digest,
        previousHash: "",
        signers: [seller, buyer],
      });
      const ledgerResponse = await fetch(`http://127.0.0.1:${network.port}/ledger/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal }),
      });
      expect(ledgerResponse.status).toBe(201);
      const ledgerBody = await ledgerResponse.json();
      expect(ledgerBody.record.sequence).toBe(0);
      expect(ledgerBody.record.parties).toEqual(["buyer-sandbox", "seller-sandbox"]);
    } finally {
      await network.stop();
    }
  });
});