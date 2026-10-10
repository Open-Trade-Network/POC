import { z } from "zod";

const participantId = z.string().min(1).max(128);
const documentId = z.string().uuid();
const minorUnits = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const InstallmentSchema = z.object({
  installmentNumber: z.number().int().positive().max(100),
  dueDaysAfterDeliveryApproval: z.number().int().min(0).max(3650),
  allocation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("FIXED"), amountMinor: minorUnits }).strict(),
    z.object({ kind: z.literal("PERCENTAGE"), basisPoints: z.number().int().positive().max(10_000) }).strict(),
  ]),
}).strict();

export const PayoutReleasePolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("MANUAL") }).strict(),
  z.object({ mode: z.literal("AUTOMATIC") }).strict(),
  z.object({
    mode: z.literal("THRESHOLD"),
    thresholdMinor: minorUnits,
    belowThreshold: z.enum(["AUTO_RELEASE", "REQUIRE_APPROVAL"]),
  }).strict(),
]);

export const PaymentTermsSchema = z.object({
  currency: z.literal("INR"),
  installments: z.array(InstallmentSchema).min(1).max(100),
}).strict().superRefine((terms, context) => {
  const numbers = terms.installments.map(({ installmentNumber }) => installmentNumber);
  if (new Set(numbers).size !== numbers.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Installment numbers must be unique" });
  }

  const allocationKinds = new Set(terms.installments.map(({ allocation }) => allocation.kind));
  if (allocationKinds.size > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A payment schedule cannot mix fixed and percentage installments" });
  }

  const percentageTotal = terms.installments.reduce(
    (total, installment) => total + (installment.allocation.kind === "PERCENTAGE"
      ? installment.allocation.basisPoints
      : 0),
    0,
  );
  if (percentageTotal > 10_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Percentage installments cannot exceed the invoice total" });
  }
});

export const PaymentTermsTemplateSchema = z.object({
  templateId: z.string().min(1).max(128),
  version: z.number().int().positive(),
  ownerParticipantId: participantId,
  terms: PaymentTermsSchema,
}).strict();

export const BuyerPayoutPolicySchema = z.object({
  buyerParticipantId: participantId,
  version: z.number().int().positive(),
  releasePolicy: PayoutReleasePolicySchema,
}).strict();

export const AgreedPaymentTermsSchema = z.object({
  termsId: z.string().min(1).max(128),
  version: z.number().int().positive(),
  invoiceDocumentId: documentId,
  invoiceRevision: z.number().int().nonnegative(),
  buyerParticipantId: participantId,
  sellerParticipantId: participantId,
  template: z.object({
    templateId: z.string().min(1).max(128),
    version: z.number().int().positive(),
  }).strict().optional(),
  terms: PaymentTermsSchema,
  agreement: z.object({
    buyerEventId: z.string().min(1).max(256),
    sellerEventId: z.string().min(1).max(256),
    agreedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict().superRefine((agreement, context) => {
  if (agreement.buyerParticipantId === agreement.sellerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Payment terms require distinct buyer and seller participants" });
  }
});

export const PayoutStatusSchema = z.enum([
  "SCHEDULED",
  "AWAITING_APPROVAL",
  "READY",
  "SUBMITTED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REVERSED",
]);

const ReleaseAuthorizationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("PENDING") }).strict(),
  z.object({
    state: z.literal("AUTO_RELEASED"),
    evaluatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    state: z.literal("APPROVED"),
    approvalEventId: z.string().min(1).max(256),
    approverId: z.string().min(1).max(128),
    approvedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    state: z.literal("REJECTED"),
    decisionEventId: z.string().min(1).max(256),
    approverId: z.string().min(1).max(128),
    rejectedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);

export const PayoutIntentSchema = z.object({
  payoutId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128),
  termsId: z.string().min(1).max(128),
  termsVersion: z.number().int().positive(),
  installmentNumber: z.number().int().positive(),
  invoiceDocumentId: documentId,
  invoiceRevision: z.number().int().nonnegative(),
  invoiceApprovalEventId: z.string().min(1).max(256),
  invoiceApprovedAt: z.string().datetime({ offset: true }),
  deliveryNoteDocumentId: documentId,
  deliveryNoteRevision: z.number().int().nonnegative(),
  deliveryApprovalEventId: z.string().min(1).max(256),
  deliveryApprovedAt: z.string().datetime({ offset: true }),
  buyerParticipantId: participantId,
  sellerParticipantId: participantId,
  amountMinor: minorUnits,
  currency: z.literal("INR"),
  dueAt: z.string().datetime({ offset: true }),
  buyerPolicyVersion: z.number().int().positive(),
  releasePolicy: PayoutReleasePolicySchema,
  releaseAuthorization: ReleaseAuthorizationSchema,
  providerId: z.string().min(1).max(128),
  providerAccountReference: z.string().min(1).max(256),
  beneficiaryReference: z.string().min(1).max(256),
  providerPayoutId: z.string().min(1).max(256).optional(),
  status: PayoutStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((payout, context) => {
  if (payout.buyerParticipantId === payout.sellerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Payout buyer and seller must be distinct participants" });
  }
  if (Date.parse(payout.updatedAt) < Date.parse(payout.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Payout update time cannot precede its creation time" });
  }
  const authorization = payout.releaseAuthorization.state;
  if (payout.status === "AWAITING_APPROVAL" && authorization !== "PENDING") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Awaiting-approval payouts must have pending release authorization" });
  }
  if (
    ["READY", "SUBMITTED", "PROCESSING", "SUCCEEDED", "FAILED", "REVERSED"].includes(payout.status)
    && authorization !== "APPROVED"
    && authorization !== "AUTO_RELEASED"
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A payout cannot be released without approved or automatic authorization" });
  }
});

export type PayoutReleasePolicy = z.infer<typeof PayoutReleasePolicySchema>;
export type PaymentTerms = z.infer<typeof PaymentTermsSchema>;
export type PaymentTermsTemplate = z.infer<typeof PaymentTermsTemplateSchema>;
export type BuyerPayoutPolicy = z.infer<typeof BuyerPayoutPolicySchema>;
export type AgreedPaymentTerms = z.infer<typeof AgreedPaymentTermsSchema>;
export type PayoutStatus = z.infer<typeof PayoutStatusSchema>;
export type PayoutIntent = z.infer<typeof PayoutIntentSchema>;
export type PayoutReleaseDecision = "AUTO_RELEASE" | "REQUIRES_APPROVAL";

export function evaluatePayoutReleasePolicy(
  policy: PayoutReleasePolicy,
  amountMinor: number,
): PayoutReleaseDecision {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError("Payout amount must be a positive safe integer in INR minor units");
  }

  switch (policy.mode) {
    case "MANUAL":
      return "REQUIRES_APPROVAL";
    case "AUTOMATIC":
      return "AUTO_RELEASE";
    case "THRESHOLD":
      return amountMinor >= policy.thresholdMinor
        ? "REQUIRES_APPROVAL"
        : policy.belowThreshold === "AUTO_RELEASE" ? "AUTO_RELEASE" : "REQUIRES_APPROVAL";
  }
}
