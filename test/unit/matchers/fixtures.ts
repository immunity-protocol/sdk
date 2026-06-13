import { keccak256 } from "ethers";
import { AntibodyCache } from "../../../src/cache/cache.js";
import { computeKeccakId } from "../../../src/keccak/id.js";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../../../src/keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../../../src/keccak/matchers/call-pattern.js";
import { hashGraphMatcher } from "../../../src/keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../../../src/keccak/matchers/semantic.js";
import type { Address, Antibody, AntibodySeed, Hex32 } from "../../../src/types/antibody.js";

export const PUBLISHER: Address = "0x0000000000000000000000000000000000000aaa";

let nextSeq = 1;

export function buildAntibody(seed: AntibodySeed, publisher: Address = PUBLISHER): Antibody {
  const seq = nextSeq++;
  const primaryMatcherHash = primaryHashFor(seed);
  const keccakId = computeKeccakId(seed.abType, flavorFor(seed), primaryMatcherHash, publisher);
  return {
    keccakId,
    immSeq: seq,
    immId: `IMM-2026-${String(seq).padStart(4, "0")}`,
    abType: seed.abType,
    flavor: flavorFor(seed),
    verdict: "MALICIOUS",
    status: "ACTIVE",
    confidence: 90,
    severity: 80,
    primaryMatcherHash,
    evidenceCid: "0x0000000000000000000000000000000000000000000000000000000000000000",
    contextHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    embeddingHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    attestation: "0x0000000000000000000000000000000000000000000000000000000000000000",
    publisher,
    reviewer: "0x0000000000000000000000000000000000000000",
    stakeAmount: 1_000_000n,
    stakeLockUntil: 0n,
    expiresAt: 0n,
    createdAt: 0n,
    isSeeded: false,
    seed,
  };
}

function flavorFor(seed: AntibodySeed): number {
  if (seed.abType === "SEMANTIC") {
    return seed.flavor === "COUNTERPARTY" ? 0 : seed.flavor === "MANIPULATION" ? 1 : 2;
  }
  return 0;
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

export function makeCache(antibodies: Antibody[]): AntibodyCache {
  const c = new AntibodyCache();
  for (const ab of antibodies) c.put(ab);
  return c;
}

export function bytecodeHashFor(code: `0x${string}`): Hex32 {
  return keccak256(code) as Hex32;
}
