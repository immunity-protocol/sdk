import { zeroPadValue } from "ethers";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../keccak/matchers/call-pattern.js";
import { hashGraphMatcher } from "../keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../keccak/matchers/semantic.js";
import type { PublicMatcherSummary } from "../storage/envelope.js";
import { type AntibodySeed, type Hex32, SemanticFlavorValue } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex32;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

/**
 * The `primaryMatcherHash` for a seed — dispatched to the canonical
 * `keccak/matchers/*` helper for the seed's type. Identical inputs produce the
 * identical hash the matchers and indexer key off.
 */
export function primaryMatcherHashFor(seed: AntibodySeed): Hex32 {
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
      return hashGraphMatcher({ chainId: seed.chainId, taintedAddresses: seed.taintedAddresses });
    case "SEMANTIC":
      return hashSemanticMatcher({ flavor: seed.flavor, pattern: seed.pattern });
  }
}

/**
 * The `auxiliaryKey` the contract's `_emitAuxiliary` decodes per type to emit a
 * typed event (the A2 indexer keys off these). Encodings are EXACT, matching
 * `ImmunityRegistry._emitAuxiliary`:
 *   - ADDRESS:      `bytes32(uint256(uint160(target)))` — left-padded address.
 *   - CALL_PATTERN: selector in the high 4 bytes — `bytes4(auxKey)`.
 *   - BYTECODE:     the runtime `bytecodeHash`.
 *   - GRAPH:        the `taintSetId`.
 *   - SEMANTIC:     unused by the contract (it emits `flavor`) — pass zero.
 */
export function auxiliaryKeyFor(seed: AntibodySeed): Hex32 {
  switch (seed.abType) {
    case "ADDRESS":
      return zeroPadValue(normalizeAddress(seed.target), 32) as Hex32;
    case "CALL_PATTERN": {
      if (!SELECTOR_RE.test(seed.selector)) {
        throw new Error(`invalid selector: ${seed.selector} (expected 0x + 8 hex)`);
      }
      return `0x${seed.selector.slice(2).toLowerCase()}${"0".repeat(56)}` as Hex32;
    }
    case "BYTECODE":
      return seed.bytecodeHash;
    case "GRAPH":
      return seed.taintSetId;
    case "SEMANTIC":
      return ZERO_BYTES32;
  }
}

/** The uint8 `flavor` code: SEMANTIC carries its flavor enum, others are 0. */
export function flavorCodeOf(seed: AntibodySeed): number {
  return seed.abType === "SEMANTIC" ? SemanticFlavorValue[seed.flavor] : 0;
}

/** The public, keyless-readable matcher summary embedded in the evidence envelope. */
export function matcherSummaryFor(seed: AntibodySeed): PublicMatcherSummary {
  switch (seed.abType) {
    case "ADDRESS":
      return { kind: "address", chainId: seed.chainId, target: normalizeAddress(seed.target) };
    case "CALL_PATTERN":
      return {
        kind: "call_pattern",
        chainId: seed.chainId,
        target: normalizeAddress(seed.target),
        selector: seed.selector,
      };
    case "BYTECODE":
      return { kind: "bytecode", bytecodeHash: seed.bytecodeHash };
    case "GRAPH":
      return {
        kind: "graph",
        chainId: seed.chainId,
        taintSetId: seed.taintSetId,
        size: seed.taintedAddresses.length,
      };
    case "SEMANTIC":
      return {
        kind: "semantic",
        flavor: seed.flavor,
        ...(seed.pattern.kind === "marker" ? { markerHint: seed.pattern.value } : {}),
      };
  }
}
