import { describe, expect, it } from "vitest";
import { bindTradeDocument, deriveAccountingEvent, deriveSemanticAccountingTransaction, SemanticAccountingTransactionSchema } from "../src/core/accounting.js";
import { canonicalBytes, canonicalJson, sha256Base64Url } from "../src/core/canonical.js";
import { createEnvelope, createParticipantKeys, openEnvelope, verifyEnvelope } from "../src/core/crypto.js";
import { createCounterpartyVerificationAttestation, createLedgerProposal, createSaltedCommitment, InMemoryAppendOnlyLedger, InMemoryTripleEntryLedger, signTripleEntryEvent } from "../src/core/ledger.js";
import { createWitnessedInclusionProof } from "../src/core/transparency.js";
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

function bindTestDocument(documentId: string) {
  return {
    documentId,
    documentRevision: 0,
    documentDigest: sha256Base64Url(canonicalBytes({ documentId })),
  };
}

function submissionExpiry(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

async function createWitnessSet() {
  const witnesses = await Promise.all(["witness-a", "witness-b", "witness-c"]
    .map((participantId) => createParticipantKeys(participantId)));
  return {
    witnesses,
    trustedKeys: new Map(witnesses.map((witness) => [witness.participantId, witness.signingPublicKey])),
  };
}

async function createTestTeaLedger(seller: Awaited<ReturnType<typeof createParticipantKeys>>, buyer: Awaited<ReturnType<typeof createParticipantKeys>>) {
  const { witnesses, trustedKeys } = await createWitnessSet();
  const ledger = new InMemoryTripleEntryLedger(
    new Map([
      [seller.participantId, seller.signingPublicKey],
      [buyer.participantId, buyer.signingPublicKey],
    ]),
    trustedKeys,
    2,
    "test-trade-log",
  );
  return { ledger, witnesses };
}

async function witnessSubmission(
  eventHash: string,
  witnesses: Awaited<ReturnType<typeof createWitnessSet>>["witnesses"],
  timestamp = new Date().toISOString(),
) {
  return createWitnessedInclusionProof([eventHash], eventHash, "test-trade-log", witnesses, timestamp);
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
    const { ledger, witnesses } = await createTestTeaLedger(seller, buyer);
    const transactionId = "tea:invoice-001:0";
    const commitment = createSaltedCommitment(deriveSemanticAccountingTransaction(sampleInvoice(), transactionId));
    const submitted = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      transactionId,
      ...bindTradeDocument(sampleInvoice()),
      commitment: commitment.digest,
      expiresAt: submissionExpiry(),
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);

    const submittedRecord = await ledger.append(submitted);
    expect(ledger.getTransactionStatus(transactionId)).toBe("PROVISIONAL");
    const witnessedSubmission = await witnessSubmission(submittedRecord.eventHash, witnesses);

    const accepted = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      transactionId,
      ...bindTradeDocument(sampleInvoice()),
      commitment: commitment.digest,
      verification: createCounterpartyVerificationAttestation(
        deriveSemanticAccountingTransaction(sampleInvoice(), transactionId),
        commitment.digest,
        commitment.salt,
        "otn-accounting-v1",
      ),
      witnessedSubmission,
      previousHash: submittedRecord.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "ACCEPTED",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date(Date.parse(witnessedSubmission.checkpoint.timestamp) + 1000).toISOString(),
    }, buyer);

    const acceptedEventHash = sha256Base64Url(canonicalBytes(accepted));
    const witnessedAcceptance = await createWitnessedInclusionProof(
      [submittedRecord.eventHash, acceptedEventHash],
      acceptedEventHash,
      "test-trade-log",
      witnesses,
      new Date(Date.parse(witnessedSubmission.checkpoint.timestamp) + 2000).toISOString(),
    );
    await expect(ledger.append(accepted)).rejects.toThrow("Acceptance requires witnessed inclusion");
    await ledger.append(accepted, witnessedAcceptance);
    expect(ledger.getTransactionStatus(transactionId)).toBe("CONFIRMED");
    await expect(ledger.append(accepted)).resolves.toMatchObject({ eventHash: acceptedEventHash });
    expect(await ledger.verify()).toBe(true);
  });

  it("rejects a counterparty withdrawal of a provisional transaction", async () => {
    const seller = await createParticipantKeys("seller-tea-withdraw-policy");
    const buyer = await createParticipantKeys("buyer-tea-withdraw-policy");
    const { ledger } = await createTestTeaLedger(seller, buyer);
    const commitment = createSaltedCommitment({ transactionId: "tea:withdraw:policy" });
    const submitted = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      transactionId: "tea:withdraw:policy",
      ...bindTestDocument("document-withdraw-policy"),
      commitment: commitment.digest,
      expiresAt: submissionExpiry(),
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    const record = await ledger.append(submitted);
    const withdrawn = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      transactionId: submitted.transactionId,
      documentId: submitted.documentId,
      documentRevision: submitted.documentRevision,
      documentDigest: submitted.documentDigest,
      commitment: submitted.commitment,
      previousHash: record.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "WITHDRAWN",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date().toISOString(),
    }, buyer);

    await expect(ledger.append(withdrawn)).rejects.toThrow("Only the submitter can withdraw");
    expect(ledger.getTransactionStatus(submitted.transactionId)).toBe("PROVISIONAL");
  });

  it("rejects a submitter attempting to accept its own provisional transaction", async () => {
    const seller = await createParticipantKeys("seller-tea-policy");
    const buyer = await createParticipantKeys("buyer-tea-policy");
    const { ledger } = await createTestTeaLedger(seller, buyer);
    const commitment = createSaltedCommitment({ transactionId: "tea:invoice-002:0" });
    const parties = {
      transactionId: "tea:invoice-002:0",
      commitment: commitment.digest,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    };
    const submitted = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      ...parties,
      ...bindTestDocument(parties.transactionId),
      expiresAt: submissionExpiry(),
      previousHash: "",
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    await ledger.append(submitted);

    const selfAccepted = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      ...parties,
      ...bindTestDocument(parties.transactionId),
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
    const { ledger } = await createTestTeaLedger(seller, buyer);
    const commitment = createSaltedCommitment({ transactionId: "tea:disputed:001" });
    const transaction = {
      transactionId: "tea:disputed:001",
      commitment: commitment.digest,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    };
    const submitted = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      ...transaction,
      ...bindTestDocument(transaction.transactionId),
      expiresAt: submissionExpiry(),
      previousHash: "",
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    const originalRecord = await ledger.append(submitted);
    const disputed = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      ...transaction,
      ...bindTestDocument(transaction.transactionId),
      previousHash: originalRecord.eventHash,
      kind: "DISPUTED",
      disputeReason: "ARITHMETIC_MISMATCH",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date().toISOString(),
    }, buyer);

    await ledger.append(disputed);
    expect(ledger.getTransactionStatus(transaction.transactionId)).toBe("DISPUTED");
    expect(ledger.getRecords()[0]).toMatchObject({ kind: "SUBMITTED", eventHash: originalRecord.eventHash });
    expect(await ledger.verify()).toBe(true);
  });

  it("rejects equivocation for the same sender, document, and revision", async () => {
    const seller = await createParticipantKeys("seller-tea-equivocation");
    const buyer = await createParticipantKeys("buyer-tea-equivocation");
    const { ledger } = await createTestTeaLedger(seller, buyer);
    const commitment = createSaltedCommitment({ revision: "first" });
    const document = bindTestDocument("document-equivocation");
    const first = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      transactionId: "tea:equivocation:first",
      ...document,
      commitment: commitment.digest,
      expiresAt: submissionExpiry(),
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    await ledger.append(first);

    const conflictingCommitment = createSaltedCommitment({ revision: "different" });
    const equivocation = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      transactionId: "tea:equivocation:second",
      ...document,
      commitment: conflictingCommitment.digest,
      expiresAt: submissionExpiry(),
      previousHash: ledger.getRecords()[0]!.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);

    await expect(ledger.append(equivocation)).rejects.toThrow("Event ID was reused for conflicting signed content");
    expect(ledger.getRecords()).toHaveLength(1);
  });

  it("records witnessed expiry and does not allow late acceptance", async () => {
    const seller = await createParticipantKeys("seller-tea-expiry");
    const buyer = await createParticipantKeys("buyer-tea-expiry");
    const { ledger, witnesses } = await createTestTeaLedger(seller, buyer);
    const submittedAt = new Date(Date.now() - 120_000).toISOString();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    const commitment = createSaltedCommitment({ transactionId: "tea:expiry:001" });
    const submitted = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      transactionId: "tea:expiry:001",
      ...bindTestDocument("document-expiry"),
      commitment: commitment.digest,
      expiresAt,
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: submittedAt,
    }, seller);
    const submittedRecord = await ledger.append(submitted);
    const witnessedSubmission = await witnessSubmission(
      submittedRecord.eventHash,
      witnesses,
      new Date().toISOString(),
    );
    const expired = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      transactionId: submitted.transactionId,
      documentId: submitted.documentId,
      documentRevision: submitted.documentRevision,
      documentDigest: submitted.documentDigest,
      commitment: submitted.commitment,
      witnessedSubmission,
      previousHash: submittedRecord.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "EXPIRED",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date(Date.parse(witnessedSubmission.checkpoint.timestamp) + 1000).toISOString(),
    }, buyer);
    await ledger.append(expired);
    expect(ledger.getTransactionStatus(submitted.transactionId)).toBe("EXPIRED");

    const lateAcceptance = await signTripleEntryEvent({
      version: 2,
      sequence: 2,
      transactionId: submitted.transactionId,
      documentId: submitted.documentId,
      documentRevision: submitted.documentRevision,
      documentDigest: submitted.documentDigest,
      commitment: submitted.commitment,
      verification: {
        derivationRulesVersion: "otn-accounting-v1",
        rederivedCommitment: submitted.commitment,
      },
      witnessedSubmission,
      previousHash: ledger.getRecords()[1]!.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "ACCEPTED",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date().toISOString(),
    }, buyer);
    await expect(ledger.append(lateAcceptance)).rejects.toThrow("Only a provisional transaction");
  });

  it("allows the submitter to withdraw before a counterparty decision", async () => {
    const seller = await createParticipantKeys("seller-tea-withdraw");
    const buyer = await createParticipantKeys("buyer-tea-withdraw");
    const { ledger } = await createTestTeaLedger(seller, buyer);
    const commitment = createSaltedCommitment({ transactionId: "tea:withdraw:001" });
    const submitted = await signTripleEntryEvent({
      version: 2,
      sequence: 0,
      transactionId: "tea:withdraw:001",
      ...bindTestDocument("document-withdraw"),
      commitment: commitment.digest,
      expiresAt: submissionExpiry(),
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    const record = await ledger.append(submitted);
    const withdrawn = await signTripleEntryEvent({
      version: 2,
      sequence: 1,
      transactionId: submitted.transactionId,
      documentId: submitted.documentId,
      documentRevision: submitted.documentRevision,
      documentDigest: submitted.documentDigest,
      commitment: submitted.commitment,
      previousHash: record.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "WITHDRAWN",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    await ledger.append(withdrawn);
    expect(ledger.getTransactionStatus(submitted.transactionId)).toBe("WITHDRAWN");
  });

  it("serializes concurrent events submitted against the same chain head", async () => {
    const seller = await createParticipantKeys("seller-tea-concurrent");
    const buyer = await createParticipantKeys("buyer-tea-concurrent");
    const { ledger } = await createTestTeaLedger(seller, buyer);
    const commitment = createSaltedCommitment({ invoice: "concurrent" });
    const createSubmission = (transactionId: string) => signTripleEntryEvent({
      version: 2,
      sequence: 0,
      transactionId,
      ...bindTestDocument(transactionId),
      commitment: commitment.digest,
      expiresAt: submissionExpiry(),
      previousHash: "",
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "SUBMITTED",
      actorParticipantId: seller.participantId,
      occurredAt: new Date().toISOString(),
    }, seller);
    const [first, second] = await Promise.all([
      createSubmission("tea:concurrent:001"),
      createSubmission("tea:concurrent:002"),
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
    const { witnesses, trustedKeys } = await createWitnessSet();
    const network = new HostedTradeNetwork({
      host: "127.0.0.1",
      port: 0,
      witnessSigningKeys: trustedKeys,
      minimumWitnessSignatures: 2,
      witnessLogId: "test-trade-log",
    });
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
        version: 2,
        sequence: 0,
        transactionId,
        ...bindTradeDocument(document),
        commitment: commitment.digest,
        expiresAt: submissionExpiry(),
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

      const witnessedSubmission = await witnessSubmission(submittedRecord.eventHash, witnesses);
      const accepted = await signTripleEntryEvent({
        version: 2,
        sequence: 1,
        transactionId,
        documentId: document.documentId,
        documentRevision: document.revision,
        documentDigest: bindTradeDocument(document).documentDigest,
        commitment: commitment.digest,
        verification: createCounterpartyVerificationAttestation(
          deriveSemanticAccountingTransaction(document, transactionId),
          commitment.digest,
          commitment.salt,
          "otn-accounting-v1",
        ),
        witnessedSubmission,
        previousHash: submittedRecord.eventHash,
        sellerParticipantId: seller.participantId,
        buyerParticipantId: buyer.participantId,
        kind: "ACCEPTED",
        actorParticipantId: buyer.participantId,
        occurredAt: new Date(Date.parse(witnessedSubmission.checkpoint.timestamp) + 1000).toISOString(),
      }, buyer);
      const acceptedEventHash = sha256Base64Url(canonicalBytes(accepted));
      const witnessedAcceptance = await createWitnessedInclusionProof(
        [submittedRecord.eventHash, acceptedEventHash],
        acceptedEventHash,
        "test-trade-log",
        witnesses,
        new Date(Date.parse(witnessedSubmission.checkpoint.timestamp) + 2000).toISOString(),
      );
      const acceptanceResponse = await fetch(`http://127.0.0.1:${network.port}/tea/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: accepted, witnessedInclusion: witnessedAcceptance }),
      });
      expect(acceptanceResponse.status).toBe(201);

      const confirmedResponse = await fetch(
        `http://127.0.0.1:${network.port}/tea/transactions/${encodeURIComponent(transactionId)}`,
      );
      await expect(confirmedResponse.json()).resolves.toMatchObject({ status: "CONFIRMED" });
      expect(network.getTripleEntryEvents()).toHaveLength(2);

      const { signature: _submissionSignature, ...unsignedSubmission } = submitted;
      const conflictingSubmission = await signTripleEntryEvent({
        ...unsignedSubmission,
        occurredAt: new Date(Date.parse(submitted.occurredAt) + 1).toISOString(),
      }, seller);
      const conflictResponse = await fetch(`http://127.0.0.1:${network.port}/tea/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: conflictingSubmission }),
      });
      expect(conflictResponse.status).toBe(409);
    } finally {
      await network.stop();
    }
  });
});