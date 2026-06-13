// Corpus loading for the live-seed script.
//
// The demo threat corpus (`immunity-demo/threats/addresses.json`) carries each
// known-bad target's verdict/confidence/severity/reasoning, but its seeds are
// scoped to the 0G testnet (chainId 16602). Antibodies seeded onto Base Sepolia
// must match a Base-Sepolia agent's `check()`, whose probe is chain-scoped — so
// the chainId is overridden to 84532 here. The matcher hash is baked from that
// chainId, so all three publishers of the same target derive an identical
// `matcherHash` (the corroboration key), while their on-chain ids differ.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type Address,
  type Hex32,
  type PublishInput,
  type Verdict,
  hashAddressMatcher,
} from "../../src/index.js";

/** Base Sepolia — the chain the antibodies are seeded onto. */
export const SEED_CHAIN_ID = 84532;

export const DEFAULT_CORPUS_PATH = resolve(homedir(), "www/immunity-demo/threats/addresses.json");

/** A single known-bad target prepared for publishing as an ADDRESS antibody. */
export interface CorpusTarget {
  /** Index in the source corpus. */
  index: number;
  chainId: number;
  target: Address;
  /** Shared corroboration key — identical across all publishers of this target. */
  matcherHash: Hex32;
  /** The SDK publish request (context present only for CRE-demo targets). */
  input: PublishInput;
  /** Flagged for the CRE-challenge demo: evidence context is ECIES-encrypted. */
  isCreDemo: boolean;
}

/** Raw shape of one corpus entry as stored in `addresses.json`. */
export interface RawCorpusEntry {
  seed: { abType: string; chainId: number; target: string };
  verdict: string;
  confidence: number;
  severity: number;
  reasoning: string;
  seed_source?: string;
  evidence_url?: string;
}

export interface CorpusOptions {
  path?: string;
  /** How many targets the genesis run publishes (each 3×). Default 8. */
  count?: number;
  /** How many leading targets carry encrypted CRE context. Default 2. */
  creDemoCount?: number;
}

function toVerdict(raw: string): Verdict {
  return raw === "SUSPICIOUS" ? "SUSPICIOUS" : "MALICIOUS";
}

/**
 * The sensitive context ECIES-encrypted to the CRE oracle for demo targets.
 * Mirrors what a CRE jury workflow would decrypt during a challenge — the
 * public envelope only carries the short `reasonSummary`.
 */
function buildContext(entry: RawCorpusEntry): string {
  return JSON.stringify({
    schema: "immunity/cre-context/v1",
    reasoning: entry.reasoning,
    evidenceUrl: entry.evidence_url ?? null,
    seedSource: entry.seed_source ?? null,
  });
}

/** Map one raw entry onto a publishable ADDRESS target (chainId forced to Base Sepolia). */
export function buildTarget(
  entry: RawCorpusEntry,
  index: number,
  isCreDemo: boolean,
): CorpusTarget {
  if (entry.seed.abType !== "ADDRESS") {
    throw new Error(
      `corpus[${index}]: only ADDRESS targets are supported, got ${entry.seed.abType}`,
    );
  }
  const target = entry.seed.target.toLowerCase() as Address;
  const matcherHash = hashAddressMatcher({ chainId: SEED_CHAIN_ID, target });
  const input: PublishInput = {
    seed: { abType: "ADDRESS", chainId: SEED_CHAIN_ID, target },
    verdict: toVerdict(entry.verdict),
    confidence: entry.confidence,
    severity: entry.severity,
    reasonSummary: entry.reasoning,
    ...(isCreDemo ? { context: buildContext(entry) } : {}),
  };
  return { index, chainId: SEED_CHAIN_ID, target, matcherHash, input, isCreDemo };
}

/** Pure: select the first `count` entries and flag the first `creDemoCount` as CRE-demo. */
export function buildCorpus(raw: RawCorpusEntry[], opts: CorpusOptions = {}): CorpusTarget[] {
  const count = opts.count ?? 8;
  const creDemoCount = opts.creDemoCount ?? 2;
  return raw.slice(0, count).map((entry, index) => buildTarget(entry, index, index < creDemoCount));
}

function readCorpusFile(path: string): RawCorpusEntry[] {
  return JSON.parse(readFileSync(path, "utf8")) as RawCorpusEntry[];
}

/** The genesis `--live` corpus: first `count` targets, leading `creDemoCount` encrypted. */
export function loadCorpus(opts: CorpusOptions = {}): CorpusTarget[] {
  return buildCorpus(readCorpusFile(opts.path ?? DEFAULT_CORPUS_PATH), opts);
}

/**
 * The single throwaway-wallet validation target. Defaults to a synthetic corpus
 * entry OUTSIDE the genesis-8 set (index 12) so the validation run never adds
 * throwaway corroboration to a real genesis matcher. Always CRE-demo so the run
 * also exercises the ECIES context path end-to-end.
 */
export function loadValidateTarget(opts: { path?: string; index?: number } = {}): CorpusTarget {
  const raw = readCorpusFile(opts.path ?? DEFAULT_CORPUS_PATH);
  const index = opts.index ?? 12;
  const entry = raw[index];
  if (!entry) {
    throw new Error(`validate target index ${index} out of range (${raw.length} corpus entries)`);
  }
  return buildTarget(entry, index, true);
}
