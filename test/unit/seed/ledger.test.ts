import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeedLedger } from "../../../scripts/seed/ledger.js";

const PUB = "0xAbCdef0000000000000000000000000000000001";
const MATCHER = `0x${"ab".repeat(32)}`;

let path = "";
function tmpLedger(): SeedLedger {
  path = join(tmpdir(), `seed-ledger-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
  return new SeedLedger(path);
}

afterEach(() => {
  if (path && existsSync(path)) rmSync(path);
});

describe("SeedLedger", () => {
  it("is empty before anything is recorded", () => {
    const l = tmpLedger();
    expect(l.has("validate", PUB, MATCHER)).toBe(false);
    expect(l.get("validate", PUB, MATCHER)).toBeUndefined();
  });

  it("records and reads back an entry, case-insensitively", () => {
    const l = tmpLedger();
    l.record("validate", PUB, MATCHER, { keccakId: "0x01", evidenceCid: "0x02", txHash: "0x03" });
    expect(l.has("validate", PUB.toLowerCase(), MATCHER.toUpperCase())).toBe(true);
    expect(l.get("validate", PUB, MATCHER)?.evidenceCid).toBe("0x02");
  });

  it("scopes keys by mode and persists across instances", () => {
    const l = tmpLedger();
    l.record("validate", PUB, MATCHER, { keccakId: "0x01", evidenceCid: "0x02", txHash: "0x03" });
    expect(l.has("live", PUB, MATCHER)).toBe(false);

    const reloaded = new SeedLedger(path);
    expect(reloaded.has("validate", PUB, MATCHER)).toBe(true);
    expect(reloaded.get("validate", PUB, MATCHER)?.keccakId).toBe("0x01");
  });
});
