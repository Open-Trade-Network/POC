import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createParticipantKeys } from "../src/core/crypto.js";
import { HostedTradeNetwork } from "../src/network.js";
import { ZohoBooksTradeAdapter } from "../src/erp/zoho-invoice-sync.js";

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
          total: 11800,
          tax_total: 1800,
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

  it("imports a zoho invoice, submits it through the network, and updates the ERP status", async () => {
    const seller = await createParticipantKeys("seller-zoho");
    const buyer = await createParticipantKeys("buyer-zoho");
    network.registerParticipant(seller);
    network.registerParticipant(buyer);

    const adapter = new ZohoBooksTradeAdapter({ baseUrl }, network);
    const result = await adapter.syncInvoice("INV-1001", {
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    });

    expect(result.document.kind).toBe("INVOICE");
    expect(result.document.documentNumber).toBe("INV-1001");
    expect(result.document.totalMinor).toBe(11800);
    expect(result.ledgerRecord.sequence).toBe(0);
    expect(result.ledgerRecord.parties).toEqual(["buyer-zoho", "seller-zoho"]);
    expect(state.lastStatus).toMatchObject({
      status: "accepted",
      metadata: {
        documentId: result.document.documentId,
      },
    });
  });
});
