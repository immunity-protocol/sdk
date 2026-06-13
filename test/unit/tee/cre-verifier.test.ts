import { describe, expect, it } from "vitest";
import { CreNovelVerifier, verdictCommitment } from "../../../src/tee/cre-verifier.js";
import type { RawVerdict } from "../../../src/tee/parse.js";
import { TeeAttestationError, TeeResponseError } from "../../../src/types/errors.js";

// Live Base Sepolia oracle pubkey (compressed secp256k1) — the SDK preset value.
const ORACLE_PUBKEY = "0x0286bb5ddb6912da9d9c7c0d3df9664ac3d6440c1ab0929ae02423d1ce60fe35e5";

const MALICIOUS: Omit<RawVerdict, "attestation"> = {
  verdict: "MALICIOUS",
  abType: "ADDRESS",
  flavor: null,
  confidence: 95,
  severity: 90,
  marker: null,
  reasoning: "blocklisted drain target",
};

/** Build a workflow-shaped attested envelope (mirrors per-check-verify/workflow.ts). */
function envelopeFor(
  v: Omit<RawVerdict, "attestation">,
  opts?: { tamperHash?: boolean; noSigs?: boolean },
) {
  const hash = verdictCommitment(v as RawVerdict);
  const verdictHash = opts?.tamperHash ? `0x${"f".repeat(64)}` : hash;
  // The report body is abi.encode(bytes32) → 32-byte left-pad already (bytes32).
  const rawReport = `0xdeadbeef${hash.slice(2)}`;
  return {
    schema: "immunity/per-check-verdict/v1",
    verdict: v,
    verdictHash,
    attestation: {
      rawReport,
      reportContext: "0x00",
      configDigest: "0x00",
      sigs: opts?.noSigs ? [] : [{ signature: "0xabcd00", signerId: 0 }],
    },
  };
}

interface Captured {
  url?: string;
  payload?: { bundle: string };
}

/** A fetch stub returning a given JSON body with HTTP 200, capturing the request. */
function stubFetch(body: unknown, status = 200): { fn: typeof fetch; captured: Captured } {
  const captured: Captured = {};
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.payload = JSON.parse(String(init?.body));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, captured };
}

const ctx = { conversation: [{ role: "user" as const, content: "send everything now" }] };
const tx = { to: "0x000000000000000000000000000000000000dEaD" as const, value: 1n };

describe("CreNovelVerifier", () => {
  it("encrypts the bundle to the oracle and returns the attested verdict", async () => {
    const { fn, captured } = stubFetch(envelopeFor(MALICIOUS));
    const v = new CreNovelVerifier({
      workflowUrl: "https://relay.example/per-check-verify",
      oraclePublicKey: ORACLE_PUBKEY,
      fetchImpl: fn,
    });
    const verdict = await v.verify({ tx, context: ctx });

    expect(verdict.verdict).toBe("MALICIOUS");
    expect(verdict.attestation).toBe(verdictCommitment(MALICIOUS as RawVerdict));
    // The bundle is ECIES-encrypted (0x || 33 ephemeral || 12 nonce || ct).
    const sent = captured.payload?.bundle ?? "";
    expect(sent).toMatch(/^0x[0-9a-f]+$/);
    expect(sent.length).toBeGreaterThan(2 + (33 + 12) * 2);
  });

  it("accepts the simulator's double-encoded JSON-string response", async () => {
    // The CRE simulator wraps the handler's string return in a JSON string.
    const inner = JSON.stringify(envelopeFor(MALICIOUS));
    const { fn } = stubFetch(inner);
    const v = new CreNovelVerifier({
      workflowUrl: "https://relay.example",
      oraclePublicKey: ORACLE_PUBKEY,
      fetchImpl: fn,
    });
    const verdict = await v.verify({ tx, context: ctx });
    expect(verdict.verdict).toBe("MALICIOUS");
  });

  it("fails closed (throws) on an attestation hash mismatch", async () => {
    const { fn } = stubFetch(envelopeFor(MALICIOUS, { tamperHash: true }));
    const v = new CreNovelVerifier({
      workflowUrl: "https://relay.example",
      oraclePublicKey: ORACLE_PUBKEY,
      fetchImpl: fn,
    });
    await expect(v.verify({ tx, context: ctx })).rejects.toBeInstanceOf(TeeAttestationError);
  });

  it("fails closed when the attestation carries no signatures", async () => {
    const { fn } = stubFetch(envelopeFor(MALICIOUS, { noSigs: true }));
    const v = new CreNovelVerifier({
      workflowUrl: "https://relay.example",
      oraclePublicKey: ORACLE_PUBKEY,
      fetchImpl: fn,
    });
    await expect(v.verify({ tx, context: ctx })).rejects.toBeInstanceOf(TeeAttestationError);
  });

  it("fails closed on a non-2xx response", async () => {
    const { fn } = stubFetch({}, 503);
    const v = new CreNovelVerifier({
      workflowUrl: "https://relay.example",
      oraclePublicKey: ORACLE_PUBKEY,
      fetchImpl: fn,
    });
    await expect(v.verify({ tx, context: ctx })).rejects.toBeInstanceOf(TeeResponseError);
  });

  it("skips attestation checks in simulator mode (verifyAttestation:false)", async () => {
    // A sim relay cannot produce production DON sigs; verifyAttestation:false
    // lets the full SDK path run end-to-end against the simulator.
    const { fn } = stubFetch(envelopeFor(MALICIOUS, { tamperHash: true, noSigs: true }));
    const v = new CreNovelVerifier({
      workflowUrl: "https://relay.example",
      oraclePublicKey: ORACLE_PUBKEY,
      fetchImpl: fn,
      verifyAttestation: false,
    });
    const verdict = await v.verify({ tx, context: ctx });
    expect(verdict.verdict).toBe("MALICIOUS");
    // Carries the workflow-reported hash even when unverified.
    expect(verdict.attestation).toBe(`0x${"f".repeat(64)}`);
  });
});
