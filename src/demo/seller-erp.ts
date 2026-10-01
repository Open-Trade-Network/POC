import type { IncomingMessage, ServerResponse } from "node:http";
import { DEMO_INVOICE_ID, demoZohoInvoicePayload } from "./demo-data.js";

export interface SellerErpStatusUpdate {
  at: string;
  status: string;
  metadata: Record<string, unknown>;
}

/**
 * Minimal stand-in for the seller's Zoho Books tenant. It serves the one
 * deterministic demo invoice and records status write-backs made by the real
 * ZohoBooksClient, so the demo exercises the same code path as the ERP adapter.
 */
export class SellerErpMock {
  private readonly statusUpdates: SellerErpStatusUpdate[] = [];

  get updates(): SellerErpStatusUpdate[] {
    return structuredClone(this.statusUpdates);
  }

  get currentStatus(): string | undefined {
    return this.statusUpdates.at(-1)?.status;
  }

  /** Returns true when the request was handled. */
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/erp/")) return false;

    const invoiceMatch = /^\/erp\/invoices\/([^/]+)$/.exec(url.pathname);
    const statusMatch = /^\/erp\/invoices\/([^/]+)\/status$/.exec(url.pathname);

    if (request.method === "GET" && invoiceMatch?.[1] === DEMO_INVOICE_ID) {
      this.sendJson(response, 200, { invoice: demoZohoInvoicePayload() });
      return true;
    }

    if (request.method === "POST" && statusMatch?.[1] === DEMO_INVOICE_ID) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            status?: string;
            metadata?: Record<string, unknown>;
          };
          this.statusUpdates.push({
            at: new Date().toISOString(),
            status: body.status ?? "unknown",
            metadata: body.metadata ?? {},
          });
          this.sendJson(response, 200, { ok: true });
        } catch {
          this.sendJson(response, 400, { error: "invalid status update" });
        }
      });
      return true;
    }

    this.sendJson(response, 404, { error: "not found" });
    return true;
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(body));
  }
}
