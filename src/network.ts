import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalBytes, sha256Base64Url } from "./core/canonical.js";
import { createEnvelope, type ParticipantKeyMaterial, type SignedEnvelope, verifyEnvelope } from "./core/crypto.js";
import {
  InMemoryTripleEntryLedger,
  type LedgerProposal,
  type LedgerRecord,
  type TripleEntryEvent,
  type TripleEntryEventRecord,
  verifyLedgerProposal,
} from "./core/ledger.js";
import { TradeDocumentSchema, type TradeDocument } from "./core/schema.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const PublicParticipantSchema = z.object({
  participantId: z.string().min(1).max(128),
  signingPublicKey: z.string().min(1).max(256),
  encryptionPublicKey: z.string().min(1).max(256),
}).strict();

const SignedEnvelopeSchema = z.object({
  header: z.object({
    version: z.literal(1),
    envelopeId: z.string().uuid(),
    senderId: z.string().min(1).max(128),
    recipientId: z.string().min(1).max(128),
    createdAt: z.string().datetime({ offset: true }),
    ciphertextHash: z.string().min(1).max(128),
  }).strict(),
  ciphertext: z.string().min(1).max(DEFAULT_MAX_REQUEST_BODY_BYTES * 2),
  signature: z.string().min(1).max(256),
}).strict();

const LedgerProposalSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  eventId: z.string().min(1).max(256),
  commitment: z.string().min(1).max(256),
  previousHash: z.string().max(256),
  parties: z.tuple([z.string().min(1).max(128), z.string().min(1).max(128)]),
  signatures: z.array(z.object({
    participantId: z.string().min(1).max(128),
    signature: z.string().min(1).max(256),
  }).strict()).length(2),
}).strict();

const TripleEntryEventSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  eventId: z.string().min(1).max(256),
  transactionId: z.string().min(1).max(256),
  commitment: z.string().min(1).max(256),
  commitmentSalt: z.string().min(1).max(256).optional(),
  previousHash: z.string().max(256),
  sellerParticipantId: z.string().min(1).max(128),
  buyerParticipantId: z.string().min(1).max(128),
  kind: z.enum(["SUBMITTED", "ACCEPTED", "DISPUTED"]),
  actorParticipantId: z.string().min(1).max(128),
  occurredAt: z.string().datetime({ offset: true }),
  signature: z.string().min(1).max(256),
}).strict();

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

export interface HostedTradeNetworkOptions {
  host?: string;
  port?: number;
  apiToken?: string;
  allowedOrigins?: string[];
  maxRequestBodyBytes?: number;
  tls?: {
    key: Buffer | string;
    cert: Buffer | string;
  };
}

export interface PublicParticipantIdentity {
  participantId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

export interface HostedTradeNetworkState {
  participants: PublicParticipantIdentity[];
  ledger: LedgerRecord[];
  teaEvents: TripleEntryEventRecord[];
  envelopes: SignedEnvelope[];
}

function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "Request body is too large");
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, "Request body is too large"));
        return;
      }
      if (!settled) chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON"));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

export class HostedTradeNetwork {
  public host: string;
  public port: number;
  private server: Server | undefined;
  private readonly participants = new Map<string, ParticipantKeyMaterial>();
  private readonly trustedSigningKeys = new Map<string, string>();
  private readonly envelopes: SignedEnvelope[] = [];
  private readonly envelopeIds = new Set<string>();
  private readonly eventIds = new Set<string>();
  private ledgerRecords: LedgerRecord[] = [];
  private readonly teaLedger: InMemoryTripleEntryLedger;
  private readonly apiToken: string | undefined;
  private readonly allowedOrigins: Set<string>;
  private readonly maxRequestBodyBytes: number;
  private readonly tls: HostedTradeNetworkOptions["tls"];

  constructor(options: HostedTradeNetworkOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 3000;
    this.apiToken = options.apiToken;
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    this.tls = options.tls;
    this.teaLedger = new InMemoryTripleEntryLedger(this.trustedSigningKeys);
    if (this.apiToken && Buffer.byteLength(this.apiToken) < 32) {
      throw new Error("API token must be at least 32 bytes");
    }
    if (!Number.isInteger(this.maxRequestBodyBytes) || this.maxRequestBodyBytes < 1) {
      throw new Error("Maximum request body size must be a positive integer");
    }
  }

  get url(): string {
    return `${this.tls ? "https" : "http"}://${this.host}:${this.port}`;
  }

  getParticipant(participantId: string): ParticipantKeyMaterial | undefined {
    return this.participants.get(participantId);
  }

  getParticipants(): PublicParticipantIdentity[] {
    return [...this.participants.values()].map(({ participantId, signingPublicKey, encryptionPublicKey }) => ({
      participantId,
      signingPublicKey,
      encryptionPublicKey,
    }));
  }

  getParticipantIdentity(participantId: string): PublicParticipantIdentity | undefined {
    return this.getParticipants().find((participant) => participant.participantId === participantId);
  }

  getLedgerRecords(): LedgerRecord[] {
    return structuredClone(this.ledgerRecords);
  }

  getState(): HostedTradeNetworkState {
    return {
      participants: this.getParticipants(),
      ledger: this.getLedgerRecords(),
      teaEvents: this.getTripleEntryEvents(),
      envelopes: structuredClone(this.envelopes),
    };
  }

  registerParticipant(participant: ParticipantKeyMaterial): ParticipantKeyMaterial {
    if (!participant.participantId || !participant.signingPublicKey || !participant.encryptionPublicKey
      || !participant.signingPrivateKey || !participant.encryptionPrivateKey) {
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

  private registerPublicParticipant(participant: PublicParticipantIdentity): PublicParticipantIdentity {
    if (this.participants.has(participant.participantId)) {
      throw new HttpError(409, `Participant ${participant.participantId} is already registered`);
    }
    this.participants.set(participant.participantId, {
      ...participant,
      signingPrivateKey: "",
      encryptionPrivateKey: "",
    });
    this.trustedSigningKeys.set(participant.participantId, participant.signingPublicKey);
    return { ...participant };
  }

  registerParticipantIdentity(participant: PublicParticipantIdentity): PublicParticipantIdentity {
    return this.registerPublicParticipant(PublicParticipantSchema.parse(participant));
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
    if (!sender.signingPrivateKey || !recipient.encryptionPublicKey) {
      throw new Error("Envelope creation requires locally held sender keys");
    }
    const envelope = await createEnvelope(document, sender, recipientId, recipient.encryptionPublicKey, createdAt);
    this.envelopes.push(structuredClone(envelope));
    this.envelopeIds.add(envelope.header.envelopeId);
    return structuredClone(envelope);
  }

  async submitEnvelope(envelope: SignedEnvelope): Promise<SignedEnvelope> {
    const sender = this.participants.get(envelope.header.senderId);
    if (!sender || !this.participants.has(envelope.header.recipientId)) {
      throw new HttpError(400, "Envelope sender and recipient must be registered participants");
    }
    if (envelope.header.senderId === envelope.header.recipientId) {
      throw new HttpError(400, "Envelope sender and recipient must be different participants");
    }
    if (this.envelopeIds.has(envelope.header.envelopeId)) {
      throw new HttpError(409, "Duplicate envelope ID");
    }
    if (!await verifyEnvelope(envelope, sender.signingPublicKey)) {
      throw new HttpError(400, "Envelope signature or ciphertext hash is invalid");
    }
    this.envelopes.push(structuredClone(envelope));
    this.envelopeIds.add(envelope.header.envelopeId);
    return structuredClone(envelope);
  }

  async submitLedgerProposal(proposal: LedgerProposal): Promise<LedgerRecord> {
    const expectedPreviousHash = this.ledgerRecords.at(-1)?.chainHash ?? "";
    if (proposal.sequence !== this.ledgerRecords.length) {
      throw new HttpError(409, "Ledger proposal does not extend the current chain head");
    }
    if (proposal.previousHash !== expectedPreviousHash) {
      throw new HttpError(409, "Ledger proposal previous hash does not match the current chain head");
    }
    if (this.eventIds.has(proposal.eventId)) {
      throw new HttpError(409, "Duplicate ledger event ID");
    }
    if (!proposal.parties.every((party) => this.participants.has(party))) {
      throw new HttpError(400, "Ledger proposal includes unregistered parties");
    }
    if (!await verifyLedgerProposal(proposal, this.trustedSigningKeys)) {
      throw new HttpError(400, "Ledger proposal lacks valid signatures from both counterparties");
    }

    const record: LedgerRecord = {
      ...structuredClone(proposal),
      chainHash: sha256Base64Url(canonicalBytes(proposal)),
    };

    this.ledgerRecords.push(record);
    this.eventIds.add(record.eventId);
    return structuredClone(record);
  }

  async submitTripleEntryEvent(event: TripleEntryEvent): Promise<TripleEntryEventRecord> {
    if (!this.participants.has(event.sellerParticipantId) || !this.participants.has(event.buyerParticipantId)) {
      throw new HttpError(400, "Triple-entry event parties must be registered participants");
    }
    try {
      return await this.teaLedger.append(event);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Triple-entry event is invalid");
    }
  }

  getTripleEntryEvents(): TripleEntryEventRecord[] {
    return this.teaLedger.getRecords();
  }

  getTripleEntryTransactionStatus(transactionId: string) {
    return this.teaLedger.getTransactionStatus(transactionId);
  }

  async start(): Promise<this> {
    if (this.server) {
      return this;
    }
    if (!isLoopbackHost(this.host)) {
      if (!this.apiToken) {
        throw new Error("A bearer API token is required when binding outside loopback");
      }
      if (!this.tls) {
        throw new Error("TLS is required when binding outside loopback");
      }
    }

    const handle = (request: IncomingMessage, response: ServerResponse) => {
      void this.handleRequest(request, response);
    };
    this.server = this.tls
      ? createHttpsServer(this.tls, handle)
      : createServer(handle);

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
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.apiToken) return isLoopbackHost(this.host);
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    if (!match?.[1]) return false;
    const expected = createHash("sha256").update(this.apiToken).digest();
    const provided = createHash("sha256").update(match[1]).digest();
    return timingSafeEqual(expected, provided);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const origin = request.headers.origin;
      if (origin) {
        if (!this.allowedOrigins.has(origin)) {
          throw new HttpError(403, "Origin is not allowed");
        }
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }

      if (request.method === "OPTIONS") {
        if (origin) {
          response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
          response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
        }
        this.sendJson(response, 204, null);
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        this.sendJson(response, 200, {
          ok: true,
          network: "trade-network-poc",
        });
        return;
      }

      if (!this.isAuthorized(request)) {
        throw new HttpError(401, "Bearer authentication is required");
      }

      if (request.method === "GET" && url.pathname === "/participants") {
        this.sendJson(response, 200, { participants: this.getParticipants() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/participants") {
        const body = PublicParticipantSchema.parse(await readRequestBody(request, this.maxRequestBodyBytes));
        const participant = this.registerParticipantIdentity(body);
        this.sendJson(response, 201, { participant });
        return;
      }

      if (request.method === "GET" && url.pathname === "/tea/events") {
        this.sendJson(response, 200, { events: this.getTripleEntryEvents() });
        return;
      }

      const transactionStatusMatch = /^\/tea\/transactions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && transactionStatusMatch?.[1]) {
        const transactionId = decodeURIComponent(transactionStatusMatch[1]);
        const status = this.getTripleEntryTransactionStatus(transactionId);
        if (!status) {
          this.sendJson(response, 404, { error: "Transaction not found" });
          return;
        }
        this.sendJson(response, 200, {
          transactionId,
          status,
          events: this.getTripleEntryEvents().filter((event) => event.transactionId === transactionId),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tea/events") {
        const body = z.object({ event: TripleEntryEventSchema }).strict()
          .parse(await readRequestBody(request, this.maxRequestBodyBytes));
        const record = await this.submitTripleEntryEvent(body.event);
        this.sendJson(response, 201, { record });
        return;
      }

      if (request.method === "POST" && url.pathname === "/documents/envelope") {
        const body = z.object({ envelope: SignedEnvelopeSchema }).strict()
          .parse(await readRequestBody(request, this.maxRequestBodyBytes));
        const envelope = await this.submitEnvelope(body.envelope);
        this.sendJson(response, 201, { envelope });
        return;
      }

      if (request.method === "GET" && url.pathname === "/documents/envelopes") {
        const recipientId = url.searchParams.get("recipientId");
        if (!recipientId) {
          throw new HttpError(400, "recipientId query parameter is required");
        }
        const envelopes = this.envelopes
          .filter((envelope) => envelope.header.recipientId === recipientId)
          .map((envelope) => structuredClone(envelope));
        this.sendJson(response, 200, { envelopes });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ledger") {
        this.sendJson(response, 200, { records: this.getLedgerRecords() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/ledger/events") {
        const body = await readRequestBody(request, this.maxRequestBodyBytes);
        const proposalInput = z.object({ proposal: LedgerProposalSchema }).strict().safeParse(body);
        const proposal = proposalInput.success
          ? proposalInput.data.proposal
          : LedgerProposalSchema.parse(body);
        const record = await this.submitLedgerProposal(proposal);
        this.sendJson(response, 201, { record });
        return;
      }

      this.sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        this.sendJson(response, error.statusCode, { error: error.message });
      } else if (error instanceof z.ZodError) {
        this.sendJson(response, 400, { error: "Request does not match the expected schema" });
      } else {
        console.error("Sandbox request failed", error);
        this.sendJson(response, 500, { error: "Internal server error" });
      }
    }
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be configured together");
  }
  const tls = certPath && keyPath
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;
  const network = new HostedTradeNetwork({
    host,
    port,
    ...(process.env.NETWORK_API_TOKEN ? { apiToken: process.env.NETWORK_API_TOKEN } : {}),
    ...(tls ? { tls } : {}),
  });

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
