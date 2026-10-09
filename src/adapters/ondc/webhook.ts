import {
  OndcWebhookError,
  parseBecknEnvelope,
  type BecknAck,
  type BecknNack,
  type OndcAction,
  type OndcTradeEvent,
} from "./types.js";

export interface OndcWebhookOptions {
  processEvent: (event: OndcTradeEvent) => Promise<void>;
  onProcessingError: (error: unknown, event: OndcTradeEvent) => void | Promise<void>;
}

export interface OndcWebhookController {
  receive(action: OndcAction, payload: unknown): BecknAck;
}

export function createOndcWebhookController(options: OndcWebhookOptions): OndcWebhookController {
  return {
    receive(action, payload) {
      const event = parseBecknEnvelope(action, payload);
      setImmediate(() => {
        void Promise.resolve().then(() => options.processEvent(event)).catch(async (error: unknown) => {
          try {
            await options.onProcessingError(error, event);
          } catch (reportingError) {
            console.error("ONDC event processing and error reporting failed", { error, reportingError });
          }
        });
      });
      return { message: { ack: { status: "ACK" } } };
    },
  };
}

export function toBecknNack(error: unknown): { statusCode: number; body: BecknNack } {
  let webhookError: OndcWebhookError;
  if (error instanceof OndcWebhookError) {
    webhookError = error;
  } else if (error instanceof Error && "statusCode" in error
    && typeof error.statusCode === "number" && error.statusCode < 500) {
    webhookError = new OndcWebhookError({
      type: "JSON-SCHEMA-ERROR",
      code: String(error.statusCode),
      message: error.message,
    }, error.statusCode);
  } else {
    webhookError = new OndcWebhookError({
        type: "APPLICATION-ERROR",
        code: "50000",
        message: "The ONDC webhook could not accept the request",
      }, 500);
  }
  return {
    statusCode: webhookError.statusCode,
    body: {
      message: { ack: { status: "NACK" } },
      error: webhookError.error,
    },
  };
}
