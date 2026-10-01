import { describe, expect, it } from "vitest";
import { deriveAccountingEvent, deriveSemanticAccountingTransaction, SemanticAccountingTransactionSchema } from "../src/core/accounting.js";
import { canonicalJson } from "../src/core/canonical.js";
import { createEnvelope, createParticipantKeys, openEnvelope, verifyEnvelope } from "../src/core/crypto.js";
import { createLedgerProposal, createSaltedCommitment, InMemoryAppendOnlyLedger, InMemoryTripleEntryLedger, signTripleEntryEvent } from "../src/core/ledger.js";
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

describe("native triple-entry transaction model", () => {
  it("derives balanced seller and buyer posting sets from an invoice", () => {
    const transaction = deriveSemanticAccountingTransaction(sampleInvoice(), "tea:invoice-001:0");

    expect(transaction.amountMinor).toBe(11800);
    expect(transaction.taxMinor).toBe(1800);
    expect(transaction.postingSets.map((set) => set.participantId)).toEqual(["seller-test", "buyer-test"]);
    for (const postingSet of transaction.postingSets) {
      const debits = postingSet.postings
        .filter((posting) => posting.side === "DEBIT")
        .reduce((total, posting) => total + posting.amountMinor, 0);
      const credits = postingSet.postings
        .filter((posting) => posting.side === "CREDIT")
        .reduce((total, posting) => total + posting.amountMinor, 0);
      expect(debits).toBe(11800);
      expect(credits).toBe(11800);
    }

    expect(() => SemanticAccountingTransactionSchema.parse({
      ...transaction,
      postingSets: [
        transaction.postingSets[0],
        { ...transaction.postingSets[1], postings: transaction.postingSets[1].postings.slice(1) },
      ],
    })).toThrow();

    const creditNote = deriveSemanticAccountingTransaction(
      { ...sampleInvoice(), kind: "CREDIT_NOTE" },
      "tea:credit-note-001:0",
    );
    expect(creditNote.postingSets[0].postings.some((posting) => posting.accountCode === "contra_income.sales_returns"))
      .toBe(true);
  });

  it("moves a signed transaction from provisional to confirmed only on counterparty acceptance", async () => {
    const seller = await createParticipantKeys("seller-tea");
    const buyer = await createParticipantKeys("buyer-tea");
    const ledger = new InMemoryTripleEntryLedger(new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]));
    const transactionId = "tea:invoice-001:0";
    const commitment = createSaltedCommitment(deriveSemanticAccountingTransaction(sampleInvoice(), transactionId));
    const submitted = await signTripleEntryEvent({
      version: 1,
      sequence: 0,
      eventId: "tea-event-001",
      transactionId,
      commitment: commitment.digest,
      commitmentSalt: commitment.salt,
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);

    const submittedRecord = await ledger.append(submitted);
    expect(ledger.getTransactionStatus(transactionId)).toBe("PROVISIONAL");

    const accepted = await signTripleEntryEvent({
      version: 1,
      sequence: 1,
      eventId: "tea-event-002",
      transactionId,
      commitment: commitment.digest,
      previousHash: submittedRecord.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "ACCEPTED",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date().toISOString(),
    }, buyer);

    await ledger.append(accepted);
    expect(ledger.getTransactionStatus(transactionId)).toBe("CONFIRMED");
    expect(await ledger.verify()).toBe(true);
  });

  it("rejects a submitter attempting to accept its own provisional transaction", async () => {
    const seller = await createParticipantKeys("seller-tea-policy");
    const buyer = await createParticipantKeys("buyer-tea-policy");
    const ledger = new InMemoryTripleEntryLedger(new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]));
    const commitment = createSaltedCommitment({ transactionId: "tea:invoice-002:0" });
    const parties = {
      transactionId: "tea:invoice-002:0",
      commitment: commitment.digest,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    };
    const submitted = await signTripleEntryEvent({
      version: 1,
      sequence: 0,
      eventId: "tea-policy-event-001",
      ...parties,
      commitmentSalt: commitment.salt,
      previousHash: "",
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    await ledger.append(submitted);

    const selfAccepted = await signTripleEntryEvent({
      version: 1,
      sequence: 1,
      eventId: "tea-policy-event-002",
      ...parties,
      previousHash: ledger.getRecords()[0]!.eventHash,
      kind: "ACCEPTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);

    await expect(ledger.append(selfAccepted)).rejects.toThrow("Only the counterparty");
    expect(ledger.getTransactionStatus(parties.transactionId)).toBe("PROVISIONAL");
  });

  it("records a counterparty dispute without rewriting the submission", async () => {
    const seller = await createParticipantKeys("seller-tea-dispute");
    const buyer = await createParticipantKeys("buyer-tea-dispute");
    const ledger = new InMemoryTripleEntryLedger(new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]));
    const commitment = createSaltedCommitment({ transactionId: "tea:disputed:001" });
    const transaction = {
      transactionId: "tea:disputed:001",
      commitment: commitment.digest,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    };
    const submitted = await signTripleEntryEvent({
      version: 1,
      sequence: 0,
      eventId: "tea-dispute-submitted",
      ...transaction,
      commitmentSalt: commitment.salt,
      previousHash: "",
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    const originalRecord = await ledger.append(submitted);
    const disputed = await signTripleEntryEvent({
      version: 1,
      sequence: 1,
      eventId: "tea-dispute-raised",
      ...transaction,
      previousHash: originalRecord.eventHash,
      kind: "DISPUTED",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date().toISOString(),
    }, buyer);

    await ledger.append(disputed);
    expect(ledger.getTransactionStatus(transaction.transactionId)).toBe("DISPUTED");
    expect(ledger.getRecords()[0]).toMatchObject({ kind: "SUBMITTED", eventHash: originalRecord.eventHash });
    expect(await ledger.verify()).toBe(true);
  });

  it("serializes concurrent events submitted against the same chain head", async () => {
    const seller = await createParticipantKeys("seller-tea-concurrent");
    const buyer = await createParticipantKeys("buyer-tea-concurrent");
    const ledger = new InMemoryTripleEntryLedger(new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]));
    const commitment = createSaltedCommitment({ invoice: "concurrent" });
    const createSubmission = (eventId: string, transactionId: string) => signTripleEntryEvent({
      version: 1,
      sequence: 0,
      eventId,
      transactionId,
      commitment: commitment.digest,
      commitmentSalt: commitment.salt,
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    const [first, second] = await Promise.all([
      createSubmission("tea-concurrent-001", "tea:concurrent:001"),
      createSubmission("tea-concurrent-002", "tea:concurrent:002"),
    ]);

    const results = await Promise.allSettled([ledger.append(first), ledger.append(second)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(ledger.getRecords()).toHaveLength(1);
    expect(await ledger.verify()).toBe(true);
  });
});

describe("sandbox network hosting", () => {
  it("accepts public identities and signed ciphertext without exposing secrets or plaintext", async () => {
    const network = new HostedTradeNetwork({ host: "127.0.0.1", port: 0 });
    await network.start();

    try {
      const seller = await createParticipantKeys("seller-sandbox");
      const buyer = await createParticipantKeys("buyer-sandbox");
      const invoice = { ...sampleInvoice(), sellerParticipantId: seller.participantId, buyerParticipantId: buyer.participantId };

      const sellerResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: seller.participantId,
          signingPublicKey: seller.signingPublicKey,
          encryptionPublicKey: seller.encryptionPublicKey,
        }),
      });
      expect(sellerResponse.status).toBe(201);
      expect(await sellerResponse.json()).not.toHaveProperty("participant.signingPrivateKey");

      const buyerResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: buyer.participantId,
          signingPublicKey: buyer.signingPublicKey,
          encryptionPublicKey: buyer.encryptionPublicKey,
        }),
      });
      expect(buyerResponse.status).toBe(201);

      const envelope = await createEnvelope(invoice, seller, buyer.participantId, buyer.encryptionPublicKey);
      const envelopeResponse = await fetch(`http://127.0.0.1:${network.port}/documents/envelope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
      });
      expect(envelopeResponse.status).toBe(201);
      const envelopeBody = await envelopeResponse.json();
      expect(envelopeBody).toMatchObject({ envelope: { header: { recipientId: buyer.participantId } } });
      expect(envelopeBody).not.toHaveProperty("document");

      const participantsResponse = await fetch(`http://127.0.0.1:${network.port}/participants`);
      const participantsBody = await participantsResponse.json();
      expect(JSON.stringify(participantsBody)).not.toContain(seller.signingPrivateKey);
      expect(JSON.stringify(participantsBody)).not.toContain(buyer.encryptionPrivateKey);

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

  it("requires a bearer token for non-loopback binding and protected requests", async () => {
    const unprotected = new HostedTradeNetwork({ host: "0.0.0.0", port: 0 });
    await expect(unprotected.start()).rejects.toThrow("A bearer API token is required");
    const tokenWithoutTls = new HostedTradeNetwork({
      host: "0.0.0.0",
      port: 0,
      apiToken: "0123456789abcdef0123456789abcdef",
    });
    await expect(tokenWithoutTls.start()).rejects.toThrow("TLS is required");

    const network = new HostedTradeNetwork({
      host: "127.0.0.1",
      port: 0,
      apiToken: "0123456789abcdef0123456789abcdef",
    });
    await network.start();

    try {
      const healthResponse = await fetch(`http://127.0.0.1:${network.port}/health`);
      expect(healthResponse.status).toBe(200);

      const unauthorizedResponse = await fetch(`http://127.0.0.1:${network.port}/participants`);
      expect(unauthorizedResponse.status).toBe(401);

      const authorizedResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
      });
      expect(authorizedResponse.status).toBe(200);
    } finally {
      await network.stop();
    }
  });

  it("rejects private-key registration and request bodies over the configured limit", async () => {
    const network = new HostedTradeNetwork({ host: "127.0.0.1", port: 0, maxRequestBodyBytes: 1024 });
    await network.start();

    try {
      const participant = await createParticipantKeys("seller-private-key-rejected");
      const privateKeyResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(participant),
      });
      expect(privateKeyResponse.status).toBe(400);

      const oversizedResponse = await fetch(`http://127.0.0.1:${network.port}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantId: "x".repeat(2000) }),
      });
      expect(oversizedResponse.status).toBe(413);
    } finally {
      await network.stop();
    }
  });

  it("exposes provisional submission and counterparty confirmation over HTTP", async () => {
    const network = new HostedTradeNetwork({ host: "127.0.0.1", port: 0 });
    await network.start();

    try {
      const seller = await createParticipantKeys("seller-tea-http");
      const buyer = await createParticipantKeys("buyer-tea-http");
      for (const participant of [seller, buyer]) {
        const response = await fetch(`http://127.0.0.1:${network.port}/participants`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            participantId: participant.participantId,
            signingPublicKey: participant.signingPublicKey,
            encryptionPublicKey: participant.encryptionPublicKey,
          }),
        });
        expect(response.status).toBe(201);
      }

      const document = TradeDocumentSchema.parse({
        ...sampleInvoice(),
        sellerParticipantId: seller.participantId,
        buyerParticipantId: buyer.participantId,
      });
      const transactionId = `${document.documentId}:${document.revision}`;
      const accountingTransaction = deriveSemanticAccountingTransaction(document, transactionId);
      const commitment = createSaltedCommitment(accountingTransaction);
      const submitted = await signTripleEntryEvent({
        version: 1,
        sequence: 0,
        eventId: "tea-http-submitted",
        transactionId,
        commitment: commitment.digest,
        commitmentSalt: commitment.salt,
        previousHash: "",
        sellerParticipantId: seller.participantId,
        buyerParticipantId: buyer.participantId,
        kind: "SUBMITTED",
        actorParticipantId: seller.participantId,
        occurredAt: new Date().toISOString(),
      }, seller);
      const submissionResponse = await fetch(`http://127.0.0.1:${network.port}/tea/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: submitted }),
      });
      expect(submissionResponse.status).toBe(201);
      const submissionBody = await submissionResponse.json();
      const submittedRecord = submissionBody.record;

      const provisionalResponse = await fetch(
        `http://127.0.0.1:${network.port}/tea/transactions/${encodeURIComponent(transactionId)}`,
      );
      await expect(provisionalResponse.json()).resolves.toMatchObject({ status: "PROVISIONAL" });

      const accepted = await signTripleEntryEvent({
        version: 1,
        sequence: 1,
        eventId: "tea-http-accepted",
        transactionId,
        commitment: commitment.digest,
        previousHash: submittedRecord.eventHash,
        sellerParticipantId: seller.participantId,
        buyerParticipantId: buyer.participantId,
        kind: "ACCEPTED",
        actorParticipantId: buyer.participantId,
        occurredAt: new Date().toISOString(),
      }, buyer);
      const acceptanceResponse = await fetch(`http://127.0.0.1:${network.port}/tea/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: accepted }),
      });
      expect(acceptanceResponse.status).toBe(201);

      const confirmedResponse = await fetch(
        `http://127.0.0.1:${network.port}/tea/transactions/${encodeURIComponent(transactionId)}`,
      );
      await expect(confirmedResponse.json()).resolves.toMatchObject({ status: "CONFIRMED" });
      expect(network.getTripleEntryEvents()).toHaveLength(2);
    } finally {
      await network.stop();
    }
  });
});