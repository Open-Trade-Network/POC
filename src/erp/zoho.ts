import { randomUUID } from "node:crypto";
import type { ZohoBooksConfig, ZohoInvoicePayload } from "./types.js";

export class ZohoBooksClient {
  constructor(private readonly config: ZohoBooksConfig) {}

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.config.accessToken) {
      headers.Authorization = `Zoho-oauthtoken ${this.config.accessToken}`;
    }
    if (this.config.organizationId) {
      headers["X-Zoho-Organization-Id"] = this.config.organizationId;
    }
    return headers;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const timeoutMs = this.config.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          ...this.buildHeaders(),
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Zoho request failed for ${path}: ${response.status} ${text}`);
      }
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getInvoice(invoiceId: string): Promise<ZohoInvoicePayload> {
    const payload = await this.request<{ invoice?: ZohoInvoicePayload; data?: ZohoInvoicePayload; }>(`/invoices/${encodeURIComponent(invoiceId)}`);
    const invoice = (payload as { invoice?: ZohoInvoicePayload; data?: ZohoInvoicePayload; }).invoice
      ?? (payload as { invoice?: ZohoInvoicePayload; data?: ZohoInvoicePayload; }).data
      ?? (payload as unknown as ZohoInvoicePayload);
    if (!invoice || typeof invoice !== "object") {
      throw new Error(`Invoice ${invoiceId} was not found in Zoho Books`);
    }
    return invoice as ZohoInvoicePayload;
  }

  async updateInvoiceStatus(invoiceId: string, status: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/invoices/${encodeURIComponent(invoiceId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        idempotencyKey: randomUUID(),
        metadata,
      }),
    });
  }
}
