import { z } from "zod";

const participantId = z.string().min(1).max(128);
const minorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const TradeDocumentSchema = z.object({
  version: z.literal(1),
  documentId: z.string().uuid(),
  documentNumber: z.string().min(1).max(64),
  revision: z.number().int().min(0),
  kind: z.enum(["INVOICE", "CREDIT_NOTE", "ORDER", "DISPATCH", "GRN", "PAYMENT_ADVICE"]),
  sellerParticipantId: participantId,
  buyerParticipantId: participantId,
  issuedAt: z.string().datetime({ offset: true }),
  currency: z.literal("INR"),
  totalMinor: minorUnits,
  tax: z.object({
    cgstMinor: minorUnits,
    sgstMinor: minorUnits,
    igstMinor: minorUnits,
    cessMinor: minorUnits,
    totalMinor: minorUnits,
  }).strict().superRefine((tax, context) => {
    const componentTotal = tax.cgstMinor + tax.sgstMinor + tax.igstMinor + tax.cessMinor;
    if (componentTotal !== tax.totalMinor) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Tax total must equal its components" });
    }
  }),
}).strict().superRefine((document, context) => {
  if (document.sellerParticipantId === document.buyerParticipantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Seller and buyer must be different participants" });
  }
  if (document.tax.totalMinor > document.totalMinor) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Tax total cannot exceed document total" });
  }
});

export type TradeDocument = z.infer<typeof TradeDocumentSchema>;