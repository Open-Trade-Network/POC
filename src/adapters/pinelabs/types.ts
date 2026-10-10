import type { PayoutStatus } from "../../core/payouts.js";

export type ProviderPayoutStatus =
  | "ACCEPTED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "REVERSED";

export interface ProviderPayoutResult {
  providerPayoutId: string;
  status: ProviderPayoutStatus;
  providerUpdatedAt: string;
}

export interface ProviderPayoutEvent {
  providerEventId: string;
  idempotencyKey: string;
  providerPayoutId: string;
  status: ProviderPayoutStatus;
  occurredAt: string;
}

export interface ProviderPayoutRequest {
  idempotencyKey: string;
  amountMinor: number;
  currency: "INR";
  beneficiaryReference: string;
  merchantReference: string;
}

export interface PineLabsPayoutPort {
  submitPayout(request: ProviderPayoutRequest): Promise<ProviderPayoutResult>;
  getPayoutStatus(input: {
    idempotencyKey: string;
    providerPayoutId?: string;
  }): Promise<ProviderPayoutResult>;
  verifyWebhook(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    rawBody: Uint8Array;
  }): Promise<ProviderPayoutEvent>;
}

export function mapProviderPayoutStatus(status: ProviderPayoutStatus): PayoutStatus {
  switch (status) {
    case "ACCEPTED":
    case "PROCESSING":
      return "PROCESSING";
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    case "REVERSED":
      return "REVERSED";
  }
}
