import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const canonicalize = require("canonicalize") as (value: unknown) => string | undefined;

export function canonicalJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new TypeError("Value cannot be represented as canonical JSON");
  }
  return serialized;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Base64Url(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}