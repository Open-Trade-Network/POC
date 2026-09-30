import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { canonicalBytes, sha256Base64Url } from "./core/canonical.js";
import { createEnvelope, type ParticipantKeyMaterial, type SignedEnvelope } from "./core/crypto.js";
import { type LedgerProposal, type LedgerRecord, verifyLedgerProposal } from "./core/ledger.js";
import { TradeDocumentSchema, type TradeDocument } from "./core/schema.js";

export interface HostedTradeNetworkOptions {
  host?: string;
  port?: number;
}

export interface HostedTradeNetworkState {
  participants: ParticipantKeyMaterial[];
  ledger: LedgerRecord[];
  envelopes: SignedEnvelope[];
}

function readRequestBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    request.on("error", (error) => reject(error));
  });
}

export class HostedTradeNetwork {
  public host: string;
  public port: number;
  private server: Server | undefined;
  private readonly participants = new Map<string, ParticipantKeyMaterial>();
  private readonly trustedSigningKeys = new Map<string, string>();
  private readonly envelopes: SignedEnvelope[] = [];
  private readonly eventIds = new Set<string>();
  private ledgerRecords: LedgerRecord[] = [];

  constructor(options: HostedTradeNetworkOptions = {}) {
    this.host = options.host ?? "0.0.0.0";
    this.port = options.port ?? 3000;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  getParticipant(participantId: string): ParticipantKeyMaterial | undefined {
    return this.participants.get(participantId);
  }

  getParticipants(): ParticipantKeyMaterial[] {
    return [...this.participants.values()].map((participant) => structuredClone(participant));
  }

  getLedgerRecords(): LedgerRecord[] {
    return structuredClone(this.ledgerRecords);
  }

  getState(): HostedTradeNetworkState {
    return {
      participants: this.getParticipants(),
      ledger: this.getLedgerRecords(),
      envelopes: structuredClone(this.envelopes),
    };
  }

  registerParticipant(participant: ParticipantKeyMaterial): ParticipantKeyMaterial {
    if (!participant.participantId || !participant.signingPublicKey || !participant.encryptionPublicKey) {
      throw new Error("Participant metadata is incomplete");
    }
    if (this.participants.has(participant.participantId)) {
      throw new Error(`Participant ${participant.participantId} is already registered`);
    }
    const normalized = structuredClone(participant);
    this.participants.set(normalized.participantId, normalized);
    this.trustedSigningKeys.set(normalized.participantId, normalized.signingPublicKey);
    return structuredClone(normalized);
  }

  async createEnvelopeForDocument(
    document: TradeDocument,
    senderId: string,
    recipientId: string,
    createdAt = new Date().toISOString(),
  ): Promise<SignedEnvelope> {
    const sender = this.getParticipant(senderId);
    const recipient = this.getParticipant(recipientId);
    if (!sender || !recipient) {
      throw new Error("Sender and recipient must be registered participants");
    }
    const envelope = await createEnvelope(document, sender, recipientId, recipient.encryptionPublicKey, createdAt);
    this.envelopes.push(structuredClone(envelope));
    return structuredClone(envelope);
  }

  async submitLedgerProposal(proposal: LedgerProposal): Promise<LedgerRecord> {
    const expectedPreviousHash = this.ledgerRecords.at(-1)?.chainHash ?? "";
    if (proposal.sequence !== this.ledgerRecords.length) {
      throw new Error("Ledger proposal does not extend the current chain head");
    }
    if (proposal.previousHash !== expectedPreviousHash) {
      throw new Error("Ledger proposal previous hash does not match the current chain head");
    }
    if (this.eventIds.has(proposal.eventId)) {
      throw new Error("Duplicate ledger event ID");
    }
    if (!proposal.parties.every((party) => this.participants.has(party))) {
      throw new Error("Ledger proposal includes unregistered parties");
    }
    if (!await verifyLedgerProposal(proposal, this.trustedSigningKeys)) {
      throw new Error("Ledger proposal lacks valid signatures from both counterparties");
    }

    const record: LedgerRecord = {
      ...structuredClone(proposal),
      chainHash: sha256Base64Url(canonicalBytes(proposal)),
    };

    this.ledgerRecords.push(record);
    this.eventIds.add(record.eventId);
    return structuredClone(record);
  }

  async start(): Promise<this> {
    if (this.server) {
      return this;
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        const info = this.server!.address();
        if (info && typeof info !== "string") {
          this.port = info.port;
        }
        resolve();
      });
    });

    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server = undefined;
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end(JSON.stringify(body));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "OPTIONS") {
        this.sendJson(response, 204, null);
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        this.sendJson(response, 200, {
          ok: true,
          network: "trade-network-poc",
          host: this.host,
          port: this.port,
          participants: this.participants.size,
          ledgerLength: this.ledgerRecords.length,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/participants") {
        this.sendJson(response, 200, { participants: this.getParticipants() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/participants") {
        const body = await readRequestBody(request) as Record<string, unknown>;
        const participant = this.registerParticipant(body as unknown as ParticipantKeyMaterial);
        this.sendJson(response, 201, { participant });
        return;
      }

      if (request.method === "POST" && url.pathname === "/documents/envelope") {
        const body = await readRequestBody(request) as Record<string, unknown>;
        const document = TradeDocumentSchema.parse(body.document);
        const senderId = String(body.senderId ?? "");
        const recipientId = String(body.recipientId ?? "");
        const createdAt = typeof body.createdAt === "string" ? body.createdAt : new Date().toISOString();
        const envelope = await this.createEnvelopeForDocument(document, senderId, recipientId, createdAt);
        this.sendJson(response, 201, { document, envelope });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ledger") {
        this.sendJson(response, 200, { records: this.getLedgerRecords() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/ledger/events") {
        const body = await readRequestBody(request) as Record<string, unknown>;
        const proposal = (body.proposal ?? body) as LedgerProposal;
        const record = await this.submitLedgerProposal(proposal);
        this.sendJson(response, 201, { record });
        return;
      }

      this.sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.sendJson(response, 400, { error: message });
    }
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const network = new HostedTradeNetwork({ host, port });

  await network.start();
  console.log(`Trade network sandbox listening on ${network.url}`);

  const shutdown = async () => {
    await network.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
