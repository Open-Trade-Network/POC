import { canonicalBytes } from "../core/canonical.js";
import { signMessage, verifyMessage, type ParticipantKeyMaterial } from "../core/crypto.js";

export type AgentAction =
  | "invoice_validation_request"
  | "invoice_acceptance"
  | "status_update"
  | "dispute_submission";

export interface AgentIntentPolicy {
  allowActions: AgentAction[];
  allowDocumentIds: string[];
  allowRecipients: string[];
}

export interface AgentIntentRequest {
  action: AgentAction;
  intentId: string;
  agentId: string;
  documentId: string;
  recipientId: string;
  purpose: string;
  payload: Record<string, unknown>;
  expiresAt: string;
}

export interface AgentIntent extends AgentIntentRequest {
  version: 1;
  companyId: string;
  participantId: string;
  senderSigningPublicKey: string;
  createdAt: string;
}

export interface SignedAgentIntent {
  intent: AgentIntent;
  signature: string;
}

export interface CompanyAgentGatewayConfig {
  companyId: string;
  participantId: string;
  keyMaterial: ParticipantKeyMaterial;
  policy: AgentIntentPolicy;
}

export class CompanyAgentGateway {
  readonly companyId: string;
  readonly participantId: string;
  readonly policy: AgentIntentPolicy;
  readonly keyMaterial: ParticipantKeyMaterial;

  constructor(config: CompanyAgentGatewayConfig) {
    this.companyId = config.companyId;
    this.participantId = config.participantId;
    this.keyMaterial = config.keyMaterial;
    this.policy = config.policy;
  }

  publicSigningKey(): string {
    return this.keyMaterial.signingPublicKey;
  }

  async signIntent(request: AgentIntentRequest): Promise<SignedAgentIntent> {
    const intent: AgentIntent = {
      version: 1,
      companyId: this.companyId,
      participantId: this.participantId,
      senderSigningPublicKey: this.keyMaterial.signingPublicKey,
      action: request.action,
      intentId: request.intentId,
      agentId: request.agentId,
      documentId: request.documentId,
      recipientId: request.recipientId,
      purpose: request.purpose,
      payload: request.payload,
      expiresAt: request.expiresAt,
      createdAt: new Date().toISOString(),
    };

    const signature = await signMessage(canonicalBytes(intent), this.keyMaterial.signingPrivateKey);
    return { intent, signature };
  }

  async sendIntent(target: CompanyAgentGateway, request: AgentIntentRequest): Promise<SignedAgentIntent> {
    const signed = await this.signIntent(request);
    if (target.participantId !== request.recipientId) {
      throw new Error("Recipient mismatch between agent intent and target gateway");
    }
    return signed;
  }

  async verifyIntent(signedIntent: SignedAgentIntent, signerPublicKey: string): Promise<boolean> {
    const { intent, signature } = signedIntent;
    if (intent.version !== 1) return false;
    if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) return false;
    if (intent.senderSigningPublicKey !== signerPublicKey) return false;
    return verifyMessage(canonicalBytes(intent), signature, signerPublicKey);
  }

  async authorizeIntent(signedIntent: SignedAgentIntent): Promise<boolean> {
    const { intent } = signedIntent;
    if (!this.policy.allowActions.includes(intent.action)) return false;
    if (!this.policy.allowDocumentIds.includes(intent.documentId)) return false;
    if (!this.policy.allowRecipients.includes(intent.recipientId)) return false;
    if (intent.participantId === this.participantId && intent.companyId === this.companyId) {
      return false;
    }
    if (new Date(intent.expiresAt).getTime() <= Date.now()) return false;
    return this.verifyIntent(signedIntent, intent.senderSigningPublicKey);
  }
}
