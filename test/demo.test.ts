import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoServer } from "../src/demo/server.js";

describe("one-click demo flow", () => {
  let server: DemoServer;

  beforeEach(async () => {
    server = new DemoServer({ port: 0, networkPort: 0, stepDelayMs: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("executes the complete invoice exchange end-to-end over the live sandbox", async () => {
    const snapshot = await server.runDemo();

    expect(snapshot.phase).toBe("complete");
    expect(snapshot.transactionStatus).toBe("CONFIRMED");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.steps.every((step) => step.status === "done")).toBe(true);

    // Real invoice math: 10×₹5,000 + 10×₹3,000 + 18% IGST = ₹94,400
    expect(snapshot.invoice?.subtotalMinor).toBe(8_000_000);
    expect(snapshot.invoice?.taxMinor).toBe(1_440_000);
    expect(snapshot.invoice?.totalMinor).toBe(9_440_000);
    expect(snapshot.document?.document.totalMinor).toBe(9_440_000);

    // Real cryptographic artifacts and buyer-side verification
    expect(snapshot.document?.signature).toBeTruthy();
    expect(snapshot.envelope?.ciphertext).toBeTruthy();
    expect(snapshot.envelope?.ciphertext).not.toContain("INV-2026-0001");
    expect(snapshot.buyerVerification).toEqual({
      envelopeSignatureValid: true,
      ciphertextHashMatch: true,
      documentSignatureValid: true,
      documentDigestMatch: true,
      commitmentVerified: true,
      accountingMatch: true,
    });
    expect(snapshot.chainVerified).toBe(true);

    // Hash-chained TEA lifecycle: SUBMITTED → ACCEPTED
    expect(snapshot.events.map((event) => event.kind)).toEqual(["SUBMITTED", "ACCEPTED"]);
    expect(snapshot.events[1]?.previousHash).toBe(snapshot.events[0]?.eventHash);

    // Balanced posting sets were derived for both parties
    for (const set of snapshot.accountingTransaction?.postingSets ?? []) {
      const debits = set.postings.filter((p) => p.side === "DEBIT")
        .reduce((total, p) => total + p.amountMinor, 0);
      expect(debits).toBe(9_440_000);
    }

    // Signed, policy-scoped AI gateway intents were exchanged
    expect(snapshot.intents.validationRequest?.intent.action).toBe("invoice_validation_request");
    expect(snapshot.intents.acceptance?.intent.action).toBe("invoice_acceptance");

    // ERP write-backs happened through the real ZohoBooksClient
    expect(snapshot.erpStatusUpdates.map((update) => update.status)).toEqual([
      "pending_counterparty",
      "accepted_by_counterparty",
    ]);
  });

  it("serves demo state over HTTP and resets cleanly", async () => {
    await server.runDemo();
    const stateResponse = await fetch(`${server.url}/api/demo/state`);
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json() as { phase: string; transactionStatus: string };
    expect(state.phase).toBe("complete");
    expect(state.transactionStatus).toBe("CONFIRMED");

    const resetResponse = await fetch(`${server.url}/api/demo/reset`, { method: "POST" });
    expect(resetResponse.status).toBe(200);
    const reset = await resetResponse.json() as { phase: string; events: unknown[] };
    expect(reset.phase).toBe("idle");
    expect(reset.events).toHaveLength(0);

    // The network was rebuilt: a second run must work end-to-end again
    const secondRun = await server.runDemo();
    expect(secondRun.phase).toBe("complete");
    expect(secondRun.transactionStatus).toBe("CONFIRMED");
  });
});
