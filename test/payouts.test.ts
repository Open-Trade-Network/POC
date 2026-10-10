import { describe, expect, it } from "vitest";
import {
  evaluatePayoutReleasePolicy,
  PayoutIntentSchema,
  PaymentTermsSchema,
} from "../src/core/payouts.js";
import { mapProviderPayoutStatus } from "../src/adapters/pinelabs/index.js";

describe("payout foundation", () => {
  it("validates reusable terms with fixed and percentage-based installment schedules", () => {
    const terms = {
      currency: "INR",
      installments: [
        { installmentNumber: 1, dueDaysAfterDeliveryApproval: 0, allocation: { kind: "PERCENTAGE", basisPoints: 2500 } },
        { installmentNumber: 2, dueDaysAfterDeliveryApproval: 30, allocation: { kind: "PERCENTAGE", basisPoints: 7500 } },
      ],
    };

    expect(PaymentTermsSchema.parse(terms)).toEqual(terms);
    expect(() => PaymentTermsSchema.parse({
      ...terms,
      installments: [...terms.installments, {
        installmentNumber: 3,
        dueDaysAfterDeliveryApproval: 45,
        allocation: { kind: "PERCENTAGE", basisPoints: 1 },
      }],
    })).toThrow();
  });

  it("applies the buyer-configured below-threshold behavior", () => {
    const thresholdPolicy = {
      mode: "THRESHOLD" as const,
      thresholdMinor: 5_000_000,
      belowThreshold: "AUTO_RELEASE" as const,
    };
    expect(evaluatePayoutReleasePolicy(thresholdPolicy, 4_999_999)).toBe("AUTO_RELEASE");
    expect(evaluatePayoutReleasePolicy(thresholdPolicy, 5_000_000)).toBe("REQUIRES_APPROVAL");
    expect(evaluatePayoutReleasePolicy({
      ...thresholdPolicy,
      belowThreshold: "REQUIRE_APPROVAL",
    }, 1)).toBe("REQUIRES_APPROVAL");
  });

  it("maps provider outcomes without treating submission acceptance as payment success", () => {
    expect(mapProviderPayoutStatus("ACCEPTED")).toBe("PROCESSING");
    expect(mapProviderPayoutStatus("SUCCEEDED")).toBe("SUCCEEDED");
    expect(mapProviderPayoutStatus("REVERSED")).toBe("REVERSED");
  });

  it("requires recorded buyer authorization before a payout can be released", () => {
    const payout = {
      payoutId: "8a2ecf95-8f00-4a66-8ef7-50192aa6fbd6",
      idempotencyKey: "otn-payout-installment-1",
      termsId: "terms-1",
      termsVersion: 1,
      installmentNumber: 1,
      invoiceDocumentId: "5fb02c4a-32f1-4c3b-9f98-40e0c3192272",
      invoiceRevision: 0,
      invoiceApprovalEventId: "invoice-approved-1",
      invoiceApprovedAt: "2026-10-09T11:00:00.000Z",
      deliveryNoteDocumentId: "8a2ecf95-8f00-4a66-8ef7-50192aa6fbd7",
      deliveryNoteRevision: 0,
      deliveryApprovalEventId: "delivery-approved-1",
      deliveryApprovedAt: "2026-10-09T12:00:00.000Z",
      buyerParticipantId: "buyer.example",
      sellerParticipantId: "seller.example",
      amountMinor: 10_000,
      currency: "INR",
      dueAt: "2026-10-09T12:00:00.000Z",
      buyerPolicyVersion: 1,
      releasePolicy: { mode: "MANUAL" },
      releaseAuthorization: { state: "PENDING" },
      providerId: "PINE_LABS",
      providerAccountReference: "buyer-merchant-ref",
      beneficiaryReference: "vendor-beneficiary-ref",
      status: "AWAITING_APPROVAL",
      createdAt: "2026-10-09T12:00:00.000Z",
      updatedAt: "2026-10-09T12:00:00.000Z",
    };

    expect(PayoutIntentSchema.parse(payout)).toEqual(payout);
    expect(() => PayoutIntentSchema.parse({ ...payout, status: "SUBMITTED" })).toThrow();
    expect(PayoutIntentSchema.parse({
      ...payout,
      status: "READY",
      releaseAuthorization: {
        state: "APPROVED",
        approvalEventId: "release-approved-1",
        approverId: "buyer-finance-user-1",
        approvedAt: "2026-10-09T12:01:00.000Z",
      },
      updatedAt: "2026-10-09T12:01:00.000Z",
    }).status).toBe("READY");
  });
});
