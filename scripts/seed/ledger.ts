// Idempotency ledger for the seed run.
//
// The seed is a long multi-transaction script that WILL get interrupted. The
// ledger records what each publisher has already published (keyed by mode +
// publisher + matcher hash) so a re-run skips the gateway upload and on-chain
// publish instead of reverting on a duplicate. The on-chain state is the source
// of truth; the ledger is a local fast-path to avoid re-uploading evidence.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LedgerEntry {
  keccakId: string;
  evidenceCid: string;
  contextHash?: string;
  txHash: string;
}

type LedgerData = Record<string, LedgerEntry>;

export const DEFAULT_LEDGER_PATH = resolve(process.cwd(), "scripts/.seed-ledger.json");

export class SeedLedger {
  readonly #path: string;
  #data: LedgerData;

  constructor(path: string = DEFAULT_LEDGER_PATH) {
    this.#path = path;
    this.#data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LedgerData) : {};
  }

  static key(mode: string, publisher: string, matcherHash: string): string {
    return `${mode}:${publisher.toLowerCase()}:${matcherHash.toLowerCase()}`;
  }

  get(mode: string, publisher: string, matcherHash: string): LedgerEntry | undefined {
    return this.#data[SeedLedger.key(mode, publisher, matcherHash)];
  }

  has(mode: string, publisher: string, matcherHash: string): boolean {
    return this.get(mode, publisher, matcherHash) !== undefined;
  }

  record(mode: string, publisher: string, matcherHash: string, entry: LedgerEntry): void {
    this.#data[SeedLedger.key(mode, publisher, matcherHash)] = entry;
    this.save();
  }

  save(): void {
    writeFileSync(this.#path, `${JSON.stringify(this.#data, null, 2)}\n`);
  }
}
