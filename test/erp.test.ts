import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { deriveSemanticAccountingTransaction } from "../src/core/accounting.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createParticipantKeys } from "../src/core/crypto.js";
import { signTripleEntryEvent, verifySaltedCommitment } from "../src/core/ledger.js";
import { HostedTradeNetwork } from "../src/network.js";
import { mapZohoInvoiceToTradeDocument, ZohoBooksTradeAdapter } from "../src/erp/zoho-invoice-sync.js";

interface FakeZohoState {
  lastStatus: Record<string, unknown> | null;
}

describe("zoho books ERP integration", () => {
  let server: Server;
  let baseUrl: string;
  let state: FakeZohoState;
  let network: HostedTradeNetwork;

  beforeEach(async () => {
    state = { lastStatus: null };
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/invoices/INV-1001") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          invoice_id: "INV-1001",
          invoice_number: "INV-1001",
          customer_id: "cust-007",
          customer_name: "Example Buyer",
          date: "2026-09-30",
          currency_code: "INR",
          total: "118.00",
          tax_total: "18.00",
          taxes: [
            { tax_name: "CGST", tax_amount: "9.00" },
            { tax_name: "SGST", tax_amount: "9.00" },
          ],
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/invoices/INV-1001/status") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => {
          state.lastStatus = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fake Zoho server did not bind to a TCP socket");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    network = new HostedTradeNetwork({ host: "127.0.0.1", port: 0 });
    await network.start();
  });

  afterEach(async () => {
    await network.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("rejects invoice tax totals without a classifiable tax breakdown", () => {
    expect(() => mapZohoInvoiceToTradeDocument({
      invoice_id: "INV-AMBIGUOUS-TAX",
      invoice_number: "INV-AMBIGUOUS-TAX",
      currency_code: "INR",
      total: "118.00",
      tax_total: "18.00",
    }, {
      sellerParticipantId: "seller",
      buyerParticipantId: "buyer",
    })).toThrow("Zoho tax components must be classified");
  });

  it("rejects unsupported currencies and missing source dates", () => {
    const invoice = {
      invoice_id: "INV-VALIDATION",
      invoice_number: "INV-VALIDATION",
      total: "118.00",
      tax_total: "0.00",
    };
    const parties = { sellerParticipantId: "seller", buyerParticipantId: "buyer" };
    expect(() => mapZohoInvoiceToTradeDocument({
      ...invoice,
      currency_code: "USD",
      date: "2026-09-30",
    }, parties)).toThrow("Only INR");
    expect(() => mapZohoInvoiceToTradeDocument({
      ...invoice,
      currency_code: "INR",
    }, parties)).toThrow("Invoice issue date is required");
  });

  it("imports a zoho invoice, submits it through the network, and updates the ERP status", async () => {
    const seller = await createParticipantKeys("seller-zoho");
    const buyer = await createParticipantKeys("buyer-zoho");
    network.registerParticipantIdentity({
      participantId: seller.participantId,
      signingPublicKey: seller.signingPublicKey,
      encryptionPublicKey: seller.encryptionPublicKey,
    });
    network.registerParticipantIdentity({
      participantId: buyer.participantId,
      signingPublicKey: buyer.signingPublicKey,
      encryptionPublicKey: buyer.encryptionPublicKey,
    });

    const adapter = new ZohoBooksTradeAdapter({ baseUrl }, network, seller);
    const result = await adapter.syncInvoice("INV-1001", {
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    });

    expect(result.document.kind).toBe("INVOICE");
    expect(result.document.documentNumber).toBe("INV-1001");
    expect(result.document.totalMinor).toBe(11800);
    expect(result.status).toBe("PROVISIONAL");
    expect(result.teaEventRecord.kind).toBe("SUBMITTED");
    expect(network.getTripleEntryTransactionStatus(result.accountingTransaction.transactionId)).toBe("PROVISIONAL");
    expect(state.lastStatus).toMatchObject({
      status: "pending_counterparty",
      metadata: { status: "PROVISIONAL" },
    });

    const buyerTransaction = deriveSemanticAccountingTransaction(
      result.document,
      result.accountingTransaction.transactionId,
    );
    expect(result.teaEventRecord.commitmentSalt).toBeDefined();
    expect(verifySaltedCommitment(
      buyerTransaction,
      result.teaEventRecord.commitment,
      result.teaEventRecord.commitmentSalt!,
    )).toBe(true);

    const acceptedEvent = await signTripleEntryEvent({
      version: 1,
      sequence: 1,
      eventId: "buyer-accepts-zoho-invoice",
      transactionId: result.teaEventRecord.transactionId,
      commitment: result.teaEventRecord.commitment,
      previousHash: result.teaEventRecord.eventHash,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
      kind: "ACCEPTED",
      actorParticipantId: buyer.participantId,
      occurredAt: new Date().toISOString(),
    }, buyer);
    await network.submitTripleEntryEvent(acceptedEvent);
    expect(network.getTripleEntryTransactionStatus(result.accountingTransaction.transactionId)).toBe("CONFIRMED");

    expect(state.lastStatus).toMatchObject({
      status: "pending_counterparty",
      metadata: {
        transactionId: result.accountingTransaction.transactionId,
      },
    });
  });
});
