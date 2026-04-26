import { zeroPadValue } from "ethers";
import { computeKeccakId } from "../keccak/id.js";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../keccak/matchers/call-pattern.js";
import { computeTaintSetId, hashGraphMatcher } from "../keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../keccak/matchers/semantic.js";
import {
  type AntibodySeed,
  AntibodyTypeValue,
  type Hex32,
  type Verdict,
  VerdictValue,
} from "../types/antibody.js";
import type { Address } from "../types/antibody.js";
import { DuplicateAntibodyError } from "../types/errors.js";
import { normalizeAddress } from "../util/address.js";
import type { RegistryClient } from "./registry-client.js";

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface PublishInput {
  seed: AntibodySeed;
  verdict: Verdict;
  confidence: number;
  severity: number;
  evidenceCid?: Hex32;
  contextHash?: Hex32;
  embeddingHash?: Hex32;
  attestation?: Hex32;
  expiresAt?: bigint;
  reviewer?: Address;
}

export interface PublishParamsStruct {
  abType: number;
  flavor: number;
  verdict: number;
  confidence: number;
  severity: number;
  primaryMatcherHash: Hex32;
  evidenceCid: Hex32;
  contextHash: Hex32;
  embeddingHash: Hex32;
  attestation: Hex32;
  expiresAt: bigint;
  reviewer: Address;
  auxiliaryKey: Hex32;
}

export interface PublishResult {
  keccakId: Hex32;
  immSeq: number;
  txHash: Hex32;
  params: PublishParamsStruct;
}

/**
 * Build the on-chain `PublishParams` struct from a seed plus envelope
 * fields. Computes `primaryMatcherHash` and `auxiliaryKey` per type
 * according to the Registry's `_emitAuxiliary` dispatch.
 */
export function buildPublishParams(input: PublishInput): PublishParamsStruct {
  const { seed } = input;
  const flavor = seed.abType === "SEMANTIC" ? semanticFlavorCode(seed.flavor) : 0;
  const primaryMatcherHash = primaryHashFor(seed);
  const auxiliaryKey = auxiliaryKeyFor(seed);
  return {
    abType: AntibodyTypeValue[seed.abType],
    flavor,
    verdict: VerdictValue[input.verdict],
    confidence: clamp(input.confidence, 0, 100),
    severity: clamp(input.severity, 0, 100),
    primaryMatcherHash,
    evidenceCid: input.evidenceCid ?? ZERO_BYTES32,
    contextHash: input.contextHash ?? ZERO_BYTES32,
    embeddingHash: input.embeddingHash ?? ZERO_BYTES32,
    attestation: input.attestation ?? ZERO_BYTES32,
    expiresAt: input.expiresAt ?? 0n,
    reviewer: (input.reviewer ?? "0x0000000000000000000000000000000000000000") as Address,
    auxiliaryKey,
  };
}

/**
 * Send a `Registry.publish(params)` tx, parse the `AntibodyPublished` event
 * for the assigned `keccakId` and `immSeq`, and return both. Maps the
 * Registry's `AntibodyExists` revert into a typed `DuplicateAntibodyError`.
 */
export async function publish(
  registry: RegistryClient,
  publisher: Address,
  input: PublishInput,
): Promise<PublishResult> {
  const params = buildPublishParams(input);
  const keccakId = computeKeccakId(
    input.seed.abType,
    params.flavor,
    params.primaryMatcherHash,
    normalizeAddress(publisher) as Address,
  );

  let tx: Awaited<ReturnType<typeof registry.contract.publish>>;
  try {
    tx = await registry.contract.publish(params);
  } catch (err) {
    if (looksLikeDuplicate(err)) throw new DuplicateAntibodyError(keccakId);
    throw err;
  }
  const receipt = await tx.wait();
  const eventLog = (receipt?.logs ?? [])
    .map((l: { topics: ReadonlyArray<string>; data: string }) => {
      try {
        return registry.contract.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        return null;
      }
    })
    .find((l: { name: string } | null) => l?.name === "AntibodyPublished");
  const immSeq = eventLog ? Number(eventLog.args.immSeq as bigint) : 0;
  return {
    keccakId,
    immSeq,
    txHash: (receipt?.hash ?? tx.hash) as Hex32,
    params,
  };
}

function semanticFlavorCode(flavor: "COUNTERPARTY" | "MANIPULATION" | "PROMPT_INJECTION"): number {
  return flavor === "COUNTERPARTY" ? 0 : flavor === "MANIPULATION" ? 1 : 2;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) throw new Error(`expected number in [${lo},${hi}]`);
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function primaryHashFor(seed: AntibodySeed): Hex32 {
  switch (seed.abType) {
    case "ADDRESS":
      return hashAddressMatcher({ chainId: seed.chainId, target: seed.target });
    case "CALL_PATTERN":
      return hashCallPatternMatcher({
        chainId: seed.chainId,
        target: seed.target,
        selector: seed.selector,
        argsTemplate: seed.argsTemplate,
      });
    case "BYTECODE":
      return hashBytecodeMatcher({ bytecodeHash: seed.bytecodeHash });
    case "GRAPH":
      return hashGraphMatcher({
        chainId: seed.chainId,
        taintedAddresses: seed.taintedAddresses,
      });
    case "SEMANTIC":
      return hashSemanticMatcher({ flavor: seed.flavor, pattern: seed.pattern });
  }
}

/**
 * Compute the auxiliaryKey the contract uses to dispatch `_emitAuxiliary`.
 *
 * - ADDRESS: bytes32(uint256(uint160(address))) — the target padded left.
 * - CALL_PATTERN: bytes32 with selector in the leading 4 bytes.
 * - BYTECODE: the runtime bytecode hash directly.
 * - GRAPH: the taintSetId (the inner keccak of the matcher hash).
 * - SEMANTIC: zero — flavor is the indexed event arg, auxKey is unused.
 */
function auxiliaryKeyFor(seed: AntibodySeed): Hex32 {
  switch (seed.abType) {
    case "ADDRESS":
      return zeroPadValue(normalizeAddress(seed.target), 32) as Hex32;
    case "CALL_PATTERN": {
      const sel = seed.selector;
      return `${sel}${"00".repeat(28)}` as Hex32;
    }
    case "BYTECODE":
      return seed.bytecodeHash;
    case "GRAPH":
      return computeTaintSetId({
        chainId: seed.chainId,
        taintedAddresses: seed.taintedAddresses,
      });
    case "SEMANTIC":
      return ZERO_BYTES32;
  }
}

function looksLikeDuplicate(err: unknown): boolean {
  const msg = String((err as { message?: string }).message ?? "");
  return msg.includes("AntibodyExists");
}
