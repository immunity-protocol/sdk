import type { Antibody } from "../types/antibody.js";

export const ENVELOPE_SCHEMA = "immunity/antibody-gossip/v1" as const;

interface EnvelopeJson {
  schema: typeof ENVELOPE_SCHEMA;
  antibody: Record<string, unknown>;
}

/**
 * JSON-encode an antibody for gossip transport.
 *
 * The on-chain `Antibody` shape carries `bigint` and `0x...`-string fields.
 * `bigint` is not JSON-serializable directly, so we stringify on the way
 * out and parse back on the way in. The seed (matcher inputs) rides along
 * verbatim so subscribers can rebuild type-specific indices.
 */
export function encodeAntibody(antibody: Antibody): Uint8Array {
  const env: EnvelopeJson = {
    schema: ENVELOPE_SCHEMA,
    antibody: serializeBigints(antibody),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

export function decodeAntibody(payload: Uint8Array): Antibody {
  const text = new TextDecoder().decode(payload);
  const parsed = JSON.parse(text) as Partial<EnvelopeJson>;
  if (parsed?.schema !== ENVELOPE_SCHEMA) {
    throw new Error(`unexpected gossip schema: ${parsed?.schema}`);
  }
  const ab = parsed.antibody;
  if (!ab) throw new Error("gossip envelope missing antibody payload");
  return deserializeBigints(ab) as unknown as Antibody;
}

const BIGINT_FIELDS = new Set([
  "stakeAmount",
  "stakeLockUntil",
  "expiresAt",
  "createdAt",
]);

function serializeBigints(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (typeof v === "bigint") return [k, v.toString()];
      return [k, v];
    }),
  );
}

function deserializeBigints(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (BIGINT_FIELDS.has(k) && (typeof v === "string" || typeof v === "number")) {
      out[k] = BigInt(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
