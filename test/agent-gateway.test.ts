import { describe, expect, it } from "vitest";
import { CompanyAgentGateway, type AgentIntentRequest } from "../src/agents/index.js";
import { createParticipantKeys } from "../src/core/crypto.js";

describe("sovereign company agent gateways", () => {
  it("accepts signed cross-company intents within policy scope and rejects out-of-scope actions", async () => {
    const companyA = await createParticipantKeys("company-a");
    const companyB = await createParticipantKeys("company-b");

    const gatewayA = new CompanyAgentGateway({
      companyId: "company-a",
      participantId: companyA.participantId,
      keyMaterial: companyA,
      policy: {
        allowActions: ["invoice_validation_request", "invoice_acceptance"],
        allowDocumentIds: ["doc-123"],
        allowRecipients: [companyB.participantId],
      },
    });

    const gatewayB = new CompanyAgentGateway({
      companyId: "company-b",
      participantId: companyB.participantId,
      keyMaterial: companyB,
      policy: {
        allowActions: ["invoice_validation_request", "invoice_acceptance"],
        allowDocumentIds: ["doc-123"],
        allowRecipients: [companyB.participantId],
      },
    });

    const signedIntent = await gatewayA.sendIntent(gatewayB, {
      action: "invoice_validation_request",
      intentId: "intent-001",
      agentId: "agent-a-01",
      documentId: "doc-123",
      recipientId: companyB.participantId,
      purpose: "tax verification",
      payload: { field: "tax_total", value: 1800 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } satisfies AgentIntentRequest);

    expect(await gatewayB.verifyIntent(signedIntent, gatewayA.publicSigningKey())).toBe(true);
    expect(await gatewayB.authorizeIntent(signedIntent)).toBe(true);

    const denied = await gatewayA.sendIntent(gatewayB, {
      action: "invoice_acceptance",
      intentId: "intent-002",
      agentId: "agent-a-02",
      documentId: "doc-999",
      recipientId: companyB.participantId,
      purpose: "override settlement",
      payload: { value: true },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } satisfies AgentIntentRequest);

    expect(await gatewayB.verifyIntent(denied, gatewayA.publicSigningKey())).toBe(true);
    expect(await gatewayB.authorizeIntent(denied)).toBe(false);
  });
});
